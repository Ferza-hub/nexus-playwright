'use strict';

const { executeGhostView, executeGhostAction } = require('../playwright-engine/index');
const { getDb }      = require('../database/db');
const { makeLogger } = require('../utils/logger');

const log = makeLogger('TrafficRunner');

const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_BROWSERS ?? '8', 10);

// Daily cap — rotating proxy can handle much higher volume than static pool.
// Default 10,000 views/day (10 workers × ~50s/view ≈ 700/hr theoretical).
// Lower this in .env if you want to pace delivery (e.g. DAILY_VIEW_LIMIT=500).
const DAILY_LIMIT = parseInt(process.env.DAILY_VIEW_LIMIT ?? '10000', 10);

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

// Global semaphore — shared singleton so ALL Playwright consumers (social runner +
// web traffic engine) compete for the same browser slot pool, preventing OOM.
const _sem = require('../utils/semaphore');

function _todayCount(db) {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  try {
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM traffic_logs WHERE status='success' AND created_at >= ?`
    ).get(midnight.toISOString());
    return row?.n ?? 0;
  } catch { return 0; }
}

// ----------------------------------------------------------------
// Action definitions — all traffic goes through the ghost pool.
//
// type 'view'   → executeGhostView(ghostPlatform, targetValue)
//   Anonymous proxy-only browser. Only works for platforms that
//   allow unauthenticated access (YouTube).
//
// type 'action' → executeGhostAction(ghostPlatform, action, params)
//   Loads an imported account session. Required for all platforms
//   that wall off content behind login (Facebook, Instagram, TikTok).
// ----------------------------------------------------------------

// minWatchMs — minimum milliseconds the video must have played for the platform
// to register the view in analytics. Only view/watch actions carry this field.
// The engine returns result.watchMs; if undefined (action not a video), skip the check.
const TRAFFIC_ACTIONS = {
  youtube: {
    views:     { type: 'view',   ghostPlatform: 'youtube',   minWatchMs: 31_000                                              },
    likes:     { type: 'action', ghostPlatform: 'youtube',   action: 'like_video',    buildParams: v => ({ videoUrl: v })   },
    subscribe: { type: 'action', ghostPlatform: 'youtube',   action: 'subscribe',     buildParams: v => ({ channelUrl: v }) },
  },
  instagram: {
    views:     { type: 'action', ghostPlatform: 'instagram', action: 'watch_reel',    buildParams: v => ({ reelUrl: v }),    minWatchMs: 5_000  },
    likes:     { type: 'action', ghostPlatform: 'instagram', action: 'like_post',     buildParams: v => ({ postUrl: v })    },
    follow:    { type: 'action', ghostPlatform: 'instagram', action: 'follow',        buildParams: v => ({ username: v })   },
  },
  tiktok: {
    views:     { type: 'action', ghostPlatform: 'tiktok',    action: 'watch_video',   buildParams: v => ({ videoUrl: v }),   minWatchMs: 5_000  },
    likes:     { type: 'action', ghostPlatform: 'tiktok',    action: 'like_video',    buildParams: v => ({ videoUrl: v })   },
    follow:    { type: 'action', ghostPlatform: 'tiktok',    action: 'follow',        buildParams: v => ({ username: v })   },
  },
  facebook: {
    // Facebook requires login to load video content — anonymous ghost hits a login wall.
    // watch_video uses an authenticated account session and navigates to the specific URL.
    views:     { type: 'action', ghostPlatform: 'facebook',  action: 'watch_reel',    buildParams: v => ({ reelUrl: v }),    minWatchMs: 5_000  },
    likes:     { type: 'action', ghostPlatform: 'facebook',  action: 'like_post',     buildParams: v => ({ postUrl: v })    },
    follow:    { type: 'action', ghostPlatform: 'facebook',  action: 'follow_page',   buildParams: v => ({ profileUrl: v }) },
  },
  twitter: {
    likes:     { type: 'action', ghostPlatform: 'twitter',   action: 'like_post',     buildParams: v => ({ tweetUrl: v })   },
    follow:    { type: 'action', ghostPlatform: 'twitter',   action: 'follow',        buildParams: v => ({ username: v })   },
  },
};

// In-memory stop signals keyed by job id
const _active = new Map();

// ----------------------------------------------------------------
// Main runner — called async, does not block server.
// Safe to call again on a paused job (resume): done is seeded from
// completed_count so delivery continues from where it left off.
// ----------------------------------------------------------------

async function runJob(jobId) {
  const db  = getDb();
  const job = db.prepare('SELECT * FROM traffic_jobs WHERE id=?').get(jobId);
  if (!job) return;

  const actionDef = TRAFFIC_ACTIONS[job.platform]?.[job.action_type];
  if (!actionDef) {
    db.prepare(`UPDATE traffic_jobs SET status='failed', updated_at=? WHERE id=?`)
      .run(new Date().toISOString(), jobId);
    return;
  }

  // Preserve original started_at when resuming a paused job
  db.prepare(`UPDATE traffic_jobs SET status='running', started_at=COALESCE(started_at,?), updated_at=? WHERE id=?`)
    .run(new Date().toISOString(), new Date().toISOString(), jobId);

  _active.set(jobId, true);

  // Resume from the count already delivered rather than restarting from zero
  let done = job.completed_count ?? 0;

  const logEntry = (status, message) => {
    try {
      db.prepare(
        `INSERT INTO traffic_logs (job_id, platform, action, status, message, created_at)
         VALUES (?,?,?,?,?,?)`
      ).run(jobId, job.platform, job.action_type, status, message ?? null, new Date().toISOString());
    } catch (_) {}
  };

  const worker = async () => {
    let streak = 0; // per-worker consecutive failure count
    while (_active.has(jobId) && done < job.target_count) {
      if (streak >= 10) break;

      // Daily cap — pause workers until midnight if limit reached
      if (_todayCount(db) >= DAILY_LIMIT) {
        logEntry('skipped', 'daily_limit_reached');
        log.info('Daily limit reached, pausing worker', { jobId, limit: DAILY_LIMIT });
        await delay(randInt(300_000, 600_000)); // check again in 5-10 min
        continue;
      }

      // Acquire a global browser slot before launching Playwright
      await _sem.acquire();
      let result;
      try {
        if (actionDef.type === 'view') {
          result = await executeGhostView(actionDef.ghostPlatform, job.target_value);
        } else {
          const params = actionDef.buildParams(job.target_value);
          result = await executeGhostAction(actionDef.ghostPlatform, actionDef.action, params);
        }
      } catch (err) {
        result = { success: false, reason: err.message };
      } finally {
        _sem.release();
      }

      if (result.success) {
        // Only count views that the platform will actually register.
        // result.watchMs is set by view/watch engine calls; undefined means a
        // non-video action (like, follow) where no watch threshold applies.
        const minMs = actionDef.minWatchMs;
        if (minMs && result.watchMs !== undefined && result.watchMs < minMs) {
          logEntry('skipped', `watch_too_short:${result.watchMs}ms`);
          await delay(randInt(500, 1500));
          continue;
        }
        done++;
        streak = 0;
        db.prepare('UPDATE traffic_jobs SET completed_count=completed_count+1, updated_at=? WHERE id=?')
          .run(new Date().toISOString(), jobId);
        logEntry('success', null);
        log.debug('Action done', { jobId, done, target: job.target_count });
      } else if (result.reason === 'no_ghost_available') {
        logEntry('skipped', result.reason);
        await delay(randInt(2_000, 5_000));
      } else if (result.reason === 'no_key_account') {
        streak = 0; // not a real failure — account pool temporarily empty
        logEntry('skipped', 'account_required');
        await delay(randInt(2_000, 5_000));
      } else {
        streak++;
        const isTimeout = /timeout|ETIMEDOUT|net::/i.test(result.reason ?? '');
        logEntry('failed', result.reason ?? result.error ?? null);
        log.debug('Action failed', { jobId, streak, reason: result.reason });
        if (isTimeout) await delay(randInt(30_000, 60_000) * Math.min(streak, 3));
      }

      if (_active.has(jobId) && done < job.target_count) {
        await delay(randInt(500, 1500));
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: MAX_CONCURRENT }, worker));
  } catch (err) {
    log.error('Worker threw', { jobId, err: err.message });
  }

  if (_active.has(jobId)) {
    const status = done >= job.target_count ? 'completed' : 'paused';
    db.prepare(`UPDATE traffic_jobs SET status=?, completed_at=?, updated_at=? WHERE id=?`)
      .run(status, new Date().toISOString(), new Date().toISOString(), jobId);
    _active.delete(jobId);
  } else {
    // Stopped externally
    db.prepare(`UPDATE traffic_jobs SET status='paused', updated_at=? WHERE id=?`)
      .run(new Date().toISOString(), jobId);
  }

  log.info('Job finished', { jobId, done, target: job.target_count });
}

function stopJob(jobId) {
  _active.delete(jobId);
  // Always write to DB — even if jobId wasn't in _active (e.g. stale from
  // a previous process after pm2 restart). This ensures Stop always works.
  try {
    getDb().prepare(`UPDATE traffic_jobs SET status='paused', updated_at=? WHERE id=?`)
      .run(new Date().toISOString(), jobId);
  } catch (_) {}
}

function isRunning(jobId) {
  return _active.has(jobId);
}

// Reset any jobs left in running/pending state from a previous process.
// Called once at startup — after pm2 restart those jobs are no longer
// actually running so they must be paused so the user can resume them.
function resetStaleJobs() {
  try {
    const n = getDb().prepare(
      `UPDATE traffic_jobs SET status='paused', updated_at=? WHERE status IN ('running','pending')`
    ).run(new Date().toISOString()).changes;
    if (n > 0) log.info(`Reset ${n} stale running job(s) to paused on startup`);
  } catch (_) {}
}

module.exports = { runJob, stopJob, isRunning, resetStaleJobs, TRAFFIC_ACTIONS };
