'use strict';
// Remote browser relay — headless Playwright + screenshot streaming + input forwarding.
// Users log into their platform accounts inside this server-side browser.
// When done, storageState is captured and warmup starts automatically.
// No extension required.

const { WebSocketServer } = require('ws');
const { chromium }        = require('playwright');
const { getDb }           = require('../database/db');
const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');

const SESSION_DIR        = process.env.SESSION_DIR ?? path.join(__dirname, '../../data/sessions');
const MAX_RELAY_SESSIONS = parseInt(process.env.MAX_RELAY_SESSIONS || '3', 10);
const SESSION_TTL_MS     = 15 * 60 * 1000; // 15 min auto-destroy
const FPS_INTERVAL_MS    = 300;            // ~3 fps — enough for login interaction

const PLATFORM_LOGIN_URLS = {
  youtube:   'https://accounts.google.com/ServiceLogin?service=youtube&hl=en',
  instagram: 'https://www.instagram.com/accounts/login/',
  tiktok:    'https://www.tiktok.com/login',
  facebook:  'https://www.facebook.com/login',
  twitter:   'https://x.com/i/flow/login',
  threads:   'https://www.threads.net/login',
};

const sessions = new Map(); // id → RelaySession

// ── RelaySession ──────────────────────────────────────────────────────────────

class RelaySession {
  constructor(id, platform) {
    this.id        = id;
    this.platform  = platform;
    this.status    = 'starting';
    this.browser   = null;
    this.context   = null;
    this.page      = null;
    this.clients   = new Set();
    this.currentUrl = '';
    this.accountId  = null;
    this._timer     = null;
    this._ttlTimer  = setTimeout(() => this.destroy(), SESSION_TTL_MS);
    this._queue     = [];   // serialized input queue
    this._draining  = false;
  }

  async start() {
    const loginUrl = PLATFORM_LOGIN_URLS[this.platform] || `https://www.${this.platform}.com`;

    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1280,800',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--lang=en-US',
      ],
    });

    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale:   'en-US',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });

    // Remove automation fingerprints that Google detects
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver',  { get: () => undefined });
      Object.defineProperty(navigator, 'languages',  { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins',    { get: () => ({ length: 3 }) });
      Object.defineProperty(navigator, 'platform',   { get: () => 'Win32' });
      window.chrome = { runtime: {} };
      // Remove cdc_ automation marker
      delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
      delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
      delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
    });

    this.page = await this.context.newPage();

    this.page.on('framenavigated', frame => {
      if (frame === this.page.mainFrame()) {
        this.currentUrl = frame.url();
        this._broadcast({ type: 'url', url: this.currentUrl });
        // Auto-focus first visible input after navigation
        setTimeout(() => this._autoFocusInput(), 1200);
      }
    });

    await this.page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    this.status = 'ready';
    this._broadcast({ type: 'status', status: 'ready' });
    this._startCapture();
    // Auto-focus first input on initial load
    setTimeout(() => this._autoFocusInput(), 1500);
  }

  async _autoFocusInput() {
    if (!this.page) return;
    try {
      await this.page.evaluate(() => {
        const el = document.querySelector('input:not([type="hidden"]):not([type="submit"]):not([type="button"])');
        if (el) { el.focus(); el.click(); }
      });
    } catch (_) {}
  }

  _startCapture() {
    this._timer = setInterval(async () => {
      if (!this.page || this.clients.size === 0) return;
      try {
        const jpeg = await this.page.screenshot({ type: 'jpeg', quality: 65, fullPage: false });
        // Binary frame: 0x01 prefix byte followed by raw JPEG
        const buf = Buffer.allocUnsafe(1 + jpeg.length);
        buf[0] = 0x01;
        jpeg.copy(buf, 1);
        for (const ws of this.clients) {
          if (ws.readyState === 1) ws.send(buf);
        }
      } catch (_) {}
    }, FPS_INTERVAL_MS);
  }

  _broadcast(obj) {
    const msg = JSON.stringify(obj);
    for (const ws of this.clients) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  attachWs(ws) {
    this.clients.add(ws);
    ws.send(JSON.stringify({ type: 'status', status: this.status }));
    if (this.currentUrl) ws.send(JSON.stringify({ type: 'url', url: this.currentUrl }));

    ws.on('message', (data) => {
      try {
        if (data instanceof Buffer && data[0] === 0x01) return; // binary frame, skip
        const msg = JSON.parse(data.toString());
        // Skip high-frequency mousemove to avoid queue buildup
        if (msg.type === 'mousemove') {
          this._handleInput(msg).catch(() => {});
          return;
        }
        this._queue.push(msg);
        this._drainQueue();
      } catch (_) {}
    });

    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));
  }

  async _drainQueue() {
    if (this._draining) return;
    this._draining = true;
    while (this._queue.length > 0) {
      const msg = this._queue.shift();
      await this._handleInput(msg).catch(() => {});
    }
    this._draining = false;
  }

  async _handleInput(msg) {
    if (!this.page) return;
    try {
      switch (msg.type) {
        case 'click': {
          await this.page.mouse.click(msg.x, msg.y);
          // Wait for page JS to process click, then force-focus the element
          await new Promise(r => setTimeout(r, 300));
          await this.page.evaluate(({x, y}) => {
            const el = document.elementFromPoint(x, y);
            if (!el) return;
            const target = el.closest('input, textarea, [contenteditable]') || el;
            if (target !== document.activeElement && target.focus) target.focus();
          }, { x: msg.x, y: msg.y }).catch(() => {});
          break;
        }
        case 'dblclick':
          await this.page.mouse.dblclick(msg.x, msg.y);
          break;
        case 'mousemove':
          await this.page.mouse.move(msg.x, msg.y);
          break;
        case 'scroll':
          await this.page.mouse.wheel(0, msg.dy);
          break;
        case 'keydown':
          await this.page.keyboard.press(msg.key);
          break;
        case 'type':
          await this.page.keyboard.type(msg.text, { delay: 30 });
          break;
        case 'navigate':
          if (msg.url) {
            await this.page.goto(msg.url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
          }
          break;
      }
    } catch (_) {}
  }

  async captureSession(label) {
    if (this.status !== 'ready') throw new Error('Session not ready');

    const state = await this.context.storageState();
    if (!state.cookies.length && !state.origins.some(o => o.localStorage?.length)) {
      throw new Error('No session found — please log in first');
    }

    const db   = getDb();
    const nick = label?.trim() || `${this.platform} #${Date.now().toString(36)}`;

    const r = db.prepare(
      `INSERT INTO accounts (platform, label, email, password, warmup_status) VALUES (?,?,?,'','cold')`
    ).run(this.platform, nick, '');
    const id = Number(r.lastInsertRowid);

    const dir      = path.join(SESSION_DIR, String(id));
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'session.json');
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2));

    db.prepare(`UPDATE accounts SET storage_state_path=?, status='active' WHERE id=?`).run(filePath, id);

    this.accountId = id;
    this.status    = 'captured';
    this._broadcast({ type: 'status', status: 'captured', accountId: id });

    const { platform } = this;
    setImmediate(async () => {
      db.prepare(`UPDATE accounts SET warmup_status='warming' WHERE id=?`).run(id);
      const { warmupAccount } = require('../playwright-engine/warmup');
      const result = await warmupAccount(platform, filePath);
      const ws = result.success ? 'warm' : 'cold';
      db.prepare(`UPDATE accounts SET warmup_status=?, last_warmup_at=? WHERE id=?`)
        .run(ws, ws === 'warm' ? new Date().toISOString() : null, id);
    });

    return { id, label: nick, cookies: state.cookies.length };
  }

  async destroy() {
    clearTimeout(this._ttlTimer);
    clearInterval(this._timer);
    this._broadcast({ type: 'closed' });
    for (const ws of this.clients) ws.close();
    this.clients.clear();
    sessions.delete(this.id);
    if (this.browser) await this.browser.close().catch(() => {});
    this.status = 'closed';
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

function attachRelay(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws/relay' });
  wss.on('connection', (ws, req) => {
    const id = new URL(req.url, 'http://x').searchParams.get('s');
    const s  = sessions.get(id);
    if (!s) { ws.close(4004, 'Session not found'); return; }
    s.attachWs(ws);
  });
}

async function startRelaySession(platform) {
  if (sessions.size >= MAX_RELAY_SESSIONS) {
    throw new Error(`Server busy — max ${MAX_RELAY_SESSIONS} browser sessions active`);
  }
  const id = crypto.randomUUID();
  const s  = new RelaySession(id, platform);
  sessions.set(id, s);
  s.start().catch(err => {
    s.status = 'error';
    s._broadcast({ type: 'error', message: err.message });
    sessions.delete(id);
  });
  return id;
}

function getRelaySession(id) { return sessions.get(id); }

module.exports = { attachRelay, startRelaySession, getRelaySession };
