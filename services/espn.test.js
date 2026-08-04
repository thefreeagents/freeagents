// Quick self-contained test for the pure ESPN helpers.
// Run: node services/espn.test.js
const assert = require('assert');
const {
  normalizeName, espnTeamName, parseTeams, leagueName,
  suggestSiteTeamId, planRosterMerge,
  leagueUrl, draftDetailUrl, parseDraftPicks
} = require('./espn');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }
function eq(a, b, msg) { assert.deepStrictEqual(a, b, msg); passed++; }

// --- normalizeName ---------------------------------------------------------
eq(normalizeName('Patrick Mahomes II'), 'patrick mahomes', 'strips suffix');
eq(normalizeName("Ja'Marr Chase"), 'jamarr chase', 'strips apostrophe');
eq(normalizeName('  A.J.  Brown '), 'aj brown', 'collapses spaces/punct');

// --- espnTeamName ----------------------------------------------------------
eq(espnTeamName({ name: 'Gridiron Gang' }), 'Gridiron Gang', 'uses name');
eq(espnTeamName({ location: 'Team', nickname: 'Rocket' }), 'Team Rocket', 'joins loc+nick');
eq(espnTeamName({ abbrev: 'TR', id: 3 }), 'TR', 'falls back to abbrev');

// --- parseTeams ------------------------------------------------------------
const sample = {
  settings: { name: 'The Free Agents' },
  teams: [
    {
      id: 1, name: 'Comeback Kids',
      record: { overall: { wins: 3, losses: 1, ties: 0, pointsFor: 412.7 } },
      roster: { entries: [
        { playerPoolEntry: { player: { fullName: 'Patrick Mahomes' } } },
        { playerPoolEntry: { player: { fullName: 'Bijan Robinson' } } }
      ] }
    },
    {
      id: 2, location: 'Sunday', nickname: 'Scaries',
      record: { overall: { wins: 2, losses: 2, ties: 1, pointsFor: 388 } },
      roster: { entries: [
        { playerPoolEntry: { player: { fullName: 'Josh Allen' } } }
      ] }
    }
  ]
};
const parsed = parseTeams(sample);
eq(parsed.length, 2, 'two teams parsed');
eq(parsed[0].record, '3-1', 'W-L when no ties');
eq(parsed[1].record, '2-2-1', 'W-L-T when ties');
eq(parsed[0].pointsFor, 412.7, 'pointsFor rounded');
eq(parsed[0].players, ['Patrick Mahomes', 'Bijan Robinson'], 'player names extracted');
eq(leagueName(sample), 'The Free Agents', 'league name');

// --- suggestSiteTeamId -----------------------------------------------------
const siteTeams = [
  { id: 10, name: 'The Comeback Kids' },
  { id: 11, name: 'Sunday Scaries' }
];
eq(suggestSiteTeamId({ name: 'Comeback Kids' }, siteTeams), 10, 'contains match');
eq(suggestSiteTeamId({ name: 'Sunday Scaries' }, siteTeams), 11, 'exact match');
eq(suggestSiteTeamId({ name: 'Nobody Here' }, siteTeams), null, 'no match -> null');

// --- planRosterMerge (the rewritten "separate ESPN section") ---------------
// ESPN sees the full active NFL roster. The site already lists some of these
// players as contract / ncaa_contract (manual). Taxi + ncaa_player are league
// designations ESPN never sees.
const espnRoster = [
  'Patrick Mahomes',   // already a contract player -> excluded from espn_active
  "Ja'Marr Chase",     // already ncaa_contract     -> excluded
  'Bijan Robinson',    // new on ESPN               -> goes to espn_active
  'Sam LaPorta',       // new on ESPN               -> goes to espn_active
  'Bijan Robinson'     // duplicate in ESPN list    -> deduped
];
const sitePlayers = [
  { name: 'Patrick Mahomes', section: 'contract' },
  { name: "Ja'Marr Chase",   section: 'ncaa_contract' },
  { name: 'Caleb Williams',  section: 'taxi' },          // never on ESPN
  { name: 'Jeremiah Smith',  section: 'ncaa_player' },    // never on ESPN
  { name: 'Derrick Henry',   section: 'contract' }        // NOT on ESPN -> possiblyDropped
];
const MANUAL = ['contract', 'ncaa_contract', 'taxi', 'ncaa_player'];
const CONTRACT = ['contract', 'ncaa_contract'];
const prevEspnActive = ['Sam LaPorta']; // already had LaPorta last sync

const plan = planRosterMerge(espnRoster, sitePlayers, MANUAL, CONTRACT, prevEspnActive);

eq(plan.espnActive, ['Bijan Robinson', 'Sam LaPorta'],
   'espn_active = ESPN roster minus manual players, deduped');
eq(plan.added, ['Bijan Robinson'],
   'added = newly appearing since last sync (LaPorta was already there)');
eq(plan.possiblyDropped, [{ name: 'Derrick Henry', section: 'contract' }],
   'possiblyDropped = contract players no longer on ESPN (taxi/ncaa_player ignored)');

// Taxi + ncaa_player must NEVER be flagged as dropped even though not on ESPN.
ok(!plan.possiblyDropped.some(p => p.section === 'taxi'), 'taxi never flagged');
ok(!plan.possiblyDropped.some(p => p.section === 'ncaa_player'), 'ncaa_player never flagged');

// --- URL builders: draft detail is fetched separately ----------------------
// The main league request must NOT bundle mDraftDetail (ESPN drops it when too
// many views are combined, which zeroed out auction prices); it has its own URL.
ok(!leagueUrl('123', '2026').includes('mDraftDetail'), 'leagueUrl does not bundle mDraftDetail');
ok(leagueUrl('123', '2026').includes('view=mRoster'), 'leagueUrl still requests mRoster');
ok(draftDetailUrl('123', '2026').includes('view=mDraftDetail'), 'draftDetailUrl requests mDraftDetail');
ok(draftDetailUrl('123', '2026').includes('/2026/'), 'draftDetailUrl includes the season');

// --- parseDraftPicks from a dedicated draft-detail payload ------------------
const draftPayload = { draftDetail: { picks: [
  { playerId: 100, teamId: 1, bidAmount: 54 },
  { playerId: 101, teamId: 2, bidAmount: 0 },
  { teamId: 3, bidAmount: 9 }            // no playerId -> dropped
] } };
const picks = parseDraftPicks(draftPayload);
eq(picks.length, 2, 'parseDraftPicks keeps only picks with a playerId');
eq(picks[0], { playerId: 100, teamId: 1, bidAmount: 54 }, 'pick carries the auction bid');
eq(parseDraftPicks({}), [], 'parseDraftPicks tolerates a missing draftDetail');

console.log(`\n  All ${passed} assertions passed.\n`);
