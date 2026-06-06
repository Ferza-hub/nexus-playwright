'use strict';

// ============================================================================
// src/traffic/benchmark.js — NEW FILE
//
// The personalization engine. Three responsibilities:
//
// 1. CLASSIFY — extract category + keywords from channel metadata
// 2. INDEX    — upsert channel into the shared cohort pool
// 3. RANK     — compute user's percentile + identify nearest rivals
//
// V1: rule-based (percentile from Nexus userbase + YouTube API search)
// V2: collaborative filtering (after enough data accumulates)
// ============================================================================

const { getDb } = require('../database/db');

// ─── Category taxonomy ────────────────────────────────────────────────────────
// Maps YouTube category IDs + keyword signals to our internal categories.
// Kept simple — 12 buckets covers 90% of monetizing creators.

const CATEGORY_MAP = {
  // YouTube category ID → our label
  '1':  'Film & Entertainment', '2': 'Automotive',
  '10': 'Music',                '15': 'Pets & Animals',
  '17': 'Sports',               '19': 'Travel',
  '20': 'Gaming',               '22': 'People & Vlogs',
  '23': 'Comedy',               '24': 'Entertainment',
  '25': 'News',                 '26': 'How-to & Style',
  '27': 'Education',            '28': 'Science & Tech',
  '29': 'Nonprofit',
};

// Keyword → category override (catches channels miscategorized by YouTube)
const KEYWORD_SIGNALS = {
  cooking: 'Food & Cooking', recipe: 'Food & Cooking', masak: 'Food & Cooking',
  resep: 'Food & Cooking', kuliner: 'Food & Cooking', food: 'Food & Cooking',
  gaming: 'Gaming', game: 'Gaming', gameplay: 'Gaming', esport: 'Gaming',
  finance: 'Finance', investing: 'Finance', crypto: 'Finance', saham: 'Finance',
  beauty: 'Beauty & Fashion', makeup: 'Beauty & Fashion', skincare: 'Beauty & Fashion',
  fashion: 'Beauty & Fashion', ootd: 'Beauty & Fashion',
  fitness: 'Health & Fitness', workout: 'Health & Fitness', gym: 'Health & Fitness',
  tech: 'Science & Tech', review: 'Science & Tech', unboxing: 'Science & Tech',
  vlog: 'People & Vlogs', daily: 'People & Vlogs', lifestyle: 'People & Vlogs',
  music: 'Music', lagu: 'Music', cover: 'Music',
  education: 'Education', belajar: 'Education', tutorial: 'Education',
  travel: 'Travel', wisata: 'Travel', jalan: 'Travel',
};

// RPM estimates per category (USD, mid-range) — used for revenue projection
const CATEGORY_RPM = {
  'Finance':          12.0, 'Science & Tech':    8.0,
  'Health & Fitness':  5.0, 'Education':          5.0,
  'Food & Cooking':    3.5, 'How-to & Style':     4.0,
  'Gaming':            3.0, 'Beauty & Fashion':   4.5,
  'Travel':            4.0, 'People & Vlogs':     2.5,
  'Music':             2.0, 'Entertainment':      2.5,
  'Sports':            3.5, 'News':               4.0,
  '_default':          3.0,
};

function classifyChannel(channelData) {
  // channelData from YouTube API: { title, description, tags[], categoryId, country, language }
  const text = [
    channelData.title || '',
    channelData.description || '',
    ...(channelData.tags || []),
  ].join(' ').toLowerCase();

  // Keyword signal wins over category ID (more accurate)
  for (const [signal, cat] of Object.entries(KEYWORD_SIGNALS)) {
    if (text.includes(signal)) return cat;
  }
  return CATEGORY_MAP[channelData.categoryId] || 'Entertainment';
}

function extractKeywords(channelData) {
  const tags = channelData.tags || [];
  const titleWords = (channelData.title || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
  return [...new Set([...tags.slice(0, 7), ...titleWords.slice(0, 3)])].slice(0, 10);
}

function sizeTier(subs) {
  if (subs < 1000)    return '0-1k';
  if (subs < 10000)   return '1k-10k';
  if (subs < 100000)  return '10k-100k';
  return '100k+';
}

function ageBucket(days) {
  if (days < 180)  return '0-6mo';
  if (days < 365)  return '6-12mo';
  if (days < 730)  return '1-2yr';
  return '2yr+';
}

// ─── Index a channel into the cohort pool ─────────────────────────────────────
// Called after OAuth connect + on daily cron refresh.
// This is what builds the data moat — every user enriches the pool.

function indexChannel(goalId, channelData, metrics = {}) {
  const db       = getDb();
  const category = classifyChannel(channelData);
  const keywords = extractKeywords(channelData);
  const subs     = metrics.subs ?? 0;
  const ageDays  = channelData.ageDays ?? 0;

  // growth_rate_30d: need prev snapshot to compute; default 0 on first index
  const prevSnap = db.prepare(`
    SELECT subs FROM goal_snapshots
    WHERE goal_id=? AND source='metric'
    ORDER BY snapshot_date DESC LIMIT 1 OFFSET 30
  `).get(goalId);
  const growth30d = prevSnap && prevSnap.subs > 0
    ? ((subs - prevSnap.subs) / prevSnap.subs) * 100
    : 0;

  const monthlyViews = metrics.monthlyViews ?? 0;

  db.prepare(`
    INSERT INTO channel_index
      (goal_id, platform, channel_id, category, keywords, language, country,
       channel_age_days, size_tier, subs, watch_hr, monthly_views,
       growth_rate_30d, monetized, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(platform, channel_id) DO UPDATE SET
      category=excluded.category, keywords=excluded.keywords,
      size_tier=excluded.size_tier, subs=excluded.subs,
      watch_hr=excluded.watch_hr, monthly_views=excluded.monthly_views,
      growth_rate_30d=excluded.growth_rate_30d,
      monetized=excluded.monetized, updated_at=CURRENT_TIMESTAMP
  `).run(
    goalId, channelData.platform || 'youtube', channelData.channelId,
    category, JSON.stringify(keywords),
    channelData.language || '', channelData.country || '',
    ageDays, sizeTier(subs),
    subs, metrics.watch_hr ?? 0, monthlyViews,
    +growth30d.toFixed(2),
    metrics.monetized ? 1 : 0
  );

  return { category, keywords, sizeTier: sizeTier(subs), ageBucket: ageBucket(ageDays) };
}

// ─── Cohort percentile ────────────────────────────────────────────────────────
// "You're growing faster than X% of channels like yours"

function computeUserPercentile(goalId) {
  const db  = getDb();
  const ch  = db.prepare('SELECT * FROM channel_index WHERE goal_id=?').get(goalId);
  if (!ch) return null;

  const bucket = ageBucket(ch.channel_age_days);

  // Get cohort from Nexus userbase (same platform + category + size tier)
  const cohort = db.prepare(`
    SELECT growth_rate_30d FROM channel_index
    WHERE platform=? AND category=? AND size_tier=?
    AND is_external=0
    ORDER BY growth_rate_30d ASC
  `).all(ch.platform, ch.category, ch.size_tier);

  if (cohort.length < 3) {
    // Not enough data yet — don't show a fake percentile
    return { percentile: null, sampleSize: cohort.length, needsMoreData: true };
  }

  const rates  = cohort.map(r => r.growth_rate_30d);
  const below  = rates.filter(r => r < ch.growth_rate_30d).length;
  const pct    = Math.round((below / rates.length) * 100);

  // Save aggregated stats for future use
  const p = (arr, n) => arr[Math.floor((n / 100) * (arr.length - 1))];
  db.prepare(`
    INSERT INTO cohort_stats (platform, category, size_tier, age_bucket, p25, p50, p75, p90, sample_size)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(platform, category, size_tier, age_bucket) DO UPDATE SET
      p25=excluded.p25, p50=excluded.p50, p75=excluded.p75,
      p90=excluded.p90, sample_size=excluded.sample_size,
      computed_at=CURRENT_TIMESTAMP
  `).run(ch.platform, ch.category, ch.size_tier, bucket,
    p(rates,25), p(rates,50), p(rates,75), p(rates,90), rates.length);

  return { percentile: pct, sampleSize: rates.length, category: ch.category, needsMoreData: false };
}

// ─── Rival discovery ──────────────────────────────────────────────────────────
// Find channels slightly ahead of user. Auto-suggested from:
// 1. Nexus userbase (channels in same category, 1.5x-5x bigger)
// 2. YouTube API search (if not enough internal rivals)

function findRivals(goalId, limit = 3) {
  const db = getDb();
  const ch = db.prepare('SELECT * FROM channel_index WHERE goal_id=?').get(goalId);
  if (!ch) return [];

  const minSubs = Math.floor(ch.subs * 1.2);   // at least 20% ahead
  const maxSubs = ch.subs * 8;                  // not too far ahead (demotivating)

  // Look in Nexus pool first
  const rivals = db.prepare(`
    SELECT ci.*, rp.gap_days_estimate
    FROM channel_index ci
    LEFT JOIN rival_pairs rp ON rp.rival_channel_id=ci.channel_id AND rp.goal_id=?
    WHERE ci.platform=? AND ci.category=?
    AND ci.subs BETWEEN ? AND ?
    AND ci.goal_id != ?
    ORDER BY ci.subs ASC
    LIMIT ?
  `).all(goalId, ch.platform, ch.category, minSubs, maxSubs, goalId, limit);

  // Compute gap + catch-up estimate for each rival
  const result = rivals.map(r => {
    const gapSubs    = r.subs - ch.subs;
    // days to catch up: gap / (user daily growth rate)
    const userDailyRate = ch.growth_rate_30d > 0
      ? (ch.subs * (ch.growth_rate_30d / 100)) / 30
      : 1;
    const catchUpDays = userDailyRate > 0 ? Math.ceil(gapSubs / userDailyRate) : null;
    const rpm         = CATEGORY_RPM[ch.category] ?? CATEGORY_RPM['_default'];
    const estMonthly  = Math.round((r.monthly_views / 1000) * rpm);

    // Upsert rival pair
    db.prepare(`
      INSERT INTO rival_pairs (goal_id, rival_channel_id, source, gap_subs, gap_days_estimate)
      VALUES (?,?,'auto',?,?)
      ON CONFLICT(goal_id, rival_channel_id) DO UPDATE SET
        gap_subs=excluded.gap_subs, gap_days_estimate=excluded.gap_days_estimate
    `).run(goalId, r.channel_id, gapSubs, catchUpDays);

    return {
      channelId:     r.channel_id,
      label:         r.channel_id,   // label populated from API in routes
      category:      r.category,
      subs:          r.subs,
      monthlyViews:  r.monthly_views,
      estMonthlyUSD: estMonthly,
      gapSubs,
      catchUpDays,
      growthRate30d: r.growth_rate_30d,
    };
  });

  return result;
}

// ─── Add external rival (user manually submits a channel URL) ─────────────────
function addExternalRival(goalId, channelData, metrics = {}) {
  const db       = getDb();
  const category = classifyChannel(channelData);
  const subs     = metrics.subs ?? 0;

  db.prepare(`
    INSERT INTO channel_index
      (platform, channel_id, category, keywords, language, country,
       channel_age_days, size_tier, subs, monthly_views,
       growth_rate_30d, is_external, external_url, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,CURRENT_TIMESTAMP)
    ON CONFLICT(platform, channel_id) DO UPDATE SET
      subs=excluded.subs, monthly_views=excluded.monthly_views,
      updated_at=CURRENT_TIMESTAMP
  `).run(
    channelData.platform || 'youtube', channelData.channelId,
    category, JSON.stringify(extractKeywords(channelData)),
    channelData.language || '', channelData.country || '',
    channelData.ageDays ?? 0, sizeTier(subs),
    subs, metrics.monthlyViews ?? 0,
    metrics.growth30d ?? 0, channelData.url || ''
  );

  // Auto-create rival pair
  const ch      = db.prepare('SELECT * FROM channel_index WHERE goal_id=?').get(goalId);
  const gapSubs = subs - (ch?.subs ?? 0);
  db.prepare(`
    INSERT INTO rival_pairs (goal_id, rival_channel_id, source, gap_subs)
    VALUES (?,?,'user',?)
    ON CONFLICT(goal_id, rival_channel_id) DO UPDATE SET
      gap_subs=excluded.gap_subs, source='user'
  `).run(goalId, channelData.channelId, Math.max(0, gapSubs));

  return findRivals(goalId);
}

// ─── Full benchmark summary for a goal ────────────────────────────────────────
// This is what the dashboard calls. Returns everything needed for the
// personalized narrative: percentile + rivals + revenue estimate.

function benchmarkSummary(goalId) {
  const db  = getDb();
  const ch  = db.prepare('SELECT * FROM channel_index WHERE goal_id=?').get(goalId);
  if (!ch) return null;

  const percentileData = computeUserPercentile(goalId);
  const rivals         = findRivals(goalId);
  const rpm            = CATEGORY_RPM[ch.category] ?? CATEGORY_RPM['_default'];
  const estMonthly     = Math.round((ch.monthly_views / 1000) * rpm);

  // Narrative generation — the "Spotify Wrapped" moment
  const narrative = buildNarrative({
    channel: ch, percentileData, rivals, estMonthly,
  });

  return {
    channel:       ch,
    category:      ch.category,
    percentile:    percentileData,
    rivals,
    estMonthlyUSD: estMonthly,
    narrative,     // ready-to-display strings for the dashboard
  };
}

// Generate personalized narrative strings
function buildNarrative({ channel, percentileData, rivals, estMonthly }) {
  const lines = [];

  // Percentile narrative
  if (percentileData?.percentile != null) {
    const pct = percentileData.percentile;
    if (pct >= 75) {
      lines.push(`Your channel is growing faster than ${pct}% of ${channel.category} channels.`);
    } else if (pct >= 50) {
      lines.push(`You're ahead of ${pct}% of ${channel.category} channels your size.`);
    } else {
      lines.push(`${100 - pct}% of ${channel.category} channels your size are growing faster — Nexus can close that gap.`);
    }
  } else if (percentileData?.needsMoreData) {
    lines.push(`Building your benchmark — check back in a few days as we gather data from similar channels.`);
  }

  // Revenue narrative
  if (channel.monetized && estMonthly > 0) {
    lines.push(`At your current view rate, you're earning an estimated $${estMonthly}/month.`);
  }

  // Rival narrative (nearest rival = most motivating)
  const nearest = rivals[0];
  if (nearest) {
    if (nearest.catchUpDays && nearest.catchUpDays <= 90) {
      lines.push(`You're ${nearest.gapSubs.toLocaleString()} subscribers behind your nearest rival. At current pace: ${nearest.catchUpDays} days to catch up.`);
    } else if (nearest.catchUpDays) {
      lines.push(`Your nearest rival is ${nearest.gapSubs.toLocaleString()} subscribers ahead. Nexus can accelerate that gap.`);
    }
  }

  return lines;
}

module.exports = {
  classifyChannel, extractKeywords, sizeTier, ageBucket,
  indexChannel, computeUserPercentile, findRivals,
  addExternalRival, benchmarkSummary, buildNarrative,
  CATEGORY_RPM,
};
