// Unit tests for the password-reset schema/token logic and the mail no-op.
// Run: node services/passwordReset.test.js  (uses a throwaway DB in /tmp)
const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// Point the app at a fresh, isolated database BEFORE requiring db.js.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pwreset-'));
process.env.DATA_DIR = tmp;
// Make sure SMTP is unconfigured so mail.send() takes the no-op path.
delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;

const dbMod = require('../db/db');
const { db } = dbMod;
dbMod.init();
const mail = require('../services/mail');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

// The exact lookup the /reset routes use.
const findByToken = (token) =>
  db.prepare('SELECT * FROM teams WHERE reset_token = ? AND reset_expires > ?').get(token, Date.now());

(async () => {
  // --- mail is a safe no-op when SMTP isn't configured ---------------------
  ok(mail.isConfigured() === false, 'mail should report not configured');
  const sent = await mail.send({ to: 'x@example.com', subject: 'hi', text: 'yo' });
  ok(sent === false, 'send() should resolve false (skipped) when unconfigured');

  // --- seed a team with a login --------------------------------------------
  const info = db.prepare(
    "INSERT INTO teams (slug, name, email, password_hash, sort_order, updated_at) VALUES (?, ?, ?, ?, 0, ?)"
  ).run('reset-fc', 'Reset FC', 'owner@example.com', bcrypt.hashSync('oldpass', 10), '2026-01-01');
  const teamId = info.lastInsertRowid;

  // --- request a reset: store token + 1h expiry ----------------------------
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('UPDATE teams SET reset_token = ?, reset_expires = ? WHERE id = ?')
    .run(token, Date.now() + 3600 * 1000, teamId);
  ok(findByToken(token), 'a fresh token within its window should be found');
  ok(!findByToken('not-a-real-token'), 'a wrong token should not match');

  // --- expired token is rejected -------------------------------------------
  db.prepare('UPDATE teams SET reset_expires = ? WHERE id = ?').run(Date.now() - 1000, teamId);
  ok(!findByToken(token), 'an expired token should not be found');

  // --- perform the reset: set new hash, clear token ------------------------
  db.prepare('UPDATE teams SET reset_expires = ? WHERE id = ?').run(Date.now() + 3600 * 1000, teamId);
  const team = findByToken(token);
  ok(team, 'token valid again after refreshing expiry');
  db.prepare('UPDATE teams SET password_hash = ?, reset_token = NULL, reset_expires = 0 WHERE id = ?')
    .run(bcrypt.hashSync('newpass', 10), teamId);

  const after = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
  ok(bcrypt.compareSync('newpass', after.password_hash), 'new password should verify');
  ok(!bcrypt.compareSync('oldpass', after.password_hash), 'old password should no longer verify');
  ok(!after.reset_token, 'reset token should be cleared after use');
  ok(!findByToken(token), 'a used token should no longer be valid');

  console.log(`# passwordReset.test.js — all ${passed} assertions passed`);
})();
