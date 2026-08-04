// Seeds the database with The Free Agents starting content.
// Safe to run repeatedly: it only inserts rows that don't already exist.
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { db, init } = require('./db');

init();

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// ---- Admin user -----------------------------------------------------------
const adminUser = process.env.ADMIN_USER || 'admin';
const adminPass = process.env.ADMIN_PASS || 'changeme';
const existingAdmin = db.prepare('SELECT id FROM admins WHERE username = ?').get(adminUser);
if (!existingAdmin) {
  const hash = bcrypt.hashSync(adminPass, 10);
  db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(adminUser, hash);
  console.log(`Created admin login  ->  username: ${adminUser}  password: ${adminPass}`);
} else {
  console.log(`Admin "${adminUser}" already exists (login unchanged).`);
}

// ---- Site settings --------------------------------------------------------
const settings = {
  site_title: 'THE FREE AGENTS',
  site_subtitle: 'A Dynasty Fantasy Football League',
  banner_image: '',            // admin can upload one; otherwise a CSS banner is used
  footer_text: 'The Free Agents \u00b7 Est. 2013'
};
const upsertSetting = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING'
);
for (const [k, v] of Object.entries(settings)) upsertSetting.run(k, v);

// ---- Teams ----------------------------------------------------------------
// Real team names pulled from the current site. Owners/records left blank for
// Brian to fill in via the admin console.
const teams = [
  'Impeach Goodell!!',
  'Sustained Excellence',
  "That's What CeeDee Said",
  'Eternal Futility',
  'Playoffs?!! Playoffs?',
  "Don't Mess With Tex",
  'Fuller Genome Project',
  'Emerson Big TDs',
  'Jamarcus Purple Drank',
  'Inflationary Pressure'
];

const insertTeam = db.prepare(`
  INSERT INTO teams (slug, name, owner, tagline, championships, sort_order, updated_at)
  VALUES (@slug, @name, @owner, @tagline, @championships, @sort_order, @updated_at)
`);
const teamExists = db.prepare('SELECT id FROM teams WHERE slug = ?');

teams.forEach((name, i) => {
  const slug = slugify(name);
  if (teamExists.get(slug)) return;
  insertTeam.run({
    slug,
    name,
    owner: '',
    tagline: '',
    championships: slug === 'sustained-excellence' ? '2013, 2018, 2021' : '',
    sort_order: i,
    updated_at: new Date().toISOString().slice(0, 10)
  });
});

// ---- Sample roster (one team, as an example of the data model) -------------
// This shows Brian exactly how rosters look; he can edit/replace in the admin.
const se = db.prepare('SELECT id FROM teams WHERE slug = ?').get('sustained-excellence');
const hasPlayers = db.prepare('SELECT COUNT(*) c FROM players WHERE team_id = ?').get(se.id).c;
if (se && hasPlayers === 0) {
  const insertPlayer = db.prepare(`
    INSERT INTO players (team_id, name, section, contracts, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `);
  const sample = [
    ['Joe Burrow',     'contract',      '2025: $12\n2026: $12'],
    ['Puka Nacua',     'contract',      '2025: $15\n2026: $15'],
    ['Zay Flowers',    'contract',      '2025: $12\n2026: $12'],
    ['Terry McLaurin', 'contract',      '2025: $11'],
    ['Aaron Jones',    'contract',      '2025: $11'],
    ['Sam LaPorta',    'contract',      '2025: $11'],
    ['Xavier Worthy',  'ncaa_contract', '2025: $10\n2026: $15\n2027: $20'],
    ['Ryan Williams',  'ncaa_contract', '2025: $10\n2026: $15'],
    ['Rome Odunze',    'ncaa_contract', '2025: $15\n2026: $20'],
    ['Kenny McIntosh', 'taxi',          '2025: $10'],
    ['Tre Harris',     'taxi',          '2025: $10'],
    ['Evan Stewart',   'ncaa_player',   ''],
    ['Jeremiah Love',  'ncaa_player',   '']
  ];
  sample.forEach((p, i) => insertPlayer.run(se.id, p[0], p[1], p[2], i));
  console.log('Seeded sample roster for "Sustained Excellence".');
}

// ---- Content pages (top menu) ---------------------------------------------
// Each page shows in the top menu and is editable in the admin console.
const rulesContent = `## League Rules & Constitution

_Replace this text with your real constitution using the admin console. You can use simple formatting: **bold**, headings with ##, numbered lists, and bullet points._

### 1. The Auction Draft
1. Draft will be by auction.
2. There shall be a salary cap of **$200**.
3. Every team is entitled to a **$200 budget**.

### 2. Contracts
- Player contracts are set at the time a player is won.
- Franchise, taxi-squad, and NCAA contract rules apply as described below.

### 3. Rosters
- Contract Players
- NCAA Contracts
- Taxi Squad
- NCAA Players

### Amendments
_List rule amendments here as they are voted in._
`;

const seedPages = [
  { slug: 'rules', title: 'Rules & Constitution', nav_label: 'Rules', nav_order: 1, content: rulesContent },
  { slug: 'records', title: 'League Records', nav_label: 'Records', nav_order: 2,
    content: `## League Records\n\n_Add your all-time records here — most points in a week, longest win streak, biggest blowout, etc. Use the admin console to edit this page._\n\n### All-Time Champions\n- 2013 — \n- 2018 — \n- 2021 — \n\n### Single-Week Records\n- Most points: \n- Fewest points: \n` },
  { slug: 'ncaa-draft', title: 'NCAA Draft', nav_label: 'NCAA Draft', nav_order: 3,
    content: `## NCAA Draft\n\n_Rules, order, and results for the NCAA rookie draft. Edit this page in the admin console._\n\n### Draft Order\n1. \n2. \n3. \n\n### Recent Picks\n- \n` },
  { slug: 'free-agents', title: 'Free Agents', nav_label: 'Free Agents', nav_order: 4,
    content: `## Free Agents\n\n_Available players and how to claim them. Edit this page in the admin console._\n\n### Available Now\n- \n\n### How Claims Work\n_Describe your free-agency / waiver process here._\n` }
];

const insertPage = db.prepare(
  'INSERT INTO pages (slug, title, nav_label, content, in_nav, nav_order, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)'
);
const backfillPage = db.prepare(
  "UPDATE pages SET nav_label = ?, nav_order = ? WHERE slug = ? AND (nav_label IS NULL OR nav_label = '')"
);
const today = new Date().toISOString().slice(0, 10);
for (const p of seedPages) {
  const exists = db.prepare('SELECT slug FROM pages WHERE slug = ?').get(p.slug);
  if (exists) {
    backfillPage.run(p.nav_label, p.nav_order, p.slug); // give older rows their menu label/order
  } else {
    insertPage.run(p.slug, p.title, p.nav_label, p.content, p.nav_order, today);
    console.log(`Seeded "${p.nav_label}" page.`);
  }
}

console.log('Seed complete.');
