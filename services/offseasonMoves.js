// Shared off-season move logic.
//
// Every off-season transaction (drop, promote, sign, undo, etc.) lives here as a
// plain function so BOTH the commissioner's admin pages and the public team
// pages run the exact same code. Each function performs the move and returns a
// short "result code" string (e.g. 'dropped', 'taxi_full') that the calling
// route turns into a redirect + friendly message. Returning null means "nothing
// to do / not applicable".
//
// Caps are enforced here, not in the routes, so they can never be bypassed by
// hitting a different page.
const { db, CONTRACT_CAP, TAXI_CAP } = require('../db/db');
const offseason = require('./offseason');
const espnSync = require('./espnSync');

const today = () => new Date().toISOString().slice(0, 10);

// Is Off-Season Mode currently on? All moves refuse to run unless it is.
function isOn() {
  return espnSync.getSetting('offseason_mode') === '1';
}

// Fetch a player, ensuring it belongs to the given team (prevents cross-team
// tampering via a guessed player id).
function teamPlayer(teamId, playerId) {
  return db.prepare('SELECT * FROM players WHERE id = ? AND team_id = ?').get(playerId, teamId);
}

function sectionCount(teamId, section) {
  return db.prepare('SELECT COUNT(*) c FROM players WHERE team_id = ? AND section = ?')
    .get(teamId, section).c;
}

// When a batch "Submit" is running, every move logged during it is tagged with
// this shared batch id so the whole submission can be undone as one unit. It is
// set for the duration of submitMoves() and cleared afterward. Node handles each
// request synchronously through these (synchronous) SQLite calls, so a simple
// module-level value is safe here.
let activeBatch = null;

// Record a completed move in the audit log. `payload` holds whatever is needed
// to reverse the move; it's stored as JSON so undo() can read it back.
function logTxn(teamId, kind, playerName, summary, payload) {
  db.prepare(
    'INSERT INTO transactions (team_id, kind, player_name, summary, payload, undone, batch_id, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)'
  ).run(teamId, kind, playerName, summary, JSON.stringify(payload || {}), activeBatch, today());
}

// 1) Drop a Taxi Squad player entirely.
function dropTaxi(teamId, pid) {
  const p = teamPlayer(teamId, pid);
  if (p && p.section === 'taxi') {
    db.prepare('DELETE FROM players WHERE id = ?').run(p.id);
    logTxn(teamId, 'drop', p.name, `Dropped ${p.name} from the Taxi Squad`,
      { name: p.name, contracts: p.contracts, image: p.image, sort_order: p.sort_order });
  }
  return 'dropped';
}

// 2) Promote a Taxi Squad player to NCAA Contracts.
function taxiToNcaac(teamId, pid) {
  const p = teamPlayer(teamId, pid);
  if (p && p.section === 'taxi') {
    db.prepare("UPDATE players SET section = 'ncaa_contract' WHERE id = ?").run(p.id);
    logTxn(teamId, 'promote_ncaac', p.name, `Promoted ${p.name} from Taxi Squad to NCAA Contracts`,
      { player_id: p.id });
  }
  return 'promoted_ncaac';
}

// 3a) Toggle whether an NCAA Player is eligible to be promoted to the Taxi Squad.
function toggleEligible(teamId, pid) {
  const p = teamPlayer(teamId, pid);
  if (p && p.section === 'ncaa_player') {
    db.prepare('UPDATE players SET eligible = ? WHERE id = ?').run(p.eligible ? 0 : 1, p.id);
  }
  return null;
}

// 3b) Promote an eligible NCAA Player to the Taxi Squad (cap: TAXI_CAP).
function ncaaToTaxi(teamId, pid) {
  const p = teamPlayer(teamId, pid);
  if (!p || p.section !== 'ncaa_player') return null;
  if (!p.eligible) return 'not_eligible';
  if (sectionCount(teamId, 'taxi') >= TAXI_CAP) return 'taxi_full';
  db.prepare("UPDATE players SET section = 'taxi', eligible = 0 WHERE id = ?").run(p.id);
  logTxn(teamId, 'promote_taxi', p.name, `Promoted ${p.name} from NCAA Players to Taxi Squad`,
    { player_id: p.id });
  return 'promoted_taxi';
}

// 3c) Activate an eligible NCAA Player into NCAA Contracts.
function ncaaActivate(teamId, pid) {
  const p = teamPlayer(teamId, pid);
  if (!p || p.section !== 'ncaa_player') return null;
  if (!p.eligible) return 'not_eligible';
  db.prepare("UPDATE players SET section = 'ncaa_contract', eligible = 0 WHERE id = ?").run(p.id);
  logTxn(teamId, 'activate_ncaac', p.name, `Activated ${p.name} from NCAA Players to NCAA Contracts`,
    { player_id: p.id });
  return 'activated_ncaac';
}

// 3d) Drop an eligible NCAA Player from the watchlist entirely.
function dropNcaaPlayer(teamId, pid) {
  const p = teamPlayer(teamId, pid);
  if (!p || p.section !== 'ncaa_player') return null;
  if (!p.eligible) return 'not_eligible';
  db.prepare('DELETE FROM players WHERE id = ?').run(p.id);
  logTxn(teamId, 'drop_ncaa', p.name, `Dropped ${p.name} from NCAA Players`,
    { name: p.name, contracts: p.contracts, image: p.image, sort_order: p.sort_order });
  return 'dropped_ncaa';
}

// 3e) Apply the chosen move to an eligible NCAA Player. The team page/admin
// editor forces a selection (Activate / Taxi / Drop); this is the single entry
// point that dispatches to the right handler and guards against a missing or
// unknown choice server-side (belt-and-suspenders with the required radios).
function ncaaEligibleMove(teamId, pid, action) {
  const p = teamPlayer(teamId, pid);
  if (!p || p.section !== 'ncaa_player') return null;
  if (!p.eligible) return 'not_eligible';
  if (action === 'activate') return ncaaActivate(teamId, pid);
  if (action === 'taxi') return ncaaToTaxi(teamId, pid);
  if (action === 'drop') return dropNcaaPlayer(teamId, pid);
  return 'choose_action';
}

// Pull the "$N" price for the current season out of a contract's text lines
// (e.g. "2026: $12" -> "$12"). Returns '' when no line matches. Used to record
// the drop penalty (a dropped Contract Player's penalty equals their current
// season price) in the audit-log summary.
function seasonPrice(contracts) {
  if (!contracts) return '';
  const year = String(espnSync.currentSeason());
  let found = '';
  String(contracts).split(/\r?\n/).forEach((line) => {
    const mm = line.match(/(\d{4})\s*:\s*\$?\s*(\d+)/);
    if (mm && mm[1] === year) found = '$' + mm[2];
  });
  return found;
}

// Parse a Contract Player's remaining obligations: every "YYYY: $N" line for the
// current season and beyond, in year order. These are the years the drop penalty
// (dead money) keeps applying, so we can spell them out — year by year — in the
// drop's log entry and notification email for a permanent record.
function remainingYears(contracts) {
  const from = espnSync.currentSeason();
  const out = [];
  String(contracts || '').split(/\r?\n/).forEach((line) => {
    const mm = line.match(/(\d{4})\s*:\s*\$?\s*(\d+)/);
    if (mm) {
      const yr = parseInt(mm[1], 10);
      if (yr >= from) out.push({ year: yr, amount: parseInt(mm[2], 10) });
    }
  });
  out.sort((a, b) => a.year - b.year);
  return out;
}

// 6) Drop a Contract Player entirely. A dropped contract is still paid in full as
// a penalty (dead money) — dropping only frees the roster slot. We record the
// remaining per-year salary right in the log summary (which is also what the
// notification email shows) so the future-year penalties are documented.
function dropContract(teamId, pid) {
  const p = teamPlayer(teamId, pid);
  if (p && p.section === 'contract') {
    const years = remainingYears(p.contracts);
    let penaltyText = '';
    if (years.length) {
      const schedule = years.map(y => `${y.year}: $${y.amount}`).join(', ');
      const total = years.reduce((s, y) => s + y.amount, 0);
      penaltyText = ` — dead-money penalty by year: ${schedule} (total $${total})`;
    }
    db.prepare('DELETE FROM players WHERE id = ?').run(p.id);
    logTxn(teamId, 'drop_contract', p.name,
      `Dropped ${p.name} from Contract Players${penaltyText}`,
      { name: p.name, contracts: p.contracts, image: p.image, sort_order: p.sort_order });
  }
  return 'dropped_contract';
}

// Dead money: a dropped Contract Player's salary keeps counting against the
// $200 cap (they're paid the same amount as a penalty — only their roster slot
// opens up). We reconstruct that ongoing charge from the audit log rather than a
// separate column: every still-in-effect (undone = 0) 'drop_contract' entry
// stores the player's original contract text, so we total each one's price for
// the CURRENT season. This means the penalty naturally reflects a multi-year
// contract (falling to $0 once its last season passes) and disappears the moment
// the drop is undone (which re-creates the player and marks the row undone).
function deadMoney(teamId) {
  const rows = db.prepare(
    "SELECT payload FROM transactions WHERE team_id = ? AND kind = 'drop_contract' AND undone = 0"
  ).all(teamId);
  let total = 0;
  for (const r of rows) {
    let data = {};
    try { data = JSON.parse(r.payload || '{}'); } catch (e) { data = {}; }
    const pr = seasonPrice(data.contracts);
    if (pr) total += parseInt(pr.replace(/[^0-9]/g, ''), 10) || 0;
  }
  return total;
}

// 5) Drop an NCAA Contract player entirely.
function dropNcaac(teamId, pid) {
  const p = teamPlayer(teamId, pid);
  if (p && p.section === 'ncaa_contract') {
    db.prepare('DELETE FROM players WHERE id = ?').run(p.id);
    logTxn(teamId, 'drop_ncaac', p.name, `Dropped ${p.name} from NCAA Contracts`,
      { name: p.name, contracts: p.contracts, image: p.image, sort_order: p.sort_order });
  }
  return 'dropped_ncaac';
}

// 4a) Save/update the available contract offer for an ESPN-listed player, so a
// team can see the terms before electing. Kept in espn_offers (survives syncs).
function saveOffer(teamId, body) {
  const name = (body.player_name || '').trim();
  const acqType = body.acq_type === 'waiver' ? 'waiver' : 'auction';
  const price = parseInt(body.auction_price, 10) || 0;
  if (name) {
    db.prepare(`
      INSERT INTO espn_offers (team_id, player_name, acq_type, auction_price, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(team_id, player_name)
      DO UPDATE SET acq_type = excluded.acq_type, auction_price = excluded.auction_price, updated_at = excluded.updated_at
    `).run(teamId, name, acqType, price, today());
  }
  return 'offer_saved';
}

// 4b) Sign an ESPN-listed player as a new Contract Player (cap: CONTRACT_CAP).
// Builds the salary schedule from the saved offer + chosen years, creates the
// contract row, and removes the volatile espn_active row for that player.
function signPlayer(teamId, body) {
  const name = (body.player_name || '').trim();
  if (!name) return null;
  if (sectionCount(teamId, 'contract') >= CONTRACT_CAP) return 'contract_full';
  const offer = db.prepare('SELECT * FROM espn_offers WHERE team_id = ? AND player_name = ?').get(teamId, name);
  const acqType = offer ? offer.acq_type : 'auction';
  const price = offer ? offer.auction_price : 0;
  let contractText;
  try {
    contractText = offseason.buildContractText(espnSync.currentSeason(), acqType, price, body.years);
  } catch (e) {
    return 'bad_terms';
  }
  const maxOrder = db.prepare(
    "SELECT MAX(sort_order) m FROM players WHERE team_id = ? AND section = 'contract'"
  ).get(teamId).m || 0;
  const info = db.prepare(
    "INSERT INTO players (team_id, name, section, contracts, sort_order) VALUES (?, ?, 'contract', ?, ?)"
  ).run(teamId, name, contractText, maxOrder + 1);
  // Remove the now-signed player from the auto ESPN section + clear the offer.
  db.prepare("DELETE FROM players WHERE team_id = ? AND section = 'espn_active' AND name = ?").run(teamId, name);
  db.prepare('DELETE FROM espn_offers WHERE team_id = ? AND player_name = ?').run(teamId, name);
  const termLabel = contractText.split('\n').join(', ');
  logTxn(teamId, 'sign', name, `Signed ${name} as a Contract Player (${termLabel})`,
    { player_id: info.lastInsertRowid, name, acq_type: acqType, auction_price: price });
  return 'signed';
}

// Reverse a single logged transaction and mark it undone (kept in the log for
// the audit trail). Shared by the single-move undo() and the batch undoBatch().
function reverseTxn(teamId, txn) {
  if (!txn || txn.undone) return;
  let data = {};
  try { data = JSON.parse(txn.payload || '{}'); } catch (e) { data = {}; }

  if (txn.kind === 'drop' || txn.kind === 'drop_ncaac' || txn.kind === 'drop_ncaa' || txn.kind === 'drop_contract') {
    // Re-create the deleted player back in its original section. NCAA Players
    // come back eligible (that's the only state they can be dropped from).
    const section = txn.kind === 'drop' ? 'taxi'
      : txn.kind === 'drop_ncaac' ? 'ncaa_contract'
      : txn.kind === 'drop_contract' ? 'contract' : 'ncaa_player';
    const eligible = txn.kind === 'drop_ncaa' ? 1 : 0;
    db.prepare(
      'INSERT INTO players (team_id, name, section, contracts, image, sort_order, eligible) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(teamId, data.name, section, data.contracts || '', data.image || '', data.sort_order || 0, eligible);
  } else if (txn.kind === 'promote_ncaac') {
    db.prepare("UPDATE players SET section = 'taxi' WHERE id = ? AND team_id = ?").run(data.player_id, teamId);
  } else if (txn.kind === 'promote_taxi') {
    db.prepare("UPDATE players SET section = 'ncaa_player', eligible = 1 WHERE id = ? AND team_id = ?").run(data.player_id, teamId);
  } else if (txn.kind === 'activate_ncaac') {
    db.prepare("UPDATE players SET section = 'ncaa_player', eligible = 1 WHERE id = ? AND team_id = ?").run(data.player_id, teamId);
  } else if (txn.kind === 'sign') {
    db.prepare('DELETE FROM players WHERE id = ? AND team_id = ?').run(data.player_id, teamId);
    const dup = db.prepare("SELECT id FROM players WHERE team_id = ? AND section = 'espn_active' AND name = ?").get(teamId, data.name);
    if (!dup) {
      db.prepare("INSERT INTO players (team_id, name, section, contracts, sort_order) VALUES (?, ?, 'espn_active', '', 0)").run(teamId, data.name);
    }
    db.prepare(`
      INSERT INTO espn_offers (team_id, player_name, acq_type, auction_price, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(team_id, player_name)
      DO UPDATE SET acq_type = excluded.acq_type, auction_price = excluded.auction_price
    `).run(teamId, data.name, data.acq_type || 'auction', data.auction_price || 0, today());
  }

  db.prepare('UPDATE transactions SET undone = 1 WHERE id = ?').run(txn.id);
}

// Undo one completed move by its transaction id (legacy single-move undo, kept
// for any pre-batch log rows). Returns 'undone' on success.
function undo(teamId, txnId) {
  const txn = db.prepare('SELECT * FROM transactions WHERE id = ? AND team_id = ?').get(txnId, teamId);
  if (!txn || txn.undone) return null;
  reverseTxn(teamId, txn);
  return 'undone';
}

// ---------------------------------------------------------------------------
// Batch submit + batch undo
//
// The team page shows one big form: a choice for every player (Taxi: keep /
// promote / drop; NCAA Contracts: keep / drop; eligible NCAA Players: keep /
// activate / taxi / drop) plus which ESPN players to sign. A single "Submit"
// applies them ALL AT ONCE inside one database transaction, so the roster caps
// (max 6 Contract, max 2 Taxi) are enforced against the final result — if any
// single move would break a rule, nothing is applied and the team is left
// exactly as it was. A matching "Undo" reverses the whole submission.
// ---------------------------------------------------------------------------

// Result codes that mean "this move can't be applied" -> abort the whole batch.
const FAILURES = new Set(['taxi_full', 'contract_full', 'not_eligible', 'bad_terms', 'choose_action']);

// Turn the submitted form body into an ordered list of moves. Anything left on
// its default ("keep"/unchecked) is simply ignored.
function collectMoves(body) {
  const list = [];
  for (const k of Object.keys(body || {})) {
    let m;
    const v = body[k];
    if ((m = /^contract_(\d+)$/.exec(k)) && v && v !== 'keep') {
      list.push({ type: 'contract', pid: parseInt(m[1], 10), action: v });
    } else if ((m = /^taxi_(\d+)$/.exec(k)) && v && v !== 'keep') {
      list.push({ type: 'taxi', pid: parseInt(m[1], 10), action: v });
    } else if ((m = /^ncaac_(\d+)$/.exec(k)) && v && v !== 'keep') {
      list.push({ type: 'ncaac', pid: parseInt(m[1], 10), action: v });
    } else if ((m = /^ncaa_(\d+)$/.exec(k)) && v && v !== 'keep') {
      list.push({ type: 'ncaa', pid: parseInt(m[1], 10), action: v });
    } else if ((m = /^sign_(\d+)$/.exec(k)) && (v === '1' || v === 'on' || v === true)) {
      list.push({ type: 'sign', pid: parseInt(m[1], 10), years: body['years_' + m[1]] });
    }
  }
  // Order so slot-FREEING moves run before slot-FILLING moves; that way a team
  // can, in one submit, drop a Taxi player and promote another into the freed
  // spot without tripping the cap.
  const rank = (mv) => {
    if (mv.type === 'contract' && mv.action === 'drop') return 1; // frees a Contract slot
    if (mv.type === 'taxi') return 1;            // drop / promote-out of Taxi
    if (mv.type === 'ncaac' && mv.action === 'drop') return 1;
    if (mv.type === 'ncaa' && mv.action === 'drop') return 2;
    if (mv.type === 'ncaa' && mv.action === 'activate') return 2; // into NCAA Contracts (uncapped)
    if (mv.type === 'ncaa' && mv.action === 'taxi') return 3;     // into Taxi (capped)
    if (mv.type === 'sign') return 4;            // into Contract (capped)
    return 5;
  };
  list.sort((a, b) => rank(a) - rank(b));
  return list;
}

// Apply a single collected move, recording the player's display name on the
// move (for error messages). Returns the underlying result code.
function execMove(teamId, mv, opts) {
  const p = teamPlayer(teamId, mv.pid);
  if (p) mv._name = p.name;

  if (mv.type === 'sign') {
    if (!p || p.section !== 'espn_active') return null;
    return signPlayer(teamId, { player_name: p.name, years: mv.years });
  }
  if (mv.type === 'contract') {
    if (mv.action === 'drop') return dropContract(teamId, mv.pid);
    return null;
  }
  if (mv.type === 'taxi') {
    if (mv.action === 'promote') return taxiToNcaac(teamId, mv.pid);
    if (mv.action === 'drop') return dropTaxi(teamId, mv.pid);
    return null;
  }
  if (mv.type === 'ncaac') {
    if (mv.action === 'drop') return dropNcaac(teamId, mv.pid);
    return null;
  }
  if (mv.type === 'ncaa') {
    // On the commissioner (admin) page the choice itself implies eligibility, so
    // mark the player eligible first; the public page only ever shows choices
    // for players the commissioner already made eligible.
    if (opts && opts.isAdmin && p && p.section === 'ncaa_player' && !p.eligible) {
      db.prepare("UPDATE players SET eligible = 1 WHERE id = ? AND team_id = ?").run(mv.pid, teamId);
    }
    return ncaaEligibleMove(teamId, mv.pid, mv.action);
  }
  return null;
}

function failMessage(code, name) {
  const who = name ? `"${name}"` : 'a player';
  switch (code) {
    case 'taxi_full': return `That would put more than ${TAXI_CAP} players on the Taxi Squad (stopped at ${who}). Nothing was changed.`;
    case 'contract_full': return `That would sign more than ${CONTRACT_CAP} Contract Players (stopped at ${who}). Nothing was changed.`;
    case 'bad_terms': return `Contract terms for ${who} aren't set correctly (price / years). Nothing was changed.`;
    case 'not_eligible': return `${who} isn't eligible for that move yet. Nothing was changed.`;
    case 'choose_action': return `Please choose an action for ${who}. Nothing was changed.`;
    default: return 'That submission could not be completed, so nothing was changed.';
  }
}

// Apply every chosen move at once. Returns:
//   { ok:true, empty:true }                      -> nothing was selected
//   { ok:true, batchId, applied }                -> all moves applied
//   { ok:false, error, message, player }         -> a rule was hit; NOTHING applied
function submitMoves(teamId, body, opts) {
  const list = collectMoves(body);
  if (!list.length) return { ok: true, empty: true, applied: 0 };

  const batchId = db.prepare('SELECT COALESCE(MAX(batch_id), 0) + 1 AS n FROM transactions').get().n;

  db.exec('BEGIN');
  activeBatch = batchId;
  try {
    for (const mv of list) {
      const res = execMove(teamId, mv, opts);
      if (FAILURES.has(res)) {
        db.exec('ROLLBACK');
        activeBatch = null;
        return { ok: false, error: res, player: mv._name || '', message: failMessage(res, mv._name) };
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    activeBatch = null;
    return { ok: false, error: 'exception', message: 'Something went wrong applying the moves, so nothing was changed.' };
  }
  activeBatch = null;
  return { ok: true, batchId, applied: list.length };
}

// Build the commissioner-notification email for one submitted batch. Shared by
// BOTH the public team page and the admin editor so a submission always produces
// the same alert no matter who made it. Returns { subject, text } or null when
// there is nothing to report (e.g. an empty or already-undone batch).
function submissionEmail(teamId, batchId, viewUrl) {
  const team = db.prepare('SELECT name, slug FROM teams WHERE id = ?').get(teamId);
  if (!team) return null;
  const rows = db.prepare(
    'SELECT summary FROM transactions WHERE team_id = ? AND batch_id = ? AND undone = 0 ORDER BY id'
  ).all(teamId, batchId);
  if (!rows.length) return null;
  const lines = rows.map(r => '\u2022 ' + r.summary);
  const subject = `[The Free Agents] ${team.name} submitted off-season moves`;
  const text =
    `${team.name} just submitted the following off-season ` +
    `move${lines.length === 1 ? '' : 's'}:\n\n` +
    lines.join('\n') +
    (viewUrl ? `\n\nView the team: ${viewUrl}` : '');
  return { subject, text };
}

// Group audit-log rows (ordered newest-first) into submissions for display.
// Each batch becomes one group with a single Undo; legacy pre-batch rows (no
// batch_id) each stand alone. Returns groups newest-first, items chronological.
function groupTransactions(rows) {
  const groups = [];
  const byBatch = new Map();
  for (const t of rows || []) {
    if (t.batch_id == null) {
      groups.push({ batchId: null, txnId: t.id, created_at: t.created_at, items: [t], allUndone: !!t.undone });
    } else {
      let g = byBatch.get(t.batch_id);
      if (!g) {
        g = { batchId: t.batch_id, txnId: null, created_at: t.created_at, items: [], allUndone: true };
        byBatch.set(t.batch_id, g);
        groups.push(g);
      }
      g.items.push(t);
      if (!t.undone) g.allUndone = false;
    }
  }
  for (const g of groups) g.items.reverse(); // show moves in the order they happened
  // Once a submission is undone it disappears from the log entirely — we only
  // list submissions that are still in effect (and therefore still undoable).
  return groups.filter(g => !g.allUndone);
}

// Undo an entire submitted batch: reverse every move in it (newest first) and
// mark them undone. Returns 'undone' on success, null if nothing to undo.
function undoBatch(teamId, batchId) {
  const txns = db.prepare(
    'SELECT * FROM transactions WHERE team_id = ? AND batch_id = ? AND undone = 0 ORDER BY id DESC'
  ).all(teamId, parseInt(batchId, 10));
  if (!txns.length) return null;

  db.exec('BEGIN');
  try {
    for (const t of txns) reverseTxn(teamId, t);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    return null;
  }
  return 'undone';
}

module.exports = {
  isOn,
  dropTaxi,
  taxiToNcaac,
  toggleEligible,
  ncaaToTaxi,
  ncaaActivate,
  dropNcaaPlayer,
  ncaaEligibleMove,
  dropNcaac,
  dropContract,
  deadMoney,
  submissionEmail,
  saveOffer,
  signPlayer,
  undo,
  submitMoves,
  undoBatch,
  collectMoves,
  groupTransactions,
  CONTRACT_CAP,
  TAXI_CAP
};
