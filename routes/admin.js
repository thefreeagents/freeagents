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
// In-memory upload for the ESPN Draft Recap PDF — we parse it on the fly for
// auction prices and never need to keep the file, so no disk write.
const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

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
    txnGroups: moves.groupTransactions(transactions),
    counts, caps: { contract: CONTRACT_CAP, taxi: TAXI_CAP },
    startYear: espnSync.currentSeason(),
    offSummary: offseason.offerSummary,
    maxYears: offseason.maxYears,
    osmsg: req.query.osmsg || null,
    oswarn: req.query.oswarn === '1'
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
  // Owner login: email is stored as typed; password is only changed when a new
  // one is provided (blank leaves the existing hash untouched). Clearing the
  // email disables the owner login for this team.
  const email = (req.body.email || '').trim();
  const newPassword = (req.body.new_password || '').trim();
  let passwordHash = team.password_hash || '';
  if (!email) passwordHash = '';               // no email => login disabled
  else if (newPassword) passwordHash = bcrypt.hashSync(newPassword, 10);
  db.prepare(`
    UPDATE teams SET name=?, owner=?, tagline=?, championships=?, image=?,
      all_time_record=?, all_time_pf=?, all_time_seasons=?, email=?, password_hash=?,
      updated_at=? WHERE id=?
  `).run(
    (req.body.name || team.name).trim(),
    req.body.owner || '',
    req.body.tagline || '',
    req.body.championships || '',
    bannerImage,
    (req.body.all_time_record || '').trim(),
    (req.body.all_time_pf || '').trim(),
    parseInt(req.body.all_time_seasons, 10) || 0,
    email,
    passwordHash,
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
const backToTeamMsg = (res, id, r) =>
  res.redirect('/admin/teams/' + id + osQuery(r));

// Build the ?osmsg=...&oswarn=... flash query from a submit/undo result.
function osQuery(r) {
  let msg, warn = 0;
  if (r.undo) msg = 'Submission undone — the team was reset to how it was before.';
  else if (r.saved) msg = 'Contract terms saved.';
  else if (r.empty) msg = 'No moves were selected — nothing to submit.';
  else if (r.ok) msg = 'Submitted ' + r.applied + ' move' + (r.applied === 1 ? '' : 's') + '.';
  else { msg = r.message || 'Nothing was changed.'; warn = 1; }
  return '?osmsg=' + encodeURIComponent(msg) + (warn ? '&oswarn=1' : '');
}

// Toggle the mode on/off.
router.post('/offseason/toggle', requireAdmin, (req, res) => {
  espnSync.setSetting('offseason_mode', moves.isOn() ? '0' : '1');
  res.redirect(req.get('Referer') || '/admin');
});

// One "Submit" applies every chosen move at once (caps enforced together).
router.post('/teams/:id/moves/submit', requireAdmin, requireOffseason, (req, res) => {
  backToTeamMsg(res, req.params.id, moves.submitMoves(req.params.id, req.body, { isAdmin: true }));
});

// One "Undo" reverses an entire submitted batch back to the prior state.
router.post('/teams/:id/moves/undo-batch/:batchId', requireAdmin, requireOffseason, (req, res) => {
  const code = moves.undoBatch(req.params.id, req.params.batchId);
  backToTeamMsg(res, req.params.id, code ? { ok: true, undo: true } : { ok: false, message: 'Nothing to undo.' });
});

// Legacy single-move undo (for any pre-batch log rows).
router.post('/teams/:id/moves/undo/:txnId', requireAdmin, requireOffseason, (req, res) => {
  const code = moves.undo(req.params.id, req.params.txnId);
  backToTeamMsg(res, req.params.id, code ? { ok: true, undo: true } : { ok: false, message: 'Nothing to undo.' });
});

// Commissioner-only: mark/unmark an NCAA Player eligible (immediate — this just
// unlocks the batch choices for that player; it isn't itself an undoable move).
router.post('/teams/:id/moves/eligible/:pid', requireAdmin, requireOffseason, (req, res) => {
  moves.toggleEligible(req.params.id, req.params.pid);
  backToTeam(res, req.params.id);
});

// Commissioner-only: save/update the contract offer terms for an ESPN player
// (immediate — sets the price/type a team can then sign on within a batch).
router.post('/teams/:id/moves/offer', requireAdmin, requireOffseason, (req, res) => {
  moves.saveOffer(req.params.id, req.body);
  backToTeamMsg(res, req.params.id, { ok: true, saved: true });
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
      auction_season: espnSync.auctionSeason(),
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
  const auctionSeason = (req.body.auction_season || '').trim();
  espnSync.setSetting('espn_league_id', leagueId);
  if (season) espnSync.setSetting('espn_season', season);
  // Blank clears the override so it falls back to (roster season − 1).
  espnSync.setSetting('espn_auction_season', auctionSeason);
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
    // Pre-fill each ESPN team's dropdown, but never suggest the SAME site team
    // for two ESPN teams — a duplicate pre-fill is the main way a bad mapping
    // gets saved (two teams end up pointing at one site team). Existing saved
    // matches always win; a fuzzy-name suggestion is only used if that site
    // team hasn't already been claimed above.
    const claimed = new Set();
    for (const st of siteTeams) {
      if (st.espn_team_id) claimed.add(String(st.id)); // already-mapped site teams are taken
    }
    const rows = espnTeams.map(et => {
      const saved = siteByEspnId.get(String(et.espnId)) || null;
      let suggestion = saved;
      if (!suggestion) {
        const guess = suggestSiteTeamId(et, siteTeams);
        if (guess && !claimed.has(String(guess))) {
          suggestion = guess;
          claimed.add(String(guess));
        }
      }
      return {
        espnId: et.espnId,
        espnName: et.name,
        record: et.record,
        currentSiteId: saved,
        suggestedSiteId: suggestion
      };
    });
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
//
// A site team may be matched to at most ONE ESPN team (and vice-versa). If the
// same site team is picked for two ESPN teams we must NOT save — otherwise the
// second pick silently overwrites the first, leaving one site team showing the
// wrong roster and another team unmapped (skipped by the sync). Instead we
// reject the save, keep the existing mapping untouched, and explain the clash.
router.post('/espn/map/save', requireAdmin, (req, res) => {
  const rawMap = req.body.map || {}; // { 't<espnId>': siteTeamId }

  // The form keys are prefixed with 't' (e.g. map[t5]) ON PURPOSE. ESPN team
  // ids are small integers (1–12); if the keys were bare numbers the form
  // parser (qs) would treat `map` as an ARRAY, compact it, and silently discard
  // the real ESPN ids — mapping every team to the wrong ESPN roster. The prefix
  // forces it to stay a keyed object. Strip the prefix back to the numeric id.
  const map = {}; // { espnId: siteTeamId }
  for (const [key, siteId] of Object.entries(rawMap)) {
    const espnId = String(key).replace(/^\D+/, ''); // drop the leading 't'
    if (espnId) map[espnId] = siteId;
  }

  // Collect the ESPN teams pointing at each chosen site team.
  const espnIdsBySite = new Map(); // siteId -> [espnId, ...]
  for (const [espnId, siteId] of Object.entries(map)) {
    if (!siteId) continue;
    if (!espnIdsBySite.has(siteId)) espnIdsBySite.set(siteId, []);
    espnIdsBySite.get(siteId).push(espnId);
  }

  const dupes = [...espnIdsBySite.entries()].filter(([, espnIds]) => espnIds.length > 1);
  if (dupes.length) {
    const nameById = new Map(
      db.prepare('SELECT id, name FROM teams').all().map(t => [String(t.id), t.name])
    );
    const detail = dupes
      .map(([siteId, espnIds]) => `"${nameById.get(String(siteId)) || 'a site team'}" is matched to ${espnIds.length} ESPN teams`)
      .join('; ');
    return res.redirect('/admin/espn?error=' + encodeURIComponent(
      `Each site team can only match one ESPN team. ${detail}. Please give each ESPN team a different site team (or "skip") and save again. Your previous matches were left unchanged.`
    ));
  }

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

// Set contract prices straight from ESPN.
// Reads each "On ESPN Roster" player's acquisition type + auction bid from the
// same ESPN feed the sync uses: drafted & held -> auction price (1–3 yrs);
// everyone else (waivers / trade / free agency) -> waiver $11/$15 (1–2 yrs).
// Contract / NCAA / Taxi players are never touched. Offers are upserted so the
// sign buttons show the right terms; the commissioner can edit any before signing.
router.post('/espn/pricing', requireAdmin, async (req, res) => {
  try {
    const pricingReport = await espnSync.priceFromEspn();
    res.render('admin/espn', {
      ...espnHomeData(),
      mapping: null,
      report: null,
      pricing: pricingReport,
      error: null,
      flash: null
    });
  } catch (e) {
    res.redirect('/admin/espn?error=' + encodeURIComponent(e.message));
  }
});

// Set contract prices from an uploaded ESPN "Draft Recap" PDF. This is the
// reliable path for a PRIVATE league, where ESPN's API hides auction bids (so
// step 4 shows $0). We keep ESPN's DRAFT-vs-free-agency labels and use the PDF
// only to fill in each drafted player's winning bid, matched by name.
router.post('/espn/pricing-pdf', requireAdmin, uploadMem.single('recap_pdf'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer || !req.file.buffer.length) {
      return res.redirect('/admin/espn?error=' + encodeURIComponent('Please choose a Draft Recap PDF to upload.'));
    }
    const pricingPdf = await espnSync.priceFromPdf(req.file.buffer);
    res.render('admin/espn', {
      ...espnHomeData(),
      mapping: null,
      report: null,
      pricingPdf,
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
