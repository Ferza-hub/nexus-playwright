'use strict';

// Simplified browser launcher — real sessions don't need fingerprint spoofing.
// Focus: load stored storageState (cookies from user's real browser), launch with
// minimal stealth flags, close when done.

const { chromium } = require('playwright');
const fs           = require('fs');
const { makeLogger } = require('../utils/logger');
const { getDb }      = require('../database/db');

const log = makeLogger('Browser');

const DESKTOP_VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1280, height: 800 },
];

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];

const TIMEZONES = [
  'America/New_York', 'America/Chicago', 'America/Los_Angeles',
  'America/Toronto',  'Europe/London',   'Europe/Berlin',
  'Asia/Tokyo',       'Asia/Singapore',  'Australia/Sydney',
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }

// ── Concurrency tracking ──────────────────────────────────────────────────────

const _active = new Set();
let   _seq    = 0;
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_BROWSERS ?? '3', 10);

function isConcurrencyFull() { return _active.size >= MAX_CONCURRENT; }

// ── Proxy helpers ─────────────────────────────────────────────────────────────

let   _proxyCache    = null;
let   _proxyCacheAt  = 0;
const _proxyFails    = new Map();

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
  if (!proxyId) return;
  const e = _proxyFails.get(proxyId) ?? { n: 0, at: 0 };
  if (Date.now() - e.at > 30 * 60_000) e.n = 0;
  e.n++; e.at = Date.now();
  _proxyFails.set(proxyId, e);
}

function _pickProxy() {
  const all  = _getProxies();
  if (!all.length) return null;
  const good = all.filter(p => {
    const e = _proxyFails.get(p.id);
    return !e || e.n < 3 || Date.now() - e.at > 30 * 60_000;
  });
  return pick(good.length ? good : all);
}

// ── Stealth init script — minimal, no complex spoofing ───────────────────────

function _stealthScript() {
  return `
(function() {
  // Remove webdriver flag
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  // Minimal chrome runtime mock
  if (!window.chrome) {
    window.chrome = { runtime: { connect: () => {}, sendMessage: () => {} } };
  }
  // Visibility — headless defaults to hidden which breaks some platforms
  try {
    Object.defineProperty(document, 'hidden',          { get: () => false });
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
    Object.defineProperty(document, 'hasFocus',        { value: () => true });
  } catch(_) {}
})();
  `;
}

// ── Core launcher ─────────────────────────────────────────────────────────────

function _launchArgs(viewport, proxy) {
  const args = [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars', '--no-first-run', '--no-default-browser-check',
    '--disable-http2',  // avoid H2 fingerprinting on datacenter IPs
    '--lang=en-US',
    `--window-size=${viewport.width},${viewport.height}`,
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

// launchWithSession — authenticated browser using stored storageState.
// This is the primary launcher for all social actions.
async function launchWithSession(storagePath) {
  if (isConcurrencyFull()) throw new Error(`Concurrency limit reached (${MAX_CONCURRENT})`);

  const slotId   = `session_${++_seq}`;
  const viewport = pick(DESKTOP_VIEWPORTS);
  const ua       = pick(USER_AGENTS);
  const timezone = pick(TIMEZONES);
  const proxy    = _pickProxy();

  const ctxOpts = {
    viewport,
    userAgent: ua,
    locale: 'en-US',
    timezoneId: timezone,
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  };

  if (storagePath) {
    try { ctxOpts.storageState = JSON.parse(fs.readFileSync(storagePath, 'utf8')); } catch (_) {}
  }

  const browser = await chromium.launch(_launchArgs(viewport, proxy));
  const context = await browser.newContext(ctxOpts);
  await context.addInitScript(_stealthScript());
  const page = await context.newPage();

  _active.add(slotId);
  log.info('Browser launched', { proxy: proxy ? `${proxy.host}:${proxy.port}` : 'direct' });

  return { browser, context, page, proxyId: proxy?.id ?? null, cleanup: _cleanup(browser, slotId) };
}

// launchEphemeral — no session, anonymous. Used for YouTube views without login.
async function launchEphemeral() {
  return launchWithSession(null);
}

module.exports = { launchEphemeral, launchWithSession, isConcurrencyFull, recordProxyFailure };
