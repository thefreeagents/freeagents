// Pure helpers for Off-Season Mode contract terms.
//
// League contract rules (set by the commissioner when signing an ESPN player
// as a new Contract Player):
//   - AUCTION: a player drafted at the ESPN auction may be signed for 1-3
//     years at their auction price (same $ each year).
//   - WAIVER: a player acquired through ESPN waivers may be signed for 1-2
//     years at $11 in year 1 and $15 in year 2.
//
// These are intentionally pure (no DB, no I/O) so they can be unit-tested.

const WAIVER_SCHEDULE = [11, 15]; // year 1, year 2

// How many years each acquisition type allows.
function maxYears(acqType) {
  return acqType === 'waiver' ? 2 : 3;
}

// Return the yearly salary array for a given offer + chosen number of years.
// Throws on invalid input so callers can surface a friendly message.
function salarySchedule(acqType, auctionPrice, years) {
  const y = parseInt(years, 10);
  if (!Number.isInteger(y) || y < 1 || y > maxYears(acqType)) {
    throw new Error(`Choose between 1 and ${maxYears(acqType)} years for a ${acqType} signing.`);
  }
  if (acqType === 'waiver') {
    return WAIVER_SCHEDULE.slice(0, y);
  }
  const price = parseInt(auctionPrice, 10);
  if (!Number.isInteger(price) || price < 1) {
    throw new Error('Enter the auction price (a whole dollar amount) before signing.');
  }
  return Array.from({ length: y }, () => price);
}

// Build the multi-line contract text the roster stores/displays, e.g.
//   "2026: $12\n2027: $12\n2028: $12"
function buildContractText(startYear, acqType, auctionPrice, years) {
  const start = parseInt(startYear, 10) || new Date().getFullYear();
  const schedule = salarySchedule(acqType, auctionPrice, years);
  return schedule.map((amt, i) => `${start + i}: $${amt}`).join('\n');
}

// One-line human summary of what's on offer (shown next to an ESPN player so a
// team can see the terms before electing).
function offerSummary(acqType, auctionPrice) {
  if (acqType === 'waiver') {
    return 'Waiver: 1-2 yrs at $11 / $15';
  }
  const price = parseInt(auctionPrice, 10);
  return price >= 1
    ? `Auction: 1-3 yrs at $${price}/yr`
    : 'Auction: set the auction price';
}

module.exports = { maxYears, salarySchedule, buildContractText, offerSummary, WAIVER_SCHEDULE };
