'use strict';

const path = require('path');
const fs   = require('fs');
const { makeLogger }      = require('../utils/logger');
const { launchEphemeral, launchWithSession, isConcurrencyFull, recordProxyFailure } = require('./browser');
const { getDb }           = require('../database/db');

const instagram = require('./platforms/instagram');
const tiktok    = require('./platforms/tiktok');
const twitter   = require('./platforms/twitter');
const youtube   = require('./platforms/youtube');
const threads   = require('./platforms/threads');
const facebook  = require('./platforms/facebook');

const log = makeLogger('PlaywrightEngine');

const PLATFORMS = { instagram, tiktok, twitter, youtube, threads, facebook };

// ----------------------------------------------------------------
// Action map — used by executeGhostAction to resolve fn + args
// ----------------------------------------------------------------

const ACTION_MAP = {
  instagram: {
    watch_reel:  { fn: 'watchReel',    args: p => [p.reelUrl]             },
    like_post:   { fn: 'likePost',     args: p => [p.postUrl]             },
    follow:      { fn: 'followUser',   args: p => [p.username]            },
    unfollow:    { fn: 'unfollowUser', args: p => [p.username]            },
    comment:     { fn: 'commentPost',  args: p => [p.postUrl, p.text]     },
  },
  tiktok: {
    watch_video: { fn: 'watchVideo',   args: p => [p.videoUrl]            },
    like_video:  { fn: 'likeVideo',    args: p => [p.videoUrl]            },
    follow:      { fn: 'followUser',   args: p => [p.username]            },
    comment:     { fn: 'commentVideo', args: p => [p.videoUrl, p.text]    },
  },
  twitter: {
    like_post:   { fn: 'likePost',     args: p => [p.tweetUrl]            },
    follow:      { fn: 'followUser',   args: p => [p.username]            },
  },
  youtube: {
    watch_video: { fn: 'watchVideo',   args: p => [youtube.cleanUrl(p.videoUrl), p] },
    like_video:  { fn: 'likeVideo',    args: p => [p.videoUrl]            },
    subscribe:   { fn: 'subscribeChannel', args: p => [p.channelUrl]      },
    comment:     { fn: 'commentVideo', args: p => [p.videoUrl, p.text]    },
  },
  threads: {
    like_post:   { fn: 'likePost',     args: p => [p.postUrl]             },
    follow:      { fn: 'followUser',   args: p => [p.username]            },
  },
  facebook: {
    watch_video: { fn: 'watchVideo',   args: p => [p.videoUrl]            },
    watch_reel:  { fn: 'watchReel',    args: p => [p]                     },
    like_post:   { fn: 'likePost',     args: p => [p.postUrl]             },
    follow_page: { fn: 'followPage',   args: p => [p.profileUrl]          },
    comment:     { fn: 'comment',      args: p => [p.postUrl, p.text]     },
  },
};

// ----------------------------------------------------------------
// Key account helpers — round-robin from accounts table
// ----------------------------------------------------------------

const SESSION_DIR = process.env.SESSION_DIR ?? path.join(__dirname, '../../data/sessions');

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
  const dir = path.join(SESSION_DIR, String(accountId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'session.json');
}

function _saveSession(accountId, state) {
  const filePath = _sessionPath(accountId);
  fs.writeFileSync(filePath, JSON.stringify(state));
  getDb().prepare('UPDATE accounts SET storage_state_path=? WHERE id=?').run(filePath, accountId);
}

// ----------------------------------------------------------------
// ----------------------------------------------------------------
// Social referrer pool — weighted per platform to match real
// traffic distribution. Set as Referer header on first navigation;
// zero extra page loads, platform sees organic share traffic.
//
// Weights reflect: WhatsApp/Telegram (mobile share) dominate for
// short-form content; Google leads for YouTube; FB wrapper for FB.
// ----------------------------------------------------------------

const _REFERRERS = {
  youtube: [
    { url: 'https://www.google.com/',     w: 30 },
    { url: null,                           w: 20 }, // direct
    { url: 'https://web.whatsapp.com/',   w: 20 },
    { url: 'https://www.facebook.com/',   w: 15 },
    { url: 'https://web.telegram.org/',   w: 10 },
    { url: 'https://x.com/',              w:  5 },
  ],
  facebook: [
    { url: 'https://web.whatsapp.com/',   w: 30 },
    { url: 'https://l.facebook.com/',     w: 25 },
    { url: null,                           w: 20 },
    { url: 'https://web.telegram.org/',   w: 15 },
    { url: 'https://www.google.com/',     w: 10 },
  ],
  instagram: [
    { url: 'https://web.whatsapp.com/',   w: 35 },
    { url: null,                           w: 25 },
    { url: 'https://web.telegram.org/',   w: 20 },
    { url: 'https://l.facebook.com/',     w: 15 },
    { url: 'https://www.google.com/',     w:  5 },
  ],
  tiktok: [
    { url: 'https://web.whatsapp.com/',   w: 30 },
    { url: null,                           w: 30 },
    { url: 'https://web.telegram.org/',   w: 20 },
    { url: 'https://www.facebook.com/',   w: 10 },
    { url: 'https://x.com/',              w: 10 },
  ],
  twitter: [
    { url: 'https://x.com/',              w: 30 },
    { url: null,                           w: 25 },
    { url: 'https://web.whatsapp.com/',   w: 20 },
    { url: 'https://www.google.com/',     w: 15 },
    { url: 'https://web.telegram.org/',   w: 10 },
  ],
  threads: [
    { url: 'https://web.whatsapp.com/',   w: 30 },
    { url: null,                           w: 25 },
    { url: 'https://l.facebook.com/',     w: 25 },
    { url: 'https://web.telegram.org/',   w: 20 },
  ],
};

function _pickReferrer(platform) {
  const pool  = _REFERRERS[platform] ?? [{ url: null, w: 1 }];
  const total = pool.reduce((s, e) => s + e.w, 0);
  let r = Math.random() * total;
  for (const entry of pool) { r -= entry.w; if (r <= 0) return entry.url; }
  return null;
}

function _ri(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function _delay(ms)    { return new Promise(r => setTimeout(r, ms)); }

// ----------------------------------------------------------------
// _checkLoggedIn — navigate to platform and verify session
// ----------------------------------------------------------------

async function _checkLoggedIn(page, platform) {
  try {
    if (platform === 'instagram') {
      await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 15_000 });
      return !page.url().includes('/accounts/login') && !page.url().includes('/challenge');
    }
    if (platform === 'tiktok') {
      await page.goto('https://www.tiktok.com/', { waitUntil: 'domcontentloaded', timeout: 15_000 });
      return !(await page.$('a[href*="/login"]'));
    }
    if (platform === 'twitter') {
      await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 15_000 });
      return !page.url().includes('/flow/login') && !page.url().includes('/login');
    }
    if (platform === 'youtube') {
      await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 15_000 });
      return !!(await page.$('button#avatar-btn, #avatar-container'));
    }
    if (platform === 'threads') {
      await page.goto('https://www.threads.net/', { waitUntil: 'domcontentloaded', timeout: 15_000 });
      return !page.url().includes('/login');
    }
    if (platform === 'facebook') {
      await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15_000 });
      return !page.url().includes('/login') && !page.url().includes('login.php');
    }
    return true;
  } catch (_) { return false; }
}

// ----------------------------------------------------------------
// executeGhostView — ephemeral browser, quick platform entry, then
// watch 15-60 seconds (countable by the platform).
// No persistent identity. Ghost is born and dies for this one task.
// ----------------------------------------------------------------

// ── executeGhostView ──────────────────────────────────────────────────────────
// One worker: pick proxy → launch browser (random profile) → navigate with
// social referrer → watch → done. Proxy handles IP; profile handles identity.

async function executeGhostView(platform, url) {
  let session = null;
  try {
    session = await launchEphemeral();
    const { page, proxyId } = session;

    // Social referrer — makes platform see organic share traffic, not direct
    const referer = _pickReferrer(platform) ?? undefined;

    // Navigate with referrer baked into the HTTP request
    await page.goto(url, { waitUntil: 'commit', timeout: 60000, referer });
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});

    // Dismiss consent / cookie banners (Google, GDPR, platform-specific)
    const consentSels = [
      'button[aria-label*="Accept all"]',
      'button:has-text("Accept all")',
      'button:has-text("Agree")',
      'button:has-text("I agree")',
      'form[action*="consent"] button[value="1"]',
      '[data-cookiebanner="accept_button"]',
    ].join(',');
    await page.locator(consentSels).first().click({ timeout: 3000 }).catch(() => {});
    await _delay(_ri(800, 1500));

    // Trigger playback for video platforms
    if (/youtube|facebook|tiktok|instagram/.test(platform)) {
      await page.locator('video').first().waitFor({ timeout: 8000 }).catch(() => {});
      // click centre of player or press Space
      const player = await page.$('#movie_player, video').catch(() => null);
      if (player) {
        const box = await player.boundingBox().catch(() => null);
        if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
      }
      await page.keyboard.press('Space').catch(() => {});
    }

    // Watch — minimum threshold that platforms count
    const isShorts = platform === 'youtube' && /\/shorts\//i.test(url);
    const watchMs  = platform === 'youtube'
      ? (isShorts ? _ri(5_000, 15_000) : _ri(35_000, 65_000))  // regular: 35-65s
      : _ri(15_000, 35_000);

    await _delay(watchMs);

    log.info('View delivered', { platform, ms: watchMs, referer: referer ?? 'direct', proxy: proxyId ?? 'none' });
    return { success: true };

  } catch (err) {
    if (/timeout|net::|ECONNREFUSED|ERR_/i.test(err.message) && session?.proxyId) {
      recordProxyFailure(session.proxyId);
    }
    log.warn('View failed', { platform, err: err.message });
    return { success: false, reason: err.message };
  } finally {
    if (session) await session.cleanup();
  }
}

// ----------------------------------------------------------------
// executeGhostAction — load key account session, spawn ephemeral
// browser with that session, execute action, close.
// Auth cookies are re-saved only when a re-login happens.
// ----------------------------------------------------------------

async function executeGhostAction(platform, action, params = {}) {
  const platformModule = PLATFORMS[platform];
  if (!platformModule) return { success: false, reason: `unknown_platform:${platform}` };

  const actionDef = ACTION_MAP[platform]?.[action];
  if (!actionDef) return { success: false, reason: `unknown_action:${action}` };

  const account = _getAccount(platform);
  if (!account) return { success: false, reason: 'no_key_account' };

  let session = null;
  try {
    session = await launchWithSession(account.storage_state_path);
    const { page, context } = session;

    const loggedIn = await _checkLoggedIn(page, platform);
    if (!loggedIn) {
      log.info('Key account session expired — re-logging in', { accountId: account.id, platform });
      const creds = { email: account.email, password: account.password, username: account.email };
      const loginR = await platformModule.login(page, creds);
      if (!loginR.success) {
        getDb().prepare("UPDATE accounts SET status='expired' WHERE id=?").run(account.id);
        return { success: false, reason: `relogin_failed:${loginR.event}` };
      }
      // Persist fresh session so next launch doesn't need to re-login
      const state = await context.storageState();
      _saveSession(account.id, state);
    }

    const fn     = platformModule[actionDef.fn];
    const args   = actionDef.args(params);
    const result = await fn(page, ...args);

    if (!result.success && result.event) {
      log.warn('Ghost action detection', { accountId: account.id, platform, action, event: result.event });
      if (['disabled', 'challenge'].includes(result.event)) {
        getDb().prepare("UPDATE accounts SET status='expired' WHERE id=?").run(account.id);
      }
      return result;
    }

    log.info('Ghost action done', { platform, action });
    return result;

  } catch (err) {
    log.error('Ghost action error', { accountId: account.id, platform, action, err: err.message });
    return { success: false, error: err.message };
  } finally {
    if (session) await session.cleanup(); // browser closes; no state saved
  }
}

module.exports = { executeGhostView, executeGhostAction };
