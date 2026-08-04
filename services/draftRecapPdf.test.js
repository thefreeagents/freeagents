// Tests for the ESPN Draft Recap PDF parser.
//   1. parseDraftRecapText  — pure, on synthetic pdf-parse-style text.
//   2. parseDraftRecapPdf   — against Brian's REAL uploaded recap PDF, if present.
const assert = require('assert');
const fs = require('fs');
const { parseDraftRecapText, parseDraftRecapPdf, detectSeason } = require('./draftRecapPdf');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const ok = (c, m) => { assert.ok(c, m); passed++; };

// --- 1. Pure text parsing (mirrors how pdf-parse flattens each column) ------
// Per team: name, "OFFER AMOUNT", the amounts in pick order, "NO.PLAYER", then
// the players in the SAME order. Amounts and players are parallel arrays.
const synthetic = [
  'Season:',
  'Draft Recap',
  'The Free Agents',
  'Draft Date: Wed., Sep. 03, 2025Time: 9:00 PMType: Salary Cap',
  '2025',
  'You are currently viewing league history pages from the 2025 season.',
  'Sustained Excellence',
  'OFFER AMOUNT',
  '$12',
  '$4',
  '$1',
  'NO.PLAYER',
  '1Jahmyr Gibbs Det, RB',
  '5Justin Fields NYJ, QB',
  '130Jared Goff Det, QB',
  'Impeach Goodell!',
  'OFFER AMOUNT',
  '$15',
  '$46',
  'NO.PLAYER',
  '12Puka Nacua LAR, WR',
  '96Alvin Kamara NO, RB'
].join('\n');

const r = parseDraftRecapText(synthetic);
eq(r.players.length, 5, 'parsed all five players across two columns');
eq(r.season, '2025', 'detected the auction season');
eq(r.leagueName, 'The Free Agents', 'detected the league name');
const byName = Object.fromEntries(r.players.map(p => [p.name, p.price]));
eq(byName['Jahmyr Gibbs'], 12, 'Gibbs zipped to $12');
eq(byName['Justin Fields'], 4, 'Fields zipped to $4');
eq(byName['Jared Goff'], 1, 'high pick number (130) still parsed, $1');
eq(byName['Puka Nacua'], 15, 'second column zips independently, Puka $15');
eq(byName['Alvin Kamara'], 46, 'Kamara $46');
ok(r.warnings.length === 0, 'balanced columns produce no warnings');

// Mismatched column (more players than prices) -> warn, zip the overlap.
const bad = ['T', 'OFFER AMOUNT', '$5', 'NO.PLAYER', '1A B NYG, RB', '2C D SF, WR'].join('\n');
const rb = parseDraftRecapText(bad);
eq(rb.players.length, 1, 'mismatched column zips only the overlap');
ok(rb.warnings.length === 1, 'mismatched column raises a warning');

// detectSeason fallbacks
eq(detectSeason('Draft Date: Wed., Sep. 03, 2024 blah'), '2024', 'season from draft date');
eq(detectSeason('nothing here'), '', 'no season -> empty string');

console.log(`  draftRecapPdf pure-text: all ${passed} assertions passed.`);

// --- 2. Real PDF (skips cleanly if the upload isn't available) --------------
const REAL = '/sessions/brave-beautiful-knuth/mnt/uploads/Draft Recap - The Free Agents - ESPN Fantasy Football.pdf';
(async () => {
  if (!fs.existsSync(REAL)) {
    console.log('  (real-PDF check skipped — upload not present)\n');
    return;
  }
  const parsed = await parseDraftRecapPdf(fs.readFileSync(REAL));
  assert.ok(parsed.players.length >= 150, `expected the full auction (~176), got ${parsed.players.length}`);
  assert.strictEqual(parsed.season, '2025', 'real recap is the 2025 season');
  const m = Object.fromEntries(parsed.players.map(p => [p.name, p.price]));
  assert.strictEqual(m['Jahmyr Gibbs'], 12, 'real: Gibbs $12');
  assert.strictEqual(m['Justin Jefferson'], 70, 'real: Jefferson $70');
  assert.strictEqual(m['Bijan Robinson'], 12, 'real: Bijan $12');
  // Every price parses to a finite number ≥ 0. Some legitimate $0 entries exist
  // (keepers ESPN lists in the recap without an auction bid), so assert the bulk
  // are positive rather than requiring all of them to be.
  assert.ok(parsed.players.every(p => Number.isFinite(p.price) && p.price >= 0), 'every real price is a finite number ≥ 0');
  const positive = parsed.players.filter(p => p.price > 0).length;
  assert.ok(positive >= 150, `expected most players to have a real bid, got ${positive}/${parsed.players.length}`);
  console.log(`  draftRecapPdf real PDF: ${parsed.players.length} players (${positive} with a bid, ${parsed.players.length - positive} keeper $0). ✓\n`);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
