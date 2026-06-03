'use strict';

const fs     = require('fs');
const path   = require('path');
const { Router } = require('express');
const { getDb }  = require('../../database/db');
const { warmupAccount } = require('../../playwright-engine/warmup');

const SESSION_DIR = process.env.SESSION_DIR ?? path.join(__dirname, '../../../data/sessions');

const router = Router();

const VALID_PLATFORMS = ['youtube', 'instagram', 'tiktok', 'facebook', 'twitter', 'threads'];

// Domains that are relevant per platform — cookies outside these are discarded
const PLATFORM_DOMAINS = {
  youtube:   ['youtube.com', 'google.com', 'google.co'],
  instagram: ['instagram.com', 'facebook.com', 'fbcdn.net'],
  tiktok:    ['tiktok.com', 'musical.ly'],
  facebook:  ['facebook.com', 'fbcdn.net', 'fb.com'],
  twitter:   ['twitter.com', 'x.com', 'twimg.com'],
  threads:   ['threads.net', 'instagram.com', 'facebook.com'],
};

function _domainMatches(cookieDomain, platform) {
  const allowed = PLATFORM_DOMAINS[platform] || [];
  const d = cookieDomain.replace(/^\./, '').toLowerCase();
  return allowed.some(a => d === a || d.endsWith('.' + a) || d.endsWith(a));
}

// ── Session helpers ───────────────────────────────────────────────────────────

const SAME_SITE_MAP = {
  no_restriction: 'None', unspecified: 'None', lax: 'Lax', strict: 'Strict', none: 'None',
};

function cookiesToStorageState(raw, platform) {
  let list;
  try { list = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { throw new Error('Invalid JSON'); }
  if (!Array.isArray(list)) throw new Error('Cookies must be a JSON array');
  const cookies = list
    .map(c => ({
      name:     String(c.name   || ''),
      value:    String(c.value  || ''),
      domain:   String(c.domain || ''),
      path:     String(c.path   || '/'),
      expires:  c.expirationDate ?? c.expires ?? -1,
      httpOnly: Boolean(c.httpOnly),
      secure:   Boolean(c.secure),
      sameSite: SAME_SITE_MAP[(c.sameSite || '').toLowerCase()] ?? 'None',
    }))
    .filter(c => c.name && c.domain && (!platform || _domainMatches(c.domain, platform)));
  if (!cookies.length) throw new Error('No relevant cookies found — make sure you exported from the right site');
  return { cookies, origins: [] };
}

function saveStorageState(accountId, state) {
  const dir  = path.join(SESSION_DIR, String(accountId));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.json');
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
  return file;
}

function _setWarmupStatus(id, status) {
  getDb().prepare(
    `UPDATE accounts SET warmup_status=?, last_warmup_at=? WHERE id=?`
  ).run(status, status === 'warm' ? new Date().toISOString() : null, id);
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/accounts
router.get('/', (req, res) => {
  try {
    const { platform } = req.query;
    const db = getDb();
    const rows = platform
      ? db.prepare(`SELECT id, platform, label, status, use_count, warmup_status, last_warmup_at,
                           storage_state_path, created_at, last_used_at
                    FROM accounts WHERE platform=? ORDER BY created_at DESC`).all(platform)
      : db.prepare(`SELECT id, platform, label, status, use_count, warmup_status, last_warmup_at,
                           storage_state_path, created_at, last_used_at
                    FROM accounts ORDER BY platform, created_at DESC`).all();
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/accounts/connect ────────────────────────────────────────────────
// Connect an account by logging in with credentials — Playwright handles login
// headlessly, captures storageState, then auto-warms the session.
// Body: { platform, email, password, label? }
router.post('/connect', async (req, res) => {
  const { platform, email, password, label } = req.body;
  if (!platform || !email || !password) {
    return res.status(400).json({ error: 'platform, email, and password required' });
  }
  if (!VALID_PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: `platform must be one of: ${VALID_PLATFORMS.join(', ')}` });
  }

  const db   = getDb();
  const nick = label?.trim() || `${platform} — ${email.split('@')[0]}`;

  // Create DB row first to get the ID for session path
  const row = db.prepare(
    `INSERT INTO accounts (platform, label, email, password, warmup_status) VALUES (?,?,?,?,'cold')`
  ).run(platform, nick, email, '');   // password not stored — used once then discarded
  const id = Number(row.lastInsertRowid);

  // Respond immediately so UI doesn't hang — login + warmup run in background
  res.status(202).json({ id, label: nick, status: 'connecting' });

  // Background: login → capture session → warmup
  setImmediate(async () => {
    try {
      const { chromium } = require('playwright');
      const platformMod  = require(`../../playwright-engine/platforms/${platform}`);

      const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
      const context = await browser.newContext({ locale: 'en-US' });
      const page    = await context.newPage();

      const loginResult = await platformMod.login(page, { email, password, username: email });

      if (!loginResult.success) {
        await browser.close();
        db.prepare(`UPDATE accounts SET status='expired' WHERE id=?`).run(id);
        return;
      }

      const state    = await context.storageState();
      const filePath = saveStorageState(id, state);
      await browser.close();

      db.prepare(
        `UPDATE accounts SET storage_state_path=?, status='active', warmup_status='warming' WHERE id=?`
      ).run(filePath, id);

      // Warmup with the fresh session
      const result = await warmupAccount(platform, filePath);
      _setWarmupStatus(id, result.success ? 'warm' : 'cold');

    } catch (err) {
      db.prepare(`UPDATE accounts SET status='expired' WHERE id=?`).run(id);
    }
  });
});

// ── POST /api/accounts/import ────────────────────────────────────────────────
// Add account via cookie paste (Cookie Editor extension export).
// Body: { platform, label, cookies_json }
router.post('/import', (req, res) => {
  try {
    const { platform, label, cookies_json } = req.body;
    if (!platform || !cookies_json) {
      return res.status(400).json({ error: 'platform and cookies_json required' });
    }
    if (!VALID_PLATFORMS.includes(platform)) {
      return res.status(400).json({ error: `platform must be one of: ${VALID_PLATFORMS.join(', ')}` });
    }

    const state = cookiesToStorageState(cookies_json, platform);
    const db    = getDb();
    const nick  = label?.trim() || `${platform} #${Date.now().toString(36)}`;
    const r     = db.prepare(
      `INSERT INTO accounts (platform, label, email, password, warmup_status) VALUES (?,?,?,'','cold')`
    ).run(platform, nick, '');
    const id = Number(r.lastInsertRowid);

    const filePath = saveStorageState(id, state);
    db.prepare('UPDATE accounts SET storage_state_path=?, status=\'active\' WHERE id=?').run(filePath, id);

    // Auto-warmup in background
    setImmediate(async () => {
      db.prepare(`UPDATE accounts SET warmup_status='warming' WHERE id=?`).run(id);
      const result = await warmupAccount(platform, filePath);
      _setWarmupStatus(id, result.success ? 'warm' : 'cold');
    });

    res.status(201).json({ id, label: nick, cookies: state.cookies.length, warmup: 'started' });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── POST /api/accounts/:id/warmup ────────────────────────────────────────────
// Manually trigger warmup (re-warm a cold or stale session).
router.post('/:id/warmup', async (req, res) => {
  const db   = getDb();
  const acct = db.prepare('SELECT * FROM accounts WHERE id=?').get(req.params.id);
  if (!acct) return res.status(404).json({ error: 'Account not found' });
  if (!acct.storage_state_path) return res.status(400).json({ error: 'No session — connect first' });

  db.prepare(`UPDATE accounts SET warmup_status='warming' WHERE id=?`).run(acct.id);
  res.json({ ok: true, message: 'Warmup started' });

  setImmediate(async () => {
    const result = await warmupAccount(acct.platform, acct.storage_state_path);
    _setWarmupStatus(acct.id, result.success ? 'warm' : 'cold');
  });
});

// ── PATCH /api/accounts/:id/status ───────────────────────────────────────────
router.patch('/:id/status', (req, res) => {
  try {
    const { status } = req.body;
    if (!['active', 'inactive', 'expired'].includes(status)) {
      return res.status(400).json({ error: 'status must be active|inactive|expired' });
    }
    getDb().prepare('UPDATE accounts SET status=? WHERE id=?').run(status, req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DELETE /api/accounts/:id ─────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  try {
    const db   = getDb();
    const acct = db.prepare('SELECT storage_state_path FROM accounts WHERE id=?').get(req.params.id);
    if (acct?.storage_state_path) {
      try { fs.rmSync(path.dirname(acct.storage_state_path), { recursive: true }); } catch (_) {}
    }
    db.prepare('DELETE FROM accounts WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
