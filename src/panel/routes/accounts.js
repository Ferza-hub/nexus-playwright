'use strict';

const fs     = require('fs');
const path   = require('path');
const { Router } = require('express');
const { getDb }  = require('../../database/db');

const SESSION_DIR = process.env.SESSION_DIR ?? path.join(__dirname, '../../../data/sessions');

const router = Router();

// ── Cookie → Playwright storageState conversion ───────────────────────────────

const SAME_SITE_MAP = {
  no_restriction: 'None', unspecified: 'None', lax: 'Lax', strict: 'Strict', none: 'None',
};

function cookiesToStorageState(raw) {
  let list;
  try { list = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { throw new Error('Invalid JSON'); }
  if (!Array.isArray(list)) throw new Error('Cookies must be a JSON array');

  const cookies = list.map(c => ({
    name:     String(c.name   || ''),
    value:    String(c.value  || ''),
    domain:   String(c.domain || ''),
    path:     String(c.path   || '/'),
    expires:  c.expirationDate ?? c.expires ?? -1,
    httpOnly: Boolean(c.httpOnly),
    secure:   Boolean(c.secure),
    sameSite: SAME_SITE_MAP[(c.sameSite || '').toLowerCase()] ?? 'None',
  })).filter(c => c.name && c.domain);

  if (!cookies.length) throw new Error('No valid cookies found in JSON');
  return { cookies, origins: [] };
}

function saveStorageState(accountId, state) {
  const dir  = path.join(SESSION_DIR, String(accountId));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.json');
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
  return file;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/accounts
router.get('/', (req, res) => {
  try {
    const { platform } = req.query;
    const db = getDb();
    const rows = platform
      ? db.prepare(`SELECT id, platform, label, status, use_count, storage_state_path, created_at, last_used_at
                    FROM accounts WHERE platform=? ORDER BY created_at DESC`).all(platform)
      : db.prepare(`SELECT id, platform, label, status, use_count, storage_state_path, created_at, last_used_at
                    FROM accounts ORDER BY platform, created_at DESC`).all();
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/accounts/import — add account via cookie paste from Cookie Editor extension
// Body: { platform, label, cookies_json }
router.post('/import', (req, res) => {
  try {
    const { platform, label, cookies_json } = req.body;
    if (!platform || !cookies_json) {
      return res.status(400).json({ error: 'platform and cookies_json required' });
    }
    const VALID = ['youtube', 'instagram', 'tiktok', 'facebook', 'twitter'];
    if (!VALID.includes(platform)) {
      return res.status(400).json({ error: `platform must be one of: ${VALID.join(', ')}` });
    }

    const state = cookiesToStorageState(cookies_json);

    const db   = getDb();
    const nick = label?.trim() || `${platform} #${Date.now().toString(36)}`;
    // email/password kept as empty for schema compat (not used in cookie-import model)
    const r    = db.prepare(`INSERT INTO accounts (platform, label, email, password) VALUES (?,?,?,?)`)
                   .run(platform, nick, '', '');
    const id   = Number(r.lastInsertRowid);

    const filePath = saveStorageState(id, state);
    db.prepare('UPDATE accounts SET storage_state_path=? WHERE id=?').run(filePath, id);

    res.status(201).json({ id, label: nick, cookies: state.cookies.length });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// PATCH /api/accounts/:id/status
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

// DELETE /api/accounts/:id
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
