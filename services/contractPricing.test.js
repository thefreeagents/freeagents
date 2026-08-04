// Unit tests for the ESPN-based contract pricing engine + extractors.
// Run with:  node services/contractPricing.test.js
// No network: we feed a hand-built payload shaped like ESPN's mRoster +
// mDraftDetail response.

const assert = require('assert');
const { parseRosterEntries, parseDraftPicks } = require('./espn');
const { computeOffersFromEspn, computeOffersFromRecap, acqReason, applyAuctionFloor } = require('./contractPricing');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }
function eq(a, b, msg) { assert.strictEqual(a, b, msg); passed++; }

// ---------------------------------------------------------------------------
// A realistic-ish ESPN payload. Two mapped teams (espn ids 1 and 2) plus one
// unmapped team (id 9), a draft with bid amounts, and roster entries carrying
// acquisitionType.
// ---------------------------------------------------------------------------
const payload = {
  teams: [
    {
      id: 1,
      roster: { entries: [
        { playerId: 101, acquisitionType: 'DRAFT', playerPoolEntry: { player: { fullName: 'Josh Allen' } } },
        { playerId: 102, acquisitionType: 'DRAFT', playerPoolEntry: { player: { fullName: 'Patrick Mahomes' } } },
        { playerId: 103, acquisitionType: 'ADD',   playerPoolEntry: { player: { fullName: 'Waiver Wire Willie' } } },
        // A contract player also shows on ESPN's roster but is NOT espn_active
        // on the site, so must be skipped by the pricing engine.
        { playerId: 104, acquisitionType: 'DRAFT', playerPoolEntry: { player: { fullName: 'Existing Contract Dude' } } }
      ] }
    },
    {
      id: 2,
      roster: { entries: [
        // Drafted originally, but acquisitionType is TRADE now -> waiver terms.
        { playerId: 201, acquisitionType: 'TRADE', playerPoolEntry: { player: { fullName: 'Bijan Robinson' } } },
        // Name-punctuation differs from site spelling ("A.J." vs "AJ").
        { playerId: 202, acquisitionType: 'DRAFT', playerPoolEntry: { player: { fullName: 'A.J. Brown' } } },
        // Drafted but has no bid amount in draftDetail -> auction, price 0, flagged.
        { playerId: 203, acquisitionType: 'DRAFT', playerPoolEntry: { player: { fullName: 'No Bid Nolan' } } }
      ] }
    },
    {
      // An unmapped ESPN team (no site mapping) -> its players are ignored + counted.
      id: 9,
      roster: { entries: [
        { playerId: 900, acquisitionType: 'DRAFT', playerPoolEntry: { player: { fullName: 'Ghost Player' } } }
      ] }
    }
  ],
  draftDetail: { picks: [
    { playerId: 101, teamId: 1, bidAmount: 54 },
    { playerId: 102, teamId: 1, bidAmount: 47 },
    { playerId: 104, teamId: 1, bidAmount: 20 },
    { playerId: 201, teamId: 3, bidAmount: 41 }, // drafted by team 3 originally
    { playerId: 202, teamId: 2, bidAmount: 33 },
    { playerId: 900, teamId: 9, bidAmount: 12 }
    // note: 203 (No Bid Nolan) intentionally absent from the draft
  ] }
};

// ---- extractor: parseRosterEntries ----------------------------------------
const entries = parseRosterEntries(payload);
eq(entries.length, 8, 'all rostered players extracted across teams');
const allen = entries.find(e => e.playerName === 'Josh Allen');
eq(allen.espnTeamId, 1, 'Josh Allen on espn team 1');
eq(allen.acquisitionType, 'DRAFT', 'Josh Allen acquisitionType captured');
eq(allen.playerId, 101, 'Josh Allen playerId captured');

// ---- extractor: parseDraftPicks -------------------------------------------
const picks = parseDraftPicks(payload);
eq(picks.length, 6, 'all draft picks extracted');
eq(picks.find(p => p.playerId === 101).bidAmount, 54, 'bid amount captured');

// ---- pricing engine -------------------------------------------------------
// Site teams: espn 1 -> site 10, espn 2 -> site 20. espn 9 unmapped.
const espnToSiteTeam = { 1: 10, 2: 20 };
const espnActive = [
  { team_id: 10, name: 'Josh Allen' },
  { team_id: 10, name: 'Patrick Mahomes' },
  { team_id: 10, name: 'Waiver Wire Willie' },
  { team_id: 20, name: 'Bijan Robinson' },
  { team_id: 20, name: 'AJ Brown' },       // site spelling differs from ESPN "A.J. Brown"
  { team_id: 20, name: 'No Bid Nolan' }
  // "Existing Contract Dude" and "Ghost Player" deliberately NOT in espn_active
];

const { offers, stats } = computeOffersFromEspn({
  rosterEntries: entries, draftPicks: picks, espnActive, espnToSiteTeam
});

const byName = Object.fromEntries(offers.map(o => [o.player_name, o]));

// DRAFT + bid -> auction at bid amount
eq(byName['Josh Allen'].acq_type, 'auction', 'Josh Allen = auction');
eq(byName['Josh Allen'].auction_price, 54, 'Josh Allen priced at $54');
eq(byName['Patrick Mahomes'].acq_type, 'auction', 'Mahomes = auction');
eq(byName['Patrick Mahomes'].auction_price, 47, 'Mahomes priced at $47');

// ADD -> waiver
eq(byName['Waiver Wire Willie'].acq_type, 'waiver', 'ADD player = waiver');
eq(byName['Waiver Wire Willie'].auction_price, 0, 'waiver has no auction price');

// TRADE -> waiver (even though originally drafted by another team)
eq(byName['Bijan Robinson'].acq_type, 'waiver', 'TRADE player = waiver');

// Name normalization: site "AJ Brown" matches ESPN "A.J. Brown", DRAFT -> auction $33
eq(byName['AJ Brown'].acq_type, 'auction', 'AJ Brown matched across punctuation and = auction');
eq(byName['AJ Brown'].auction_price, 33, 'AJ Brown priced at $33');

// DRAFT but missing bid -> auction, price 0, flagged in stats
eq(byName['No Bid Nolan'].acq_type, 'auction', 'No Bid Nolan still auction');
eq(byName['No Bid Nolan'].auction_price, 0, 'No Bid Nolan price 0 when bid missing');
ok(stats.auctionNoBid.includes('No Bid Nolan'), 'No-bid auction player flagged');

// Excluded players never get an offer
ok(!byName['Existing Contract Dude'], 'contract player excluded (not espn_active)');
ok(!byName['Ghost Player'], 'unmapped-team player excluded');

// Counts + unmatched team reporting
eq(offers.length, 6, 'exactly the 6 espn_active players priced');
eq(stats.auction, 4, 'four auction offers');
eq(stats.waiver, 2, 'two waiver offers');
ok(stats.unmatchedTeams.includes(9), 'unmapped espn team 9 reported');

// ---- acqReason helper -----------------------------------------------------
ok(/free agency|waivers/i.test(acqReason('ADD')), 'ADD reason mentions waivers');
ok(/trade/i.test(acqReason('TRADE')), 'TRADE reason mentions trade');

// ---- map passed as a Map (not just an object) -----------------------------
const asMap = new Map([['1', 10], ['2', 20]]);
const r2 = computeOffersFromEspn({ rosterEntries: entries, draftPicks: picks, espnActive, espnToSiteTeam: asMap });
eq(r2.offers.length, 6, 'engine accepts a Map for espnToSiteTeam');

// ---- computeOffersFromRecap (PDF-price variant) ---------------------------
// Same DRAFT-vs-FA labels from ESPN, but the auction price comes from a PDF
// keyed by normalized NAME. Reuse the same entries/espnActive/mapping.
{
  // Price map by normalized name. "A.J. Brown" style punctuation must match
  // however espnActive spells it, via normalizeName on both sides.
  const priceByName = {};
  // Grab the drafted espn_active players from the existing fixtures and give
  // them PDF prices; leave one drafted player unpriced to test auctionNoBid.
  const draftedActive = entries
    .filter(e => String(e.acquisitionType).toUpperCase() === 'DRAFT')
    .map(e => e.playerName);
  // normalizeName isn't exported here, but names in fixtures are plain, so a
  // lowercase key works for the ones we set; the engine normalizes internally.
  const { } = {};
  // Price all but the last drafted player.
  draftedActive.slice(0, -1).forEach((n, i) => { priceByName[n.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()] = 30 + i; });

  const rr = computeOffersFromRecap({ rosterEntries: entries, priceByName, espnActive, espnToSiteTeam });
  ok(rr.offers.length === offers.length, 'recap engine prices the same set of espn_active players');
  ok(rr.stats.auction === stats.auction, 'recap engine keeps ESPN auction/FA split');
  ok(rr.stats.waiver === stats.waiver, 'recap engine keeps the same waiver count');
  // The one drafted player we left unpriced must be flagged for manual pricing.
  ok(rr.stats.auctionNoBid.length >= 1, 'a drafted player with no PDF price is flagged');
  // A priced drafted player carries its PDF amount and an auction acq_type.
  const pricedAuction = rr.offers.find(o => o.acq_type === 'auction' && o.auction_price > 0);
  ok(pricedAuction && /Draft Recap PDF/.test(pricedAuction.reason), 'priced auction offer cites the PDF');
  ok(rr.stats.unmatchedTeams.includes(9), 'recap engine still reports unmapped team 9');
}

// ---- $11 auction floor (league rule) --------------------------------------
// Any auction price of $10 or less is bumped to the $11 contract minimum.
// A price of 0 (unknown / no bid found) is NOT bumped — it stays flagged.
eq(applyAuctionFloor(1), 11, 'a $1 win floors to $11');
eq(applyAuctionFloor(8), 11, 'an $8 win floors to $11');
eq(applyAuctionFloor(10), 11, 'a $10 win floors to $11');
eq(applyAuctionFloor(11), 11, 'a $11 win stays $11');
eq(applyAuctionFloor(12), 12, 'a $12 win is unchanged');
eq(applyAuctionFloor(54), 54, 'a $54 win is unchanged');
eq(applyAuctionFloor(0), 0, 'a $0 (unknown) is left alone, not bumped');

// End-to-end: a drafted player with a cheap bid gets the $11 floor + is flagged.
{
  const rosterEntries = [
    { espnTeamId: 1, playerId: 501, acquisitionType: 'DRAFT', playerName: 'Cheap Charlie' },
    { espnTeamId: 1, playerId: 502, acquisitionType: 'DRAFT', playerName: 'Exact Ten Eddie' },
    { espnTeamId: 1, playerId: 503, acquisitionType: 'DRAFT', playerName: 'Pricey Pete' }
  ];
  const draftPicks = [
    { playerId: 501, teamId: 1, bidAmount: 3 },
    { playerId: 502, teamId: 1, bidAmount: 10 },
    { playerId: 503, teamId: 1, bidAmount: 40 }
  ];
  const active = [
    { team_id: 10, name: 'Cheap Charlie' },
    { team_id: 10, name: 'Exact Ten Eddie' },
    { team_id: 10, name: 'Pricey Pete' }
  ];
  const r = computeOffersFromEspn({ rosterEntries, draftPicks, espnActive: active, espnToSiteTeam: { 1: 10 } });
  const bn = Object.fromEntries(r.offers.map(o => [o.player_name, o]));
  eq(bn['Cheap Charlie'].auction_price, 11, '$3 bid floored to $11');
  eq(bn['Exact Ten Eddie'].auction_price, 11, '$10 bid floored to $11');
  eq(bn['Pricey Pete'].auction_price, 40, '$40 bid unchanged');
  ok(/raised to the \$11 league minimum/.test(bn['Cheap Charlie'].reason), 'floored offer explains the bump');
  ok(/\$3\b/.test(bn['Cheap Charlie'].reason), 'floored offer still shows the original $3 bid');
  ok(r.stats.floored.includes('Cheap Charlie') && r.stats.floored.includes('Exact Ten Eddie'), 'floored players tracked in stats');
  ok(!r.stats.floored.includes('Pricey Pete'), 'unfloored player not in floored stats');
}

// The floor also applies on the PDF-price path.
{
  const rosterEntries = [
    { espnTeamId: 1, playerId: 601, acquisitionType: 'DRAFT', playerName: 'Bargain Bob' }
  ];
  const active = [{ team_id: 10, name: 'Bargain Bob' }];
  const priceByName = { 'bargain bob': 5 };
  const r = computeOffersFromRecap({ rosterEntries, priceByName, espnActive: active, espnToSiteTeam: { 1: 10 } });
  const off = r.offers.find(o => o.player_name === 'Bargain Bob');
  eq(off.auction_price, 11, 'PDF $5 price floored to $11');
  ok(/raised to the \$11 league minimum/.test(off.reason) && /Draft Recap PDF/.test(off.reason), 'PDF floored offer explains bump + cites PDF');
  ok(r.stats.floored.includes('Bargain Bob'), 'PDF-floored player tracked in stats');
}

console.log(`contractPricing.test.js — all ${passed} assertions passed`);
