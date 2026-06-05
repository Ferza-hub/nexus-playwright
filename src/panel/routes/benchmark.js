'use strict';

// ============================================================================
// PATCH 7 — Benchmark routes (src/panel/routes/benchmark.js — NEW FILE)
// Register in server.js:
//   app.use('/api/benchmark', requireAuth, require('./routes/benchmark'));
// ============================================================================

const { Router } = require('express');
const { getDb }  = require('../../database/db');
const {
  benchmarkSummary, addExternalRival, indexChannel,
  classifyChannel, extractKeywords, sizeTier,
} = require('../../traffic/benchmark');

const router = Router();

// GET /api/benchmark/:goalId — full benchmark for a goal
// Returns: percentile + rivals + narrative + revenue estimate
router.get('/:goalId', (req, res) => {
  try {
    const summary = benchmarkSummary(Number(req.params.goalId));
    if (!summary) return res.status(404).json({ error: 'No benchmark data yet' });
    res.json(summary);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/benchmark/:goalId/rival — user manually adds a rival channel
// Body: { channelUrl } — we fetch their stats from YouTube API
router.post('/:goalId/rival', async (req, res) => {
  try {
    const { channelUrl } = req.body;
    if (!channelUrl) return res.status(400).json({ error: 'channelUrl required' });

    // Get goal's account token to call YouTube API
    const db   = getDb();
    const goal = db.prepare('SELECT * FROM growth_goals WHERE id=?').get(Number(req.params.goalId));
    if (!goal) return res.status(404).json({ error: 'goal not found' });

    const acct = goal.account_id
      ? db.prepare('SELECT * FROM accounts WHERE id=?').get(goal.account_id)
      : null;

    // Extract channel ID from URL
    const channelId = extractChannelId(channelUrl);
    if (!channelId) return res.status(400).json({ error: 'Could not parse channel ID from URL' });

    let channelData = { channelId, platform: goal.platform, url: channelUrl };
    let metrics = {};

    if (acct?.oauth_access_token && goal.platform === 'youtube') {
      // Fetch real stats for the rival channel
      const data = await fetchRivalStats(acct.oauth_access_token, channelId);
      if (data) {
        channelData = { ...channelData, ...data.channelData };
        metrics     = data.metrics;
      }
    }

    const rivals = addExternalRival(Number(req.params.goalId), channelData, metrics);
    res.json({ rivals, summary: benchmarkSummary(Number(req.params.goalId)) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/benchmark/sync — nightly cron: reindex all channels + recompute cohorts
router.post('/sync', async (_req, res) => {
  try {
    await syncBenchmarks();
    res.json({ ok: true, synced_at: new Date().toISOString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractChannelId(url) {
  try {
    const u = new URL(url);
    // youtube.com/channel/UC...
    const m = u.pathname.match(/\/channel\/(UC[\w-]+)/);
    if (m) return m[1];
    // youtube.com/@handle — need API to resolve, return handle as-is
    const h = u.pathname.match(/\/@([\w.-]+)/);
    if (h) return `@${h[1]}`;
    return null;
  } catch (_) { return null; }
}

async function fetchRivalStats(accessToken, channelId) {
  try {
    const id  = channelId.startsWith('@') ? `forHandle=${channelId.slice(1)}` : `id=${channelId}`;
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,brandingSettings&${id}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const ch   = data.items?.[0];
    if (!ch) return null;

    const publishedAt = new Date(ch.snippet.publishedAt);
    const ageDays     = Math.floor((Date.now() - publishedAt.getTime()) / 86400000);

    return {
      channelData: {
        channelId:   ch.id,
        title:       ch.snippet.title,
        description: ch.snippet.description,
        tags:        ch.brandingSettings?.channel?.keywords?.split(',') ?? [],
        country:     ch.snippet.country || '',
        language:    ch.snippet.defaultLanguage || '',
        ageDays,
        platform:    'youtube',
      },
      metrics: {
        subs:         parseInt(ch.statistics.subscriberCount ?? '0', 10),
        monthlyViews: Math.round(parseInt(ch.statistics.viewCount ?? '0', 10) / Math.max(1, ageDays / 30)),
      },
    };
  } catch (_) { return null; }
}

// Re-index all active channels from their latest goal snapshots
async function syncBenchmarks() {
  const db    = getDb();
  const goals = db.prepare(`
    SELECT gg.*, a.oauth_access_token
    FROM growth_goals gg
    LEFT JOIN accounts a ON a.id=gg.account_id
    WHERE gg.status='active'
  `).all();

  for (const goal of goals) {
    try {
      const snap = db.prepare(`
        SELECT subs, watch_hr FROM goal_snapshots
        WHERE goal_id=? AND source='metric'
        ORDER BY snapshot_date DESC LIMIT 1
      `).get(goal.id);
      if (!snap) continue;

      // Try to get full channel data from API for classification accuracy
      let channelData = { channelId: goal.channel_url, platform: goal.platform };
      if (goal.oauth_access_token && goal.platform === 'youtube') {
        const chId = extractChannelId(goal.channel_url);
        if (chId) {
          const d = await fetchRivalStats(goal.oauth_access_token, chId);
          if (d) channelData = { ...channelData, ...d.channelData };
        }
      }

      indexChannel(goal.id, channelData, {
        subs:      snap.subs,
        watch_hr:  snap.watch_hr,
        monetized: snap.subs >= 1000 && snap.watch_hr >= 4000,
      });
    } catch (_) {}
  }
}

module.exports = router;
