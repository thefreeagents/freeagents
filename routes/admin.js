// Admin CMS routes: login, dashboard, edit teams/players/rules/settings
const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { db, SECTIONS, UPLOAD_DIR } = require('../db/db');

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
  res.render('admin/dashboard', { teams, flash: req.query.saved });
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
  res.render('admin/team-edit', { team, roster, sections: SECTIONS, flash: req.query.saved });
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
    UPDATE teams SET name=?, owner=?, tagline=?, championships=?, image=?, updated_at=? WHERE id=?
  `).run(
    (req.body.name || team.name).trim(),
    req.body.owner || '',
    req.body.tagline || '',
    req.body.championships || '',
    bannerImage,
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
