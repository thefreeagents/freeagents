// Unit tests for the shared off-season move logic.
// Run: node services/offseasonMoves.test.js   (uses a throwaway DB in /tmp)
const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

// Point the app at a fresh, isolated database BEFORE requiring db.js.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osmoves-'));
process.env.DATA_DIR = tmp;

const dbMod = require('../db/db');
const { db } = dbMod;
dbMod.init(); // create the schema in the throwaway DB
const espnSync = require('../services/espnSync');
const moves = require('../services/offseasonMoves');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

// --- helpers ---------------------------------------------------------------
function newTeam(name) {
  const info = db.prepare('INSERT INTO teams (slug, name, sort_order, updated_at) VALUES (?, ?, 0, ?)')
    .run(name.toLowerCase().replace(/\W+/g, '-'), name, '2026-01-01');
  return info.lastInsertRowid;
}
function addPlayer(teamId, name, section, extra = {}) {
  const info = db.prepare(
    'INSERT INTO players (team_id, name, section, contracts, eligible, sort_order, image) VALUES (?, ?, ?, ?, ?, 0, ?)'
  ).run(teamId, name, section, extra.contracts || '', extra.eligible ? 1 : 0, extra.image || '');
  return info.lastInsertRowid;
}
const section = (id) => db.prepare('SELECT section FROM players WHERE id = ?').get(id);
const exists  = (id) => !!db.prepare('SELECT 1 FROM players WHERE id = ?').get(id);
const lastTxn = (teamId) => db.prepare('SELECT * FROM transactions WHERE team_id = ? ORDER BY id DESC LIMIT 1').get(teamId);

espnSync.setSetting('offseason_mode', '1');
espnSync.setSetting('espn_season', '2026');

// --- 1. Drop a taxi player + undo -----------------------------------------
(() => {
  const t = newTeam('Drop Test');
  const pid = addPlayer(t, 'Taxi Guy', 'taxi', { contracts: '2026: $3' });
  const code = moves.dropTaxi(t, pid);
  ok(code === 'dropped', 'dropTaxi returns dropped');
  ok(!exists(pid), 'taxi player removed');
  const txn = lastTxn(t);
  ok(txn.kind === 'drop', 'drop txn logged');
  const undo = moves.undo(t, txn.id);
  ok(undo === 'undone', 'undo returns undone');
  const restored = db.prepare("SELECT * FROM players WHERE team_id = ? AND name = 'Taxi Guy'").get(t);
  ok(restored && restored.section === 'taxi', 'dropped taxi player restored to taxi');
  ok(restored.contracts === '2026: $3', 'restored player keeps its contract text');
})();

// --- 2. Promote taxi -> NCAA Contracts + undo -----------------------------
(() => {
  const t = newTeam('Promote NCAAC');
  const pid = addPlayer(t, 'Riser', 'taxi');
  ok(moves.taxiToNcaac(t, pid) === 'promoted_ncaac', 'taxiToNcaac code');
  ok(section(pid).section === 'ncaa_contract', 'moved to ncaa_contract');
  moves.undo(t, lastTxn(t).id);
  ok(section(pid).section === 'taxi', 'undo returns to taxi');
})();

// --- 3. Eligibility toggle -------------------------------------------------
(() => {
  const t = newTeam('Eligible Test');
  const pid = addPlayer(t, 'Prospect', 'ncaa_player');
  moves.toggleEligible(t, pid);
  ok(db.prepare('SELECT eligible FROM players WHERE id = ?').get(pid).eligible === 1, 'eligible set on');
  moves.toggleEligible(t, pid);
  ok(db.prepare('SELECT eligible FROM players WHERE id = ?').get(pid).eligible === 0, 'eligible toggled off');
})();

// --- 4. NCAA Player -> Taxi (eligibility + cap) + undo --------------------
(() => {
  const t = newTeam('NCAA to Taxi');
  const pid = addPlayer(t, 'Callup', 'ncaa_player');
  ok(moves.ncaaToTaxi(t, pid) === 'not_eligible', 'blocked when not eligible');
  ok(section(pid).section === 'ncaa_player', 'stays put when not eligible');
  moves.toggleEligible(t, pid);
  // Fill the taxi squad to the cap.
  for (let i = 0; i < moves.TAXI_CAP; i++) addPlayer(t, 'Filler' + i, 'taxi');
  ok(moves.ncaaToTaxi(t, pid) === 'taxi_full', 'blocked when taxi full');
  // Open a slot, then succeed.
  const filler = db.prepare("SELECT id FROM players WHERE team_id = ? AND section='taxi' LIMIT 1").get(t);
  db.prepare('DELETE FROM players WHERE id = ?').run(filler.id);
  ok(moves.ncaaToTaxi(t, pid) === 'promoted_taxi', 'promotes when eligible + room');
  ok(section(pid).section === 'taxi', 'now on taxi');
  ok(db.prepare('SELECT eligible FROM players WHERE id = ?').get(pid).eligible === 0, 'eligibility cleared after promote');
  moves.undo(t, lastTxn(t).id);
  ok(section(pid).section === 'ncaa_player', 'undo back to ncaa_player');
  ok(db.prepare('SELECT eligible FROM players WHERE id = ?').get(pid).eligible === 1, 'undo restores eligibility');
})();

// --- 5. Drop NCAA Contract + undo -----------------------------------------
(() => {
  const t = newTeam('Drop NCAAC');
  const pid = addPlayer(t, 'NcaacGuy', 'ncaa_contract', { contracts: '2026: $5' });
  ok(moves.dropNcaac(t, pid) === 'dropped_ncaac', 'dropNcaac code');
  ok(!exists(pid), 'ncaac player removed');
  moves.undo(t, lastTxn(t).id);
  const restored = db.prepare("SELECT * FROM players WHERE team_id = ? AND name='NcaacGuy'").get(t);
  ok(restored && restored.section === 'ncaa_contract', 'restored to ncaa_contract');
})();

// --- 6. Offer + Sign (auction) + undo -------------------------------------
(() => {
  const t = newTeam('Sign Test');
  const pid = addPlayer(t, 'Star WR', 'espn_active');
  ok(moves.saveOffer(t, { player_name: 'Star WR', acq_type: 'auction', auction_price: '10' }) === 'offer_saved', 'offer saved');
  const offer = db.prepare('SELECT * FROM espn_offers WHERE team_id = ? AND player_name = ?').get(t, 'Star WR');
  ok(offer && offer.acq_type === 'auction' && offer.auction_price === 10, 'offer stored correctly');
  ok(moves.signPlayer(t, { player_name: 'Star WR', years: '2' }) === 'signed', 'sign code');
  ok(!exists(pid), 'espn_active row removed after signing');
  const contract = db.prepare("SELECT * FROM players WHERE team_id = ? AND name='Star WR' AND section='contract'").get(t);
  ok(contract, 'contract row created');
  ok(contract.contracts === '2026: $10\n2027: $10', 'auction schedule is flat price for chosen years');
  ok(!db.prepare('SELECT 1 FROM espn_offers WHERE team_id = ? AND player_name = ?').get(t, 'Star WR'), 'offer cleared after signing');
  // Undo the sign: contract removed, back on ESPN list, offer restored.
  moves.undo(t, lastTxn(t).id);
  ok(!db.prepare("SELECT 1 FROM players WHERE team_id=? AND name='Star WR' AND section='contract'").get(t), 'undo removes contract');
  ok(db.prepare("SELECT 1 FROM players WHERE team_id=? AND name='Star WR' AND section='espn_active'").get(t), 'undo restores espn_active');
  ok(db.prepare('SELECT 1 FROM espn_offers WHERE team_id=? AND player_name=?').get(t, 'Star WR'), 'undo restores offer');
})();

// --- 7. Waiver schedule + contract cap ------------------------------------
(() => {
  const t = newTeam('Waiver + Cap');
  // Waiver sign: $11 then $15.
  addPlayer(t, 'Waiver Guy', 'espn_active');
  moves.saveOffer(t, { player_name: 'Waiver Guy', acq_type: 'waiver' });
  ok(moves.signPlayer(t, { player_name: 'Waiver Guy', years: '2' }) === 'signed', 'waiver sign ok');
  const wc = db.prepare("SELECT contracts FROM players WHERE team_id=? AND name='Waiver Guy'").get(t);
  ok(wc.contracts === '2026: $11\n2027: $15', 'waiver schedule is 11 then 15');
  // Fill contracts to the cap, then attempt one more.
  const current = db.prepare("SELECT COUNT(*) c FROM players WHERE team_id=? AND section='contract'").get(t).c;
  for (let i = current; i < moves.CONTRACT_CAP; i++) addPlayer(t, 'C' + i, 'contract');
  addPlayer(t, 'Overflow', 'espn_active');
  moves.saveOffer(t, { player_name: 'Overflow', acq_type: 'auction', auction_price: '4' });
  ok(moves.signPlayer(t, { player_name: 'Overflow', years: '1' }) === 'contract_full', 'blocked at contract cap');
  ok(db.prepare("SELECT 1 FROM players WHERE team_id=? AND name='Overflow' AND section='espn_active'").get(t), 'overflow stays on ESPN list');
})();

// --- 8. Eligible NCAA Player: Activate / Taxi / Drop dispatcher -----------
(() => {
  const t = newTeam('NCAA Eligible');

  // A selection is required: no/unknown action changes nothing.
  const nc = addPlayer(t, 'Nochoice', 'ncaa_player', { eligible: true });
  ok(moves.ncaaEligibleMove(t, nc, '') === 'choose_action', 'empty action -> choose_action');
  ok(moves.ncaaEligibleMove(t, nc, 'bogus') === 'choose_action', 'unknown action -> choose_action');
  ok(section(nc).section === 'ncaa_player', 'no-choice player is untouched');

  // Must be eligible first.
  const ie = addPlayer(t, 'Ineligible', 'ncaa_player');
  ok(moves.ncaaEligibleMove(t, ie, 'activate') === 'not_eligible', 'ineligible blocked');
  ok(section(ie).section === 'ncaa_player', 'ineligible player untouched');

  // Activate -> NCAA Contracts, and undo restores an eligible ncaa_player.
  const a = addPlayer(t, 'Activate Me', 'ncaa_player', { eligible: true });
  ok(moves.ncaaEligibleMove(t, a, 'activate') === 'activated_ncaac', 'activate code');
  ok(section(a).section === 'ncaa_contract', 'activated into ncaa_contract');
  ok(lastTxn(t).kind === 'activate_ncaac', 'activate txn logged');
  moves.undo(t, lastTxn(t).id);
  ok(section(a).section === 'ncaa_player', 'undo activate -> ncaa_player');
  ok(db.prepare('SELECT eligible FROM players WHERE id = ?').get(a).eligible === 1, 'undo activate restores eligibility');

  // Taxi -> reuses ncaaToTaxi (cap-aware).
  const x = addPlayer(t, 'Taxi Me', 'ncaa_player', { eligible: true });
  ok(moves.ncaaEligibleMove(t, x, 'taxi') === 'promoted_taxi', 'taxi code via dispatcher');
  ok(section(x).section === 'taxi', 'taxi via dispatcher moves to taxi');

  // Drop -> removed, and undo restores an eligible ncaa_player.
  const d = addPlayer(t, 'Drop Me', 'ncaa_player', { eligible: true, contracts: 'watch' });
  ok(moves.ncaaEligibleMove(t, d, 'drop') === 'dropped_ncaa', 'drop code');
  ok(!exists(d), 'dropped ncaa_player removed');
  ok(lastTxn(t).kind === 'drop_ncaa', 'drop_ncaa txn logged');
  moves.undo(t, lastTxn(t).id);
  const dr = db.prepare("SELECT * FROM players WHERE team_id = ? AND name = 'Drop Me'").get(t);
  ok(dr && dr.section === 'ncaa_player' && dr.eligible === 1, 'undo drop restores eligible ncaa_player');
})();

console.log(`offseasonMoves.test.js — all ${passed} assertions passed`);
