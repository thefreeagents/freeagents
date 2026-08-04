// End-to-end test for priceFromPdf against a TEMP database.
//   - ESPN roster feed is MOCKED (global fetch) to supply acquisitionType
//     (DRAFT vs ADD) — the part ESPN gets right even for a private league.
//   - The auction PRICES come from Brian's REAL uploaded Draft Recap PDF.
// Verifies the intended split: DRAFT players get their real PDF bid, free-agent
// pickups get waiver terms, and keepers (Contract Players) are never priced.
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const REAL_PDF = '/sessions/brave-beautiful-knuth/mnt/uploads/Draft Recap - The Free Agents - ESPN Fantasy Football.pdf';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-pricepdf-'));
process.env.DATA_DIR = tmp;

const { db, init } = require('../db/db');
const espnSync = require('./espnSync');
init();

if (!fs.existsSync(REAL_PDF)) {
  console.log('  (priceFromPdf e2e skipped — recap upload not present)\n');
  process.exit(0);
}

// --- Seed one team: two drafted players, one FA pickup, one keeper ----------
const t1 = db.prepare('INSERT INTO teams (slug, name, sort_order, updated_at) VALUES (?, ?, ?, ?)')
  .run('sustained-excellence', 'Sustained Excellence', 0, '2026-01-01').lastInsertRowid;
const insPlayer = db.prepare('INSERT INTO players (team_id, name, section, contracts, sort_order) VALUES (?, ?, ?, ?, ?)');
insPlayer.run(t1, 'Bijan Robinson',   'espn_active', '', 0); // DRAFT  -> auction $12 (from PDF)
insPlayer.run(t1, 'Justin Jefferson', 'espn_active', '', 1); // DRAFT  -> auction $70 (from PDF)
insPlayer.run(t1, 'CeeDee Lamb',      'espn_active', '', 2); // ADD    -> waiver terms
insPlayer.run(t1, 'Joe Burrow',       'contract',    '2025: $12', 3); // keeper -> never priced

espnSync.setSetting('espn_league_id', '374586');
espnSync.setSetting('espn_season', '2026');
db.prepare('UPDATE teams SET espn_team_id = ? WHERE id = ?').run(101, t1);

// --- Mock ONLY the roster feed (acquisitionType). No draft-detail needed. ---
const rosterPayload = {
  settings: { name: 'The Free Agents' },
  teams: [{
    id: 101, name: 'Sustained Excellence',
    roster: { entries: [
      { playerId: 1, acquisitionType: 'DRAFT', playerPoolEntry: { player: { id: 1, fullName: 'Bijan Robinson' } } },
      { playerId: 2, acquisitionType: 'DRAFT', playerPoolEntry: { player: { id: 2, fullName: 'Justin Jefferson' } } },
      { playerId: 3, acquisitionType: 'ADD',   playerPoolEntry: { player: { id: 3, fullName: 'CeeDee Lamb' } } }
    ] }
  }]
};
global.fetch = async () => ({ ok: true, status: 200, json: async () => rosterPayload });

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const ok = (c, m) => { assert.ok(c, m); passed++; };

(async () => {
  const report = await espnSync.priceFromPdf(fs.readFileSync(REAL_PDF));

  eq(report.source, 'pdf', 'report flags the PDF source');
  eq(report.auctionSeason, '2025', 'auction season detected from the PDF');
  ok(report.recapPlayers >= 150, 'read the full recap');

  const offers = db.prepare('SELECT player_name, acq_type, auction_price FROM espn_offers WHERE team_id = ? ORDER BY player_name').all(t1);
  const by = Object.fromEntries(offers.map(o => [o.player_name, o]));

  ok(!by['Joe Burrow'], 'keeper (contract player) is never priced');
  eq(by['Bijan Robinson'].acq_type, 'auction', 'DRAFT player -> auction');
  eq(by['Bijan Robinson'].auction_price, 12, 'Bijan gets his REAL 2025 bid ($12) from the PDF');
  eq(by['Justin Jefferson'].acq_type, 'auction', 'DRAFT player -> auction');
  eq(by['Justin Jefferson'].auction_price, 70, 'Jefferson gets $70 from the PDF (not $0!)');
  eq(by['CeeDee Lamb'].acq_type, 'waiver', 'ESPN ADD -> waiver, PDF price ignored');
  eq(by['CeeDee Lamb'].auction_price, 0, 'waiver player has no auction price');

  eq(report.priced, 3, 'priced exactly the three espn_active players');
  eq(report.stats.auction, 2, 'two auction offers');
  eq(report.stats.waiver, 1, 'one waiver offer');
  eq(report.stats.auctionNoBid.length, 0, 'both drafted players found a price -> none flagged');

  console.log(`\n  priceFromPdf end-to-end: all ${passed} assertions passed.`);
  console.log('  (DRAFT->real PDF price, ADD->waiver, keeper excluded)\n');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
