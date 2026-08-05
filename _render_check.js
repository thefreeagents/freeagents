const ejs = require('ejs');
const path = require('path');
const fs = require('fs');
const V = path.join(process.cwd(), 'views');

const baseLocals = {
  settings: { site_title: 'The Free Agents', site_subtitle:'', banner_image:'' },
  navPages: [],
  isAdmin: false,
  memberTeamId: 1,
  memberTeamName: 'Team Alpha',
  canManage: () => true,
  active: null,
};

function render(file, extra) {
  const opts = { filename: path.join(V, file), views: [V] };
  const locals = Object.assign({}, baseLocals, extra);
  const src = fs.readFileSync(path.join(V, file), 'utf8');
  try {
    const out = ejs.render(src, locals, opts);
    const hasCap = out.includes('os-capmeter');
    const hasAcct = out.includes('/account');
    console.log('OK   ' + file + (extra._checks ? '  [capmeter:'+hasCap+']' : ''));
  } catch (e) {
    console.log('FAIL ' + file + ' :: ' + e.message);
  }
}

render('account.ejs', {
  team: { id:1, name:'Team Alpha', slug:'team-alpha', email:'a@b.com' },
  msg: null, err: null,
});
console.log('done');
