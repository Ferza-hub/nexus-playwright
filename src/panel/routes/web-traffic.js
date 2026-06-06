'use strict';

const { Router }      = require('express');
const { getDb }       = require('../../database/db');
const { runCampaign } = require('../../web-traffic/engine');

const router = Router();

// ── CAMPAIGNS ──

// GET /api/web-traffic/campaigns
router.get('/campaigns', (req, res) => {
  try {
    const campaigns = getDb().prepare(`
      SELECT *,
        ROUND(CAST(visits_sent AS FLOAT) / NULLIF(visits_total, 0) * 100, 1) AS progress
      FROM web_campaigns ORDER BY created_at DESC
    `).all();
    res.json(campaigns);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/web-traffic/campaigns
router.post('/campaigns', (req, res) => {
  try {
    const {
      name, target_url, pages, visits_total,
      traffic_source = 'organic',
      device         = 'mixed',
      persona        = 'mixed',
      bounce_rate    = 40,
      pages_per_session = 3,
    } = req.body;

    if (!name || !target_url || !visits_total)
      return res.status(400).json({ error: 'name, target_url, visits_total required' });

    try { new URL(target_url); } catch {
      return res.status(400).json({ error: 'Invalid URL' });
    }

    const pagesJson = JSON.stringify(pages || [target_url]);
    const db     = getDb();
    const result = db.prepare(`
      INSERT INTO web_campaigns
        (name, target_url, pages, visits_total, traffic_source, device, persona, bounce_rate, pages_per_session, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(name, target_url, pagesJson, Number(visits_total),
           traffic_source, device, persona,
           Number(bounce_rate), Number(pages_per_session));

    res.status(201).json({ id: result.lastInsertRowid, message: 'Campaign created' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/web-traffic/campaigns/:id/status
router.patch('/campaigns/:id/status', (req, res) => {
  try {
    const { status } = req.body;
    if (!['running', 'paused', 'cancelled'].includes(status))
      return res.status(400).json({ error: 'status must be running|paused|cancelled' });
    getDb().prepare('UPDATE web_campaigns SET status=? WHERE id=?').run(status, req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/web-traffic/campaigns/:id
router.delete('/campaigns/:id', (req, res) => {
  try {
    const db = getDb();
    db.prepare('DELETE FROM web_visits WHERE campaign_id=?').run(req.params.id);
    db.prepare('DELETE FROM web_campaigns WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/web-traffic/campaigns/:id/start — set running + kick off engine
router.post('/campaigns/:id/start', (req, res) => {
  try {
    const db       = getDb();
    const campaign = db.prepare('SELECT * FROM web_campaigns WHERE id=?').get(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.status === 'completed' || campaign.status === 'cancelled')
      return res.status(400).json({ error: `Cannot start a ${campaign.status} campaign` });

    db.prepare("UPDATE web_campaigns SET status='running' WHERE id=?").run(req.params.id);
    // Fire-and-forget — scheduler will also pick it up on the next tick
    runCampaign(Number(req.params.id)).catch(() => {});
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PROXIES (shared with social engine) ──

// GET /api/web-traffic/proxies
router.get('/proxies', (req, res) => {
  try {
    res.json(getDb().prepare('SELECT * FROM proxies ORDER BY id').all());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/web-traffic/proxies/bulk
router.post('/proxies/bulk', (req, res) => {
  try {
    const { proxies, geo } = req.body;
    if (!Array.isArray(proxies)) return res.status(400).json({ error: 'proxies must be array' });

    const db   = getDb();
    const stmt = db.prepare(`
      INSERT INTO proxies (host, port, username, password, geo_region)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertMany = db.transaction(list => {
      let added = 0;
      for (const raw of list) {
        const parts = String(raw).trim().split(':');
        if (parts.length < 2) continue;
        const [host, port, username = null, password = null] = parts;
        stmt.run(host, parseInt(port), username, password, geo ?? null);
        added++;
      }
      return added;
    });
    const added = insertMany(proxies);
    res.json({ ok: true, added });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/web-traffic/proxies/:id/status
router.patch('/proxies/:id/status', (req, res) => {
  try {
    const { status } = req.body;
    if (!['active', 'inactive', 'banned'].includes(status))
      return res.status(400).json({ error: 'status must be active|inactive|banned' });
    getDb().prepare('UPDATE proxies SET status=? WHERE id=?').run(status, req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/web-traffic/proxies/:id
router.delete('/proxies/:id', (req, res) => {
  try {
    getDb().prepare('DELETE FROM proxies WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── STATS ──

// GET /api/web-traffic/stats
router.get('/stats', (req, res) => {
  try {
    const db = getDb();
    const totalCampaigns  = db.prepare('SELECT COUNT(*) AS c FROM web_campaigns').get().c;
    const activeCampaigns = db.prepare("SELECT COUNT(*) AS c FROM web_campaigns WHERE status='running'").get().c;
    const totalVisits     = db.prepare("SELECT COALESCE(SUM(visits_sent),0) AS c FROM web_campaigns").get().c;
    const successVisits   = db.prepare("SELECT COUNT(*) AS c FROM web_visits WHERE status='sent'").get().c;
    const failedVisits    = db.prepare("SELECT COUNT(*) AS c FROM web_visits WHERE status='failed'").get().c;
    const activeProxies   = db.prepare("SELECT COUNT(*) AS c FROM proxies WHERE status='active'").get().c;

    const recentVisits = db.prepare(`
      SELECT v.*, c.name AS campaign_name
      FROM web_visits v
      LEFT JOIN web_campaigns c ON v.campaign_id = c.id
      ORDER BY v.created_at DESC LIMIT 20
    `).all();

    const visitsByDay = db.prepare(`
      SELECT DATE(created_at) AS day, COUNT(*) AS count
      FROM web_visits WHERE created_at >= DATE('now', '-7 days')
      GROUP BY DATE(created_at) ORDER BY day ASC
    `).all();

    res.json({
      overview: { totalCampaigns, activeCampaigns, totalVisits, successVisits, failedVisits, activeProxies },
      successRate: totalVisits > 0 ? ((successVisits / (successVisits + failedVisits || 1)) * 100).toFixed(1) : 0,
      recentVisits,
      visitsByDay,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
