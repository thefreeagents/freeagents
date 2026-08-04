// Admin CMS routes: login, dashboard, edit teams/players/rules/settings
const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { db, SECTIONS, UPLOAD_DIR, CONTRACT_CAP, TAXI_CAP } = require('../db/db');
const espnSync = require('../services/espnSync');
const { suggestSiteTeamId } = require('../services/espn');
const offseason = require('../services/offseason');
const moves = require('../services/offseasonMoves');

const router = express.Router();

// ---- Image uploads --------------------------------------------------------
// UPLOAD_DIR lives under DATA_DIR (persistent disk) so photos are never lost.
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-z0-9.\-_]/gi, '_');
    cb(null, `${Date.now()}-${safe}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 8 * 1024 * 1024 } });

// ---- Auth guard -----------------------------------------------------------
function requireAdmin(req, res, next) {
  if (req.session && req.session.adminId) return next();
  return res.redirect('/admin/login');
}

const today = () => new Date().toISOString().slice(0, 10);

// ---- Login / logout -------------------------------------------------------
router.get('/login', (req, res) => {
  if (req.session.adminId) return res.redirect('/admin');
  res.render('admin/login', { error: null, layout: false });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username || '');
  if (admin && bcrypt.compareSync(password || '', admin.password_hash)) {
    req.session.adminId = admin.id;
    req.session.adminUser = admin.username;
    return res.redirect('/admin');
  }
  res.render('admin/login', { error: 'Incorrect username or password.', layout: false });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ---- Dashboard ------------------------------------------------------------
router.get('/', requireAdmin, (req, res) => {
  const teams = db.prepare('SELECT * FROM teams ORDER BY sort_order, name').all();
  res.render('admin/dashboard', {
    teams,
    flash: req.query.saved,
    offseasonOn: espnSync.getSetting('offseason_mode') === '1'
  });
});

// ---- New team -------------------------------------------------------------
router.post('/teams/new', requireAdmin, (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/admin');
  let slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  if (db.prepare('SELECT id FROM teams WHERE slug = ?').get(slug)) slug += '-' + Date.now();
  const max = db.prepare('SELECT MAX(sort_order) m FROM teams').get().m || 0;
  const info = db.prepare(
    'INSERT INTO teams (slug, name, sort_order, updated_at) VALUES (?, ?, ?, ?)'
  ).run(slug, name, max + 1, today());
  res.redirect('/admin/teams/' + info.lastInsertRowid);
});

// ---- Edit team form -------------------------------------------------------
router.get('/teams/:id', requireAdmin, (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!team) return res.redirect('/admin');
  const players = db.prepare('SELECT * FROM players WHERE team_id = ? ORDER BY sort_order, id').all(team.id);
  const roster = SECTIONS.map(s => ({ ...s, players: players.filter(p => p.section === s.key) }));

  // Off-Season Mode extras: the ESPN roster list, saved offers, live counts,
  // and caps so the panel can show/hide buttons and enforce limits.
  const offseasonOn = espnSync.getSetting('offseason_mode') === '1';
  const espnPlayers = players.filter(p => p.section === 'espn_active');
  const offerRows = db.prepare('SELECT * FROM espn_offers WHERE team_id = ?').all(team.id);
  const offers = {};
  for (const o of offerRows) offers[o.player_name] = o;
  const counts = {
    contract: players.filter(p => p.section === 'contract').length,
    taxi: players.filter(p => p.section === 'taxi').length
  };
  const transactions = db.prepare(
    'SELECT * FROM transactions WHERE team_id = ? ORDER BY id DESC'
  ).all(team.id);

  res.render('admin/team-edit', {
    team, roster, sections: SECTIONS, flash: req.query.saved,
    offseasonOn, espnPlayers, offers, transactions,
    counts, caps: { contract: CONTRACT_CAP, taxi: TAXI_CAP },
    startYear: espnSync.currentSeason(),
    offSummary: offseason.offerSummary,
    maxYears: offseason.maxYears,
    move: req.query.move || null
  });
});

// ---- Save team (details + full roster) ------------------------------------
// upload.any() lets us accept the team banner ("image") plus one file per
// player row ("p_image_<key>"), so each player card can have its own picture.
router.post('/teams/:id', requireAdmin, upload.any(), (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!team) return res.redirect('/admin');

  const files = req.files || [];
  const fileByField = {};
  for (const f of files) fileByField[f.fieldname] = f.filename;

  const bannerImage = fileByField['image'] || team.image;
  db.prepare(`
    UPDATE teams SET name=?, owner=?, tagline=?, championships=?, image=?,
      all_time_record=?, all_time_pf=?, all_time_seasons=?, updated_at=? WHERE id=?
  `).run(
    (req.body.name || team.name).trim(),
    req.body.owner || '',
    req.body.tagline || '',
    req.body.championships || '',
    bannerImage,
    (req.body.all_time_record || '').trim(),
    (req.body.all_time_pf || '').trim(),
    parseInt(req.body.all_time_seasons, 10) || 0,
    today(),
    team.id
  );

  // Roster rows arrive as parallel arrays. p_id is the existing player id
  // (blank for new rows); p_imgkey ties a row to its file/remove fields.
  const ids       = [].concat(req.body.p_id || []);
  const names     = [].concat(req.body.p_name || []);
  const sections  = [].concat(req.body.p_section || []);
  const contracts = [].concat(req.body.p_contracts || []);
  const imgkeys   = [].concat(req.body.p_imgkey || []);

  const existing = db.prepare('SELECT * FROM players WHERE team_id = ?').all(team.id);
  const existingById = new Map(existing.map(p => [String(p.id), p]));
  const surviving = new Set();

  const updateStmt = db.prepare(
    'UPDATE players SET name=?, section=?, contracts=?, image=?, sort_order=? WHERE id=?'
  );
  const insertStmt = db.prepare(
    'INSERT INTO players (team_id, name, section, contracts, image, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
  );

  let order = 0;
  for (let i = 0; i < names.length; i++) {
    const name = (names[i] || '').trim();
    if (!name) continue; // blank rows are dropped (and, if they had an id, deleted below)

    const id      = ids[i] || '';
    const key     = imgkeys[i] || '';
    const prev    = id && existingById.has(id) ? existingById.get(id) : null;
    const newFile = fileByField['p_image_' + key];
    const remove  = req.body['p_removeimg_' + key] === '1';

    let image = '';
    if (newFile) image = newFile;               // uploaded a new picture
    else if (remove) image = '';                // asked to remove it
    else if (prev) image = prev.image;          // keep the existing one

    if (prev) {
      updateStmt.run(name, sections[i] || 'contract', contracts[i] || '', image, order++, prev.id);
      surviving.add(String(prev.id));
    } else {
      insertStmt.run(team.id, name, sections[i] || 'contract', contracts[i] || '', image, order++);
    }
  }

  // Remove players whose rows were deleted/blanked out.
  const del = db.prepare('DELETE FROM players WHERE id = ?');
  for (const p of existing) if (!surviving.has(String(p.id))) del.run(p.id);

  res.redirect('/admin/teams/' + team.id + '?saved=1');
});

// ---- Delete team ----------------------------------------------------------
router.post('/teams/:id/delete', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM teams WHERE id = ?').run(req.params.id);
  res.redirect('/admin?saved=deleted');
});

// ---- Off-Season Mode ------------------------------------------------------
// A single commissioner toggle. When on, both the admin team pages AND the
// public team pages show the off-season move buttons. The actual move logic
// lives in services/offseasonMoves.js so admin and public share one code path.
function requireOffseason(req, res, next) {
  if (!moves.isOn()) return res.redirect('/admin/teams/' + req.params.id);
  next();
}
const backToTeam = (res, id, move) =>
  res.redirect('/admin/teams/' + id + (move ? '?move=' + move : ''));

// Toggle the mode on/off.
router.post('/offseason/toggle', requireAdmin, (req, res) => {
  espnSync.setSetting('offseason_mode', moves.isOn() ? '0' : '1');
  res.redirect(req.get('Referer') || '/admin');
});

// 1) Drop a Taxi Squad player entirely.
router.post('/teams/:id/moves/drop/:pid', requireAdmin, requireOffseason, (req, res) => {
  backToTeam(res, req.params.id, moves.dropTaxi(req.params.id, req.params.pid));
});

// 2) Promote a Taxi Squad player to NCAA Contracts.
router.post('/teams/:id/moves/taxi-to-ncaac/:pid', requireAdmin, requireOffseason, (req, res) => {
  backToTeam(res, req.params.id, moves.taxiToNcaac(req.params.id, req.params.pid));
});

// 3a) Toggle whether an NCAA Player is eligible to be promoted to the Taxi Squad.
router.post('/teams/:id/moves/eligible/:pid', requireAdmin, requireOffseason, (req, res) => {
  backToTeam(res, req.params.id, moves.toggleEligible(req.params.id, req.params.pid));
});

// 3b) Promote an eligible NCAA Player to the Taxi Squad (cap enforced in module).
router.post('/teams/:id/moves/ncaa-to-taxi/:pid', requireAdmin, requireOffseason, (req, res) => {
  backToTeam(res, req.params.id, moves.ncaaToTaxi(req.params.id, req.params.pid));
});

// 5) Drop an NCAA Contract player entirely.
router.post('/teams/:id/moves/drop-ncaac/:pid', requireAdmin, requireOffseason, (req, res) => {
  backToTeam(res, req.params.id, moves.dropNcaac(req.params.id, req.params.pid));
});

// 4a) Save/update the available contract offer for an ESPN-listed player.
router.post('/teams/:id/moves/offer', requireAdmin, requireOffseason, (req, res) => {
  backToTeam(res, req.params.id, moves.saveOffer(req.params.id, req.body));
});

// 4b) Sign an ESPN-listed player as a new Contract Player (cap enforced in module).
router.post('/teams/:id/moves/sign', requireAdmin, requireOffseason, (req, res) => {
  backToTeam(res, req.params.id, moves.signPlayer(req.params.id, req.body));
});

// Undo a completed off-season move.
router.post('/teams/:id/moves/undo/:txnId', requireAdmin, requireOffseason, (req, res) => {
  backToTeam(res, req.params.id, moves.undo(req.params.id, req.params.txnId));
});

// ---- Pages (menu) manager -------------------------------------------------
router.get('/rules', requireAdmin, (req, res) => res.redirect('/admin/pages/rules')); // old link

router.get('/pages', requireAdmin, (req, res) => {
  const pages = db.prepare('SELECT * FROM pages ORDER BY nav_order, title').all();
  res.render('admin/pages', { pages, flash: req.query.saved });
});

// Add a new page
router.post('/pages/new', requireAdmin, (req, res) => {
  const title = (req.body.title || '').trim();
  if (!title) return res.redirect('/admin/pages');
  let slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  if (!slug) slug = 'page';
  if (db.prepare('SELECT slug FROM pages WHERE slug = ?').get(slug)) slug += '-' + Date.now();
  const max = db.prepare('SELECT MAX(nav_order) m FROM pages').get().m || 0;
  db.prepare(
    'INSERT INTO pages (slug, title, nav_label, content, in_nav, nav_order, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)'
  ).run(slug, title, '', '', max + 1, today());
  res.redirect('/admin/pages/' + slug);
});

// Edit a page
router.get('/pages/:slug', requireAdmin, (req, res) => {
  const page = db.prepare('SELECT * FROM pages WHERE slug = ?').get(req.params.slug);
  if (!page) return res.redirect('/admin/pages');
  res.render('admin/page-edit', { page, flash: req.query.saved });
});

// Save a page
router.post('/pages/:slug', requireAdmin, (req, res) => {
  const page = db.prepare('SELECT * FROM pages WHERE slug = ?').get(req.params.slug);
  if (!page) return res.redirect('/admin/pages');
  db.prepare(`
    UPDATE pages SET title=?, nav_label=?, content=?, in_nav=?, nav_order=?, updated_at=? WHERE slug=?
  `).run(
    (req.body.title || page.title).trim(),
    (req.body.nav_label || '').trim(),
    req.body.content || '',
    req.body.in_nav === '1' ? 1 : 0,
    parseInt(req.body.nav_order, 10) || 0,
    today(),
    page.slug
  );
  res.redirect('/admin/pages/' + page.slug + '?saved=1');
});

// Delete a page
router.post('/pages/:slug/delete', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM pages WHERE slug = ?').run(req.params.slug);
  res.redirect('/admin/pages?saved=deleted');
});

// ---- Site settings --------------------------------------------------------
router.get('/settings', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const values = Object.fromEntries(rows.map(r => [r.key, r.value]));
  res.render('admin/settings', { values, flash: req.query.saved });
});

router.post('/settings', requireAdmin, upload.single('banner_image'), (req, res) => {
  const set = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  );
  set.run('site_title', req.body.site_title || 'THE FREE AGENTS');
  set.run('site_subtitle', req.body.site_subtitle || '');
  set.run('footer_text', req.body.footer_text || '');
  if (req.file) set.run('banner_image', req.file.filename);
  else if (req.body.remove_banner === '1') set.run('banner_image', '');
  res.redirect('/admin/settings?saved=1');
});

// ---- ESPN sync ------------------------------------------------------------
// Small helper: everything the ESPN screen needs about current settings +
// which site teams are already mapped to an ESPN team.
function espnHomeData() {
  const teams = db.prepare('SELECT * FROM teams ORDER BY sort_order, name').all();
  return {
    settings: {
      league_id: espnSync.getSetting('espn_league_id'),
      season: espnSync.currentSeason(),
      last_sync: espnSync.getSetting('espn_last_sync')
    },
    teams
  };
}

// Hub: settings form + list of teams with their current mapping + Sync button.
router.get('/espn', requireAdmin, (req, res) => {
  res.render('admin/espn', {
    ...espnHomeData(),
    mapping: null,
    report: null,
    error: req.query.error || null,
    flash: req.query.saved || null
  });
});

// Save league ID / season.
router.post('/espn/settings', requireAdmin, (req, res) => {
  const leagueId = (req.body.league_id || '').trim();
  const season = (req.body.season || '').trim();
  espnSync.setSetting('espn_league_id', leagueId);
  if (season) espnSync.setSetting('espn_season', season);
  res.redirect('/admin/espn?saved=settings');
});

// Fetch ESPN teams and show the mapping screen (with suggested matches).
router.post('/espn/map', requireAdmin, async (req, res) => {
  try {
    const { leagueName: lgName, season, teams: espnTeams } = await espnSync.fetchEspnTeams();
    const siteTeams = db.prepare('SELECT * FROM teams ORDER BY sort_order, name').all();
    // Which site team is each ESPN team already mapped to? (reverse lookup)
    const siteByEspnId = new Map();
    for (const st of siteTeams) {
      if (st.espn_team_id) siteByEspnId.set(String(st.espn_team_id), st.id);
    }
    const rows = espnTeams.map(et => ({
      espnId: et.espnId,
      espnName: et.name,
      record: et.record,
      currentSiteId: siteByEspnId.get(String(et.espnId)) || null,
      suggestedSiteId: siteByEspnId.get(String(et.espnId)) || suggestSiteTeamId(et, siteTeams)
    }));
    res.render('admin/espn', {
      ...espnHomeData(),
      mapping: { leagueName: lgName, season, rows, siteTeams },
      report: null,
      error: null,
      flash: null
    });
  } catch (e) {
    res.redirect('/admin/espn?error=' + encodeURIComponent(e.message));
  }
});

// Save the chosen mappings. We reset every team's mapping first, then apply
// the selected pairs, so unselecting a team clears it.
router.post('/espn/map/save', requireAdmin, (req, res) => {
  const map = req.body.map || {}; // { espnId: siteTeamId }
  const clear = db.prepare('UPDATE teams SET espn_team_id = NULL');
  const setMap = db.prepare('UPDATE teams SET espn_team_id = ? WHERE id = ?');
  clear.run();
  for (const [espnId, siteId] of Object.entries(map)) {
    if (siteId) setMap.run(parseInt(espnId, 10), parseInt(siteId, 10));
  }
  res.redirect('/admin/espn?saved=mapped');
});

// Run the sync now and show the change report.
router.post('/espn/sync', requireAdmin, async (req, res) => {
  try {
    const report = await espnSync.syncLeague();
    res.render('admin/espn', {
      ...espnHomeData(),
      mapping: null,
      report,
      error: null,
      flash: null
    });
  } catch (e) {
    res.redirect('/admin/espn?error=' + encodeURIComponent(e.message));
  }
});

// ---- Change password ------------------------------------------------------
router.post('/password', requireAdmin, (req, res) => {
  const { current, next } = req.body;
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.session.adminId);
  if (!admin || !bcrypt.compareSync(current || '', admin.password_hash)) {
    return res.redirect('/admin/settings?saved=badpass');
  }
  if (!next || next.length < 6) return res.redirect('/admin/settings?saved=shortpass');
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?')
    .run(bcrypt.hashSync(next, 10), admin.id);
  res.redirect('/admin/settings?saved=pass');
});

module.exports = router;
