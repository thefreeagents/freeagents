// Orchestrates a full ESPN sync against the database.
// Uses the pure helpers in ./espn and writes results safely:
//   - REBUILDS only the auto-managed 'espn_active' section.
//   - NEVER touches contract / ncaa_contract / taxi / ncaa_player rows.
//   - Updates each mapped team's record + points_for.
const { db, MANUAL_SECTIONS, CONTRACT_SECTIONS } = require('../db/db');
const {
  fetchLeague, parseTeams, leagueName, planRosterMerge,
  parseRosterEntries, parseDraftPicks,
  fetchLeagueHistory, aggregateAllTime, formatRecord
} = require('./espn');
const { computeOffersFromEspn } = require('./contractPricing');

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
    const at = allTime[String(st.espn_team_id)] || allTime[st.espn_team_id];
    let allTimeStr = '';
    if (at) {
      allTimeStr = formatRecord(at);
      updAllTime.run(allTimeStr, String(Math.round(at.pointsFor * 10) / 10), at.seasons, st.id);
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
  const data = await fetchLeague(leagueId, season);

  const rosterEntries = parseRosterEntries(data);
  const draftPicks = parseDraftPicks(data);

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
    priced: offers.length,
    draftCount: draftPicks.length,
    rosterCount: rosterEntries.length,
    stats,
    teams: [...byTeam.entries()].map(([team, list]) => ({ team, offers: list }))
  };
}

module.exports = { fetchEspnTeams, syncLeague, priceFromEspn, getSetting, setSetting, currentSeason };
