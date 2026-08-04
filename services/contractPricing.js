// Contract pricing straight from ESPN.
//
// The commissioner clicks "Set contract prices from ESPN" on the ESPN Sync
// screen. We reuse the same league feed the roster sync already pulls (now with
// the mDraftDetail + mRoster views), which tells us, for every rostered player:
//   - acquisitionType  -> DRAFT (drafted at auction & still held) vs ADD /
//                         TRADE / etc. (picked up off waivers / free agency).
//     This is exactly the "ACQ" column shown on ESPN's League Rosters page.
//   - the auction bidAmount for players who were drafted.
//
// We set a contract offer for every player currently on a team's "On ESPN
// Roster" (espn_active) list. NOTE: espn_active already EXCLUDES any player
// filed under Contract Players or NCAA Contracts (and Taxi / NCAA Players), so
// by only pricing espn_active rows we automatically skip them.
//
// Pricing rule (from the league):
//   - acquisitionType === 'DRAFT'  ->  AUCTION: signable 1–3 years at the
//     player's auction bid amount. (ESPN's DRAFT status already means the
//     player was drafted by their current team and never dropped/re-added.)
//   - anything else (ADD / TRADE / waiver claim / free agency)  ->  WAIVER:
//     $11 (yr 1) / $15 (yr 2), signable 1–2 years.
//
// The two extractors that read the raw ESPN payload live in ./espn
// (parseRosterEntries, parseDraftPicks). computeOffersFromEspn() below is the
// pure decision engine and is fully unit-tested with no network.

const { normalizeName } = require('./espn');

// acquisitionType values ESPN uses that mean "not a held auction pick".
// (We treat DRAFT as auction; everything else is waiver terms.)
function acqReason(acquisitionType) {
  switch (String(acquisitionType || '').toUpperCase()) {
    case 'ADD':
    case 'ADD_WAIVER':
    case 'WAIVER':
    case 'FREE_AGENT':
      return 'Acquired via free agency / waivers — waiver terms';
    case 'TRADE':
      return 'Acquired via trade — waiver terms';
    case '':
      return 'No acquisition info from ESPN — waiver terms';
    default:
      return `Acquired via ${acquisitionType} — waiver terms`;
  }
}

// --- pure decision engine --------------------------------------------------
//
//  rosterEntries : [{ espnTeamId, playerId, playerName, acquisitionType }]
//                  (every rostered player, from parseRosterEntries)
//  draftPicks    : [{ playerId, teamId, bidAmount }] (from parseDraftPicks)
//  espnActive    : [{ team_id, name }]  players to price — already excludes
//                  contract / ncaa_contract / taxi / ncaa_player
//  espnToSiteTeam: Map|object  ESPN team id (string) -> site team id
//
// Returns { offers: [{ team_id, player_name, acq_type, auction_price, reason }],
//           stats: { auction, waiver, auctionNoBid: [names], unmatchedTeams: [ids] } }.
function computeOffersFromEspn({ rosterEntries = [], draftPicks = [], espnActive = [], espnToSiteTeam }) {
  const toSite = normalizeTeamMap(espnToSiteTeam);

  // Auction bid keyed by ESPN player id.
  const bidByPlayerId = new Map();
  for (const p of draftPicks) {
    if (p.playerId == null) continue;
    bidByPlayerId.set(String(p.playerId), p.bidAmount);
  }

  // The players we actually price, keyed by "<siteTeamId>|<normName>" -> the
  // site's canonical player name. We store the SITE spelling on the offer so it
  // links back to the espn_active row (which may differ in punctuation from
  // ESPN's fullName, e.g. "AJ Brown" vs "A.J. Brown").
  const activeByKey = new Map();
  for (const a of espnActive) {
    activeByKey.set(`${a.team_id}|${normalizeName(a.name)}`, a.name);
  }

  const offers = [];
  const stats = { auction: 0, waiver: 0, auctionNoBid: [], unmatchedTeams: new Set() };

  for (const e of rosterEntries) {
    const siteId = toSite.get(String(e.espnTeamId));
    if (siteId == null) { stats.unmatchedTeams.add(e.espnTeamId); continue; }

    const key = `${siteId}|${normalizeName(e.playerName)}`;
    const siteName = activeByKey.get(key);
    if (siteName == null) continue; // not an espn_active player (contract/ncaa/taxi/etc.)

    const isDraft = String(e.acquisitionType || '').toUpperCase() === 'DRAFT';
    if (isDraft) {
      const bid = bidByPlayerId.get(String(e.playerId));
      const price = (bid != null && Number.isFinite(bid)) ? bid : 0;
      if (price <= 0) stats.auctionNoBid.push(siteName);
      offers.push({
        team_id: siteId,
        player_name: siteName,
        acq_type: 'auction',
        auction_price: price,
        reason: price > 0
          ? `Drafted at auction for $${price}`
          : 'Drafted at auction (no bid amount found — please set the price)'
      });
      stats.auction++;
    } else {
      offers.push({
        team_id: siteId,
        player_name: siteName,
        acq_type: 'waiver',
        auction_price: 0,
        reason: acqReason(e.acquisitionType)
      });
      stats.waiver++;
    }
  }

  stats.unmatchedTeams = [...stats.unmatchedTeams];
  return { offers, stats };
}

// --- pure decision engine, PDF-price variant -------------------------------
//
// Same shape as computeOffersFromEspn, but the auction price for a DRAFT player
// comes from a Draft Recap PDF (keyed by normalized NAME) instead of the API's
// bidAmount (keyed by playerId). We STILL take auction-vs-waiver from ESPN's
// acquisitionType — that part of the ESPN pull is already correct; the PDF only
// supplies the dollar amount that the private-league API hides.
//
//  rosterEntries : [{ espnTeamId, playerId, playerName, acquisitionType }]
//  priceByName   : Map|object  normalizedName -> winning auction bid ($)
//  espnActive    : [{ team_id, name }]  players to price
//  espnToSiteTeam: Map|object  ESPN team id (string) -> site team id
//
// Returns { offers, stats } where stats also carries `matched` (Set of
// normalized names that got a PDF price) so callers can report leftovers.
function computeOffersFromRecap({ rosterEntries = [], priceByName, espnActive = [], espnToSiteTeam }) {
  const toSite = normalizeTeamMap(espnToSiteTeam);
  const prices = new Map();
  if (priceByName instanceof Map) {
    for (const [k, v] of priceByName.entries()) prices.set(String(k), v);
  } else if (priceByName) {
    for (const k of Object.keys(priceByName)) prices.set(String(k), priceByName[k]);
  }

  const activeByKey = new Map();
  for (const a of espnActive) {
    activeByKey.set(`${a.team_id}|${normalizeName(a.name)}`, a.name);
  }

  const offers = [];
  const stats = { auction: 0, waiver: 0, auctionNoBid: [], unmatchedTeams: new Set(), matched: new Set() };

  for (const e of rosterEntries) {
    const siteId = toSite.get(String(e.espnTeamId));
    if (siteId == null) { stats.unmatchedTeams.add(e.espnTeamId); continue; }

    const norm = normalizeName(e.playerName);
    const siteName = activeByKey.get(`${siteId}|${norm}`);
    if (siteName == null) continue; // not an espn_active player

    const isDraft = String(e.acquisitionType || '').toUpperCase() === 'DRAFT';
    if (isDraft) {
      const found = prices.has(norm);
      const price = found ? prices.get(norm) : 0;
      if (found) stats.matched.add(norm);
      if (!(price > 0)) stats.auctionNoBid.push(siteName);
      offers.push({
        team_id: siteId,
        player_name: siteName,
        acq_type: 'auction',
        auction_price: price > 0 ? price : 0,
        reason: price > 0
          ? `Drafted at auction for $${price} (from Draft Recap PDF)`
          : 'Drafted at auction, but no price for this name was found in the PDF — please set it'
      });
      stats.auction++;
    } else {
      offers.push({
        team_id: siteId,
        player_name: siteName,
        acq_type: 'waiver',
        auction_price: 0,
        reason: acqReason(e.acquisitionType)
      });
      stats.waiver++;
    }
  }

  stats.unmatchedTeams = [...stats.unmatchedTeams];
  return { offers, stats };
}

// Accept a Map or a plain object for the ESPN->site team mapping and return a
// Map keyed by string ESPN id.
function normalizeTeamMap(m) {
  const out = new Map();
  if (!m) return out;
  if (m instanceof Map) {
    for (const [k, v] of m.entries()) out.set(String(k), v);
  } else {
    for (const k of Object.keys(m)) out.set(String(k), m[k]);
  }
  return out;
}

module.exports = { computeOffersFromEspn, computeOffersFromRecap, acqReason };
