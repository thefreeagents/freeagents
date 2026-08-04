// Tests for the Off-Season contract-terms helpers.
// Run: node services/offseason.test.js
const assert = require('assert');
const { maxYears, salarySchedule, buildContractText, offerSummary } = require('./offseason');

let n = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
const throws = (fn, m) => { assert.throws(fn, m); n++; };

// maxYears
eq(maxYears('auction'), 3, 'auction allows up to 3');
eq(maxYears('waiver'), 2, 'waiver allows up to 2');

// salarySchedule — auction: flat auction price each year
eq(salarySchedule('auction', 14, 1), [14], 'auction 1yr');
eq(salarySchedule('auction', 14, 3), [14, 14, 14], 'auction 3yr flat price');
// salarySchedule — waiver: fixed $11 / $15
eq(salarySchedule('waiver', 0, 1), [11], 'waiver 1yr = $11');
eq(salarySchedule('waiver', 0, 2), [11, 15], 'waiver 2yr = $11/$15');

// buildContractText — multi-line, starts at given season
eq(buildContractText(2026, 'auction', 12, 3), '2026: $12\n2027: $12\n2028: $12', 'auction text');
eq(buildContractText(2026, 'waiver', 0, 2), '2026: $11\n2027: $15', 'waiver text');
eq(buildContractText(2026, 'waiver', 0, 1), '2026: $11', 'waiver 1yr text');

// Invalid inputs must throw (so routes can block the sign)
throws(() => salarySchedule('auction', 12, 4), 'auction 4yr rejected');
throws(() => salarySchedule('waiver', 0, 3), 'waiver 3yr rejected');
throws(() => salarySchedule('auction', 0, 2), 'auction with no price rejected');
throws(() => salarySchedule('auction', 12, 0), 'zero years rejected');

// offerSummary
eq(offerSummary('waiver', 0), 'Waiver: 1-2 yrs at $11 / $15', 'waiver summary');
eq(offerSummary('auction', 20), 'Auction: 1-3 yrs at $20/yr', 'auction summary with price');
eq(offerSummary('auction', 0), 'Auction: set the auction price', 'auction summary no price');

console.log(`\n  All ${n} off-season assertions passed.\n`);
