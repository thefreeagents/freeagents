// Transactional email for the league site.
//
// Everything is sent through a plain SMTP mailbox — in our case the league's
// aplus mail account. All credentials come from environment variables so no
// secrets ever live in the repo or the database. Set these in the Render
// dashboard (Environment tab):
//
//   SMTP_HOST     e.g. mail.thefreeagents.org   (aplus outgoing/SMTP server)
//   SMTP_PORT     587 (STARTTLS) or 465 (SSL)   — defaults to 587
//   SMTP_USER     the full mailbox address, e.g. commissioner@thefreeagents.org
//   SMTP_PASS     that mailbox's password
//   MAIL_FROM     what recipients see in "From" (defaults to SMTP_USER)
//   NOTIFY_EMAIL  where "a team submitted moves" alerts go (defaults to MAIL_FROM)
//
// If SMTP is not configured, every send() is a harmless no-op that just logs.
// That way local development and the test suite never fail for lack of a mail
// server, and a mail outage can never break a submission or a password reset.
const HOST = process.env.SMTP_HOST || '';
const PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const USER = process.env.SMTP_USER || '';
const PASS = process.env.SMTP_PASS || '';
const FROM = process.env.MAIL_FROM || USER;
// Where off-season submission alerts go (the commissioner's inbox).
const NOTIFY_TO = process.env.NOTIFY_EMAIL || FROM;

function isConfigured() {
  return !!(HOST && USER && PASS);
}

let _transport = null;
function transport() {
  if (_transport) return _transport;
  // Required lazily so the app boots (and tests run) even when nodemailer is
  // not installed or SMTP is switched off.
  const nodemailer = require('nodemailer');
  _transport = nodemailer.createTransport({
    host: HOST,
    port: PORT,
    secure: PORT === 465, // 465 = implicit TLS; 587 = STARTTLS
    auth: { user: USER, pass: PASS }
  });
  return _transport;
}

// Fire-and-forget send. Never throws into the request path. Resolves to true if
// the message was handed to the mail server, false if skipped or failed.
async function send({ to, subject, text, html }) {
  if (!isConfigured()) {
    console.log(`[mail] SMTP not configured — skipping "${subject}" to ${to}`);
    return false;
  }
  if (!to) {
    console.log(`[mail] no recipient — skipping "${subject}"`);
    return false;
  }
  try {
    await transport().sendMail({ from: FROM, to, subject, text, html });
    return true;
  } catch (e) {
    console.error(`[mail] failed to send "${subject}" to ${to}:`, e.message);
    return false;
  }
}

// A password-free snapshot of the current mail settings, for the admin
// diagnostics card. `secure` reflects how we'll connect (implicit TLS on 465).
function config() {
  return {
    configured: isConfigured(),
    host: HOST,
    port: PORT,
    secure: PORT === 465,
    user: USER,
    from: FROM,
    notifyTo: NOTIFY_TO,
    hasPass: !!PASS
  };
}

// Like send(), but returns a structured result instead of a bare boolean so the
// admin "Send test email" button can show exactly what happened: skipped (not
// configured / no recipient), sent, or failed with the mail server's message.
async function sendDetailed({ to, subject, text, html }) {
  if (!isConfigured()) {
    return { ok: false, skipped: true, error: 'SMTP is not configured — set SMTP_HOST, SMTP_USER and SMTP_PASS in Render.' };
  }
  if (!to) {
    return { ok: false, skipped: true, error: 'No recipient — set NOTIFY_EMAIL (or MAIL_FROM) in Render.' };
  }
  try {
    await transport().sendMail({ from: FROM, to, subject, text, html });
    return { ok: true, skipped: false, error: null };
  } catch (e) {
    return { ok: false, skipped: false, error: e.message };
  }
}

module.exports = { isConfigured, send, sendDetailed, config, NOTIFY_TO, FROM };
