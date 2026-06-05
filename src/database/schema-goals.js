'use strict';

// ============================================================================
// PATCH 1 — Goal tracking schema
// Paste SCHEMA_GOALS + applyGoalSchema into src/database/schema.js.
// Call applyGoalSchema(db) at the end of runMigrations(). Additive only.
// ============================================================================

const SCHEMA_GOALS = `
CREATE TABLE IF NOT EXISTS growth_goals (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id       INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  platform         TEXT    NOT NULL,
  channel_url      TEXT    NOT NULL,
  channel_label    TEXT    NOT NULL DEFAULT '',
  goal_type        TEXT    NOT NULL DEFAULT 'monetization',
  target_subs      INTEGER NOT NULL DEFAULT 0,
  target_watch_hr  INTEGER NOT NULL DEFAULT 0,
  target_followers INTEGER NOT NULL DEFAULT 0,
  target_views_60d INTEGER NOT NULL DEFAULT 0,
  start_subs       INTEGER NOT NULL DEFAULT 0,
  start_watch_hr   INTEGER NOT NULL DEFAULT 0,
  start_followers  INTEGER NOT NULL DEFAULT 0,
  video_list       TEXT    NOT NULL DEFAULT '[]',
  status           TEXT    NOT NULL DEFAULT 'active'
                           CHECK(status IN ('active','paused','reached','archived')),
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  reached_at       DATETIME
);

CREATE TABLE IF NOT EXISTS goal_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id       INTEGER NOT NULL REFERENCES growth_goals(id) ON DELETE CASCADE,
  source        TEXT    NOT NULL DEFAULT 'metric'
                        CHECK(source IN ('metric','engine')),
  subs          INTEGER NOT NULL DEFAULT 0,
  watch_hr      REAL    NOT NULL DEFAULT 0,
  followers     INTEGER NOT NULL DEFAULT 0,
  views_60d     INTEGER NOT NULL DEFAULT 0,
  delivered     INTEGER NOT NULL DEFAULT 0,
  snapshot_date DATE    NOT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(goal_id, source, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_goal_snapshots ON goal_snapshots(goal_id, source, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_growth_goals_status ON growth_goals(status, platform);
`;

function applyGoalSchema(db) {
  db.exec(SCHEMA_GOALS);
  // Link traffic_jobs to a goal for delivery rollup
  try { db.prepare(`ALTER TABLE traffic_jobs ADD COLUMN goal_id INTEGER`).run(); } catch (_) {}
  // OAuth token columns on accounts (added when user connects platform)
  try { db.prepare(`ALTER TABLE accounts ADD COLUMN oauth_access_token TEXT`).run(); } catch (_) {}
  try { db.prepare(`ALTER TABLE accounts ADD COLUMN oauth_refresh_token TEXT`).run(); } catch (_) {}
  try { db.prepare(`ALTER TABLE accounts ADD COLUMN oauth_status TEXT NOT NULL DEFAULT 'active'`).run(); } catch (_) {}
  try { db.prepare(`ALTER TABLE accounts ADD COLUMN oauth_scope TEXT`).run(); } catch (_) {}
  try { db.prepare(`ALTER TABLE accounts ADD COLUMN oauth_expires_at DATETIME`).run(); } catch (_) {}
}

module.exports = { SCHEMA_GOALS, applyGoalSchema };
