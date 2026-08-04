// End-to-end test for priceFromEspn against a TEMP database with a MOCKED ESPN.
// The key behaviour under test (Brian's keeper/auction league):
//   - The ROSTER is read from the current season (espn_season).
//   - The AUCTION BIDS are read from a SEPARATE season (espn_auction_season),
//     because last year's winning bids become this year's contract prices.
//   - ESPN player IDs are stable across seasons, so a 2025 bid maps onto the
//     2026 roster by playerId.
//   - DRAFT acquisitions get the auction price; everything else gets waiver terms.
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-price-'));
process.env.DATA_DIR = tmp;

const { db, init } = require('../db/db');
const espnSync = require('./espnSync');
init();

// --- Seed one team + its espn_active roster --------------------------------
const insTeam = db.prepare('INSERT INTO teams (slug, name, sort_order, updated_at) VALUES (?, ?, ?, ?)');
const t1 = insTeam.run('sustained-excellence', 'Sustained Excellence', 0, '2026-01-01').lastInsertRowid;

const insPlayer = db.prepare('INSERT INTO players (team_id, name, section, contracts, sort_order) VALUES (?, ?, ?, ?, ?)');
// Two priced players (espn_active) + one keeper (contract, must NOT be priced).
insPlayer.run(t1, 'Bijan Robinson', 'espn_active', '', 0);   // DRAFT -> auction price
insPlayer.run(t1, 'CeeDee Lamb',    'espn_active', '', 1);   // ADD   -> waiver terms
insPlayer.run(t1, 'Joe Burrow',     'contract',    '2025: $12', 2); // keeper, excluded

espnSync.setSetting('espn_league_id', '374586');
espnSync.setSetting('espn_season', '2026');          // roster season
espnSync.setSetting('espn_auction_season', '2025');  // auction-price season
db.prepare('UPDATE teams SET espn_team_id = ? WHERE id = ?').run(101, t1);

// --- Mock ESPN: roster from 2026, draft (bids) from 2025 -------------------
// ESPN player IDs: Bijan=1001, CeeDee=1002, Burrow=1003.
const rosterPayload2026 = {
  settings: { name: 'The Free Agents' },
  teams: [{
    id: 101, name: 'Sustained Excellence',
    roster: { entries: [
      { playerId: 1001, acquisitionType: 'DRAFT', playerPoolEntry: { player: { id: 1001, fullName: 'Bijan Robinson' } } },
      { playerId: 1002, acquisitionType: 'ADD',   playerPoolEntry: { player: { id: 1002, fullName: 'CeeDee Lamb' } } },
      { playerId: 1003, acquisitionType: 'DRAFT', playerPoolEntry: { player: { id: 1003, fullName: 'Joe Burrow' } } }
    ] }
  }]
};
// 2025 auction results. Note Burrow (1003) has a bid too, but he's a keeper on
// the site (contract section) so he must never be priced.
const draftPayload2025 = { draftDetail: { picks: [
  { playerId: 1001, teamId: 101, bidAmount: 41 },  // Bijan's REAL 2025 winning bid
  { playerId: 1003, teamId: 101, bidAmount: 12 }   // Burrow — keeper, ignored
] } };

const fetchedUrls = [];
global.fetch = async (url) => {
  fetchedUrls.push(url);
  const isDraft = String(url).includes('mDraftDetail');
  return {
    ok: true, status: 200,
    json: async () => (isDraft ? draftPayload2025 : rosterPayload2026)
  };
};

let passed = 0;
function eq(a, b, msg) { assert.deepStrictEqual(a, b, msg); passed++; }
function ok(c, msg) { assert.ok(c, msg); passed++; }

(async () => {
  const report = await espnSync.priceFromEspn();

  // --- The two feeds hit the right seasons ---------------------------------
  const rosterCall = fetchedUrls.find(u => !String(u).includes('mDraftDetail'));
  const draftCall  = fetchedUrls.find(u =>  String(u).includes('mDraftDetail'));
  ok(String(rosterCall).includes('/seasons/2026/'), 'roster is read from the current season (2026)');
  ok(String(draftCall).includes('/seasons/2025/'),  'auction bids are read from the auction season (2025)');
  eq(report.auctionSeason, '2025', 'report names the auction season used');

  // --- Offers written to the DB --------------------------------------------
  const offers = db.prepare('SELECT player_name, acq_type, auction_price FROM espn_offers WHERE team_id = ? ORDER BY player_name').all(t1);
  const byName = Object.fromEntries(offers.map(o => [o.player_name, o]));

  ok(!byName['Joe Burrow'], 'keeper (contract player) is never priced');
  eq(byName['Bijan Robinson'].acq_type, 'auction', 'DRAFT player priced at auction');
  eq(byName['Bijan Robinson'].auction_price, 41, "Bijan gets his real 2025 winning bid, not $0 or an estimate");
  eq(byName['CeeDee Lamb'].acq_type, 'waiver', 'ADD player gets waiver terms');
  eq(byName['CeeDee Lamb'].auction_price, 0, 'waiver player has no auction price');

  eq(report.priced, 2, 'exactly the two espn_active players were priced');
  eq(report.stats.auction, 1, 'one auction offer');
  eq(report.stats.waiver, 1, 'one waiver offer');
  eq(report.draftPicksWithBid, 2, 'both 2025 picks carried a bid amount');

  // --- auctionSeason() default (blank override -> roster season - 1) --------
  espnSync.setSetting('espn_auction_season', '');
  eq(espnSync.auctionSeason(), '2025', 'blank override defaults to roster season minus one');
  espnSync.setSetting('espn_auction_season', '2024');
  eq(espnSync.auctionSeason(), '2024', 'explicit override wins');

  console.log(`\n  priceFromEspn end-to-end: all ${passed} assertions passed.`);
  console.log('  (roster=2026, auction bids=2025, keepers excluded)\n');

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
