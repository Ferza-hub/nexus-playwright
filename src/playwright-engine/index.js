'use strict';

// src/playwright-engine/index.js
// Ghost engine — ephemeral browser + rotating proxy + human behavior layers
// Quality target: 9/10 (indistinguishable from organic traffic in pattern analysis)
//
// BEHAVIOR LAYERS:
//   L1: Entry via platform homepage (not direct URL)
//   L2: Feed scroll before engaging target
//   L3: Duration-aware watch (80-90% of actual video length, random exit)
//   L4: Natural time-of-day pacing (off-peak trickle)
//   L5: Probabilistic interactions (like, comment scroll, subscribe — all rare)
//   L6: Inter-session variance (not all ghosts behave identically)
//   L7: Shorts/Reels loop-aware (platform counts loops, not just first play)

const { launchEphemeral, launchWithSession } = require('./browser');
const { recordProxyFailure }                 = require('../database/proxies');
const { getDb }                              = require('../database/db');
const log                                    = require('../utils/logger');

// ── Platform ACTION_MAP ───────────────────────────────────────────────────────
const youtube   = require('./platforms/youtube');
const instagram = require('./platforms/instagram');
const tiktok    = require('./platforms/tiktok');
const twitter   = require('./platforms/twitter');
const facebook  = require('./platforms/facebook');
const threads   = require('./platforms/threads');

const ACTION_MAP = {
  instagram: {
    watch_reel:  { fn: 'watchReel',    args: p => [p.reelUrl]             },
    like_post:   { fn: 'likePost',     args: p => [p.postUrl]             },
    follow:      { fn: 'follow',       args: p => [p.profileUrl]          },
    comment:     { fn: 'comment',      args: p => [p.postUrl, p.text]     },
  },
  tiktok: {
    watch_video: { fn: 'watchVideo',   args: p => [p.videoUrl]            },
    like_video:  { fn: 'likeVideo',    args: p => [p.videoUrl]            },
    follow:      { fn: 'follow',       args: p => [p.profileUrl]          },
  },
  twitter: {
    like_post:   { fn: 'likePost',     args: p => [p.tweetUrl]            },
    follow:      { fn: 'follow',       args: p => [p.profileUrl]          },
  },
  youtube: {
    watch_video: { fn: 'watchVideo',   args: p => [youtube.cleanUrl(p.videoUrl), p] },
    like_video:  { fn: 'likeVideo',    args: p => [p.videoUrl]            },
    subscribe:   { fn: 'subscribe',    args: p => [p.channelUrl]          },
    comment:     { fn: 'comment',      args: p => [p.videoUrl, p.text]    },
  },
  threads: {
    like_post:   { fn: 'likePost',     args: p => [p.postUrl]             },
    follow:      { fn: 'follow',       args: p => [p.profileUrl]          },
  },
  facebook: {
    watch_video: { fn: 'watchVideo',   args: p => [p.videoUrl]            },
    watch_reel:  { fn: 'watchReel',    args: p => [p]                     },
    like_post:   { fn: 'likePost',     args: p => [p.postUrl]             },
    follow_page: { fn: 'followPage',   args: p => [p.profileUrl]          },
    comment:     { fn: 'comment',      args: p => [p.postUrl, p.text]     },
  },
};

// ── Accounts ──────────────────────────────────────────────────────────────────
function _getAccount(platform) {
  const db   = getDb();
  const acct = db.prepare(`
    SELECT * FROM accounts
    WHERE platform=? AND status='active' AND storage_state_path IS NOT NULL
    ORDER BY last_used_at ASC NULLS FIRST LIMIT 1
  `).get(platform);
  if (!acct) return null;
  db.prepare('UPDATE accounts SET last_used_at=?, use_count=use_count+1 WHERE id=?')
    .run(new Date().toISOString(), acct.id);
  return acct;
}

function _sessionPath(accountId) {
  return require('path').join(
    require('path').dirname(require.resolve('../database/db')),
    '..', 'data', 'sessions', `${accountId}`, 'session.json'
  );
}

function _saveSession(accountId, state) {
  const p  = _sessionPath(accountId);
  const fs = require('fs');
  fs.mkdirSync(require('path').dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state));
}

// ── Referrer pool ─────────────────────────────────────────────────────────────
const _REFERRERS = {
  youtube:   ['https://l.facebook.com/', 'https://t.co/', 'https://www.google.com/', 'https://wa.me/', null],
  facebook:  ['https://www.google.com/', 'https://t.co/', null, null],
  instagram: ['https://l.facebook.com/', 'https://www.google.com/', null],
  tiktok:    ['https://www.google.com/', 'https://t.co/', null],
  default:   ['https://www.google.com/', null, null],
};

function _pickReferrer(platform) {
  const pool = _REFERRERS[platform] ?? _REFERRERS.default;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── Core utilities ────────────────────────────────────────────────────────────
const _ri    = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const _delay = ms => new Promise(r => setTimeout(r, ms));
const _coin  = p  => Math.random() < p; // true with probability p

// ── L6: Per-ghost persona variance ───────────────────────────────────────────
// Each ghost gets a "personality" that stays consistent for its lifetime.
// Avoids all ghosts having identical behavior patterns.
function _ghostPersona() {
  const types = ['casual', 'engaged', 'distracted', 'lurker'];
  const type  = types[Math.floor(Math.random() * types.length)];
  return {
    type,
    // casual:     normal watch, occasional like
    // engaged:    longer watch, more interactions
    // distracted: shorter watch, more pauses
    // lurker:     minimal interaction, variable watch
    watchMultiplier:    { casual:1.0, engaged:1.2, distracted:0.75, lurker:0.9  }[type],
    likeProb:           { casual:0.055, engaged:0.12, distracted:0.02, lurker:0.01 }[type],
    pauseProb:          { casual:0.25, engaged:0.15, distracted:0.45, lurker:0.20 }[type],
    scrubProb:          { casual:0.15, engaged:0.25, distracted:0.10, lurker:0.05 }[type],
    commentScrollProb:  { casual:0.20, engaged:0.40, distracted:0.05, lurker:0.10 }[type],
    homepageDwellMs:    { casual:_ri(2000,4000), engaged:_ri(4000,8000), distracted:_ri(800,2000), lurker:_ri(1000,3000) }[type],
  };
}

// ── Login check ───────────────────────────────────────────────────────────────
async function _checkLoggedIn(page, platform) {
  const loggedInSels = {
    youtube:   '#avatar-btn, ytd-topbar-menu-button-renderer',
    instagram: 'svg[aria-label="Home"], a[href="/direct/inbox/"]',
    tiktok:    '[data-e2e="profile-icon"], [data-testid="user-avatar"]',
    twitter:   'a[data-testid="AppTabBar_Home_Link"]',
    facebook:  '[aria-label="Your profile"], [data-testid="royal_login_button"]',
    threads:   'a[href*="/threads/"]',
  };
  const sel = loggedInSels[platform];
  if (!sel) return true;
  try {
    await page.waitForSelector(sel, { timeout: 20000 });
    return true;
  } catch {
    return false;
  }
}

// ── executeGhostView ──────────────────────────────────────────────────────────
// Ghost worker: homepage → feed scroll → target video → duration-aware watch
// → probabilistic interactions → exit. Pattern is persona-driven, not fixed.

async function executeGhostView(platform, url) {
  let session = null;
  const persona = _ghostPersona(); // L6: unique personality per ghost

  try {
    session = await launchEphemeral();
    const { page, proxyId } = session;
    const referer = _pickReferrer(platform) ?? undefined;

    // ── L1: Enter via homepage, not direct URL ────────────────────────────────
    const homepages = {
      youtube:'https://www.youtube.com/',facebook:'https://www.facebook.com/',
      instagram:'https://www.instagram.com/',tiktok:'https://www.tiktok.com/',
    };
    if (homepages[platform]) {
      await page.goto(homepages[platform], { waitUntil:'domcontentloaded', timeout:30000, referer }).catch(()=>{});
      // ── L2: Scroll feed with persona-specific dwell ───────────────────────
      await _feedScroll(page, persona);
      await _delay(persona.homepageDwellMs);
    }

    // Navigate to target
    await page.goto(url, { waitUntil:'commit', timeout:60000, referer });
    await page.waitForLoadState('domcontentloaded', { timeout:30000 }).catch(()=>{});

    // Dismiss consent
    const consent = ['button[aria-label*="Accept all"]','button:has-text("Accept all")',
      'button:has-text("Agree")','button:has-text("I agree")',
      'form[action*="consent"] button[value="1"]','[data-cookiebanner="accept_button"]'].join(',');
    await page.locator(consent).first().click({ timeout:3000 }).catch(()=>{});
    await _delay(_ri(500, 1100));

    // Trigger playback for video platforms
    if (/youtube|facebook|tiktok|instagram/.test(platform)) {
      await page.locator('video').first().waitFor({ timeout:10000 }).catch(()=>{});
      await page.evaluate(()=>{
        const v=document.querySelector('video');
        if(v){v.muted=true;v.play().catch(()=>{});}
      }).catch(()=>{});
      const player = await page.$('#movie_player, video').catch(()=>null);
      if (player) {
        const box = await player.boundingBox().catch(()=>null);
        if (box) await page.mouse.click(box.x+box.width/2, box.y+box.height/2).catch(()=>{});
      }
      await page.keyboard.press('Space').catch(()=>{});
      await _delay(2500);
      const playing = await page.evaluate(()=>{
        const v=document.querySelector('video');
        return v?(!v.paused&&v.currentTime>0):false;
      }).catch(()=>false);
      if (!playing) {
        await page.evaluate(()=>{
          const v=document.querySelector('video');
          if(v){v.muted=false;v.play().catch(()=>{});}
        }).catch(()=>{});
        await _delay(1000);
      }
    }

    // ── L3: Duration-aware watch ──────────────────────────────────────────────
    const isShorts = platform==='youtube' && /\/shorts\//i.test(url);
    const watchMs  = await _durationAwareWatch(page, platform, isShorts, persona);

    // ── L5: Probabilistic interactions ───────────────────────────────────────
    await _maybeInteract(page, platform, persona);

    log.info('View delivered', { platform, ms:watchMs, persona:persona.type, proxy:proxyId??'none' });
    return { success:true, watchMs };

  } catch (err) {
    if (/timeout|net::|ECONNREFUSED|ERR_/i.test(err.message) && session?.proxyId) {
      recordProxyFailure(session.proxyId);
    }
    log.warn('View failed', { platform, err:err.message });
    return { success:false, watchMs:0 };
  } finally {
    if (session?.browser) await session.browser.close().catch(()=>{});
  }
}

// ── Duration-aware watch ──────────────────────────────────────────────────────
// KEY INSIGHT: platforms count view based on % of video watched, not seconds.
// So we read actual video duration and watch 60-90% of it — random per persona.
// For Shorts/Reels: 1-3 loops (platform counts each loop), exit mid-loop sometimes.

async function _durationAwareWatch(page, platform, isShorts, persona) {
  // Step 0: Confirm video is ACTUALLY advancing before we start timing.
  // Platform counts from their own video.currentTime signal, not our _delay().
  const videoState = await _confirmVideoAdvancing(page);
  if (!videoState.advancing) {
    log.warn('Video not advancing — skipping watch', { platform });
    return 0;
  }

  const actualDuration = videoState.duration; // seconds, from platform DOM
  let targetMs;

  if (isShorts || _isReels(platform)) {
    // Shorts/Reels: platform counts per loop via timeupdate cycling back to 0.
    // Real behavior: watch 1-3 loops, exit at random point in last loop.
    if (actualDuration) {
      const loops     = _ri(1, 3);
      const exitPoint = 0.5 + Math.random() * 0.5; // exit 50-100% into last loop
      targetMs = Math.round(((loops - 1) + exitPoint) * actualDuration * 1000);
      targetMs = Math.max(targetMs, 3000);
      targetMs = Math.min(targetMs, 180_000);
    } else {
      targetMs = _ri(15_000, 65_000);
    }
  } else {
    // Regular video: watch 60-90% of ACTUAL duration.
    // Platform validates: timeupdate fired regularly + currentTime > threshold.
    if (actualDuration) {
      const watchPct = 0.60 + Math.random() * 0.30;
      targetMs = Math.round(actualDuration * watchPct * 1000);
      targetMs = Math.round(targetMs * persona.watchMultiplier);
      targetMs = Math.max(targetMs, 31_000);  // YT minimum counted threshold
      targetMs = Math.min(targetMs, 600_000);
    } else {
      const fallbacks = {
        youtube:  _ri(38_000, 72_000),
        facebook: _ri(20_000, 55_000),
        default:  _ri(15_000, 40_000),
      };
      targetMs = Math.round((fallbacks[platform] ?? fallbacks.default) * persona.watchMultiplier);
    }
  }

  return _executeWatch(page, platform, targetMs, persona);
}

function _isReels(platform) {
  return platform === 'instagram' || platform === 'tiktok';
}

// Confirm video is actually advancing in the platform's own player.
// Returns { advancing, duration, startTime }
async function _confirmVideoAdvancing(page) {
  try {
    const t1 = await page.evaluate(() => {
      const v = document.querySelector('video');
      if (!v) return null;
      return { t: v.currentTime, d: (isFinite(v.duration) && v.duration > 2) ? v.duration : null };
    }).catch(() => null);

    if (!t1) return { advancing: false, duration: null, startTime: 0 };

    await _delay(2000);

    const t2 = await page.evaluate(() => {
      const v = document.querySelector('video');
      return v ? v.currentTime : 0;
    }).catch(() => 0);

    if ((t2 - t1.t) > 0.5) {
      return { advancing: true, duration: t1.d, startTime: t1.t };
    }

    // Not advancing yet — try one more force-play
    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v) { v.muted = false; v.play().catch(() => {}); }
    }).catch(() => {});
    await _delay(1500);

    const t3 = await page.evaluate(() => {
      const v = document.querySelector('video');
      return v ? v.currentTime : 0;
    }).catch(() => 0);

    return {
      advancing:  (t3 - t1.t) > 0.5,
      duration:   t1.d,
      startTime:  t1.t,
    };
  } catch (_) {
    return { advancing: false, duration: null, startTime: 0 };
  }
}

// Watch executor: measures via platform's own currentTime delta, not our timer.
// These diverge when: video buffers, ghost pauses, network hiccup.
// Platform only counts time where currentTime was actually advancing.
async function _executeWatch(page, platform, totalMs, persona) {
  const vp = { width: 1366, height: 768 };

  // Capture platform-side start position
  const startCurrentTime = await page.evaluate(() =>
    document.querySelector('video')?.currentTime ?? 0
  ).catch(() => 0);

  const segments = _ri(3, 6);
  const segMs    = Math.floor(totalMs / segments);
  let   elapsed  = 0;

  // Health check state
  let lastCheckAt   = Date.now();
  let lastCtTime    = startCurrentTime;
  let stallCount    = 0;

  for (let seg = 0; seg < segments; seg++) {
    const thisSegMs = seg === segments - 1
      ? Math.max(1000, totalMs - elapsed)
      : segMs + _ri(-2000, 2000);

    await _delay(Math.max(1000, thisSegMs));
    elapsed += Math.max(1000, thisSegMs);

    // Periodic health check every ~15s: is platform currentTime still advancing?
    if (Date.now() - lastCheckAt > 15000) {
      const nowCt = await page.evaluate(() =>
        document.querySelector('video')?.currentTime ?? 0
      ).catch(() => 0);

      if (nowCt <= lastCtTime + 0.5) {
        stallCount++;
        if (stallCount >= 3) break; // give up after 3 consecutive stalls
        await page.evaluate(() => {
          const v = document.querySelector('video');
          if (v) v.play().catch(() => {});
        }).catch(() => {});
        await _delay(1500);
      } else {
        stallCount = 0;
      }
      lastCtTime  = nowCt;
      lastCheckAt = Date.now();
    }

    // Pause / resume (persona-driven)
    if (seg < segments - 1 && _coin(persona.pauseProb) && /youtube|facebook/.test(platform)) {
      await page.keyboard.press('k').catch(() => {});
      await page.keyboard.press('Space').catch(() => {});
      await _delay(_ri(1500, 6000));
      await page.keyboard.press('k').catch(() => {});
      await page.keyboard.press('Space').catch(() => {});
    }

    // Scrub backward (persona-driven)
    if (_coin(persona.scrubProb) && /youtube/.test(platform)) {
      const scrubs = _ri(1, 3);
      for (let i = 0; i < scrubs; i++) {
        await page.keyboard.press('ArrowLeft').catch(() => {});
        await _delay(180);
      }
      await _delay(_ri(3000, 7000)); // re-advance after scrub
    }

    // Idle mouse
    if (_coin(0.35)) {
      await page.mouse.move(
        _ri(100, vp.width - 100),
        _ri(100, vp.height - 100),
        { steps: _ri(8, 20) }
      ).catch(() => {});
    }

    // Peek at comments at ~60% mark
    if (seg === Math.floor(segments * 0.6) && _coin(persona.commentScrollProb)) {
      await page.evaluate(() => window.scrollBy({ top: 380, behavior: 'smooth' })).catch(() => {});
      await _delay(_ri(2000, 5000));
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' })).catch(() => {});
      await _delay(_ri(500, 1100));
    }
  }

  // Measure actual platform-side watch time from their own currentTime
  const endCurrentTime = await page.evaluate(() =>
    document.querySelector('video')?.currentTime ?? 0
  ).catch(() => 0);

  const platformWatchedSec = endCurrentTime - startCurrentTime;

  // If currentTime went backward (scrub) or looped (Shorts), fall back to elapsed
  const actualWatchMs = platformWatchedSec > 5
    ? Math.round(platformWatchedSec * 1000)
    : elapsed;

  log.debug('Watch complete', {
    platform,
    plannedMs:   totalMs,
    elapsedMs:   elapsed,
    platformSec: +platformWatchedSec.toFixed(1),
    actualWatchMs,
    stallCount,
  });

  return actualWatchMs;
}

      await page.evaluate(d=>window.scrollBy({ top:-d, behavior:'smooth' }), _ri(60, 180)).catch(()=>{});
      await _delay(_ri(400, 900));
    }
  }
}

// ── Probabilistic interactions ────────────────────────────────────────────────
// NOT all views like. NOT all views subscribe. Ratios mirror real engagement.
// Interaction happens AFTER watch, not during — real user decides after watching.

async function _maybeInteract(page, platform, persona) {
  // Like — persona-driven, ~2-12% depending on type
  if (_coin(persona.likeProb)) {
    await _tryClick(page, {
      youtube:  '#like-button button[aria-label*="like" i]:not([aria-label*="dislike" i]), ytd-like-button-renderer button',
      facebook: '[aria-label="Like"][role="button"], [data-testid*="like_button"]',
      instagram:'svg[aria-label="Like"], button[type="button"] svg[aria-label="Like"]',
      tiktok:   '[data-e2e="like-icon"], .like-button',
    }[platform]);
    await _delay(_ri(300, 800));
  }

  // Subscribe/Follow — very rare (~1% of views, mirrors real conversion rate)
  if (_coin(0.012) && /youtube/.test(platform)) {
    await _tryClick(page, '#subscribe-button button, ytd-subscribe-button-renderer button');
    await _delay(_ri(500, 1200));
  }
}

async function _tryClick(page, selector) {
  if (!selector) return;
  try {
    await page.locator(selector).first().click({ timeout:2000 });
  } catch (_) {}
}

// ── executeGhostAction ────────────────────────────────────────────────────────
// Authenticated action: load saved session → execute action → return result.

async function executeGhostAction(platform, action, params = {}) {
  const account = _getAccount(platform);
  if (!account) {
    log.warn('No account available', { platform, action });
    return { success: false, reason: 'account_required' };
  }

  let session = null;
  try {
    const sessionPath = account.storage_state_path || _sessionPath(account.id);
    session = await launchWithSession(sessionPath);
    const { page } = session;

    const loginOk = await _checkLoggedIn(page, platform);
    if (!loginOk) {
      const platformMod = { youtube, instagram, tiktok, twitter, facebook, threads }[platform];
      if (!platformMod?.login) return { success:false, reason:'login_required' };
      const loginResult = await platformMod.login(page, account);
      if (!loginResult?.success) return loginResult;
      await _saveSession(account.id, await page.context().storageState());
    }

    const platformMod = { youtube, instagram, tiktok, twitter, facebook, threads }[platform];
    const actionDef   = ACTION_MAP[platform]?.[action];
    if (!platformMod || !actionDef) {
      return { success:false, reason:'unsupported_action' };
    }

    const args   = actionDef.args(params);
    const result = await platformMod[actionDef.fn](page, ...args);

    if (result?.success) {
      await _saveSession(account.id, await page.context().storageState());
    }
    return result;

  } catch (err) {
    log.warn('Action failed', { platform, action, err: err.message });
    return { success:false, reason:'error', message:err.message };
  } finally {
    if (session?.browser) await session.browser.close().catch(()=>{});
  }
}

module.exports = { executeGhostView, executeGhostAction };
