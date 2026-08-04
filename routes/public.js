// Public-facing routes: home/teams, single team, rules
const express = require('express');
const { marked } = require('marked');
const { db, DISPLAY_SECTIONS } = require('../db/db');

const router = express.Router();

function getTeams() {
  return db.prepare('SELECT * FROM teams ORDER BY sort_order, name').all();
}

// Home = teams overview
router.get('/', (req, res) => {
  res.render('index', { teams: getTeams(), active: 'teams' });
});

// Single team page with full roster
router.get('/team/:slug', (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE slug = ?').get(req.params.slug);
  if (!team) return res.status(404).render('404');
  const players = db.prepare('SELECT * FROM players WHERE team_id = ? ORDER BY sort_order, id').all(team.id);
  const roster = DISPLAY_SECTIONS.map(s => ({
    ...s,
    players: players.filter(p => p.section === s.key)
  }));
  const champs = (team.championships || '').split(',').map(c => c.trim()).filter(Boolean);
  // Off-season transaction history (read-only for visitors).
  const transactions = db.prepare(
    'SELECT kind, player_name, summary, undone, created_at FROM transactions WHERE team_id = ? ORDER BY id DESC'
  ).all(team.id);
  res.render('team', { team, roster, champs, transactions, active: 'teams' });
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
