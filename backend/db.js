require('dotenv').config();
const path = require('path');
const fs   = require('fs');

const IS_POSTGRES = process.env.DATABASE_URL?.startsWith('postgresql') ||
                    process.env.DATABASE_URL?.startsWith('postgres');

// ─── Schemas (separate for each DB) ──────────────────────────────────────────
const SQLITE_SCHEMA = `
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
    id                TEXT PRIMARY KEY,
    thread_id         TEXT NOT NULL,
    gmail_msg_id      TEXT,
    role              TEXT NOT NULL,
    from_name         TEXT NOT NULL,
    from_email        TEXT NOT NULL,
    body              TEXT NOT NULL,
    message_id_header TEXT,
    references_header TEXT,
    in_reply_to       TEXT,
    sent_at           INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS thread_access (
    thread_id  TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'owner',
    granted_at INTEGER DEFAULT (strftime('%s','now')),
    PRIMARY KEY (thread_id, user_id)
  );
`;

const POSTGRES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    email       TEXT UNIQUE NOT NULL,
    name        TEXT NOT NULL,
    gmail_token TEXT,
    created_at  BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
  );
  CREATE TABLE IF NOT EXISTS contacts (
    id         TEXT PRIMARY KEY,
    email      TEXT UNIQUE NOT NULL,
    name       TEXT,
    company    TEXT,
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
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
    created_at      BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()),
    updated_at      BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
  );
  CREATE TABLE IF NOT EXISTS messages (
    id                TEXT PRIMARY KEY,
    thread_id         TEXT NOT NULL,
    gmail_msg_id      TEXT,
    role              TEXT NOT NULL,
    from_name         TEXT NOT NULL,
    from_email        TEXT NOT NULL,
    body              TEXT NOT NULL,
    message_id_header TEXT,
    references_header TEXT,
    in_reply_to       TEXT,
    sent_at           BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
  );
  CREATE TABLE IF NOT EXISTS thread_access (
    thread_id  TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'owner',
    granted_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()),
    PRIMARY KEY (thread_id, user_id)
  );
`;

// ─── Postgres ─────────────────────────────────────────────────────────────────
async function initPostgres() {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  // Run each statement separately
  for (const stmt of POSTGRES_SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) {
    await pool.query(stmt);
  }
  console.log('✅ Postgres database initialized');

  function convertPlaceholders(sql) {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }

  return {
    prepare: (sql) => ({
      get:  async (...params) => { const r = await pool.query(convertPlaceholders(sql), params); return r.rows[0]; },
      all:  async (...params) => { const r = await pool.query(convertPlaceholders(sql), params); return r.rows; },
      run:  async (...params) => { await pool.query(convertPlaceholders(sql), params); },
    }),
    exec: async (sql) => { await pool.query(sql); },
  };
}

// ─── SQLite (development) ─────────────────────────────────────────────────────
async function initSqlite() {
  const initSqlJs = require('sql.js');
  const DB_PATH   = path.resolve('./mailflow.db');
  const SQL       = await initSqlJs();

  let db;
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  const save = () => fs.writeFileSync(DB_PATH, Buffer.from(db.export()));

  // Run each statement separately to avoid parser issues
  for (const stmt of SQLITE_SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) {
    db.run(stmt);
  }
  save();
  console.log('✅ SQLite database initialized at', DB_PATH);

  return {
    prepare: (sql) => ({
      get: (...params) => {
        const stmt = db.prepare(sql);
        stmt.bind(params);
        const row = stmt.step() ? stmt.getAsObject() : undefined;
        stmt.free();
        return row;
      },
      all: (...params) => {
        const rows = [];
        const stmt = db.prepare(sql);
        stmt.bind(params);
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
        return rows;
      },
      run: (...params) => {
        db.run(sql, params);
        save();
      },
    }),
    exec: (sql) => { db.run(sql); save(); },
  };
}

// ─── Proxy ────────────────────────────────────────────────────────────────────
let _dbInstance = null;

const dbProxy = {
  _init: async () => {
    _dbInstance = IS_POSTGRES ? await initPostgres() : await initSqlite();
  },
  prepare: (sql) => {
    if (!_dbInstance) throw new Error('DB not initialized. Await db._init() first.');
    return _dbInstance.prepare(sql);
  },
  exec: (sql) => {
    if (!_dbInstance) throw new Error('DB not initialized.');
    return _dbInstance.exec(sql);
  },
};

module.exports = dbProxy;