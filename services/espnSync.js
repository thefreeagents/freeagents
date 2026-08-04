// Orchestrates a full ESPN sync against the database.
// Uses the pure helpers in ./espn and writes results safely:
//   - REBUILDS only the auto-managed 'espn_active' section.
//   - NEVER touches contract / ncaa_contract / taxi / ncaa_player rows.
//   - Updates each mapped team's record + points_for.
const { db, MANUAL_SECTIONS, CONTRACT_SECTIONS } = require('../db/db');
const {
  fetchLeague, fetchDraftDetail, parseTeams, leagueName, planRosterMerge,
  parseRosterEntries, parseDraftPicks,
  fetchLeagueHistory, aggregateAllTime, formatRecord
} = require('./espn');
const { computeOffersFromEspn, computeOffersFromRecap } = require('./contractPricing');
const { normalizeName } = require('./espn');
const { parseDraftRecapPdf } = require('./draftRecapPdf');

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}
function currentSeason() {
  return getSetting('espn_season') || String(new Date().getFullYear());
}
// The season whose auction results supply contract prices. This is set
// separately from the roster season because a league auctions in one season but
// its results become the *following* season's contract prices, and because the
// current season's auction may not have happened yet. Defaults to the season
// before the roster season if not explicitly set.
function auctionSeason() {
  const explicit = getSetting('espn_auction_season');
  if (explicit) return explicit;
  const cur = parseInt(currentSeason(), 10);
  return Number.isFinite(cur) ? String(cur - 1) : currentSeason();
}

// Fetch ESPN teams (for the mapping screen). Returns { leagueName, teams }.
async function fetchEspnTeams() {
  const leagueId = getSetting('espn_league_id');
  const season = currentSeason();
  const data = await fetchLeague(leagueId, season);
  return { leagueName: leagueName(data), season, teams: parseTeams(data) };
}

// Run the full sync. Returns a change report.
async function syncLeague() {
  const leagueId = getSetting('espn_league_id');
  const season = currentSeason();
  const data = await fetchLeague(leagueId, season);
  const espnTeams = parseTeams(data);
  const byEspnId = new Map(espnTeams.map(t => [String(t.espnId), t]));
  const today = new Date().toISOString().slice(0, 10);

  const report = {
    leagueName: leagueName(data),
    season,
    when: today,
    teams: [],
    unmapped: []
  };

  // All-time franchise records from completed seasons (best-effort). We include
  // the current-season payload too so the totals are up to date. Never fatal.
  let allTime = {};
  try {
    const history = await fetchLeagueHistory(leagueId);
    allTime = aggregateAllTime(history.concat([data]));
  } catch (e) {
    allTime = {};
  }

  const siteTeams = db.prepare('SELECT * FROM teams ORDER BY sort_order, name').all();

  // Safety net: if two site teams somehow share one ESPN id, they'd both pull
  // the same roster. Flag it loudly in the report instead of syncing silently.
  const espnIdCounts = new Map();
  for (const st of siteTeams) {
    if (st.espn_team_id == null) continue;
    const k = String(st.espn_team_id);
    espnIdCounts.set(k, (espnIdCounts.get(k) || 0) + 1);
  }
  const duplicateMappedTeams = siteTeams
    .filter(st => st.espn_team_id != null && espnIdCounts.get(String(st.espn_team_id)) > 1)
    .map(st => st.name);
  report.duplicateMapping = duplicateMappedTeams;

  const delEspn = db.prepare("DELETE FROM players WHERE team_id = ? AND section = 'espn_active'");
  const insPlayer = db.prepare(
    "INSERT INTO players (team_id, name, section, contracts, sort_order) VALUES (?, ?, 'espn_active', '', ?)"
  );
  const updTeam = db.prepare('UPDATE teams SET record = ?, points_for = ?, updated_at = ? WHERE id = ?');
  const updAllTime = db.prepare('UPDATE teams SET all_time_record = ?, all_time_pf = ?, all_time_seasons = ? WHERE id = ?');

  for (const st of siteTeams) {
    if (st.espn_team_id == null) { report.unmapped.push(st.name); continue; }
    const et = byEspnId.get(String(st.espn_team_id));
    if (!et) {
      report.teams.push({ team: st.name, error: 'Saved ESPN mapping no longer matches a team in the league.' });
      continue;
    }

    const sitePlayers = db.prepare('SELECT name, section FROM players WHERE team_id = ?').all(st.id);
    const prevEspnActive = sitePlayers.filter(p => p.section === 'espn_active').map(p => p.name);
    const plan = planRosterMerge(et.players, sitePlayers, MANUAL_SECTIONS, CONTRACT_SECTIONS, prevEspnActive);

    // Rebuild ONLY the auto-managed ESPN section.
    delEspn.run(st.id);
    plan.espnActive.forEach((name, i) => insPlayer.run(st.id, name, i));

    updTeam.run(et.record, et.pointsFor != null ? String(et.pointsFor) : '', today, st.id);

    // All-time record for this franchise (matched by ESPN team id).
    //
    // Only write when we actually have completed-season history. In the preseason
    // the current-season payload carries 0-0 records, and if the league-history
    // feed comes back empty the aggregate would be all zeros — writing that would
    // stamp a bogus "0-0" onto every team. So we require at least one played
    // season (or any wins/losses/ties) before touching the stored values.
    const at = allTime[String(st.espn_team_id)] || allTime[st.espn_team_id];
    let allTimeStr = '';
    const hasHistory = at && (at.seasons > 0 || (at.wins + at.losses + at.ties) > 0);
    if (hasHistory) {
      allTimeStr = formatRecord(at);
      updAllTime.run(allTimeStr, String(Math.round(at.pointsFor * 10) / 10), at.seasons, st.id);
    } else if (/^0-0(-0)?$/.test((st.all_time_record || '').trim()) && !st.all_time_seasons) {
      // No real history available yet — clear a previously auto-written "0-0" so
      // the team page hides the empty all-time block instead of showing 0-0.
      // (A manually-entered record won't match this pattern, so it's left alone.)
      updAllTime.run('', '', 0, st.id);
    }

    report.teams.push({
      team: st.name,
      espnTeam: et.name,
      record: et.record,
      allTime: allTimeStr,
      espnActiveCount: plan.espnActive.length,
      added: plan.added,
      possiblyDropped: plan.possiblyDropped
    });
  }

  setSetting('espn_last_sync', new Date().toISOString());
  return report;
}

// Set contract prices straight from ESPN.
//
// Reuses the same league feed (now including the mDraftDetail + mRoster views)
// to read each rostered player's acquisitionType and auction bid amount, then
// sets a contract offer for every "On ESPN Roster" (espn_active) player:
//   DRAFT (held auction pick)  -> auction at the bid amount (1–3 yrs)
//   anything else (waivers / trade / free agency) -> waiver $11/$15 (1–2 yrs)
// Contract / NCAA / Taxi players are never priced (they aren't espn_active).
// Offers are upserted; the commissioner can still edit any before signing.
async function priceFromEspn() {
  const leagueId = getSetting('espn_league_id');
  const season = currentSeason();
  const auctSeason = auctionSeason();
  const data = await fetchLeague(leagueId, season);

  const rosterEntries = parseRosterEntries(data);

  // Auction bids come from a dedicated draft-detail request for the AUCTION
  // season (which may differ from the roster season — a league auctions in one
  // season but those winning bids become the following season's keeper/contract
  // prices, and the current season's auction may not have happened yet). ESPN
  // player IDs are stable across seasons, so last year's bids map cleanly onto
  // this year's roster by playerId. ESPN can also drop the draft data when views
  // are bundled, hence the dedicated request; fall back to the main payload if
  // the dedicated call fails or comes back empty, so pricing still runs.
  let draftPicks = [];
  let draftError = null;
  try {
    const draftData = await fetchDraftDetail(leagueId, auctSeason);
    draftPicks = parseDraftPicks(draftData);
  } catch (e) {
    draftError = e.message;
  }
  if (!draftPicks.length) {
    const fallback = parseDraftPicks(data);
    if (fallback.length) draftPicks = fallback;
  }
  const draftPicksWithBid = draftPicks.filter(
    p => p.bidAmount != null && Number.isFinite(p.bidAmount) && p.bidAmount > 0
  ).length;

  const siteTeams = db.prepare('SELECT id, name, espn_team_id FROM teams').all();
  const espnToSiteTeam = new Map();
  for (const st of siteTeams) {
    if (st.espn_team_id != null) espnToSiteTeam.set(String(st.espn_team_id), st.id);
  }
  const espnActive = db.prepare("SELECT team_id, name FROM players WHERE section = 'espn_active'").all();

  const { offers, stats } = computeOffersFromEspn({
    rosterEntries, draftPicks, espnActive, espnToSiteTeam
  });

  // Auto-set every offer (editable before signing).
  const upsert = db.prepare(
    `INSERT INTO espn_offers (team_id, player_name, acq_type, auction_price, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(team_id, player_name)
     DO UPDATE SET acq_type = excluded.acq_type,
                   auction_price = excluded.auction_price,
                   updated_at = excluded.updated_at`
  );
  const now = new Date().toISOString().slice(0, 10);
  for (const o of offers) upsert.run(o.team_id, o.player_name, o.acq_type, o.auction_price, now);

  // Group by team for a readable report.
  const nameById = new Map(siteTeams.map(t => [t.id, t.name]));
  const byTeam = new Map();
  for (const o of offers) {
    const key = nameById.get(o.team_id) || `Team ${o.team_id}`;
    if (!byTeam.has(key)) byTeam.set(key, []);
    byTeam.get(key).push(o);
  }

  return {
    leagueName: leagueName(data),
    season,
    auctionSeason: auctSeason,
    priced: offers.length,
    draftCount: draftPicks.length,
    draftPicksWithBid,
    draftError,
    rosterCount: rosterEntries.length,
    stats,
    teams: [...byTeam.entries()].map(([team, list]) => ({ team, offers: list }))
  };
}

// Set contract prices from an uploaded ESPN "Draft Recap" PDF.
//
// This is the reliable path for a PRIVATE league, where ESPN's read API returns
// the roster (so acquisitionType — DRAFT vs free agency — is already correct)
// but HIDES the auction bid amounts (priceFromEspn then shows $0 for everyone).
// So we keep ESPN as the source of truth for WHO was drafted, and use the Draft
// Recap PDF only to supply the missing dollar amount for those drafted players:
//   - ESPN says DRAFT  -> AUCTION, price looked up by name from the PDF
//   - ESPN says ADD / TRADE / waiver / FA -> WAIVER $11/$15 (PDF ignored)
// Names are matched with the same normalization the API path uses, so
// "A.J. Brown"/"AJ Brown" and "Jr."/"Sr." suffixes line up. The recap's own team
// columns are irrelevant (and parse noisily) — we never use them. Keepers are
// never touched: they're Contract Players, not espn_active. Offers are upserted
// and stay editable before signing.
async function priceFromPdf(buffer) {
  const parsed = await parseDraftRecapPdf(buffer);

  // Winning bid keyed by normalized player name. If the same normalized name
  // appears twice in the recap (rare), keep the higher bid and note the clash.
  const priceByName = new Map();
  const collisions = [];
  for (const p of parsed.players) {
    const key = normalizeName(p.name);
    if (!key) continue;
    if (priceByName.has(key)) {
      collisions.push(p.name);
      priceByName.set(key, Math.max(priceByName.get(key), p.price));
    } else {
      priceByName.set(key, p.price);
    }
  }

  // Pull the current roster from ESPN for the authoritative DRAFT-vs-FA labels.
  const leagueId = getSetting('espn_league_id');
  const season = currentSeason();
  const data = await fetchLeague(leagueId, season);
  const rosterEntries = parseRosterEntries(data);

  const siteTeams = db.prepare('SELECT id, name, espn_team_id FROM teams').all();
  const nameById = new Map(siteTeams.map(t => [t.id, t.name]));
  const espnToSiteTeam = new Map();
  for (const st of siteTeams) {
    if (st.espn_team_id != null) espnToSiteTeam.set(String(st.espn_team_id), st.id);
  }
  const espnActive = db.prepare("SELECT team_id, name FROM players WHERE section = 'espn_active'").all();

  const { offers, stats } = computeOffersFromRecap({
    rosterEntries, priceByName, espnActive, espnToSiteTeam
  });

  // Recap players whose price was never applied to a drafted roster spot
  // (dropped since the auction, or a name that didn't match). Informational.
  const unmatchedRecap = parsed.players
    .filter(p => !stats.matched.has(normalizeName(p.name)))
    .map(p => `${p.name} ($${p.price})`);

  const upsert = db.prepare(
    `INSERT INTO espn_offers (team_id, player_name, acq_type, auction_price, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(team_id, player_name)
     DO UPDATE SET acq_type = excluded.acq_type,
                   auction_price = excluded.auction_price,
                   updated_at = excluded.updated_at`
  );
  const now = new Date().toISOString().slice(0, 10);
  for (const o of offers) upsert.run(o.team_id, o.player_name, o.acq_type, o.auction_price, now);

  const byTeam = new Map();
  for (const o of offers) {
    const key = nameById.get(o.team_id) || `Team ${o.team_id}`;
    if (!byTeam.has(key)) byTeam.set(key, []);
    byTeam.get(key).push(o);
  }

  return {
    source: 'pdf',
    leagueName: leagueName(data) || parsed.leagueName || '',
    season,
    auctionSeason: parsed.season || '',
    pages: parsed.pages,
    recapPlayers: parsed.players.length,
    priced: offers.length,
    stats: { auction: stats.auction, waiver: stats.waiver, auctionNoBid: stats.auctionNoBid, unmatchedTeams: stats.unmatchedTeams },
    collisions,
    warnings: parsed.warnings,
    unmatchedRecap,
    teams: [...byTeam.entries()].map(([team, list]) => ({ team, offers: list }))
  };
}

module.exports = { fetchEspnTeams, syncLeague, priceFromEspn, priceFromPdf, getSetting, setSetting, currentSeason, auctionSeason };
