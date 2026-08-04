// Public-facing routes: home/teams, single team, rules.
// When Off-Season Mode is on, each team page also shows the off-season move
// controls. For now these are open to anyone (no login) so functionality can be
// demoed; later, member logins will restrict each page to its owner.
const express = require('express');
const { marked } = require('marked');
const { db, DISPLAY_SECTIONS, CONTRACT_CAP, TAXI_CAP } = require('../db/db');
const espnSync = require('../services/espnSync');
const offseason = require('../services/offseason');
const moves = require('../services/offseasonMoves');

const router = express.Router();

function getTeams() {
  return db.prepare('SELECT * FROM teams ORDER BY sort_order, name').all();
}

// Home = teams overview
router.get('/', (req, res) => {
  res.render('index', { teams: getTeams(), active: 'teams' });
});

// Single team page with full roster (+ off-season controls when the mode is on)
router.get('/team/:slug', (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE slug = ?').get(req.params.slug);
  if (!team) return res.status(404).render('404');
  const players = db.prepare('SELECT * FROM players WHERE team_id = ? ORDER BY sort_order, id').all(team.id);
  const roster = DISPLAY_SECTIONS.map(s => ({
    ...s,
    players: players.filter(p => p.section === s.key)
  }));
  const champs = (team.championships || '').split(',').map(c => c.trim()).filter(Boolean);

  // Off-season transaction history + move-panel data.
  const transactions = db.prepare(
    'SELECT * FROM transactions WHERE team_id = ? ORDER BY id DESC'
  ).all(team.id);
  const offseasonOn = moves.isOn();
  const espnPlayers = players.filter(p => p.section === 'espn_active');
  const offerRows = db.prepare('SELECT * FROM espn_offers WHERE team_id = ?').all(team.id);
  const offers = {};
  for (const o of offerRows) offers[o.player_name] = o;
  const counts = {
    contract: players.filter(p => p.section === 'contract').length,
    taxi: players.filter(p => p.section === 'taxi').length
  };

  res.render('team', {
    team, roster, champs, transactions,
    txnGroups: moves.groupTransactions(transactions), active: 'teams',
    offseasonOn, espnPlayers, offers, counts,
    caps: { contract: CONTRACT_CAP, taxi: TAXI_CAP },
    startYear: espnSync.currentSeason(),
    offSummary: offseason.offerSummary,
    maxYears: offseason.maxYears,
    osmsg: req.query.osmsg || null,
    oswarn: req.query.oswarn === '1'
  });
});

// ---- Off-season moves from a team page ------------------------------------
// Same shared logic as the admin routes; only the redirect target differs.
function requireOffseason(req, res, next) {
  const team = db.prepare('SELECT id, slug FROM teams WHERE slug = ?').get(req.params.slug);
  if (!team) return res.status(404).render('404');
  if (!moves.isOn()) return res.redirect('/team/' + team.slug);
  req.team = team;
  next();
}
const backToTeamMsg = (res, slug, r) =>
  res.redirect('/team/' + slug + osQuery(r));

// Build the ?osmsg=...&oswarn=... flash query from a submit/undo result.
function osQuery(r) {
  let msg, warn = 0;
  if (r.undo) msg = 'Submission undone — the team was reset to how it was before.';
  else if (r.empty) msg = 'No moves were selected — nothing to submit.';
  else if (r.ok) msg = 'Submitted ' + r.applied + ' move' + (r.applied === 1 ? '' : 's') + '.';
  else { msg = r.message || 'Nothing was changed.'; warn = 1; }
  return '?osmsg=' + encodeURIComponent(msg) + (warn ? '&oswarn=1' : '');
}

// One "Submit" applies every chosen move at once (caps enforced together).
router.post('/team/:slug/moves/submit', requireOffseason, (req, res) => {
  backToTeamMsg(res, req.team.slug, moves.submitMoves(req.team.id, req.body, { isAdmin: false }));
});
// One "Undo" reverses an entire submitted batch back to the prior state.
router.post('/team/:slug/moves/undo-batch/:batchId', requireOffseason, (req, res) => {
  const code = moves.undoBatch(req.team.id, req.params.batchId);
  backToTeamMsg(res, req.team.slug, code ? { ok: true, undo: true } : { ok: false, message: 'Nothing to undo.' });
});
// Legacy single-move undo (for any pre-batch log rows).
router.post('/team/:slug/moves/undo/:txnId', requireOffseason, (req, res) => {
  const code = moves.undo(req.team.id, req.params.txnId);
  backToTeamMsg(res, req.team.slug, code ? { ok: true, undo: true } : { ok: false, message: 'Nothing to undo.' });
});

// Old bookmark support: /rules -> /page/rules
router.get('/rules', (req, res) => res.redirect(301, '/page/rules'));

// Generic content page (Rules, Records, NCAA Draft, Free Agents, etc.)
router.get('/page/:slug', (req, res) => {
  const page = db.prepare('SELECT * FROM pages WHERE slug = ?').get(req.params.slug);
  if (!page) return res.status(404).render('404');
  const html = marked.parse(page.content || '');
  res.render('page', { page, html, active: page.slug });
});

module.exports = router;
