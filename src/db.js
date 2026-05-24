require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Priority: DATA_DIR env → repo/data → /root/data (legacy path)
function resolveDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  const repoData   = path.join(__dirname, '../data');
  const legacyData = path.join(__dirname, '../../data');
  // If legacy path has an existing database, use it (preserves data after path change)
  if (!fs.existsSync(path.join(repoData, 'nexus.db')) &&
       fs.existsSync(path.join(legacyData, 'nexus.db'))) {
    return legacyData;
  }
  return repoData;
}

const DATA_DIR = resolveDataDir();
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'nexus.db'));
console.log(`[db] data dir: ${DATA_DIR}`);

function initDB() {
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      target_url TEXT NOT NULL,
      pages TEXT NOT NULL,
      visits_total INTEGER NOT NULL,
      visits_sent INTEGER DEFAULT 0,
      visits_failed INTEGER DEFAULT 0,
      traffic_source TEXT DEFAULT 'organic',
      device TEXT DEFAULT 'mixed',
      persona TEXT DEFAULT 'mixed',
      min_duration INTEGER DEFAULT 30,
      max_duration INTEGER DEFAULT 180,
      bounce_rate INTEGER DEFAULT 40,
      pages_per_session INTEGER DEFAULT 3,
      speed TEXT DEFAULT 'normal',
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS proxies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      username TEXT,
      password TEXT,
      geo TEXT DEFAULT 'US',
      status TEXT DEFAULT 'active',
      last_used DATETIME,
      visits_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id TEXT NOT NULL,
      proxy_id INTEGER,
      status TEXT DEFAULT 'sent',
      duration INTEGER,
      pages INTEGER DEFAULT 1,
      persona TEXT,
      device TEXT,
      user_agent TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Remove any proxy rows with NULL or invalid port that could crash future operations
  // Migrations for existing databases
  try { db.exec(`ALTER TABLE campaigns ADD COLUMN speed TEXT DEFAULT 'normal'`); } catch {}

  try {
    const removed = db.prepare('DELETE FROM proxies WHERE port IS NULL OR port <= 0 OR port > 65535').run();
    if (removed.changes > 0) console.log(`[db] removed ${removed.changes} invalid proxy row(s)`);
  } catch {}

  const pwdRow = db.prepare("SELECT value FROM settings WHERE key = 'panel_password'").get();
  if (!pwdRow) {
    const initPwd = process.env.PANEL_PASSWORD || 'changeme123';
    db.prepare("INSERT INTO settings (key, value) VALUES ('panel_password', ?)").run(initPwd);
  }

  try {
    const count = db.prepare('SELECT COUNT(*) as c FROM proxies').get().c;
    if (count === 0) {
      const proxyStr = process.env.PROXIES || '';
      const lines = proxyStr.split(',').map(l => l.trim()).filter(Boolean);
      const insert = db.prepare('INSERT INTO proxies (host, port, username, password, geo) VALUES (?, ?, ?, ?, ?)');
      for (const line of lines) {
        const parts = line.split(':');
        if (parts.length < 2) continue;
        const [host, portRaw, username = null, password = null] = parts;
        const port = parseInt(portRaw, 10);
        if (!host || !host.includes('.') || isNaN(port) || port <= 0 || port > 65535) continue;
        insert.run(host, port, username || null, password || null, 'US');
      }
    }
  } catch (err) {
    console.error('[db] proxy seed skipped:', err.message);
  }

  console.log('Database ready');
}

module.exports = { db, initDB };
