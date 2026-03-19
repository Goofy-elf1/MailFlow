require('dotenv').config();
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const DB_PATH = path.resolve(process.env.DATABASE_URL?.replace('file:', '') || './mailflow.db');

let _db = null;

// ─── Load or create database ──────────────────────────────────────────────────
async function getDb() {
  if (_db) return _db;

  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    _db = new SQL.Database(fileBuffer);
  } else {
    _db = new SQL.Database();
  }

  // Save to disk helper — call after every write
  _db.save = () => {
    const data = _db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  };

  initSchema(_db);
  _db.save();

  console.log('✅ Database initialized at', DB_PATH);
  return _db;
}

// ─── Schema ───────────────────────────────────────────────────────────────────
function initSchema(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,
      email       TEXT UNIQUE NOT NULL,
      name        TEXT NOT NULL,
      gmail_token TEXT,
      created_at  INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id         TEXT PRIMARY KEY,
      email      TEXT UNIQUE NOT NULL,
      name       TEXT,
      company    TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS threads (
      id              TEXT PRIMARY KEY,
      gmail_thread_id TEXT UNIQUE,
      contact_id      TEXT NOT NULL,
      owner_id        TEXT NOT NULL,
      subject         TEXT NOT NULL,
      status          TEXT DEFAULT 'ai',
      ai_mode         INTEGER DEFAULT 1,
      claimed_by      TEXT,
      is_primary      INTEGER DEFAULT 1,
      deliv_score     INTEGER DEFAULT 94,
      created_at      INTEGER DEFAULT (strftime('%s','now')),
      updated_at      INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id                  TEXT PRIMARY KEY,
      thread_id           TEXT NOT NULL,
      gmail_msg_id        TEXT,
      role                TEXT NOT NULL,
      from_name           TEXT NOT NULL,
      from_email          TEXT NOT NULL,
      body                TEXT NOT NULL,
      message_id_header   TEXT,
      references_header   TEXT,
      in_reply_to         TEXT,
      sent_at             INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS thread_access (
      thread_id  TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      role       TEXT NOT NULL DEFAULT 'owner',
      granted_at INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (thread_id, user_id)
    );
  `);
}

// ─── Sync query helpers (mirrors better-sqlite3 API used in routes) ───────────
// These make the rest of the code work without changes.

function prepare(db, sql) {
  return {
    // Returns first row or undefined
    get: (...params) => {
      const stmt = db.prepare(sql);
      stmt.bind(params);
      if (stmt.step()) {
        const row = stmt.getAsObject();
        stmt.free();
        return row;
      }
      stmt.free();
      return undefined;
    },
    // Returns all rows
    all: (...params) => {
      const results = [];
      const stmt = db.prepare(sql);
      stmt.bind(params);
      while (stmt.step()) results.push(stmt.getAsObject());
      stmt.free();
      return results;
    },
    // Runs a write statement
    run: (...params) => {
      db.run(sql, params);
      db.save();
    },
  };
}

// ─── Proxy object that lazily gets db and exposes .prepare() ─────────────────
// Routes do: db.prepare('SELECT ...').get(...)
// This proxy intercepts that and injects the real db instance.
let _ready = false;
let _dbInstance = null;

const dbProxy = {
  _init: async () => {
    _dbInstance = await getDb();
    _ready = true;
  },
  prepare: (sql) => {
    if (!_dbInstance) throw new Error('DB not initialized. Call db._init() first.');
    return prepare(_dbInstance, sql);
  },
  exec: (sql) => {
    if (!_dbInstance) throw new Error('DB not initialized.');
    _dbInstance.run(sql);
    _dbInstance.save();
  },
};

module.exports = dbProxy;