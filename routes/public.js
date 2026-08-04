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
    team, roster, champs, transactions, active: 'teams',
    offseasonOn, espnPlayers, offers, counts,
    caps: { contract: CONTRACT_CAP, taxi: TAXI_CAP },
    startYear: espnSync.currentSeason(),
    offSummary: offseason.offerSummary,
    maxYears: offseason.maxYears,
    move: req.query.move || null
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
const backToTeam = (res, slug, move) =>
  res.redirect('/team/' + slug + (move ? '?move=' + move : ''));

router.post('/team/:slug/moves/drop/:pid', requireOffseason, (req, res) => {
  backToTeam(res, req.team.slug, moves.dropTaxi(req.team.id, req.params.pid));
});
router.post('/team/:slug/moves/taxi-to-ncaac/:pid', requireOffseason, (req, res) => {
  backToTeam(res, req.team.slug, moves.taxiToNcaac(req.team.id, req.params.pid));
});
// Note: marking a player eligible is a COMMISSIONER-ONLY action, so there is
// deliberately no public 'eligible' route here (see routes/admin.js). Team
// pages can only promote players the commissioner has already marked eligible.
router.post('/team/:slug/moves/ncaa-to-taxi/:pid', requireOffseason, (req, res) => {
  backToTeam(res, req.team.slug, moves.ncaaToTaxi(req.team.id, req.params.pid));
});
// Eligible NCAA Player: the team must choose Activate / Taxi / Drop.
router.post('/team/:slug/moves/ncaa-eligible/:pid', requireOffseason, (req, res) => {
  backToTeam(res, req.team.slug, moves.ncaaEligibleMove(req.team.id, req.params.pid, req.body.action));
});
router.post('/team/:slug/moves/drop-ncaac/:pid', requireOffseason, (req, res) => {
  backToTeam(res, req.team.slug, moves.dropNcaac(req.team.id, req.params.pid));
});
// Note: setting a player's contract terms (the "offer") is a COMMISSIONER-ONLY
// action, so there is deliberately no public 'offer' route here (see
// routes/admin.js). Team pages can only sign a player on terms the commissioner
// has already set — the team still chooses the number of years.
router.post('/team/:slug/moves/sign', requireOffseason, (req, res) => {
  backToTeam(res, req.team.slug, moves.signPlayer(req.team.id, req.body));
});
router.post('/team/:slug/moves/undo/:txnId', requireOffseason, (req, res) => {
  backToTeam(res, req.team.slug, moves.undo(req.team.id, req.params.txnId));
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
