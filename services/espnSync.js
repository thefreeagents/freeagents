// Orchestrates a full ESPN sync against the database.
// Uses the pure helpers in ./espn and writes results safely:
//   - REBUILDS only the auto-managed 'espn_active' section.
//   - NEVER touches contract / ncaa_contract / taxi / ncaa_player rows.
//   - Updates each mapped team's record + points_for.
const { db, MANUAL_SECTIONS, CONTRACT_SECTIONS } = require('../db/db');
const {
  fetchLeague, parseTeams, leagueName, planRosterMerge,
  fetchLeagueHistory, aggregateAllTime, formatRecord
} = require('./espn');

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
  const delEspn = db.prepare("DELETE FROM players WHERE team_id = ? AND section = 'espn_active'");
  const insPlayer = db.prepare(
    "INSERT INTO players (team_id, name, section, contracts, sort_order) VALUES (?, ?, 'espn_active', '', ?)"
  );
  const updTeam = db.prepare('UPDATE teams SET record = ?, points_for = ?, updated_at = ? WHERE id = ?');
  const updAllTime = db.prepare('UPDATE teams SET all_time_record = ?, all_time_pf = ?, all_time_seasons = ? WHERE id = ?');

  for (const st of siteTeams) {
    if (!st.espn_team_id) { report.unmapped.push(st.name); continue; }
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

module.exports = { fetchEspnTeams, syncLeague, getSetting, setSetting, currentSeason };
