require('dotenv').config();
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('./db');

const router = express.Router();
const TOKEN = process.env.PANEL_PASSWORD || 'changeme123';

// Auth middleware
router.use((req, res, next) => {
  const t = req.headers['x-auth-token'] || req.query.token;
  if (t !== TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// ── CAMPAIGNS ──
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
    bounce_rate = 40, pages_per_session = 3,
  } = req.body;

  if (!name || !target_url || !visits_total)
    return res.status(400).json({ error: 'name, target_url, visits_total required' });

  try { new URL(target_url); } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const id = uuidv4();
  const pagesJson = JSON.stringify(pages || [target_url]);

  db.prepare(`
    INSERT INTO campaigns (id, name, target_url, pages, visits_total, traffic_source, device, persona,
      min_duration, max_duration, bounce_rate, pages_per_session, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(id, name, target_url, pagesJson, visits_total, traffic_source, device, persona,
    min_duration, max_duration, bounce_rate, pages_per_session);

  res.json({ id, message: 'Campaign created' });
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

// ── PROXIES ──
router.get('/proxies', (req, res) => {
  res.json(db.prepare('SELECT * FROM proxies ORDER BY id').all());
});

router.post('/proxies/bulk', (req, res) => {
  const { proxies, geo = 'US' } = req.body;
  if (!Array.isArray(proxies)) return res.status(400).json({ error: 'proxies must be array' });

  const insert = db.prepare('INSERT INTO proxies (host, port, username, password, geo) VALUES (?, ?, ?, ?, ?)');
  const insertMany = db.transaction(list => {
    for (const raw of list) {
      const parts = raw.trim().split(':');
      if (parts.length < 2) continue;
      const [host, port, username = null, password = null] = parts;
      insert.run(host, parseInt(port), username, password, geo);
    }
  });
  insertMany(proxies);
  res.json({ success: true, added: proxies.length });
});

router.patch('/proxies/:id/status', (req, res) => {
  db.prepare('UPDATE proxies SET status = ? WHERE id = ?').run(req.body.status, req.params.id);
  res.json({ success: true });
});

router.delete('/proxies/:id', (req, res) => {
  db.prepare('DELETE FROM proxies WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── STATS ──
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

// Auth endpoint
router.post('/auth/login', (req, res) => {
  if (req.body.password === TOKEN) res.json({ success: true, token: TOKEN });
  else res.status(401).json({ error: 'Wrong password' });
});

module.exports = router;
