// Tests for all-time franchise-record aggregation across seasons.
// Run: node services/espnHistory.test.js
const assert = require('assert');
const { teamRecords, aggregateAllTime, formatRecord } = require('./espn');

let n = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };

// Three seasons of a two-team league. Team id 1 is stable across seasons.
const s2023 = { seasonId: 2023, teams: [
  { id: 1, name: 'Sustained Excellence', record: { overall: { wins: 10, losses: 4, ties: 0, pointsFor: 1600.5 } } },
  { id: 2, name: 'Eternal Futility',     record: { overall: { wins: 4,  losses: 10, ties: 0, pointsFor: 1400.0 } } }
] };
const s2024 = { seasonId: 2024, teams: [
  { id: 1, name: 'Sustained Excellence', record: { overall: { wins: 9,  losses: 4, ties: 1, pointsFor: 1550.0 } } },
  { id: 2, name: 'Eternal Futility',     record: { overall: { wins: 5,  losses: 8, ties: 1, pointsFor: 1450.5 } } }
] };
// Current (in-progress) season payload, same shape as the live endpoint.
const cur = { seasonId: 2025, teams: [
  { id: 1, name: 'Sustained Excellence', record: { overall: { wins: 3, losses: 1, ties: 0, pointsFor: 500.0 } } },
  { id: 2, name: 'Eternal Futility',     record: { overall: { wins: 1, losses: 3, ties: 0, pointsFor: 420.0 } } }
] };

// teamRecords pulls raw numbers from a single payload.
eq(teamRecords(s2023)[0], { espnId: 1, name: 'Sustained Excellence', wins: 10, losses: 4, ties: 0, pointsFor: 1600.5 }, 'teamRecords row');

// aggregateAllTime sums across all supplied seasons, keyed by ESPN team id.
const totals = aggregateAllTime([s2023, s2024, cur]);
eq(totals[1].wins, 22, 'team 1 total wins (10+9+3)');
eq(totals[1].losses, 9, 'team 1 total losses (4+4+1)');
eq(totals[1].ties, 1, 'team 1 total ties (0+1+0)');
eq(Math.round(totals[1].pointsFor * 10) / 10, 3650.5, 'team 1 total PF');
eq(totals[1].seasons, 3, 'team 1 played 3 seasons');
eq(formatRecord(totals[1]), '22-9-1', 'team 1 all-time record string');

eq(totals[2].wins, 10, 'team 2 total wins (4+5+1)');
eq(formatRecord(totals[2]), '10-21-1', 'team 2 all-time record string');

// A season a franchise didn't play (0-0-0) must not inflate its season count.
const withGap = aggregateAllTime([
  { teams: [{ id: 5, record: { overall: { wins: 0, losses: 0, ties: 0, pointsFor: 0 } } }] },
  { teams: [{ id: 5, record: { overall: { wins: 7, losses: 7, ties: 0, pointsFor: 1200 } } }] }
]);
eq(withGap[5].seasons, 1, 'empty season not counted');
eq(formatRecord(withGap[5]), '7-7', 'no-tie record omits trailing ties');

console.log(`\n  All ${n} history assertions passed.\n`);
