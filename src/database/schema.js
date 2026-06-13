'use strict';

const { getDb } = require('./db');

const SCHEMA = `
-- ---------------------------------------------------------------
-- proxies — residential pool, shared across all ephemeral ghosts
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS proxies (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  host            TEXT    NOT NULL,
  port            INTEGER NOT NULL,
  username        TEXT,
  password        TEXT,
  protocol        TEXT    NOT NULL DEFAULT 'http' CHECK(protocol IN ('http','https','socks5')),
  status          TEXT    NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive','banned')),
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_checked_at DATETIME
);

-- ---------------------------------------------------------------
-- accounts — minimal credential store, one row per platform login.
-- These are "keys" only: credentials + cached session file.
-- No warmup phases, rate limits, or health tracking.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  platform           TEXT    NOT NULL,
  email              TEXT    NOT NULL,
  password           TEXT    NOT NULL,
  storage_state_path TEXT,
  status             TEXT    NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive','expired')),
  created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_used_at       DATETIME
);

-- ---------------------------------------------------------------
-- traffic_jobs + logs
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS traffic_jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  platform        TEXT    NOT NULL,
  action_type     TEXT    NOT NULL,
  target_value    TEXT    NOT NULL,
  target_count    INTEGER NOT NULL,
  completed_count INTEGER NOT NULL DEFAULT 0,
  status          TEXT    NOT NULL DEFAULT 'pending'
                          CHECK(status IN ('pending','running','completed','failed','paused')),
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at      DATETIME,
  completed_at    DATETIME
);

CREATE TABLE IF NOT EXISTS traffic_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     INTEGER NOT NULL REFERENCES traffic_jobs(id) ON DELETE CASCADE,
  platform   TEXT    NOT NULL,
  action     TEXT    NOT NULL,
  status     TEXT    NOT NULL CHECK(status IN ('success','failed','skipped')),
  message    TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_traffic_jobs_status ON traffic_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_traffic_logs_job    ON traffic_logs(job_id, created_at);

-- ---------------------------------------------------------------
-- web_campaigns + web_visits — website traffic engine
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS web_campaigns (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL,
  target_url        TEXT    NOT NULL,
  pages             TEXT    NOT NULL DEFAULT '[]',
  visits_total      INTEGER NOT NULL,
  visits_sent       INTEGER NOT NULL DEFAULT 0,
  visits_failed     INTEGER NOT NULL DEFAULT 0,
  traffic_source    TEXT    NOT NULL DEFAULT 'organic',
  device            TEXT    NOT NULL DEFAULT 'mixed',
  persona           TEXT    NOT NULL DEFAULT 'mixed',
  bounce_rate       INTEGER NOT NULL DEFAULT 40,
  pages_per_session INTEGER NOT NULL DEFAULT 3,
  status            TEXT    NOT NULL DEFAULT 'pending'
                            CHECK(status IN ('pending','running','paused','completed','failed','cancelled')),
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at      DATETIME
);

CREATE TABLE IF NOT EXISTS web_visits (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id  INTEGER NOT NULL REFERENCES web_campaigns(id) ON DELETE CASCADE,
  proxy_id     INTEGER,
  status       TEXT    NOT NULL DEFAULT 'sent' CHECK(status IN ('sent','failed')),
  duration     INTEGER,
  pages        INTEGER DEFAULT 1,
  persona      TEXT,
  device       TEXT,
  user_agent   TEXT,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_web_campaigns_status ON web_campaigns(status, created_at);
CREATE INDEX IF NOT EXISTS idx_web_visits_campaign  ON web_visits(campaign_id, created_at);
`;

function runMigrations(db) {
  db.exec(SCHEMA);

  const addCol = (table, col, def) => {
    try { db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run(); } catch (_) {}
  };

  addCol('proxies',  'proxy_type',         `TEXT NOT NULL DEFAULT 'residential'`);
  addCol('proxies',  'geo_region',         `TEXT`);

  // accounts table — cookie-import model
  addCol('accounts', 'platform',           `TEXT NOT NULL DEFAULT 'unknown'`);
  addCol('accounts', 'label',              `TEXT NOT NULL DEFAULT ''`);
  addCol('accounts', 'storage_state_path', `TEXT`);
  addCol('accounts', 'status',             `TEXT NOT NULL DEFAULT 'active'`);
  addCol('accounts', 'use_count',          `INTEGER NOT NULL DEFAULT 0`);
  addCol('accounts', 'last_used_at',       `DATETIME`);
  addCol('accounts', 'warmup_status',      `TEXT NOT NULL DEFAULT 'cold'`);
  addCol('accounts', 'last_warmup_at',     `DATETIME`);
  // legacy columns kept so existing DBs don't break
  addCol('accounts', 'email',              `TEXT NOT NULL DEFAULT ''`);
  addCol('accounts', 'password',           `TEXT NOT NULL DEFAULT ''`);

  // web-traffic engine — extra proxy tracking columns
  addCol('proxies', 'visits_count',         'INTEGER NOT NULL DEFAULT 0');
  addCol('proxies', 'last_used_at_traffic', 'DATETIME');

  // monetization goals + benchmark
  // Identity lock columns
  addCol('accounts', 'identity_locked',  'INTEGER DEFAULT 0'); // flag — 1 = locked, 0 = not yet
  addCol('accounts', 'locked_proxy_url', 'TEXT'); // null = VPS direct IP (valid state)
  addCol('accounts', 'fp_user_agent',    'TEXT');
  addCol('accounts', 'fp_viewport_w',    'INTEGER');
  addCol('accounts', 'fp_viewport_h',    'INTEGER');
  addCol('accounts', 'fp_timezone',      'TEXT');
  addCol('accounts', 'fp_locale',        'TEXT');
  addCol('accounts', 'fp_platform',      'TEXT');
  addCol('accounts', 'fp_is_mobile',     'INTEGER DEFAULT 0');
  addCol('accounts', 'geo_region',       "TEXT DEFAULT 'id'");

  applyGoalSchema(db);
  applyBenchmarkSchema(db);
}

const { applyGoalSchema }      = require('./schema-goals');
const { applyBenchmarkSchema } = require('./schema-benchmark');

module.exports = { runMigrations };
