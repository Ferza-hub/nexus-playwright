'use strict';

// Warmup — organic browsing to make a session look "lived-in" before actions.
// Called automatically after account connect and periodically while the account is active.
// Each warmup: browse feed → watch content → back. Platform sees real engagement history.

const { makeLogger } = require('../utils/logger');

const log = makeLogger('Warmup');

function _delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function _ri(a, b)  { return Math.floor(Math.random() * (b - a + 1)) + a; }

async function _scroll(page, times = 3, pauseMs = 1500) {
  for (let i = 0; i < times; i++) {
    await page.evaluate(() => window.scrollBy(0, Math.floor(Math.random() * 400) + 300));
    await _delay(_ri(pauseMs - 300, pauseMs + 500));
  }
}

// ── Per-platform warmup routines ──────────────────────────────────────────────

async function _warmYouTube(page) {
  // 1. Homepage — scroll recommendations
  await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await _delay(_ri(2000, 3000));
  await _scroll(page, _ri(3, 5), 2000);

  // 2. Click first non-ad video thumbnail
  const thumbs = await page.$$('ytd-rich-item-renderer a#thumbnail[href*="/watch"]');
  const thumb  = thumbs.find((_, i) => i > 0); // skip first (often promoted)
  if (thumb) {
    await thumb.click().catch(() => {});
    await _delay(_ri(2000, 3500));

    // Force play + watch 60-90s
    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v) { v.muted = true; v.play().catch(() => {}); }
    }).catch(() => {});
    await _delay(_ri(60_000, 90_000));

    // Scroll comments briefly
    await _scroll(page, 2, 1500);
  }

  // 3. Back to homepage briefly
  await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await _delay(_ri(1500, 2500));
}

async function _warmInstagram(page) {
  // 1. Feed scroll
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await _delay(_ri(2000, 3000));
  await _scroll(page, _ri(4, 6), 2500);

  // 2. Navigate to Reels tab and watch briefly
  await page.goto('https://www.instagram.com/reels/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await _delay(_ri(1500, 2500));
  await page.evaluate(() => {
    const v = document.querySelector('video');
    if (v) { v.muted = true; v.play().catch(() => {}); }
  }).catch(() => {});
  await _delay(_ri(30_000, 45_000));
}

async function _warmTikTok(page) {
  // FYP — watch 2 videos
  await page.goto('https://www.tiktok.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await _delay(_ri(2000, 3000));

  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v) { v.muted = true; v.play().catch(() => {}); }
    }).catch(() => {});
    await _delay(_ri(25_000, 35_000));
    // Next video — press arrow down
    await page.keyboard.press('ArrowDown').catch(() => {});
    await _delay(_ri(1500, 2500));
  }
}

async function _warmFacebook(page) {
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await _delay(_ri(2000, 3000));
  await _scroll(page, _ri(4, 6), 2000);

  // Pause on a video if found
  await page.evaluate(() => {
    const v = document.querySelector('video');
    if (v) { v.muted = true; v.play().catch(() => {}); }
  }).catch(() => {});
  await _delay(_ri(20_000, 30_000));
}

async function _warmTwitter(page) {
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await _delay(_ri(2000, 3000));
  await _scroll(page, _ri(4, 6), 1800);
  await _delay(_ri(15_000, 25_000));
}

const WARMUP_FN = {
  youtube:   _warmYouTube,
  instagram: _warmInstagram,
  tiktok:    _warmTikTok,
  facebook:  _warmFacebook,
  twitter:   _warmTwitter,
  threads:   async (page) => {
    await page.goto('https://www.threads.net/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await _delay(_ri(2000, 3000));
    await _scroll(page, _ri(4, 6), 1800);
    await _delay(_ri(15_000, 20_000));
  },
};

// ── Public API ────────────────────────────────────────────────────────────────

async function warmupAccount(platform, storagePath) {
  const fn = WARMUP_FN[platform];
  if (!fn) { log.warn('No warmup routine for platform', { platform }); return; }

  const { chromium } = require('playwright');
  const fs           = require('fs');
  const path         = require('path');
  const { launchWithSession } = require('./browser');

  let session = null;
  const started = Date.now();
  try {
    session = await launchWithSession(storagePath);
    const { page } = session;
    log.info('Warmup started', { platform });
    await fn(page);
    const ms = Date.now() - started;
    log.info('Warmup done', { platform, ms });
    return { success: true, ms };
  } catch (err) {
    log.warn('Warmup error', { platform, err: err.message });
    return { success: false, reason: err.message };
  } finally {
    if (session) await session.cleanup();
  }
}

module.exports = { warmupAccount };
