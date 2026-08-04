// Parse an ESPN "Draft Recap" PDF into per-player auction prices.
//
// WHY THIS EXISTS: The Free Agents is a *private* ESPN league, so ESPN's public
// read API returns the roster but hides the auction bid amounts (they come back
// as $0). The commissioner CAN, however, export the Draft Recap page as a PDF
// from ESPN, and that PDF lists every player's real winning bid. This module
// reads that PDF so prices can be imported without any private-API credentials.
//
// PDF STRUCTURE (as emitted by pdf-parse, which flattens each visual column):
// for every team the text runs as ->  <Team Name>  "OFFER AMOUNT"  $a1 $a2 ...
// "NO.PLAYER"  <pick><Player Name> <NFLteam>, <POS> ... The amount list and the
// player list are PARALLEL (both in pick order), so we zip them by index. We do
// NOT rely on the team columns — players are matched to the site roster by name
// downstream, so the (often noisy) column team names are irrelevant here.

const POS = 'QB|RB|WR|TE|K|PK|DST|D/ST';
const AMOUNT_RE = /^\$(\d+)$/;
const PLAYER_RE = new RegExp(`^(\\d{1,3})(.+?)\\s([A-Za-z]{2,3}),\\s(${POS})$`);

// Pull the auction season out of the recap text (best-effort, for display only).
function detectSeason(text) {
  let m = text.match(/league history pages from the (\d{4}) season/i);
  if (m) return m[1];
  m = text.match(/Draft Date:[^\n]*?(\b20\d{2}\b)/i);
  if (m) return m[1];
  m = text.match(/^\s*(20\d{2})\s*$/m);
  return m ? m[1] : '';
}

function detectLeagueName(text) {
  const m = text.match(/Draft Recap\s*\n?\s*(.+)/);
  return m ? m[1].trim() : '';
}

// Parse already-extracted recap text -> { players, season, leagueName, warnings }.
// players: [{ name, nfl, pos, price, pick }]  (pure; no pdf dependency).
function parseDraftRecapText(text) {
  const raw = String(text || '').split('\n').map(s => s.trim());
  const lines = raw.filter(Boolean);
  const isAmount = s => AMOUNT_RE.test(s);
  const isPlayer = s => PLAYER_RE.test(s);

  const players = [];
  const warnings = [];
  let blocks = 0;

  let i = 0;
  while (i < lines.length) {
    if (lines[i] !== 'OFFER AMOUNT') { i++; continue; }
    blocks++;
    i++; // past the "OFFER AMOUNT" header

    const amounts = [];
    while (i < lines.length && isAmount(lines[i])) {
      amounts.push(parseInt(lines[i].match(AMOUNT_RE)[1], 10));
      i++;
    }
    if (lines[i] === 'NO.PLAYER' || lines[i] === 'NO.PLAYER ') i++;

    const picks = [];
    while (i < lines.length && isPlayer(lines[i])) {
      const m = lines[i].match(PLAYER_RE);
      picks.push({ pick: parseInt(m[1], 10), name: m[2].trim(), nfl: m[3], pos: m[4] });
      i++;
    }

    if (amounts.length !== picks.length) {
      warnings.push(`A draft column had ${amounts.length} prices but ${picks.length} players; matched the first ${Math.min(amounts.length, picks.length)} by pick order.`);
    }
    const n = Math.min(amounts.length, picks.length);
    for (let k = 0; k < n; k++) {
      players.push({ name: picks[k].name, nfl: picks[k].nfl, pos: picks[k].pos, price: amounts[k], pick: picks[k].pick });
    }
  }

  return { players, season: detectSeason(text), leagueName: detectLeagueName(text), warnings, blocks };
}

// Extract text from a PDF buffer (lazy require so parseDraftRecapText stays
// dependency-free and unit-testable), then parse it.
async function parseDraftRecapPdf(buffer) {
  let pdfParse;
  try {
    pdfParse = require('pdf-parse');
  } catch (e) {
    throw new Error('PDF support is not installed on the server (missing "pdf-parse").');
  }
  let data;
  try {
    data = await pdfParse(buffer);
  } catch (e) {
    throw new Error(`Could not read that PDF (${e.message}).`);
  }
  const result = parseDraftRecapText(data.text || '');
  result.pages = data.numpages;
  if (!result.players.length) {
    throw new Error('No auction prices were found in that PDF. Make sure it is the ESPN "Draft Recap" page (a Salary Cap draft), not the League Rosters or another export.');
  }
  return result;
}

module.exports = { parseDraftRecapText, parseDraftRecapPdf, detectSeason, detectLeagueName };
