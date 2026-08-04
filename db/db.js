// Database connection + schema setup for The Free Agents.
// Uses Node's built-in SQLite (node:sqlite) — no native build step required.
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

// Where the database + uploaded sessions live. Override with DATA_DIR to put
// the database on a persistent disk (e.g. a mounted volume on your host).
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Uploaded images (team + player photos) also live under DATA_DIR so they
// survive on the same persistent disk as the database.
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'freeagents.db'));
// WAL gives better concurrency but isn't supported on some network/FUSE
// filesystems, so try it and fall back to the default journal mode.
try { db.exec('PRAGMA journal_mode = WAL'); } catch (e) { /* keep default */ }
db.exec('PRAGMA foreign_keys = ON');

// The roster sections used on every team page (order matters for display).
const SECTIONS = [
  { key: 'contract',       label: 'Contract Players', color: 'yellow' },
  { key: 'ncaa_contract',  label: 'NCAA Contracts',   color: 'green'  },
  { key: 'taxi',           label: 'Taxi Squad',       color: 'green'  },
  { key: 'ncaa_player',    label: 'NCAA Players',      color: 'yellow' }
];

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      slug        TEXT UNIQUE NOT NULL,
      name        TEXT NOT NULL,
      owner       TEXT DEFAULT '',
      tagline     TEXT DEFAULT '',
      championships TEXT DEFAULT '',
      image       TEXT DEFAULT '',
      sort_order  INTEGER DEFAULT 0,
      updated_at  TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS players (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id    INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      section    TEXT NOT NULL,
      contracts  TEXT DEFAULT '',
      image      TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS pages (
      slug       TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      nav_label  TEXT DEFAULT '',
      content    TEXT DEFAULT '',
      in_nav     INTEGER DEFAULT 1,
      nav_order  INTEGER DEFAULT 100,
      updated_at TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS admins (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL
    );
  `);

  // Migrations for databases created before the nav columns existed.
  for (const stmt of [
    "ALTER TABLE pages ADD COLUMN nav_label TEXT DEFAULT ''",
    'ALTER TABLE pages ADD COLUMN in_nav INTEGER DEFAULT 1',
    'ALTER TABLE pages ADD COLUMN nav_order INTEGER DEFAULT 100'
  ]) {
    try { db.exec(stmt); } catch (e) { /* column already exists */ }
  }
}

// Pages shown in the top menu, in order. Used by the site nav.
function navPages() {
  return db.prepare(
    'SELECT slug, title, nav_label FROM pages WHERE in_nav = 1 ORDER BY nav_order, title'
  ).all().map(p => ({ slug: p.slug, label: p.nav_label || p.title }));
}

module.exports = { db, init, SECTIONS, navPages, DATA_DIR, UPLOAD_DIR };
