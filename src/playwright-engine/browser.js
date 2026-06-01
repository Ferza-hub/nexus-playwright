'use strict';

const { chromium } = require('playwright');
const os           = require('os');
const fs           = require('fs');
const { makeLogger } = require('../utils/logger');
const { getDb }      = require('../database/db');

const log = makeLogger('Browser');

// ── 20 Ghost Profiles ─────────────────────────────────────────────────────────

const GHOST_PROFILES = [
  // Desktop — Windows Chrome
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',     vp: { width: 1920, height: 1080 }, tz: 'America/New_York',    locale: 'en-US', platform: 'Win32'        },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',     vp: { width: 1440, height: 900  }, tz: 'America/Chicago',    locale: 'en-US', platform: 'Win32'        },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',     vp: { width: 1366, height: 768  }, tz: 'America/Los_Angeles', locale: 'en-US', platform: 'Win32'        },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',     vp: { width: 1280, height: 720  }, tz: 'America/Toronto',    locale: 'en-CA', platform: 'Win32'        },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',     vp: { width: 1600, height: 900  }, tz: 'Europe/London',      locale: 'en-GB', platform: 'Win32'        },
  // Desktop — Mac Chrome
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', vp: { width: 1440, height: 900  }, tz: 'America/New_York',  locale: 'en-US', platform: 'MacIntel'    },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',  vp: { width: 1920, height: 1200 }, tz: 'Europe/Paris',      locale: 'fr-FR', platform: 'MacIntel'    },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 12_6_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',  vp: { width: 2560, height: 1440 }, tz: 'Europe/Berlin',     locale: 'de-DE', platform: 'MacIntel'    },
  // Desktop — Linux Chrome
  { ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',               vp: { width: 1920, height: 1080 }, tz: 'Asia/Tokyo',         locale: 'ja-JP', platform: 'Linux x86_64' },
  { ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',               vp: { width: 1366, height: 768  }, tz: 'Asia/Singapore',     locale: 'en-SG', platform: 'Linux x86_64' },
  // Mobile — Android Chrome
  { ua: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',         vp: { width: 412, height: 915 }, tz: 'America/New_York',    locale: 'en-US', platform: 'Linux armv8l', isMobile: true },
  { ua: 'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',        vp: { width: 360, height: 780 }, tz: 'Europe/London',       locale: 'en-GB', platform: 'Linux armv8l', isMobile: true },
  { ua: 'Mozilla/5.0 (Linux; Android 12; M2101K6G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',        vp: { width: 393, height: 851 }, tz: 'Asia/Jakarta',        locale: 'id-ID', platform: 'Linux armv8l', isMobile: true },
  { ua: 'Mozilla/5.0 (Linux; Android 13; CPH2495) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',         vp: { width: 390, height: 844 }, tz: 'Asia/Kolkata',        locale: 'en-IN', platform: 'Linux armv8l', isMobile: true },
  { ua: 'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36',         vp: { width: 393, height: 851 }, tz: 'America/Los_Angeles', locale: 'en-US', platform: 'Linux armv8l', isMobile: true },
  { ua: 'Mozilla/5.0 (Linux; Android 12; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36',        vp: { width: 360, height: 800 }, tz: 'Europe/Warsaw',       locale: 'pl-PL', platform: 'Linux armv8l', isMobile: true },
  { ua: 'Mozilla/5.0 (Linux; Android 13; 23028RN4DG) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',      vp: { width: 393, height: 873 }, tz: 'Europe/Moscow',       locale: 'ru-RU', platform: 'Linux armv8l', isMobile: true },
  { ua: 'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',        vp: { width: 384, height: 832 }, tz: 'Asia/Seoul',          locale: 'ko-KR', platform: 'Linux armv8l', isMobile: true },
  // Tablet
  { ua: 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',               vp: { width: 800,  height: 1280 }, tz: 'America/Sao_Paulo', locale: 'pt-BR', platform: 'Linux armv8l', isMobile: true },
  { ua: 'Mozilla/5.0 (Linux; Android 12; 22081212UG) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',             vp: { width: 1280, height: 800  }, tz: 'Asia/Dubai',        locale: 'ar-AE', platform: 'Linux armv8l', isMobile: true },
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ── Rotating proxy support ────────────────────────────────────────────────────
// Set ROTATING_PROXY=http://user:pass@host:port in .env.
// When set, every worker uses this one endpoint — the provider rotates the IP
// per connection, so no pool management or failure tracking needed.
// Falls back to DB proxy pool if not set.

const _ROTATING_RAW = process.env.ROTATING_PROXY ?? null;

function _parseRotating() {
  if (!_ROTATING_RAW) return null;
  try {
    const u = new URL(_ROTATING_RAW);
    return {
      id:       'rotating',
      host:     u.hostname,
      port:     u.port,
      protocol: u.protocol.replace(':', ''),
      username: u.username || undefined,
      password: u.password || undefined,
    };
  } catch { return null; }
}

const _ROTATING_PROXY = _parseRotating();

// ── DB proxy pool (fallback when no rotating proxy) ───────────────────────────

let   _proxyCache   = null;
let   _proxyCacheAt = 0;
const _proxyFails   = new Map();

function _getProxies() {
  if (!_proxyCache || Date.now() - _proxyCacheAt > 60_000) {
    try {
      _proxyCache   = getDb().prepare(`SELECT * FROM proxies WHERE status='active'`).all();
      _proxyCacheAt = Date.now();
    } catch { _proxyCache = []; }
  }
  return _proxyCache;
}

function recordProxyFailure(proxyId) {
  // Rotating proxy self-heals on next connection — nothing to track
  if (!proxyId || proxyId === 'rotating') return;
  const e = _proxyFails.get(proxyId) ?? { n: 0, at: 0 };
  if (Date.now() - e.at > 30 * 60_000) e.n = 0;
  e.n++; e.at = Date.now();
  _proxyFails.set(proxyId, e);
}

function _pickProxy() {
  if (_ROTATING_PROXY) return _ROTATING_PROXY;
  const all  = _getProxies();
  if (!all.length) return null;
  const good = all.filter(p => {
    const e = _proxyFails.get(p.id);
    return !e || e.n < 3 || Date.now() - e.at > 30 * 60_000;
  });
  return pick(good.length ? good : all);
}

// ── RAM guard ─────────────────────────────────────────────────────────────────
// Refuse launch if free RAM < MIN_FREE_RAM_MB (default 300MB).
// Rotating proxy + 10 workers: ~2-2.5GB for browsers, leaves ~1.5GB headroom.

const MIN_FREE_MB    = parseInt(process.env.MIN_FREE_RAM_MB      ?? '300', 10);
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_BROWSERS ?? '10', 10);

function _ramOk()          { return (os.freemem() / 1024 / 1024) >= MIN_FREE_MB; }
function isConcurrencyFull() { return _active.size >= MAX_CONCURRENT || !_ramOk(); }

// ── Concurrency tracking ──────────────────────────────────────────────────────
// IMPORTANT: slot is reserved *before* the async chromium.launch() call so
// concurrent workers can't all pass the size check before any slot is taken.

const _active = new Set();
let   _seq    = 0;

// ── Stealth init script ───────────────────────────────────────────────────────

function _stealthScript(profile) {
  const platform = profile.platform ?? 'Win32';
  return `(function() {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'platform',  { get: () => '${platform}' });
  if (!window.chrome) {
    window.chrome = { runtime: { connect: () => {}, sendMessage: () => {} } };
  }
  try {
    Object.defineProperty(document, 'hidden',          { get: () => false });
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
    Object.defineProperty(document, 'hasFocus',        { value: () => true });
  } catch(_) {}
})();`;
}

// ── Core launcher ─────────────────────────────────────────────────────────────

function _launchArgs(profile, proxy) {
  const args = [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars', '--no-first-run', '--no-default-browser-check',
    '--disable-http2',
    `--lang=${(profile.locale ?? 'en-US').split('-')[0]}`,
    `--window-size=${profile.vp.width},${profile.vp.height}`,
  ];
  const opts = { headless: true, args };
  if (proxy) {
    opts.proxy = {
      server:   `${proxy.protocol ?? 'http'}://${proxy.host}:${proxy.port}`,
      username: proxy.username ?? undefined,
      password: proxy.password ?? undefined,
    };
  }
  return opts;
}

function _cleanup(browser, slotId) {
  return async () => {
    try { await Promise.race([browser.close(), new Promise(r => setTimeout(r, 8_000))]); } catch (_) {}
    try { browser.process()?.kill(); } catch (_) {}
    _active.delete(slotId);
  };
}

async function launchWithSession(storagePath) {
  if (isConcurrencyFull()) {
    const freeMB = Math.round(os.freemem() / 1024 / 1024);
    const reason = !_ramOk()
      ? `low RAM (${freeMB}MB free, need ${MIN_FREE_MB}MB)`
      : `concurrency limit (${MAX_CONCURRENT} active)`;
    throw new Error(`no_ghost_available: ${reason}`);
  }

  // Reserve slot immediately — before any await — so concurrent callers
  // see the updated count and don't over-launch.
  const slotId  = `session_${++_seq}`;
  _active.add(slotId);

  try {
    const profile = pick(GHOST_PROFILES);
    const proxy   = _pickProxy();

    const ctxOpts = {
      viewport:    profile.vp,
      userAgent:   profile.ua,
      locale:      profile.locale,
      timezoneId:  profile.tz,
      isMobile:    profile.isMobile ?? false,
      hasTouch:    profile.isMobile ?? false,
      extraHTTPHeaders: { 'Accept-Language': `${profile.locale},en;q=0.8` },
    };

    if (storagePath) {
      try { ctxOpts.storageState = JSON.parse(fs.readFileSync(storagePath, 'utf8')); } catch (_) {}
    }

    const browser = await chromium.launch(_launchArgs(profile, proxy));
    const context = await browser.newContext(ctxOpts);
    await context.addInitScript(_stealthScript(profile));
    const page = await context.newPage();

    log.info('Browser launched', {
      profile: `${profile.locale}/${profile.tz}`,
      mobile:  profile.isMobile ?? false,
      proxy:   proxy ? `${proxy.host}:${proxy.port}` : 'none',
      active:  _active.size,
      freeMB:  Math.round(os.freemem() / 1024 / 1024),
    });

    return { browser, context, page, proxyId: proxy?.id ?? null, cleanup: _cleanup(browser, slotId) };
  } catch (err) {
    // Release reserved slot if launch fails
    _active.delete(slotId);
    throw err;
  }
}

// launchEphemeral — anonymous, no session. Used for all proxy view workers.
async function launchEphemeral() {
  return launchWithSession(null);
}

module.exports = { launchEphemeral, launchWithSession, isConcurrencyFull, recordProxyFailure };
