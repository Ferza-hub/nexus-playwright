'use strict';

// ============================================================================
// PATCH 5 — Benchmark & Cohort schema
// Additive — paste into src/database/schema.js, call applyBenchmarkSchema(db)
// at end of runMigrations() AFTER applyGoalSchema(db).
// ============================================================================

const SCHEMA_BENCHMARK = `
-- ---------------------------------------------------------------
-- channel_index — anonymized profile of every Nexus user's channel.
-- This IS the data moat. Every user enriches benchmarks for all others.
-- No PII stored — only growth metrics and taxonomy.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS channel_index (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id          INTEGER REFERENCES growth_goals(id) ON DELETE CASCADE,
  platform         TEXT    NOT NULL,
  channel_id       TEXT    NOT NULL,          -- platform's own channel ID (not URL)
  category         TEXT    NOT NULL DEFAULT '',-- primary category (Cooking, Gaming, etc)
  keywords         TEXT    NOT NULL DEFAULT '[]',-- JSON array, top 10 keywords
  language         TEXT    NOT NULL DEFAULT '',
  country          TEXT    NOT NULL DEFAULT '',
  channel_age_days INTEGER NOT NULL DEFAULT 0, -- days since channel created
  size_tier        TEXT    NOT NULL DEFAULT '0-1k'
                           CHECK(size_tier IN ('0-1k','1k-10k','10k-100k','100k+')),
  -- latest metrics snapshot (updated daily by cron)
  subs             INTEGER NOT NULL DEFAULT 0,
  watch_hr         INTEGER NOT NULL DEFAULT 0,
  monthly_views    INTEGER NOT NULL DEFAULT 0,
  upload_freq_days REAL    NOT NULL DEFAULT 0, -- avg days between uploads
  growth_rate_30d  REAL    NOT NULL DEFAULT 0, -- % subscriber growth last 30d
  monetized        INTEGER NOT NULL DEFAULT 0, -- 0/1 boolean
  -- for external benchmarks (user-submitted rivals, not Nexus users)
  is_external      INTEGER NOT NULL DEFAULT 0,
  external_url     TEXT,
  updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(platform, channel_id)
);

-- ---------------------------------------------------------------
-- cohort_stats — pre-aggregated percentiles per segment.
-- Recomputed nightly. Drives "you're faster than X%" narrative.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cohort_stats (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  platform     TEXT NOT NULL,
  category     TEXT NOT NULL,
  size_tier    TEXT NOT NULL,
  age_bucket   TEXT NOT NULL, -- '0-6mo','6-12mo','1-2yr','2yr+'
  -- percentile breakpoints for growth_rate_30d
  p25          REAL NOT NULL DEFAULT 0,
  p50          REAL NOT NULL DEFAULT 0,
  p75          REAL NOT NULL DEFAULT 0,
  p90          REAL NOT NULL DEFAULT 0,
  sample_size  INTEGER NOT NULL DEFAULT 0,
  computed_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(platform, category, size_tier, age_bucket)
);

-- ---------------------------------------------------------------
-- rival_pairs — explicit user → rival relationships.
-- User can add rivals manually; engine also auto-suggests.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rival_pairs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id           INTEGER NOT NULL REFERENCES growth_goals(id) ON DELETE CASCADE,
  rival_channel_id  TEXT    NOT NULL,  -- references channel_index.channel_id
  source            TEXT    NOT NULL DEFAULT 'auto'
                            CHECK(source IN ('auto','user')),
  gap_subs          INTEGER NOT NULL DEFAULT 0,
  gap_days_estimate INTEGER,           -- days to catch up at current rate
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(goal_id, rival_channel_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_index_segment
  ON channel_index(platform, category, size_tier, channel_age_days);
CREATE INDEX IF NOT EXISTS idx_rival_pairs_goal ON rival_pairs(goal_id);
`;

function applyBenchmarkSchema(db) {
  db.exec(SCHEMA_BENCHMARK);
}

module.exports = { SCHEMA_BENCHMARK, applyBenchmarkSchema };
