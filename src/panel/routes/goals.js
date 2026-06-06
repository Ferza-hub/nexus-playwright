'use strict';

// ============================================================================
// PATCH 3 — Goals + OAuth routes (src/panel/routes/goals.js — NEW FILE)
// Register in server.js:
//   app.use('/api/goals', requireAuth, require('./routes/goals'));
// ============================================================================

const { Router } = require('express');
const {
  createGoal, recordMetric, recordDelivery, goalProgress,
  listGoals, thresholdsFor, syncAllGoals, syncGoalMetrics,
  fetchYouTubeStats, fetchFacebookStats,
} = require('../../traffic/goals');
const { getDb } = require('../../database/db');

const router = Router();

// ── Goals CRUD ──────────────────────────────────────────────────────────────

// GET /api/goals — all goals with progress (feeds dashboard account tabs)
router.get('/', (_req, res) => {
  try { res.json(listGoals()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/goals/thresholds/:platform
router.get('/thresholds/:platform', (req, res) => {
  res.json(thresholdsFor(req.params.platform));
});

// GET /api/goals/:id
router.get('/:id', (req, res) => {
  try {
    const p = goalProgress(Number(req.params.id));
    if (!p) return res.status(404).json({ error: 'goal not found' });
    res.json(p);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/goals — create goal (called right after OAuth connect succeeds)
// Body: { platform, channel_url, channel_label?, account_id?, baseline? }
router.post('/', async (req, res) => {
  try {
    const { platform, channel_url, channel_label, account_id, baseline } = req.body;
    if (!platform || !channel_url)
      return res.status(400).json({ error: 'platform and channel_url required' });
    const id = createGoal({ platform, channel_url, channel_label, account_id, baseline });
    res.json(goalProgress(id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Metric endpoints ────────────────────────────────────────────────────────

// POST /api/goals/:id/metric — authoritative reading from official API cron
// Body: { subs?, watch_hr?, followers?, views_60d? }
router.post('/:id/metric', (req, res) => {
  try {
    recordMetric(Number(req.params.id), req.body || {});
    res.json(goalProgress(Number(req.params.id)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/goals/:id/delivery — engine contribution delta (runner calls this internally)
router.post('/:id/delivery', (req, res) => {
  try {
    recordDelivery(Number(req.params.id), req.body || {});
    res.json(goalProgress(Number(req.params.id)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/goals/sync — daily cron: fetch real stats from all platform APIs
// Protected — only called by internal cron, not exposed to front-end users
router.post('/sync', async (_req, res) => {
  try {
    await syncAllGoals();
    res.json({ ok: true, synced_at: new Date().toISOString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── OAuth connect flow ──────────────────────────────────────────────────────
// Step 1: user clicks "Connect YouTube/Facebook" in dashboard
// Step 2: we redirect to Google/Facebook OAuth
// Step 3: callback saves token + creates goal automatically
//
// This is the ONLY entry point for new accounts. Zero setup from user —
// we read their real stats immediately after they connect.

// GET /api/goals/auth/youtube — redirect to Google OAuth
router.get('/auth/youtube', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'GOOGLE_CLIENT_ID not configured' });
  const scope = [
    'https://www.googleapis.com/auth/youtube.readonly',
    'openid', 'email', 'profile',
  ].join(' ');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', process.env.GOOGLE_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scope);
  url.searchParams.set('access_type', 'offline');   // get refresh token
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', JSON.stringify({ userId: req.user?.id }));
  res.redirect(url.toString());
});

// GET /api/goals/auth/youtube/callback — Google sends user back here
router.get('/auth/youtube/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/?error=oauth_denied');

  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri:  process.env.GOOGLE_REDIRECT_URI,
        grant_type:    'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(tokens.error_description || 'Token exchange failed');

    // Fetch real channel stats immediately — zero setup for user
    const stats = await fetchYouTubeStats(tokens.access_token);

    const db = getDb();

    // Store account with OAuth tokens
    const existing = db.prepare(`SELECT id FROM accounts WHERE platform='youtube' AND email=?`).get(stats.channelId);
    let accountId;
    if (existing) {
      db.prepare(`UPDATE accounts SET oauth_access_token=?, oauth_refresh_token=?, oauth_status='active', oauth_expires_at=? WHERE id=?`)
        .run(tokens.access_token, tokens.refresh_token, new Date(Date.now() + tokens.expires_in * 1000).toISOString(), existing.id);
      accountId = existing.id;
    } else {
      const r = db.prepare(`INSERT INTO accounts (platform, email, password, oauth_access_token, oauth_refresh_token, oauth_status, oauth_expires_at, status, label) VALUES ('youtube',?,?,?,?,'active',?,'active',?)`)
        .run(stats.channelId, '', tokens.access_token, tokens.refresh_token,
          new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
          stats.channelTitle);
      accountId = r.lastInsertRowid;
    }

    // Create goal with real baseline — channel URL + stats from API
    const channelUrl = `https://www.youtube.com/channel/${stats.channelId}`;
    const goalId = createGoal({
      platform:      'youtube',
      channel_url:   channelUrl,
      channel_label: stats.channelTitle,
      account_id:    accountId,
      baseline:      { subs: stats.subs, watch_hr: stats.watch_hr, videos: stats.videos },
    });

    res.redirect(`/monetize.html?goal=${goalId}&connected=youtube`);
  } catch (err) {
    res.redirect(`/?error=${encodeURIComponent(err.message)}`);
  }
});

// GET /api/goals/auth/facebook/callback — Facebook OAuth callback
router.get('/auth/facebook/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/?error=oauth_denied');

  try {
    const tokenRes = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token?` +
      new URLSearchParams({
        client_id:     process.env.FACEBOOK_APP_ID,
        client_secret: process.env.FACEBOOK_APP_SECRET,
        redirect_uri:  process.env.FACEBOOK_REDIRECT_URI,
        code,
      })
    );
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(tokens.error?.message || 'Token exchange failed');

    // Get user's pages (for Reels monetization)
    const pagesRes = await fetch(
      `https://graph.facebook.com/v19.0/me/accounts?access_token=${tokens.access_token}`
    );
    const pagesData = await pagesRes.json();
    const page = pagesData.data?.[0];
    if (!page) throw new Error('No Facebook page found');

    const stats = await fetchFacebookStats(page.access_token, page.id);
    const db    = getDb();

    const r = db.prepare(`INSERT INTO accounts (platform, email, password, oauth_access_token, oauth_status, status, label) VALUES ('facebook',?,?,?,'active','active',?)`)
      .run(page.id, '', page.access_token, stats.name);

    const goalId = createGoal({
      platform:      'facebook',
      channel_url:   `https://www.facebook.com/${page.id}`,
      channel_label: stats.name,
      account_id:    r.lastInsertRowid,
      baseline:      { followers: stats.followers, views_60d: stats.views_60d },
    });

    res.redirect(`/monetize.html?goal=${goalId}&connected=facebook`);
  } catch (err) {
    res.redirect(`/?error=${encodeURIComponent(err.message)}`);
  }
});

module.exports = router;
