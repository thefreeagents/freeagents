// End-to-end test for syncLeague against a TEMP database with a MOCKED ESPN
// HTTP response (global fetch is stubbed). Verifies the sync is non-destructive:
//   - manual sections (contract/ncaa_contract/taxi/ncaa_player) are untouched
//   - the espn_active section is rebuilt and excludes manual duplicates
//   - team record + points_for are updated
//   - possiblyDropped is reported but nobody is deleted
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Point the DB at a throwaway dir BEFORE requiring db/db.js.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-sync-'));
process.env.DATA_DIR = tmp;

const { db, init } = require('../db/db');
const espnSync = require('./espnSync');
init();

// --- Seed two teams with manual rosters ------------------------------------
const insTeam = db.prepare('INSERT INTO teams (slug, name, sort_order, updated_at) VALUES (?, ?, ?, ?)');
const t1 = insTeam.run('sustained-excellence', 'Sustained Excellence', 0, '2026-01-01').lastInsertRowid;
const t2 = insTeam.run('impeach-goodell', 'Impeach Goodell!!', 1, '2026-01-01').lastInsertRowid;

const insPlayer = db.prepare('INSERT INTO players (team_id, name, section, contracts, sort_order) VALUES (?, ?, ?, ?, ?)');
// Team 1 manual roster
insPlayer.run(t1, 'Joe Burrow',   'contract',      '2025: $12', 0);
insPlayer.run(t1, 'Puka Nacua',   'contract',      '2025: $15', 1);
insPlayer.run(t1, 'Xavier Worthy', 'ncaa_contract', '2025: $10', 2);
insPlayer.run(t1, 'Kenny McIntosh', 'taxi',        '2025: $10', 3);   // never on ESPN
insPlayer.run(t1, 'Evan Stewart',  'ncaa_player',  '',           4);   // never on ESPN

// --- Configure league + mapping --------------------------------------------
espnSync.setSetting('espn_league_id', '374586');
espnSync.setSetting('espn_season', '2026');
db.prepare('UPDATE teams SET espn_team_id = ? WHERE id = ?').run(101, t1);
db.prepare('UPDATE teams SET espn_team_id = ? WHERE id = ?').run(102, t2);

// --- Mock the ESPN HTTP response -------------------------------------------
const espnPayload = {
  settings: { name: 'The Free Agents' },
  teams: [
    {
      id: 101, name: 'Sustained Excellence',
      record: { overall: { wins: 4, losses: 1, ties: 0, pointsFor: 501.4 } },
      roster: { entries: [
        { playerPoolEntry: { player: { fullName: 'Joe Burrow' } } },     // already contract -> excluded
        { playerPoolEntry: { player: { fullName: 'Xavier Worthy' } } },  // already ncaa_contract -> excluded
        { playerPoolEntry: { player: { fullName: 'Bijan Robinson' } } }, // new -> espn_active
        { playerPoolEntry: { player: { fullName: 'CeeDee Lamb' } } }     // new -> espn_active
      ] }
    },
    {
      id: 102, name: 'Impeach Goodell!!',
      record: { overall: { wins: 2, losses: 3, ties: 0, pointsFor: 402.1 } },
      roster: { entries: [
        { playerPoolEntry: { player: { fullName: 'Jalen Hurts' } } }
      ] }
    }
  ]
};
global.fetch = async () => ({
  ok: true, status: 200,
  json: async () => espnPayload
});

(async () => {
  const report = await espnSync.syncLeague();

  // --- Team 1 assertions ---------------------------------------------------
  const t1players = db.prepare('SELECT name, section FROM players WHERE team_id = ? ORDER BY section, name').all(t1);
  const bySection = s => t1players.filter(p => p.section === s).map(p => p.name).sort();

  assert.deepStrictEqual(bySection('contract'), ['Joe Burrow', 'Puka Nacua'], 'contract untouched');
  assert.deepStrictEqual(bySection('ncaa_contract'), ['Xavier Worthy'], 'ncaa_contract untouched');
  assert.deepStrictEqual(bySection('taxi'), ['Kenny McIntosh'], 'taxi untouched');
  assert.deepStrictEqual(bySection('ncaa_player'), ['Evan Stewart'], 'ncaa_player untouched');
  assert.deepStrictEqual(bySection('espn_active'), ['Bijan Robinson', 'CeeDee Lamb'],
    'espn_active = ESPN roster minus manual dupes');

  const team1 = db.prepare('SELECT record, points_for FROM teams WHERE id = ?').get(t1);
  assert.strictEqual(team1.record, '4-1', 'record updated');
  assert.strictEqual(team1.points_for, '501.4', 'points_for updated');

  // --- Report assertions ---------------------------------------------------
  const r1 = report.teams.find(t => t.team === 'Sustained Excellence');
  assert.deepStrictEqual(r1.added.sort(), ['Bijan Robinson', 'CeeDee Lamb'], 'first-sync added list');
  const dropped = r1.possiblyDropped.map(p => p.name);
  assert.ok(dropped.includes('Puka Nacua'), 'Puka (contract, not on ESPN) flagged as possibly dropped');
  assert.ok(!dropped.includes('Kenny McIntosh'), 'taxi never flagged dropped');
  assert.ok(!dropped.includes('Evan Stewart'), 'ncaa_player never flagged dropped');

  // --- Idempotency / second sync -------------------------------------------
  const report2 = await espnSync.syncLeague();
  const t1again = db.prepare("SELECT name FROM players WHERE team_id = ? AND section='espn_active' ORDER BY name").all(t1).map(p => p.name);
  assert.deepStrictEqual(t1again, ['Bijan Robinson', 'CeeDee Lamb'], 'second sync: espn_active not duplicated');
  const r1b = report2.teams.find(t => t.team === 'Sustained Excellence');
  assert.deepStrictEqual(r1b.added, [], 'second sync: nothing newly added');

  // Team 2 had no manual players; its whole ESPN roster becomes espn_active.
  const t2active = db.prepare("SELECT name FROM players WHERE team_id = ? AND section='espn_active'").all(t2).map(p => p.name);
  assert.deepStrictEqual(t2active, ['Jalen Hurts'], 'team 2 espn_active populated');

  console.log('\n  syncLeague end-to-end: all assertions passed.');
  console.log('  (non-destructive, dedup-aware, idempotent)\n');

  // cleanup
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
