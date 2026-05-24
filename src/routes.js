require('dotenv').config();
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('./db');

const router = express.Router();

function getPassword() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'panel_password'").get();
  return row ? row.value : (process.env.PANEL_PASSWORD || 'changeme123');
}

router.use((req, res, next) => {
  if (req.path === '/auth/login' && req.method === 'POST') return next();
  const t = req.headers['x-auth-token'] || req.query.token;
  if (t !== getPassword()) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

router.get('/campaigns', (req, res) => {
  const campaigns = db.prepare(`
    SELECT *, ROUND(CAST(visits_sent AS FLOAT) / visits_total * 100, 1) as progress
    FROM campaigns ORDER BY created_at DESC
  `).all();
  res.json(campaigns);
});

router.post('/campaigns', (req, res) => {
  const {
    name, target_url, pages, visits_total,
    traffic_source = 'organic', device = 'mixed',
    persona = 'mixed', min_duration = 30, max_duration = 180,
    bounce_rate = 40, pages_per_session = 3, speed = 'normal', target_geo = 'any',
  } = req.body;

  if (!name || !target_url || !visits_total)
    return res.status(400).json({ error: 'name, target_url, visits_total required' });

  try { new URL(target_url); } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  if (!['natural','normal','fast','turbo'].includes(speed))
    return res.status(400).json({ error: 'speed must be natural/normal/fast/turbo' });

  const id = uuidv4();
  const pagesJson = JSON.stringify(pages || [target_url]);

  db.prepare(`
    INSERT INTO campaigns (id, name, target_url, pages, visits_total, traffic_source, device, persona,
      min_duration, max_duration, bounce_rate, pages_per_session, speed, target_geo, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(id, name, target_url, pagesJson, visits_total, traffic_source, device, persona,
    min_duration, max_duration, bounce_rate, pages_per_session, speed, target_geo);

  res.json({ id, message: 'Created' });
});

router.patch('/campaigns/:id/status', (req, res) => {
  const { status } = req.body;
  if (!['running', 'paused', 'cancelled'].includes(status))
    return res.status(400).json({ error: 'Invalid status' });
  db.prepare('UPDATE campaigns SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ success: true });
});

router.delete('/campaigns/:id', (req, res) => {
  db.prepare('DELETE FROM visits WHERE campaign_id = ?').run(req.params.id);
  db.prepare('DELETE FROM campaigns WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

router.get('/proxies', (req, res) => {
  res.json(db.prepare('SELECT * FROM proxies ORDER BY id').all());
});

router.post('/proxies/bulk', (req, res) => {
  const { proxies, geo = 'US' } = req.body;
  if (!Array.isArray(proxies)) return res.status(400).json({ error: 'proxies must be array' });

  const insert = db.prepare('INSERT INTO proxies (host, port, username, password, geo) VALUES (?, ?, ?, ?, ?)');
  let added = 0;
  const insertMany = db.transaction(list => {
    for (const raw of list) {
      const parts = raw.trim().split(':');
      if (parts.length < 2) continue;
      const [host, portRaw, username = null, password = null] = parts;
      const port = parseInt(portRaw, 10);
      if (!host || !host.includes('.') || isNaN(port) || port <= 0 || port > 65535) continue;
      insert.run(host, port, username || null, password || null, geo);
      added++;
    }
  });
  insertMany(proxies);
  res.json({ success: true, added });
});

router.patch('/proxies/:id/status', (req, res) => {
  db.prepare('UPDATE proxies SET status = ? WHERE id = ?').run(req.body.status, req.params.id);
  res.json({ success: true });
});

router.delete('/proxies/:id', (req, res) => {
  db.prepare('DELETE FROM proxies WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

router.get('/stats', (req, res) => {
  const totalCampaigns = db.prepare('SELECT COUNT(*) as c FROM campaigns').get().c;
  const activeCampaigns = db.prepare("SELECT COUNT(*) as c FROM campaigns WHERE status = 'running'").get().c;
  const totalVisits = db.prepare("SELECT SUM(visits_sent) as c FROM campaigns").get().c || 0;
  const successVisits = db.prepare("SELECT COUNT(*) as c FROM visits WHERE status = 'sent'").get().c;
  const failedVisits = db.prepare("SELECT COUNT(*) as c FROM visits WHERE status = 'failed'").get().c;
  const activeProxies = db.prepare("SELECT COUNT(*) as c FROM proxies WHERE status = 'active'").get().c;

  const recentVisits = db.prepare(`
    SELECT v.*, c.name as campaign_name, p.host as proxy_host, p.geo
    FROM visits v
    LEFT JOIN campaigns c ON v.campaign_id = c.id
    LEFT JOIN proxies p ON v.proxy_id = p.id
    ORDER BY v.created_at DESC LIMIT 20
  `).all();

  const visitsByDay = db.prepare(`
    SELECT DATE(created_at) as day, COUNT(*) as count
    FROM visits WHERE created_at >= DATE('now', '-7 days')
    GROUP BY DATE(created_at) ORDER BY day ASC
  `).all();

  res.json({
    overview: { totalCampaigns, activeCampaigns, totalVisits, successVisits, failedVisits, activeProxies },
    successRate: totalVisits > 0 ? ((successVisits / (successVisits + failedVisits)) * 100).toFixed(1) : 0,
    recentVisits,
    visitsByDay,
  });
});

router.post('/auth/login', (req, res) => {
  const pwd = getPassword();
  if (req.body.password === pwd) res.json({ success: true, token: pwd });
  else res.status(401).json({ error: 'Wrong password' });
});

router.post('/settings/password', (req, res) => {
  const { current_password, new_password } = req.body;
  if (!new_password || new_password.length < 6)
    return res.status(400).json({ error: 'Password minimal 6 karakter' });
  if (current_password !== getPassword())
    return res.status(401).json({ error: 'Password lama salah' });
  db.prepare("UPDATE settings SET value = ? WHERE key = 'panel_password'").run(new_password);
  res.json({ success: true });
});

module.exports = router;
