// Public-facing routes: home/teams, single team, rules.
// The whole site is behind a login: visitors must sign in first. The
// commissioner logs in through the admin console (/admin/login) and can manage
// every team; each team owner logs in here with their email + password and can
// make off-season moves only for their own team.
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { marked } = require('marked');
const { db, DISPLAY_SECTIONS, CONTRACT_CAP, TAXI_CAP } = require('../db/db');
const espnSync = require('../services/espnSync');
const offseason = require('../services/offseason');
const moves = require('../services/offseasonMoves');
const mail = require('../services/mail');

const router = express.Router();

function getTeams() {
  return db.prepare('SELECT * FROM teams ORDER BY sort_order, name').all();
}

// Absolute base URL for links in emails. Prefer an explicit BASE_URL env var
// (e.g. https://thefreeagents.org); otherwise derive it from the request.
function baseUrl(req) {
  const url = process.env.BASE_URL || (req.protocol + '://' + req.get('host'));
  return url.replace(/\/$/, '');
}

// ---- Login gate -----------------------------------------------------------
// Everyone must be signed in (as the commissioner OR a team owner) to see any
// page. Unauthenticated requests are bounced to the login screen. The login
// routes themselves are exempt so people can actually sign in.
function loggedIn(req) {
  return !!(req.session && (req.session.adminId || req.session.teamId));
}
router.use((req, res, next) => {
  if (loggedIn(req)) return next();
  // Exempt the team login page, the password-reset pages, and anything under
  // /admin (the commissioner console has its own login + auth guard) so the
  // "Commissioner? Log in here" link can actually reach it.
  if (
    req.path === '/login' ||
    req.path === '/forgot' ||
    req.path.startsWith('/reset/') ||
    req.path === '/admin' ||
    req.path.startsWith('/admin/')
  ) return next();
  return res.redirect('/login');
});

// Team-owner login (email + password). The commissioner uses /admin/login.
router.get('/login', (req, res) => {
  if (loggedIn(req)) return res.redirect('/');
  const notice = req.query.reset ? 'Your password has been reset — you can log in now.' : null;
  res.render('login', { error: null, notice });
});
router.post('/login', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const team = db.prepare('SELECT * FROM teams WHERE lower(email) = ?').get(email);
  if (team && team.password_hash && bcrypt.compareSync(password, team.password_hash)) {
    req.session.teamId = team.id;
    req.session.teamName = team.name;
    return res.redirect('/team/' + team.slug);
  }
  res.render('login', { error: 'Incorrect email or password.', notice: null });
});

// ---- Forgot / reset password ----------------------------------------------
// A team owner who forgets their password requests a reset link by email. The
// link carries a random, single-use token that expires after one hour.
router.get('/forgot', (req, res) => {
  if (loggedIn(req)) return res.redirect('/');
  res.render('forgot', { sent: false });
});
router.post('/forgot', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const team = email ? db.prepare('SELECT * FROM teams WHERE lower(email) = ?').get(email) : null;
  if (team && team.email) {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = Date.now() + 1000 * 60 * 60; // 1 hour
    db.prepare('UPDATE teams SET reset_token = ?, reset_expires = ? WHERE id = ?').run(token, expires, team.id);
    const link = baseUrl(req) + '/reset/' + token;
    const text =
      `Hi ${team.owner || team.name},\n\n` +
      `Someone asked to reset the password for your team login on The Free Agents (${team.name}).\n\n` +
      `Choose a new password using the link below. It expires in one hour:\n\n${link}\n\n` +
      `If you didn't request this, you can ignore this email — your password won't change.`;
    mail.send({ to: team.email, subject: 'Reset your The Free Agents password', text }).catch(() => {});
  }
  // Always show the same confirmation, so we never reveal which emails exist.
  res.render('forgot', { sent: true });
});
function findByToken(token) {
  if (!token) return null;
  return db.prepare('SELECT * FROM teams WHERE reset_token = ? AND reset_expires > ?').get(token, Date.now());
}
router.get('/reset/:token', (req, res) => {
  const team = findByToken(req.params.token);
  if (!team) return res.render('reset', { token: null, error: 'This reset link is invalid or has expired. Please request a new one.' });
  res.render('reset', { token: req.params.token, error: null });
});
router.post('/reset/:token', (req, res) => {
  const team = findByToken(req.params.token);
  if (!team) return res.render('reset', { token: null, error: 'This reset link is invalid or has expired. Please request a new one.' });
  const pw = req.body.password || '';
  const pw2 = req.body.confirm || '';
  if (pw.length < 6) return res.render('reset', { token: req.params.token, error: 'Password must be at least 6 characters.' });
  if (pw !== pw2) return res.render('reset', { token: req.params.token, error: 'The two passwords do not match.' });
  const hash = bcrypt.hashSync(pw, 10);
  db.prepare('UPDATE teams SET password_hash = ?, reset_token = NULL, reset_expires = 0 WHERE id = ?').run(hash, team.id);
  res.redirect('/login?reset=1');
});

// ---- Account (a team owner manages their own login) -----------------------
// Only a signed-in team owner has an account to manage. The commissioner edits
// team logins from the admin console instead.
function requireMember(req, res, next) {
  if (req.session && req.session.teamId) {
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.session.teamId);
    if (team) { req.member = team; return next(); }
  }
  return res.redirect(req.session && req.session.adminId ? '/admin' : '/login');
}
const acctBack = (res, kind, text) =>
  res.redirect('/account?' + kind + '=' + encodeURIComponent(text));

router.get('/account', requireMember, (req, res) => {
  res.render('account', {
    team: req.member, active: null,
    msg: req.query.msg || null, err: req.query.err || null
  });
});

router.post('/account/email', requireMember, (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return acctBack(res, 'err', 'Please enter a valid email address.');
  }
  const clash = db.prepare('SELECT id FROM teams WHERE lower(email) = ? AND id <> ?').get(email, req.member.id);
  if (clash) return acctBack(res, 'err', 'That email is already used by another team.');
  db.prepare('UPDATE teams SET email = ? WHERE id = ?').run(email, req.member.id);
  acctBack(res, 'msg', 'Your login email has been updated.');
});

router.post('/account/password', requireMember, (req, res) => {
  const cur = req.body.current || '';
  const pw = req.body.password || '';
  const pw2 = req.body.confirm || '';
  if (!req.member.password_hash || !bcrypt.compareSync(cur, req.member.password_hash)) {
    return acctBack(res, 'err', 'Your current password is incorrect.');
  }
  if (pw.length < 6) return acctBack(res, 'err', 'New password must be at least 6 characters.');
  if (pw !== pw2) return acctBack(res, 'err', 'The two new passwords do not match.');
  db.prepare('UPDATE teams SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(pw, 10), req.member.id);
  acctBack(res, 'msg', 'Your password has been changed.');
});
// Team-owner logout (leaves any admin session untouched).
router.post('/logout', (req, res) => {
  if (req.session) { delete req.session.teamId; delete req.session.teamName; }
  res.redirect('/login');
});

// Home = teams overview
router.get('/', (req, res) => {
  const teams = getTeams();
  // When a team owner is signed in, float their own team to the top of the
  // list so they see it first. The commissioner (admin) has no own team, so
  // the order is left untouched for them.
  const mine = req.session && req.session.teamId;
  if (mine) {
    teams.sort((a, b) => (b.id === mine ? 1 : 0) - (a.id === mine ? 1 : 0));
  }
  res.render('index', { teams, active: 'teams' });
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
    deadMoney: moves.deadMoney(team.id),
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
  // Only the commissioner or this team's own logged-in owner may make moves.
  const isAdmin = !!(req.session && req.session.adminId);
  const isOwner = req.session && req.session.teamId === team.id;
  if (!isAdmin && !isOwner) return res.redirect('/team/' + team.slug);
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

// Email the commissioner a summary when a team owner submits off-season moves.
// Fire-and-forget: a mail hiccup must never affect the submission itself.
function notifyCommissioner(req, team, batchId) {
  try {
    const rows = db.prepare(
      'SELECT summary FROM transactions WHERE team_id = ? AND batch_id = ? AND undone = 0 ORDER BY id'
    ).all(team.id, batchId);
    if (!rows.length) return;
    const lines = rows.map(r => '\u2022 ' + r.summary);
    const subject = `[The Free Agents] ${team.name} submitted off-season moves`;
    const text =
      `${team.name} just submitted the following off-season ` +
      `move${lines.length === 1 ? '' : 's'}:\n\n` +
      lines.join('\n') +
      `\n\nView the team: ${baseUrl(req)}/team/${team.slug}`;
    mail.send({ to: mail.NOTIFY_TO, subject, text }).catch(() => {});
  } catch (e) {
    console.error('[notify] could not build submission email:', e.message);
  }
}

// One "Submit" applies every chosen move at once (caps enforced together).
router.post('/team/:slug/moves/submit', requireOffseason, (req, res) => {
  const result = moves.submitMoves(req.team.id, req.body, { isAdmin: false });
  if (result.ok && !result.empty && result.batchId) {
    notifyCommissioner(req, req.team, result.batchId);
  }
  backToTeamMsg(res, req.team.slug, result);
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
