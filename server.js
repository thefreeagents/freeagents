// The Free Agents — league website + admin CMS
require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const { init, DATA_DIR, UPLOAD_DIR } = require('./db/db');

init(); // make sure tables exist

const app = express();
const PORT = process.env.PORT || 3000;

// Render (and most hosts) sit behind a proxy that terminates HTTPS. Trusting it
// lets req.protocol report "https", so password-reset links are built as https.
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/static', express.static(path.join(__dirname, 'public')));
// Uploaded photos are served from the persistent disk (DATA_DIR/uploads).
app.use('/uploads', express.static(UPLOAD_DIR));

app.use(session({
  store: new FileStore({
    path: path.join(DATA_DIR, 'sessions'),
    logFn: () => {},        // quiet
    retries: 1
  }),
  secret: process.env.SESSION_SECRET || 'free-agents-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 } // 30 days
}));

// Make login state + site settings + top menu available to every view
const { db, navPages } = require('./db/db');
app.use((req, res, next) => {
  res.locals.isAdmin = !!(req.session && req.session.adminId);
  // A logged-in team owner (member). The commissioner (admin) is not a member
  // but can manage every team; an owner can manage only their own team.
  res.locals.memberTeamId = (req.session && req.session.teamId) || null;
  res.locals.memberTeamName = (req.session && req.session.teamName) || null;
  // canManage(team): true for the commissioner, or the team's own logged-in owner.
  res.locals.canManage = (team) =>
    res.locals.isAdmin || (team && res.locals.memberTeamId === team.id);
  const rows = db.prepare('SELECT key, value FROM settings').all();
  res.locals.settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
  res.locals.navPages = navPages();
  next();
});

app.use('/', require('./routes/public'));
app.use('/admin', require('./routes/admin'));

app.use((req, res) => res.status(404).render('404'));

app.listen(PORT, () => {
  console.log(`The Free Agents running at http://localhost:${PORT}`);
  console.log(`Admin console at        http://localhost:${PORT}/admin`);
});
