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

// Record a completed move in the audit log. `payload` holds whatever is needed
// to reverse the move; it's stored as JSON so undo() can read it back.
function logTxn(teamId, kind, playerName, summary, payload) {
  db.prepare(
    'INSERT INTO transactions (team_id, kind, player_name, summary, payload, undone, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)'
  ).run(teamId, kind, playerName, summary, JSON.stringify(payload || {}), today());
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

// Undo a completed move. Reverses the specific change and marks the transaction
// as undone (kept in the log for the audit trail). Returns 'undone' on success.
function undo(teamId, txnId) {
  const txn = db.prepare('SELECT * FROM transactions WHERE id = ? AND team_id = ?').get(txnId, teamId);
  if (!txn || txn.undone) return null;
  let data = {};
  try { data = JSON.parse(txn.payload || '{}'); } catch (e) { data = {}; }

  if (txn.kind === 'drop' || txn.kind === 'drop_ncaac') {
    // Re-create the deleted player back in its original section.
    const section = txn.kind === 'drop' ? 'taxi' : 'ncaa_contract';
    db.prepare(
      'INSERT INTO players (team_id, name, section, contracts, image, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(teamId, data.name, section, data.contracts || '', data.image || '', data.sort_order || 0);
  } else if (txn.kind === 'promote_ncaac') {
    db.prepare("UPDATE players SET section = 'taxi' WHERE id = ? AND team_id = ?").run(data.player_id, teamId);
  } else if (txn.kind === 'promote_taxi') {
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
  return 'undone';
}

module.exports = {
  isOn,
  dropTaxi,
  taxiToNcaac,
  toggleEligible,
  ncaaToTaxi,
  dropNcaac,
  saveOffer,
  signPlayer,
  undo,
  CONTRACT_CAP,
  TAXI_CAP
};
