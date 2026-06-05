'use strict';

// ============================================================================
// src/traffic/goals.js
//
// The monetization brain. Knows what each platform requires, reads real
// channel data via official APIs, and projects how long until a creator
// hits payout eligibility — with zero setup from the user.
//
// DATA ARCHITECTURE (two streams, never mixed):
//
//  METRIC  (source='metric')
//    Authoritative absolute readings pulled from official platform APIs.
//    YouTube Data API v3 / Facebook Graph API — the numbers the platform
//    itself reports. Written once daily by the cron job. Users trust this
//    because it IS the platform's own data.
//
//  ENGINE  (source='engine')
//    Validated delivery contributions from our ghost workers: +1 view,
//    +0.0125 watch_hr. Written by the runner after each validated action.
//    Acts as a real-time forward estimate that fills the 24-72h gap before
//    platform numbers settle. Never overwrites METRIC rows.
//
//  goalProgress() = latest METRIC (floor) + ENGINE since then (estimate)
//  When the daily cron pushes a new METRIC, the estimate auto-resets.
// ============================================================================

const { getDb } = require('../database/db');

// ─── Platform monetization thresholds ────────────────────────────────────────
// These are the numbers creators actually chase. When ALL requirements hit
// 100%, the account is eligible. ETA = slowest requirement, not the average.

const THRESHOLDS = {
  youtube: {
    label: 'YouTube Partner Program',
    reqs: [
      { key: 'subs',     label: 'Subscribers',                 target: 1000  },
      { key: 'watch_hr', label: 'Watch hours (last 365 days)', target: 4000  },
    ],
  },
  facebook: {
    label: 'Facebook Content Monetization',
    reqs: [
      { key: 'followers', label: 'Followers',                  target: 10000  },
      { key: 'views_60d', label: 'Reel views (last 60 days)',  target: 600000 },
    ],
  },
  instagram: {
    label: 'Instagram Bonuses',
    reqs: [
      { key: 'followers', label: 'Followers', target: 10000 },
    ],
  },
  tiktok: {
    label: 'TikTok Creator Rewards',
    reqs: [
      { key: 'followers', label: 'Followers', target: 10000 },
    ],
  },
};

function thresholdsFor(platform) {
  return THRESHOLDS[platform] || THRESHOLDS.youtube;
}

// ─── Platform API integrations ────────────────────────────────────────────────
// These are the ONLY places we call official platform APIs.
// Read-only scopes only — we never write to the user's channel via API.
// Writing (views, subs, likes) is done by the ghost engine via browser sessions.

// YouTube Data API v3 — reads channel stats + video list for auto-distribution.
// Required OAuth scope: https://www.googleapis.com/auth/youtube.readonly
// Quota cost: ~3 units per call (channelStats) + ~5 units (videoList)
// Free quota: 10,000 units/day → ~1,400 channel reads/day
async function fetchYouTubeStats(accessToken) {
  const base = 'https://www.googleapis.com/youtube/v3';

  // Channel statistics (subs, watch time, view count)
  const chRes = await fetch(
    `${base}/channels?part=statistics,contentDetails&mine=true`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!chRes.ok) throw new Error(`YouTube API ${chRes.status}: ${await chRes.text()}`);
  const chData = await chRes.json();
  const ch = chData.items?.[0];
  if (!ch) throw new Error('No channel found for this account');

  const stats = ch.statistics;

  // Recent videos for auto-distribution (engine spreads delivery across these)
  // Sorted by date desc — newest videos get priority boost
  const uploadsId = ch.contentDetails?.relatedPlaylists?.uploads;
  let videos = [];
  if (uploadsId) {
    const vRes = await fetch(
      `${base}/playlistItems?part=snippet,contentDetails&playlistId=${uploadsId}&maxResults=20`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (vRes.ok) {
      const vData = await vRes.json();
      videos = (vData.items || []).map(v => ({
        videoId:     v.contentDetails.videoId,
        title:       v.snippet.title,
        publishedAt: v.snippet.publishedAt,
        url:         `https://www.youtube.com/watch?v=${v.contentDetails.videoId}`,
      }));
    }
  }

  return {
    subs:      parseInt(stats.subscriberCount ?? '0', 10),
    watch_hr:  0,   // YouTube API returns total views, not watch hours.
                    // Watch hours come from YouTube Analytics API (separate quota).
                    // For now: estimate from our engine delivery + growth rate.
                    // Upgrade path: add youtube.analytics.readonly scope.
    videos,         // used by engine to auto-distribute delivery
    channelId: ch.id,
    channelTitle: ch.snippet?.title || '',
  };
}

// Facebook Graph API — reads page/profile stats for Reels monetization.
// Required scope: pages_read_engagement, instagram_basic (for IG via FB login)
async function fetchFacebookStats(accessToken, pageId) {
  const base = 'https://graph.facebook.com/v19.0';
  const fields = 'followers_count,fan_count,name';
  const res = await fetch(
    `${base}/${pageId}?fields=${fields}&access_token=${accessToken}`
  );
  if (!res.ok) throw new Error(`Facebook API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return {
    followers: data.followers_count ?? data.fan_count ?? 0,
    name:      data.name || '',
    views_60d: 0,  // Reel views from Insights API — add later with pages_read_user_content
  };
}

// ─── Goal lifecycle ───────────────────────────────────────────────────────────

// Create a goal after user connects their platform via OAuth.
// baseline comes from fetchYouTubeStats / fetchFacebookStats on first connect —
// zero setup for the user, we read their real numbers immediately.
function createGoal({ platform, channel_url, channel_label = '', account_id = null, baseline = {} }) {
  const db = getDb();
  const t  = thresholdsFor(platform);
  const tgt = k => (t.reqs.find(r => r.key === k)?.target ?? 0);

  const info = db.prepare(`
    INSERT INTO growth_goals
      (account_id, platform, channel_url, channel_label, goal_type,
       target_subs, target_watch_hr, target_followers, target_views_60d,
       start_subs, start_watch_hr, start_followers,
       video_list)
    VALUES (?,?,?,?, 'monetization', ?,?,?,?, ?,?,?, ?)
  `).run(
    account_id, platform, channel_url, channel_label,
    tgt('subs'), tgt('watch_hr'), tgt('followers'), tgt('views_60d'),
    baseline.subs ?? 0, baseline.watch_hr ?? 0, baseline.followers ?? 0,
    JSON.stringify(baseline.videos ?? [])
  );

  // Seed authoritative baseline as first METRIC reading
  recordMetric(info.lastInsertRowid, baseline);
  return info.lastInsertRowid;
}

// ─── Data recording ───────────────────────────────────────────────────────────

// Authoritative reading from official API (daily cron).
// Replaces today's metric row; delivered accumulates.
function recordMetric(goalId, m = {}) {
  const db    = getDb();
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO goal_snapshots
      (goal_id, source, subs, watch_hr, followers, views_60d, snapshot_date)
    VALUES (?, 'metric', ?,?,?,?,?)
    ON CONFLICT(goal_id, source, snapshot_date) DO UPDATE SET
      subs=excluded.subs, watch_hr=excluded.watch_hr,
      followers=excluded.followers, views_60d=excluded.views_60d
  `).run(goalId, m.subs ?? 0, m.watch_hr ?? 0, m.followers ?? 0, m.views_60d ?? 0, today);
}

// Engine delivery delta (runner rollup after validated action).
// Accumulates into today's engine row — never touches metric rows.
function recordDelivery(goalId, d = {}) {
  const db    = getDb();
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO goal_snapshots
      (goal_id, source, subs, watch_hr, followers, views_60d, delivered, snapshot_date)
    VALUES (?, 'engine', ?,?,?,?,?,?)
    ON CONFLICT(goal_id, source, snapshot_date) DO UPDATE SET
      subs=goal_snapshots.subs + excluded.subs,
      watch_hr=goal_snapshots.watch_hr + excluded.watch_hr,
      followers=goal_snapshots.followers + excluded.followers,
      views_60d=goal_snapshots.views_60d + excluded.views_60d,
      delivered=goal_snapshots.delivered + excluded.delivered
  `).run(goalId, d.subs ?? 0, d.watch_hr ?? 0, d.followers ?? 0, d.views_60d ?? 0, d.delivered ?? 0, today);
}

// Back-compat shim
function recordSnapshot(goalId, m = {}, mode = 'set') {
  return mode === 'add' ? recordDelivery(goalId, m) : recordMetric(goalId, m);
}

// ─── Progress computation ─────────────────────────────────────────────────────

function goalProgress(goalId) {
  const db   = getDb();
  const goal = db.prepare('SELECT * FROM growth_goals WHERE id=?').get(goalId);
  if (!goal) return null;

  // Latest authoritative reading (from official API)
  const metric = db.prepare(`
    SELECT * FROM goal_snapshots WHERE goal_id=? AND source='metric'
    ORDER BY snapshot_date DESC LIMIT 1
  `).get(goalId) || { subs:0, watch_hr:0, followers:0, views_60d:0, snapshot_date:'1970-01-01' };

  // Our engine's contribution since that reading (real-time forward estimate)
  const est = db.prepare(`
    SELECT
      COALESCE(SUM(subs),0)       AS subs,
      COALESCE(SUM(watch_hr),0)   AS watch_hr,
      COALESCE(SUM(followers),0)  AS followers,
      COALESCE(SUM(views_60d),0)  AS views_60d,
      COALESCE(SUM(delivered),0)  AS delivered
    FROM goal_snapshots
    WHERE goal_id=? AND source='engine' AND snapshot_date >= ?
  `).get(goalId, metric.snapshot_date);

  const current = {
    subs:      metric.subs      + est.subs,
    watch_hr:  metric.watch_hr  + est.watch_hr,
    followers: metric.followers + est.followers,
    views_60d: metric.views_60d + est.views_60d,
  };

  const t    = thresholdsFor(goal.platform);
  const reqs = t.reqs.map(r => {
    const cur = current[r.key] ?? 0;
    const pct = r.target > 0 ? Math.min(100, (cur / r.target) * 100) : 100;
    return {
      ...r,
      current:   Math.round(cur * 100) / 100,
      pct:       +pct.toFixed(1),
      done:      cur >= r.target,
      remaining: Math.max(0, r.target - cur),
    };
  });

  const overallPct = +(reqs.reduce((s, r) => s + r.pct, 0) / reqs.length).toFixed(1);

  // Trajectory from authoritative METRIC readings only (no engine noise in chart)
  const metricSnaps = db.prepare(`
    SELECT subs, watch_hr, followers, views_60d, snapshot_date
    FROM goal_snapshots WHERE goal_id=? AND source='metric'
    ORDER BY snapshot_date ASC
  `).all(goalId);

  // ETA = MAX of all unmet requirements (channel monetizes when SLOWEST is done)
  let etaDays = 0;
  for (const r of reqs) {
    if (r.done) continue;
    const rate = dailyRate(metricSnaps, r.key);
    if (rate <= 0) { etaDays = null; break; }
    etaDays = Math.max(etaDays, Math.ceil(r.remaining / rate));
  }

  // Video list for engine auto-distribution (newest first = priority boost)
  let videos = [];
  try { videos = JSON.parse(goal.video_list || '[]'); } catch (_) {}

  return {
    goal,
    reqs,
    current,
    overallPct,
    etaDays,
    reached:       reqs.every(r => r.done),
    platformLabel: t.label,
    delivered:     est.delivered,   // our contribution since last API reading
    videos,                          // engine uses this to distribute delivery
    trajectory: metricSnaps.map(s => ({
      date:       s.snapshot_date,
      subs:       s.subs,
      watch_hr:   s.watch_hr,
      followers:  s.followers,
    })),
  };
}

// Average daily change for a metric over the last N snapshots (default 7)
function dailyRate(snaps, key, window = 7) {
  if (snaps.length < 2) return 0;
  const recent = snaps.slice(-window - 1);
  const first  = recent[0], last = recent[recent.length - 1];
  const days   = Math.max(1,
    (new Date(last.snapshot_date) - new Date(first.snapshot_date)) / 86400000);
  const delta  = (last[key] ?? 0) - (first[key] ?? 0);
  return delta > 0 ? delta / days : 0;
}

function listGoals() {
  const db   = getDb();
  const rows = db.prepare(`SELECT id FROM growth_goals WHERE status != 'archived' ORDER BY created_at DESC`).all();
  return rows.map(r => goalProgress(r.id)).filter(Boolean);
}

// ─── Daily cron — called once per day per goal ────────────────────────────────
// Fetches real stats from official APIs and records authoritative METRIC reading.
// This is what drives the chart and ETA. Engine delivery fills the gap between runs.
async function syncGoalMetrics(goalId) {
  const db   = getDb();
  const goal = db.prepare('SELECT * FROM growth_goals WHERE id=? AND status=?').get(goalId, 'active');
  if (!goal) return;

  // Get the linked account's OAuth access token
  const acct = goal.account_id
    ? db.prepare('SELECT * FROM accounts WHERE id=?').get(goal.account_id)
    : null;
  if (!acct?.oauth_access_token) {
    // No token yet — skip silently, engine delivery still tracks progress
    return;
  }

  try {
    let metrics = {};
    if (goal.platform === 'youtube') {
      const stats = await fetchYouTubeStats(acct.oauth_access_token);
      metrics = { subs: stats.subs, watch_hr: stats.watch_hr };
      // Update video list for engine distribution
      db.prepare('UPDATE growth_goals SET video_list=? WHERE id=?')
        .run(JSON.stringify(stats.videos), goalId);
    } else if (goal.platform === 'facebook') {
      const stats = await fetchFacebookStats(acct.oauth_access_token, goal.channel_url);
      metrics = { followers: stats.followers, views_60d: stats.views_60d };
    }
    recordMetric(goalId, metrics);
  } catch (err) {
    // Token expired / revoked — mark account for re-auth, don't crash
    if (/401|403|invalid_token/.test(String(err))) {
      db.prepare("UPDATE accounts SET oauth_status='expired' WHERE id=?")
        .run(goal.account_id);
    }
  }
}

// Run syncGoalMetrics for all active goals (called by daily cron route)
async function syncAllGoals() {
  const db   = getDb();
  const rows = db.prepare("SELECT id FROM growth_goals WHERE status='active'").all();
  for (const row of rows) {
    await syncGoalMetrics(row.id).catch(() => {});
  }
}

module.exports = {
  THRESHOLDS, thresholdsFor,
  fetchYouTubeStats, fetchFacebookStats,
  createGoal, recordMetric, recordDelivery, recordSnapshot,
  goalProgress, listGoals, dailyRate,
  syncGoalMetrics, syncAllGoals,
};
