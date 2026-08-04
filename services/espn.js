// ESPN Fantasy Football sync helpers.
//
// The network call is isolated in fetchLeague(); everything else is a pure
// function so the mapping + merge behaviour can be unit-tested without ESPN.
//
// IMPORTANT design rules (driven by how The Free Agents league works):
//  - ESPN only knows about ACTIVE NFL rosters. Those map to the site's
//    "contract" + "ncaa_contract" sections (SYNC_SECTIONS).
//  - "taxi" and "ncaa_player" are league-only designations ESPN never sees,
//    so the sync must NEVER add to or remove from them.
//  - The sync NEVER deletes players and NEVER changes a player's salary or
//    section. New ESPN players are added (blank salary, flagged for review);
//    players missing from ESPN are only *reported*, never auto-removed.

const ESPN_HOST = 'https://lm-api-reads.fantasy.espn.com';

function leagueUrl(leagueId, season) {
  // mRoster entries carry each player's acquisitionType (DRAFT / ADD / TRADE),
  // which is what tells us auction vs. waiver contracts. The auction bid amounts
  // (mDraftDetail) are fetched SEPARATELY — see draftDetailUrl below — because
  // ESPN frequently returns partial/empty data when many views are bundled into
  // one request, which was silently zeroing out every auction price.
  return `${ESPN_HOST}/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`
    + '?view=mTeam&view=mRoster&view=mSettings';
}

// Dedicated URL for the auction draft results (bid amount per pick). Requested
// on its own so ESPN reliably returns the full draftDetail.picks payload.
function draftDetailUrl(leagueId, season) {
  return `${ESPN_HOST}/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`
    + '?view=mDraftDetail';
}

// Fetch a (public) league. Throws a friendly Error on failure.
async function fetchLeague(leagueId, season) {
  if (!leagueId) throw new Error('No ESPN league ID has been set.');
  const url = leagueUrl(leagueId, season);
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TheFreeAgents/1.0)',
        'Accept': 'application/json'
      }
    });
  } catch (e) {
    throw new Error(`Could not reach ESPN (${e.message}). Check your internet/League ID.`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error('ESPN denied access. This league may be private — it must be set to public, or private-league credentials are required.');
  }
  if (res.status === 404) {
    throw new Error(`ESPN returned "not found". Double-check the League ID (${leagueId}) and season (${season}).`);
  }
  if (!res.ok) {
    throw new Error(`ESPN request failed (HTTP ${res.status}).`);
  }
  const data = await res.json();
  if (!data || !Array.isArray(data.teams)) {
    throw new Error('ESPN response did not contain any teams. The season may not be set up yet.');
  }
  return data;
}

// Fetch the auction draft results on their own request. Returns the raw payload
// (with a top-level draftDetail). Kept separate from fetchLeague so a bundled
// multi-view request can't cause ESPN to drop the draft data. Throws a friendly
// Error on transport/HTTP failure so the caller can report it.
async function fetchDraftDetail(leagueId, season) {
  if (!leagueId) throw new Error('No ESPN league ID has been set.');
  let res;
  try {
    res = await fetch(draftDetailUrl(leagueId, season), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TheFreeAgents/1.0)',
        'Accept': 'application/json'
      }
    });
  } catch (e) {
    throw new Error(`Could not reach ESPN for draft results (${e.message}).`);
  }
  if (!res.ok) {
    throw new Error(`ESPN draft-results request failed (HTTP ${res.status}).`);
  }
  try {
    return await res.json();
  } catch (e) {
    throw new Error('ESPN returned an unreadable draft-results response.');
  }
}

// Normalise a name for fuzzy matching (case, punctuation, common suffixes).
function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[.'’`]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// Build the display name for an ESPN team across API versions.
function espnTeamName(t) {
  if (t.name && String(t.name).trim()) return String(t.name).trim();
  const combined = [t.location, t.nickname].filter(Boolean).join(' ').trim();
  return combined || t.abbrev || `Team ${t.id}`;
}

// Turn a raw ESPN league payload into a tidy array of teams.
function parseTeams(data) {
  return (data.teams || []).map(t => {
    const rec = (t.record && t.record.overall) || {};
    const wins = rec.wins || 0, losses = rec.losses || 0, ties = rec.ties || 0;
    const players = ((t.roster && t.roster.entries) || [])
      .map(e => e.playerPoolEntry && e.playerPoolEntry.player && e.playerPoolEntry.player.fullName)
      .filter(Boolean);
    return {
      espnId: t.id,
      name: espnTeamName(t),
      abbrev: t.abbrev || '',
      record: ties ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`,
      pointsFor: rec.pointsFor != null ? Math.round(rec.pointsFor * 10) / 10 : null,
      players
    };
  });
}

function leagueName(data) {
  return (data.settings && data.settings.name) || '';
}

// ---- Contract-pricing inputs ----------------------------------------------
// Two pure extractors that turn a raw ESPN payload (fetched with the
// mRoster + mDraftDetail views) into the minimal facts the pricing engine
// needs. Kept here, next to fetchLeague, so all ESPN-shape knowledge lives in
// one file and the pricing engine stays payload-agnostic + unit-testable.

// One row per rostered player, across every team: who owns them now, how they
// were acquired (DRAFT / ADD / TRADE / ...), and their ESPN player id.
function parseRosterEntries(data) {
  const out = [];
  for (const t of (data.teams || [])) {
    const entries = (t.roster && t.roster.entries) || [];
    for (const e of entries) {
      const player = e.playerPoolEntry && e.playerPoolEntry.player;
      const name = player && player.fullName;
      if (!name) continue;
      out.push({
        espnTeamId: t.id,
        playerId: e.playerId != null ? e.playerId : (player && player.id),
        playerName: name,
        acquisitionType: e.acquisitionType || ''
      });
    }
  }
  return out;
}

// One row per auction draft pick: which team drafted the player and for how
// much. bidAmount is the salary-cap auction price we want for a DRAFT contract.
function parseDraftPicks(data) {
  const picks = (data.draftDetail && data.draftDetail.picks) || [];
  return picks
    .filter(p => p && p.playerId != null)
    .map(p => ({
      playerId: p.playerId,
      teamId: p.teamId,
      bidAmount: p.bidAmount != null ? p.bidAmount : null
    }));
}

// ---- All-time franchise records -------------------------------------------
// ESPN exposes completed seasons at the leagueHistory endpoint. We aggregate a
// franchise's wins/losses/ties/points across every available season, matched by
// ESPN team id (stable across seasons in most established leagues).

function historyUrl(leagueId) {
  return `${ESPN_HOST}/apis/v3/games/ffl/leagueHistory/${leagueId}?view=mTeam`;
}

// Fetch all completed seasons for a league. Returns an array of season payloads.
// On any failure returns [] (all-time records are a nice-to-have, so a history
// hiccup must never break the main sync).
async function fetchLeagueHistory(leagueId) {
  if (!leagueId) return [];
  let res;
  try {
    res = await fetch(historyUrl(leagueId), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TheFreeAgents/1.0)',
        'Accept': 'application/json'
      }
    });
  } catch (e) {
    return [];
  }
  if (!res.ok) return [];
  let data;
  try { data = await res.json(); } catch (e) { return []; }
  // The endpoint returns an array of seasons (or a single object for one).
  const seasons = Array.isArray(data) ? data : [data];
  return seasons.filter(s => s && Array.isArray(s.teams));
}

// Raw per-team win/loss/tie/points numbers from one season/league payload.
function teamRecords(data) {
  return (data.teams || []).map(t => {
    const rec = (t.record && t.record.overall) || {};
    return {
      espnId: t.id,
      name: espnTeamName(t),
      wins: rec.wins || 0,
      losses: rec.losses || 0,
      ties: rec.ties || 0,
      pointsFor: rec.pointsFor || 0
    };
  });
}

// Aggregate an array of season payloads into all-time totals per ESPN team id.
// Returns { [espnId]: { wins, losses, ties, pointsFor, seasons, name } }.
function aggregateAllTime(seasonPayloads) {
  const totals = {};
  for (const payload of seasonPayloads || []) {
    for (const r of teamRecords(payload)) {
      if (r.espnId == null) continue;
      const played = r.wins + r.losses + r.ties > 0;
      const cur = totals[r.espnId] || { wins: 0, losses: 0, ties: 0, pointsFor: 0, seasons: 0, name: r.name };
      cur.wins += r.wins;
      cur.losses += r.losses;
      cur.ties += r.ties;
      cur.pointsFor += r.pointsFor;
      if (played) cur.seasons += 1;
      cur.name = r.name; // keep the most recent season's name
      totals[r.espnId] = cur;
    }
  }
  return totals;
}

// Format an aggregated total into a "W-L" / "W-L-T" string.
function formatRecord(t) {
  return t.ties ? `${t.wins}-${t.losses}-${t.ties}` : `${t.wins}-${t.losses}`;
}

// Suggest which site team an ESPN team maps to, by normalised-name match.
// Returns the site team id, or null if no confident match.
function suggestSiteTeamId(espnTeam, siteTeams) {
  const target = normalizeName(espnTeam.name);
  if (!target) return null;
  // 1) exact normalised match
  let hit = siteTeams.find(st => normalizeName(st.name) === target);
  if (hit) return hit.id;
  // 2) one contains the other (handles minor wording differences)
  hit = siteTeams.find(st => {
    const n = normalizeName(st.name);
    return n && (n.includes(target) || target.includes(n));
  });
  return hit ? hit.id : null;
}

// Pure roster planner for one team.
//
// The auto-managed "On ESPN Roster" section should list the team's current ESPN
// roster MINUS anyone already listed in a manual section (so a player is never
// shown twice). This computes that list, plus a report of what's changing.
//
//  - espnPlayerNames : string[]           (from ESPN)
//  - sitePlayers     : [{ name, section }] (current rows on the site)
//  - manualSections  : string[]  sections whose players exclude an ESPN dup
//  - contractSections: string[]  sections we check for "dropped from ESPN"
//  - prevEspnActive  : string[]  names currently in the espn_active section
//
// Returns { espnActive, added, possiblyDropped }.
function planRosterMerge(espnPlayerNames, sitePlayers, manualSections, contractSections, prevEspnActive = []) {
  // Names already listed in a manual section — these are excluded from the
  // ESPN section so nobody appears twice.
  const excludeSet = new Set(
    sitePlayers
      .filter(p => manualSections.includes(p.section))
      .map(p => normalizeName(p.name))
  );

  const seen = new Set();
  const espnActive = [];
  for (const name of espnPlayerNames) {
    const norm = normalizeName(name);
    if (!norm) continue;
    if (excludeSet.has(norm)) continue; // already categorised manually
    if (seen.has(norm)) continue;       // de-dupe within the ESPN list
    seen.add(norm);
    espnActive.push(name);
  }

  // Which of these are newly appearing since last sync (for the change report).
  const prevSet = new Set(prevEspnActive.map(normalizeName));
  const added = espnActive.filter(n => !prevSet.has(normalizeName(n)));

  // Contract / NCAA-contract players who are no longer on the ESPN roster.
  // Taxi + NCAA-player sections are invisible to ESPN and never flagged.
  const espnSet = new Set(espnPlayerNames.map(normalizeName));
  const possiblyDropped = sitePlayers
    .filter(p => contractSections.includes(p.section))
    .filter(p => !espnSet.has(normalizeName(p.name)))
    .map(p => ({ name: p.name, section: p.section }));

  return { espnActive, added, possiblyDropped };
}

module.exports = {
  leagueUrl, fetchLeague, draftDetailUrl, fetchDraftDetail, normalizeName, espnTeamName,
  parseTeams, leagueName, suggestSiteTeamId, planRosterMerge,
  parseRosterEntries, parseDraftPicks,
  historyUrl, fetchLeagueHistory, teamRecords, aggregateAllTime, formatRecord
};
