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

// Manual, admin-editable roster sections (order matters for display).
const SECTIONS = [
  { key: 'contract',       label: 'Contract Players', color: 'yellow' },
  { key: 'ncaa_contract',  label: 'NCAA Contracts',   color: 'green'  },
  { key: 'taxi',           label: 'Taxi Squad',       color: 'green'  },
  { key: 'ncaa_player',    label: 'NCAA Players',      color: 'yellow' }
];

// Auto-managed section, filled by the ESPN sync. It lists the team's current
// ESPN roster MINUS anyone already listed in a manual section (so nobody is
// shown twice). It is NOT hand-edited — the sync rebuilds it each run.
const ESPN_SECTION = { key: 'espn_active', label: 'On ESPN Roster', color: 'blue' };

// Display order on the public team page: the ESPN section sits right after the
// two contract sections, and before Taxi / NCAA Players.
const DISPLAY_SECTIONS = [
  SECTIONS[0], SECTIONS[1], ESPN_SECTION, SECTIONS[2], SECTIONS[3]
];

// All manually-managed sections — an ESPN player already in ANY of these is
// NOT duplicated into the ESPN section.
const MANUAL_SECTIONS = SECTIONS.map(s => s.key);
// The "active" contract sections we compare against ESPN to flag players who
// appear to have been dropped from the ESPN roster.
const CONTRACT_SECTIONS = ['contract', 'ncaa_contract'];

// Off-Season Mode roster caps (hard limits enforced by the move buttons).
const CONTRACT_CAP = 6; // max players in the 'contract' section per team
const TAXI_CAP = 2;     // max players in the 'taxi' section per team

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

    -- Off-Season Mode: the commissioner-set contract offer for an ESPN-listed
    -- player, so a team can see the available terms before signing. Kept in its
    -- own table (keyed by name) so it survives ESPN syncs, which rebuild the
    -- volatile espn_active player rows every run.
    CREATE TABLE IF NOT EXISTS espn_offers (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id       INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      player_name   TEXT NOT NULL,
      acq_type      TEXT DEFAULT 'auction',  -- 'auction' | 'waiver'
      auction_price INTEGER DEFAULT 0,       -- $ per year when acq_type='auction'
      updated_at    TEXT DEFAULT '',
      UNIQUE (team_id, player_name)
    );

    -- Off-Season Mode audit log. Every completed move is recorded here so the
    -- commissioner never loses track of what happened, and each row carries a
    -- JSON payload with everything needed to reverse it (the Undo button).
    CREATE TABLE IF NOT EXISTS transactions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,        -- 'drop' | 'promote_ncaac' | 'promote_taxi' | 'sign'
      player_name TEXT NOT NULL,
      summary     TEXT NOT NULL,        -- human-readable description
      payload     TEXT DEFAULT '',      -- JSON used to reverse the move
      undone      INTEGER DEFAULT 0,    -- 1 once undone (kept for the audit trail)
      created_at  TEXT DEFAULT ''
    );
  `);

  // Migrations for databases created before newer columns existed.
  for (const stmt of [
    "ALTER TABLE pages ADD COLUMN nav_label TEXT DEFAULT ''",
    'ALTER TABLE pages ADD COLUMN in_nav INTEGER DEFAULT 1',
    'ALTER TABLE pages ADD COLUMN nav_order INTEGER DEFAULT 100',
    // ESPN sync: link a site team to its ESPN team, and store standings.
    'ALTER TABLE teams ADD COLUMN espn_team_id INTEGER',
    "ALTER TABLE teams ADD COLUMN record TEXT DEFAULT ''",
    "ALTER TABLE teams ADD COLUMN points_for TEXT DEFAULT ''",
    // Flag players newly added by a sync so they're easy to spot/categorize.
    'ALTER TABLE players ADD COLUMN needs_review INTEGER DEFAULT 0',
    // Off-Season Mode: mark an NCAA Player as eligible to promote to Taxi Squad.
    'ALTER TABLE players ADD COLUMN eligible INTEGER DEFAULT 0',
    // All-time franchise records (from ESPN league history, or entered by hand).
    "ALTER TABLE teams ADD COLUMN all_time_record TEXT DEFAULT ''",
    "ALTER TABLE teams ADD COLUMN all_time_pf TEXT DEFAULT ''",
    'ALTER TABLE teams ADD COLUMN all_time_seasons INTEGER DEFAULT 0',
    // Off-Season Mode: group all moves from one "Submit" into a single batch so
    // the whole submission can be undone together (NULL = a legacy single move).
    'ALTER TABLE transactions ADD COLUMN batch_id INTEGER',
    // Team-owner logins: each team gets an email + password so its owner can log
    // in and make their own off-season moves. The commissioner (admin) can
    // manage every team; owners can manage only their own.
    "ALTER TABLE teams ADD COLUMN email TEXT DEFAULT ''",
    "ALTER TABLE teams ADD COLUMN password_hash TEXT DEFAULT ''"
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

module.exports = {
  db, init, SECTIONS, ESPN_SECTION, DISPLAY_SECTIONS,
  MANUAL_SECTIONS, CONTRACT_SECTIONS, CONTRACT_CAP, TAXI_CAP,
  navPages, DATA_DIR, UPLOAD_DIR
};
