'use strict';

const { chromium } = require('playwright');
const os           = require('os');
const fs           = require('fs');
const { makeLogger } = require('../utils/logger');
const { getDb }      = require('../database/db');

const log = makeLogger('Browser');

// ── Ghost Profiles (anonymous views — random per session) ─────────────────────
const GHOST_PROFILES = [
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',     vp: { width: 1920, height: 1080 }, tz: 'America/New_York',    locale: 'en-US', platform: 'Win32'        },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',     vp: { width: 1440, height: 900  }, tz: 'America/Chicago',    locale: 'en-US', platform: 'Win32'        },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',     vp: { width: 1366, height: 768  }, tz: 'America/Los_Angeles', locale: 'en-US', platform: 'Win32'        },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',     vp: { width: 1280, height: 720  }, tz: 'America/Toronto',    locale: 'en-CA', platform: 'Win32'        },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',     vp: { width: 1600, height: 900  }, tz: 'Europe/London',      locale: 'en-GB', platform: 'Win32'        },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', vp: { width: 1440, height: 900  }, tz: 'America/New_York',  locale: 'en-US', platform: 'MacIntel'    },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',  vp: { width: 1920, height: 1200 }, tz: 'Europe/Paris',      locale: 'fr-FR', platform: 'MacIntel'    },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 12_6_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',  vp: { width: 2560, height: 1440 }, tz: 'Europe/Berlin',     locale: 'de-DE', platform: 'MacIntel'    },
  { ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',               vp: { width: 1920, height: 1080 }, tz: 'Asia/Tokyo',         locale: 'ja-JP', platform: 'Linux x86_64' },
  { ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',               vp: { width: 1366, height: 768  }, tz: 'Asia/Singapore',     locale: 'en-SG', platform: 'Linux x86_64' },
  { ua: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',         vp: { width: 412, height: 915 }, tz: 'America/New_York',    locale: 'en-US', platform: 'Linux armv8l', isMobile: true },
  { ua: 'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',        vp: { width: 360, height: 780 }, tz: 'Europe/London',       locale: 'en-GB', platform: 'Linux armv8l', isMobile: true },
  { ua: 'Mozilla/5.0 (Linux; Android 12; M2101K6G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',        vp: { width: 393, height: 851 }, tz: 'Asia/Jakarta',        locale: 'id-ID', platform: 'Linux armv8l', isMobile: true },
  { ua: 'Mozilla/5.0 (Linux; Android 13; CPH2495) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',         vp: { width: 390, height: 844 }, tz: 'Asia/Kolkata',        locale: 'en-IN', platform: 'Linux armv8l', isMobile: true },
  { ua: 'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36',         vp: { width: 393, height: 851 }, tz: 'America/Los_Angeles', locale: 'en-US', platform: 'Linux armv8l', isMobile: true },
  { ua: 'Mozilla/5.0 (Linux; Android 12; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36',        vp: { width: 360, height: 800 }, tz: 'Europe/Warsaw',       locale: 'pl-PL', platform: 'Linux armv8l', isMobile: true },
  { ua: 'Mozilla/5.0 (Linux; Android 13; 23028RN4DG) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',      vp: { width: 393, height: 873 }, tz: 'Europe/Moscow',       locale: 'ru-RU', platform: 'Linux armv8l', isMobile: true },
  { ua: 'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',        vp: { width: 384, height: 832 }, tz: 'Asia/Seoul',          locale: 'ko-KR', platform: 'Linux armv8l', isMobile: true },
  { ua: 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',               vp: { width: 800,  height: 1280 }, tz: 'America/Sao_Paulo', locale: 'pt-BR', platform: 'Linux armv8l', isMobile: true },
  { ua: 'Mozilla/5.0 (Linux; Android 12; 22081212UG) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',             vp: { width: 1280, height: 800  }, tz: 'Asia/Dubai',        locale: 'ar-AE', platform: 'Linux armv8l', isMobile: true },
];

// ── Locked Profiles per region (authenticated sessions only) ──────────────────
// Fingerprint MUST match proxy geography — no mixing regions.
const LOCKED_PROFILES = {
  id: [
    { ua:'Mozilla/5.0 (Linux; Android 13; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36', vp:{width:360,height:780},  tz:'Asia/Jakarta',    locale:'id-ID', platform:'Linux armv8l', isMobile:true  },
    { ua:'Mozilla/5.0 (Linux; Android 12; Redmi Note 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36', vp:{width:393,height:851}, tz:'Asia/Jakarta', locale:'id-ID', platform:'Linux armv8l', isMobile:true  },
    { ua:'Mozilla/5.0 (Linux; Android 13; CPH2495) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36', vp:{width:390,height:844},  tz:'Asia/Jakarta',    locale:'id-ID', platform:'Linux armv8l', isMobile:true  },
    { ua:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', vp:{width:1366,height:768},         tz:'Asia/Jakarta',    locale:'id-ID', platform:'Win32',        isMobile:false },
  ],
  sg: [
    { ua:'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36', vp:{width:360,height:780},  tz:'Asia/Singapore',  locale:'en-SG', platform:'Linux armv8l', isMobile:true  },
    { ua:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', vp:{width:1920,height:1080},        tz:'Asia/Singapore',  locale:'en-SG', platform:'Win32',        isMobile:false },
  ],
  us: [
    { ua:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', vp:{width:1920,height:1080},        tz:'America/New_York',locale:'en-US', platform:'Win32',        isMobile:false },
    { ua:'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36', vp:{width:412,height:915},    tz:'America/New_York',locale:'en-US', platform:'Linux armv8l', isMobile:true  },
  ],
};

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ── Proxy support ─────────────────────────────────────────────────────────────
const _ROTATING_RAW = process.env.ROTATING_PROXY ?? null;

function _parseRotating() {
  if (!_ROTATING_RAW) return null;
  try {
    const u = new URL(_ROTATING_RAW);
    return { id:'rotating', host:u.hostname, port:u.port, protocol:u.protocol.replace(':',''), username:u.username||undefined, password:u.password||undefined };
  } catch { return null; }
}

const _ROTATING_PROXY = _parseRotating();

let _proxyCache = null, _proxyCacheAt = 0;
const _proxyFails = new Map();

function _getProxies() {
  if (!_proxyCache || Date.now() - _proxyCacheAt > 60_000) {
    try { _proxyCache = getDb().prepare(`SELECT * FROM proxies WHERE status='active'`).all(); _proxyCacheAt = Date.now(); }
    catch { _proxyCache = []; }
  }
  return _proxyCache;
}

function recordProxyFailure(proxyId) {
  if (!proxyId || proxyId === 'rotating') return;
  const e = _proxyFails.get(proxyId) ?? { n:0, at:0 };
  if (Date.now() - e.at > 30*60_000) e.n = 0;
  e.n++; e.at = Date.now();
  _proxyFails.set(proxyId, e);
}

function _pickProxy() {
  if (_ROTATING_PROXY) return _ROTATING_PROXY;
  const all  = _getProxies();
  if (!all.length) return null;
  const good = all.filter(p => { const e = _proxyFails.get(p.id); return !e || e.n < 3 || Date.now()-e.at > 30*60_000; });
  return pick(good.length ? good : all);
}

function _parseProxyUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return { id:'locked', host:u.hostname, port:u.port, protocol:u.protocol.replace(':',''), username:u.username||undefined, password:u.password||undefined };
  } catch { return null; }
}

// ── Identity lock ─────────────────────────────────────────────────────────────
// Uses identity_locked flag (INTEGER) as the canonical lock indicator.
// locked_proxy_url CAN be null (= use VPS direct IP) — that is a valid state.
// fp_user_agent is always set when identity_locked = 1.
// No recursion risk: flag-based check, not value-based.

function getOrLockIdentity(account) {
  const db = getDb();

  // ── Already locked — return existing identity ────────────────────────────
  if (account.identity_locked) {
    return {
      proxyUrl: account.locked_proxy_url ?? null, // null = VPS direct IP (valid)
      profile: {
        ua:       account.fp_user_agent,
        vp:       { width: account.fp_viewport_w || 390, height: account.fp_viewport_h || 844 },
        tz:       account.fp_timezone || 'Asia/Jakarta',
        locale:   account.fp_locale   || 'id-ID',
        platform: account.fp_platform || 'Linux armv8l',
        isMobile: !!account.fp_is_mobile,
      }
    };
  }

  // ── Not locked yet — assign once, never change again ─────────────────────
  const region   = account.geo_region || 'id';
  const pool     = LOCKED_PROFILES[region] ?? LOCKED_PROFILES['id'];
  const profile  = pick(pool);
  const proxyUrl = process.env.PROXY_URL || null; // null = VPS direct IP

  try {
    db.prepare(`
      UPDATE accounts SET
        identity_locked  = 1,
        locked_proxy_url = ?,
        fp_user_agent    = ?,
        fp_viewport_w    = ?,
        fp_viewport_h    = ?,
        fp_timezone      = ?,
        fp_locale        = ?,
        fp_platform      = ?,
        fp_is_mobile     = ?,
        geo_region       = ?
      WHERE id = ?
    `).run(
      proxyUrl,
      profile.ua, profile.vp.width, profile.vp.height,
      profile.tz, profile.locale, profile.platform,
      profile.isMobile ? 1 : 0,
      region,
      account.id
    );
    log.info('Identity locked', { accountId: account.id, region, tz: profile.tz, proxy: proxyUrl ?? 'direct' });
  } catch (e) {
    log.warn('Identity lock failed — run migration', { err: e.message });
  }

  // Return immediately from local data — no re-fetch, no recursion
  return {
    proxyUrl,
    profile: {
      ua:       profile.ua,
      vp:       profile.vp,
      tz:       profile.tz,
      locale:   profile.locale,
      platform: profile.platform,
      isMobile: profile.isMobile,
    }
  };
}

// ── RAM guard ─────────────────────────────────────────────────────────────────
const MIN_FREE_MB    = parseInt(process.env.MIN_FREE_RAM_MB       ?? '400', 10);
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_BROWSERS ?? '8', 10);

function _ramOk()            { return (os.freemem()/1024/1024) >= MIN_FREE_MB; }
function isConcurrencyFull() { return _active.size >= MAX_CONCURRENT || !_ramOk(); }

const _active = new Set();
let   _seq    = 0;

// ── Stealth script ────────────────────────────────────────────────────────────
function _stealthScript(profile) {
  const platform = profile.platform ?? 'Win32';
  return `(function(){
  Object.defineProperty(navigator,'webdriver',{get:()=>undefined});
  Object.defineProperty(navigator,'platform', {get:()=>'${platform}'});
  if(!window.chrome){window.chrome={runtime:{connect:()=>{},sendMessage:()=>{}}};}
  try{
    Object.defineProperty(document,'hidden',         {get:()=>false});
    Object.defineProperty(document,'visibilityState',{get:()=>'visible'});
    Object.defineProperty(document,'hasFocus',       {value:()=>true});
  }catch(_){}
})();`;
}

// ── Core launcher ─────────────────────────────────────────────────────────────
function _launchArgs(profile, proxy) {
  const args = [
    '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars','--no-first-run','--no-default-browser-check',
    '--disable-http2',
    '--autoplay-policy=no-user-gesture-required',
    '--enable-features=AutoplayIgnoreWebAudio',
    '--use-fake-ui-for-media-stream',
    `--lang=${(profile.locale??'en-US').split('-')[0]}`,
    `--window-size=${profile.vp.width},${profile.vp.height}`,
  ];
  const opts = { headless:true, args };
  if (proxy) {
    opts.proxy = {
      server:   `${proxy.protocol??'http'}://${proxy.host}:${proxy.port}`,
      username: proxy.username ?? undefined,
      password: proxy.password ?? undefined,
    };
  }
  return opts;
}

function _cleanup(browser, slotId) {
  return async () => {
    try { await Promise.race([browser.close(), new Promise(r=>setTimeout(r,8_000))]); } catch(_){}
    try { browser.process()?.kill(); } catch(_){}
    _active.delete(slotId);
  };
}

// ── launchWithSession — AUTHENTICATED ────────────────────────────────────────
// Passes account object → identity lock applied.
// Same proxy + same fingerprint every session. No rotation.
async function launchWithSession(storagePath, account = null) {
  if (isConcurrencyFull()) {
    const freeMB = Math.round(os.freemem()/1024/1024);
    throw new Error(`no_ghost_available: ${!_ramOk() ? `low RAM (${freeMB}MB)` : `concurrency limit (${MAX_CONCURRENT})`}`);
  }

  const slotId = `session_${++_seq}`;
  _active.add(slotId);

  try {
    let profile, proxy;

    if (account) {
      const identity = getOrLockIdentity(account);
      profile = identity.profile;
      proxy   = identity.proxyUrl ? _parseProxyUrl(identity.proxyUrl) : null; // null = VPS direct
    } else {
      profile = pick(GHOST_PROFILES);
      proxy   = _pickProxy();
    }

    const ctxOpts = {
      viewport:   profile.vp,
      userAgent:  profile.ua,
      locale:     profile.locale,
      timezoneId: profile.tz,
      isMobile:   profile.isMobile ?? false,
      hasTouch:   profile.isMobile ?? false,
      extraHTTPHeaders: { 'Accept-Language': `${profile.locale},en;q=0.8` },
    };

    if (storagePath) {
      try { ctxOpts.storageState = JSON.parse(fs.readFileSync(storagePath,'utf8')); } catch(_){}
    }

    const browser = await chromium.launch(_launchArgs(profile, proxy));
    const context = await browser.newContext(ctxOpts);
    await context.addInitScript(_stealthScript(profile));
    const page = await context.newPage();

    log.info('Auth session launched', {
      accountId: account?.id,
      region:    account?.geo_region ?? 'unknown',
      proxy:     proxy ? `${proxy.host}:${proxy.port}` : 'direct',
      locked:    !!account?.identity_locked,
      active:    _active.size,
    });

    return { browser, context, page, proxyId: proxy?.id ?? null, cleanup: _cleanup(browser,slotId) };
  } catch(err) {
    _active.delete(slotId);
    throw err;
  }
}

// ── launchEphemeral — ANONYMOUS ghost views ───────────────────────────────────
// Random fingerprint + rotating proxy. No session. No lock needed.
async function launchEphemeral() {
  if (isConcurrencyFull()) {
    const freeMB = Math.round(os.freemem()/1024/1024);
    throw new Error(`no_ghost_available: ${!_ramOk() ? `low RAM (${freeMB}MB)` : `concurrency limit (${MAX_CONCURRENT})`}`);
  }

  const slotId = `ephemeral_${++_seq}`;
  _active.add(slotId);

  try {
    const profile = pick(GHOST_PROFILES);
    const proxy   = _pickProxy();

    const browser = await chromium.launch(_launchArgs(profile, proxy));
    const context = await browser.newContext({
      viewport:   profile.vp,
      userAgent:  profile.ua,
      locale:     profile.locale,
      timezoneId: profile.tz,
      isMobile:   profile.isMobile ?? false,
      hasTouch:   profile.isMobile ?? false,
      extraHTTPHeaders: { 'Accept-Language': `${profile.locale},en;q=0.8` },
    });
    await context.addInitScript(_stealthScript(profile));
    const page = await context.newPage();

    return { browser, context, page, proxyId: proxy?.id ?? null, cleanup: _cleanup(browser,slotId) };
  } catch(err) {
    _active.delete(slotId);
    throw err;
  }
}

module.exports = { launchEphemeral, launchWithSession, isConcurrencyFull, recordProxyFailure };
