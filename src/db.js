// SQLite persistence (Node's built-in node:sqlite — no native build step).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = path.join(__dirname, "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "offlineaid.db");

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

db.exec(`
CREATE TABLE IF NOT EXISTS organisations (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, facility_name TEXT,
  share_with_government INTEGER NOT NULL DEFAULT 1, emergency_status TEXT NOT NULL DEFAULT 'NORMAL',
  is_sample INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('employee','officer','administrator','citizen','government_operator')),
  job_title TEXT, organisation_id TEXT REFERENCES organisations(id),
  pin_hash TEXT NOT NULL, safety_status TEXT NOT NULL DEFAULT 'UNKNOWN', safety_updated_at TEXT,
  is_sample INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS emergency_requests (
  id TEXT PRIMARY KEY, client_id TEXT UNIQUE NOT NULL, organisation_id TEXT REFERENCES organisations(id),
  sender_id TEXT NOT NULL REFERENCES users(id), sender_name TEXT NOT NULL, sender_role TEXT NOT NULL, sender_job TEXT,
  category TEXT NOT NULL, description TEXT, people_affected INTEGER NOT NULL DEFAULT 1,
  latitude REAL, longitude REAL, floor_id TEXT, zone_id TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN', delivery_status TEXT NOT NULL DEFAULT 'RELAYED',
  client_created_at TEXT, created_at TEXT NOT NULL, received_at TEXT, acknowledged_at TEXT,
  acknowledged_by TEXT, updated_at TEXT NOT NULL, is_sample INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY, client_id TEXT UNIQUE NOT NULL, organisation_id TEXT NOT NULL REFERENCES organisations(id),
  sender_id TEXT NOT NULL REFERENCES users(id), sender_name TEXT NOT NULL, sender_role TEXT NOT NULL,
  title TEXT NOT NULL, message TEXT NOT NULL, category TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'critical',
  request_id TEXT REFERENCES emergency_requests(id), evacuation_plan_id TEXT,
  created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE'
);
CREATE TABLE IF NOT EXISTS alert_recipients (
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id),
  delivery_status TEXT NOT NULL DEFAULT 'RELAYED', retry_count INTEGER NOT NULL DEFAULT 0, last_retry_at TEXT,
  received_at TEXT, acknowledged_at TEXT, response TEXT,
  PRIMARY KEY (alert_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, client_id TEXT UNIQUE NOT NULL, organisation_id TEXT REFERENCES organisations(id),
  request_id TEXT REFERENCES emergency_requests(id), alert_id TEXT REFERENCES alerts(id),
  sender_id TEXT NOT NULL REFERENCES users(id), sender_name TEXT NOT NULL, sender_role TEXT NOT NULL,
  recipient_id TEXT, message_type TEXT NOT NULL, payload TEXT NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT 'RELAYED', retry_count INTEGER NOT NULL DEFAULT 0, last_retry_at TEXT,
  client_created_at TEXT, created_at TEXT NOT NULL, received_at TEXT, acknowledged_at TEXT
);
CREATE TABLE IF NOT EXISTS floor_plans (
  id TEXT PRIMARY KEY, organisation_id TEXT NOT NULL REFERENCES organisations(id), name TEXT NOT NULL,
  floor TEXT NOT NULL DEFAULT 'Ground', image_path TEXT NOT NULL, original_path TEXT,
  width INTEGER, height INTEGER, nodes TEXT NOT NULL DEFAULT '[]', edges TEXT NOT NULL DEFAULT '[]',
  is_sample INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS evacuation_plans (
  id TEXT PRIMARY KEY, organisation_id TEXT NOT NULL REFERENCES organisations(id),
  floor_plan_id TEXT NOT NULL REFERENCES floor_plans(id) ON DELETE CASCADE, name TEXT NOT NULL,
  emergency_type TEXT NOT NULL, start_node TEXT NOT NULL, destination_node TEXT NOT NULL,
  route TEXT NOT NULL DEFAULT '[]', blocked_nodes TEXT NOT NULL DEFAULT '[]', blocked_edges TEXT NOT NULL DEFAULT '[]',
  instructions TEXT NOT NULL DEFAULT '', is_sample INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS places (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL,
  address TEXT, phone TEXT, source TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS places_fts USING fts5(id UNINDEXED, name, category, address, tokenize='porter unicode61');
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user_id TEXT, action TEXT NOT NULL, detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_org ON emergency_requests(organisation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_recipients_user ON alert_recipients(user_id, delivery_status);
CREATE INDEX IF NOT EXISTS idx_messages_req ON messages(request_id);
`);

const now = () => new Date().toISOString();
const newId = (prefix) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

function tx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function audit(userId, action, detail) {
  db.prepare("INSERT INTO audit_log (at, user_id, action, detail) VALUES (?,?,?,?)")
    .run(now(), userId || null, action, detail ? JSON.stringify(detail).slice(0, 2000) : null);
}

// node:sqlite returns null-prototype rows; normalise to plain objects.
const plain = (row) => (row ? { ...row } : row);
const all = (sql, ...params) => db.prepare(sql).all(...params).map(plain);
const get = (sql, ...params) => plain(db.prepare(sql).get(...params));
const run = (sql, ...params) => db.prepare(sql).run(...params);

module.exports = { db, DB_PATH, DATA_DIR, now, newId, tx, audit, all, get, run };
