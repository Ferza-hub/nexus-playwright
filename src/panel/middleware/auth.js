'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

let _password = process.env.PANEL_PASSWORD || 'nexus2024';

// Token is a deterministic HMAC of the password so it survives process restarts.
// When the password changes the token automatically changes, invalidating all sessions.
const _SECRET = process.env.TOKEN_SECRET || 'nexus-token-secret-v1';

function _makeToken(pwd) {
  return crypto.createHmac('sha256', _SECRET).update(pwd).digest('hex');
}

function generateToken() {
  return _makeToken(_password);
}

function validateToken(token) {
  return token && token === _makeToken(_password);
}

function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (!validateToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function loginHandler(req, res) {
  const { password } = req.body;
  if (password !== _password) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  res.json({ token: generateToken() });
}

function changePasswordHandler(req, res) {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword required' });
  }
  if (currentPassword !== _password) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  _password = newPassword;

  const envPath = path.resolve(process.cwd(), '.env');
  try {
    let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    if (/^PANEL_PASSWORD=.*/m.test(content)) {
      content = content.replace(/^PANEL_PASSWORD=.*/m, `PANEL_PASSWORD=${newPassword}`);
    } else {
      content += `\nPANEL_PASSWORD=${newPassword}\n`;
    }
    fs.writeFileSync(envPath, content, 'utf8');
  } catch (_) {}

  res.json({ ok: true });
}

module.exports = { requireAuth, loginHandler, changePasswordHandler, validateToken };
