// Do Not Call -> email opt-out.
//
// Marking a lead Do Not Call also puts their email on the opt-out lists, so nothing
// mails them again:
//   1. AgentLab's own suppression table (the inbound responder and sequences honor it)
//   2. the Suppression tab of the outreach Google Sheet that real-help-agent's leads
//      preflight reads (set SUPPRESSION_SHEET_ID; tab name SUPPRESSION_TAB, default "Suppression")
//   3. a local suppression.jsonl next to the dialer data, same line format as
//      real-help-agent's SUPPRESSION_PATH file
// Each step is independent: one failing never blocks the others or the outcome itself.

const fs = require('fs');
const path = require('path');
const store = require('./store');

const SHEET_ID = () => process.env.SUPPRESSION_SHEET_ID || '';
const TAB = () => process.env.SUPPRESSION_TAB || 'Suppression';
const FILE = () => process.env.DIALER_SUPPRESSION_FILE || path.join(path.dirname(store.DATA_FILE), 'suppression.jsonl');
const norm = e => String(e || '').trim().toLowerCase();

function fileEmails() {
  try {
    return fs.readFileSync(FILE(), 'utf8').split('\n').filter(l => l.trim()).map(l => { try { return norm(JSON.parse(l).email); } catch { return ''; } }).filter(Boolean);
  } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

function addToFile(email, reason) {
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.appendFileSync(FILE(), JSON.stringify({ email, reason, at: new Date().toISOString() }) + '\n');
}

async function sheetEmails(agent) {
  if (!SHEET_ID()) return null;
  if (!agent || !agent.sheets || !agent.sheets.readTab) throw new Error('Google Sheets is not connected (needs an authorized mailbox)');
  const rows = await agent.sheets.readTab(SHEET_ID(), TAB());
  const header = (rows[0] || []).map(h => String(h).trim().toLowerCase());
  const col = header.indexOf('email');
  if (col === -1) throw new Error('the "' + TAB() + '" tab needs an "Email" column header');
  return { header, emails: rows.slice(1).map(r => norm(r[col])).filter(Boolean) };
}

async function addToSheet(agent, email, reason, source) {
  const t = await sheetEmails(agent);
  if (!t) return 'not configured';
  if (t.emails.includes(email)) return 'already listed';
  const values = { email, reason, date: new Date().toISOString(), source };
  await agent.sheets.appendRow(SHEET_ID(), TAB(), t.header.map(h => values[h] || ''));
  return 'added';
}

// Returns what happened on each list; never throws.
async function recordOptOut(agent, lead, { reason = 'unsubscribe', source = 'dialer-dnc' } = {}) {
  const email = norm(lead && lead.email);
  const out = { email: email || null, app: 'skipped', sheet: 'skipped', file: 'skipped', errors: [] };
  if (!email) return out;
  try {
    if (agent && agent.store && agent.store.suppress) { await agent.store.suppress(store.settings().crmClientId || 'default', email, source); out.app = 'added'; }
  } catch (e) { out.app = 'failed'; out.errors.push('AgentLab list: ' + e.message); }
  try {
    out.sheet = await addToSheet(agent, email, reason, source);
  } catch (e) { out.sheet = 'failed'; out.errors.push('Suppression sheet: ' + e.message); }
  try {
    if (!fileEmails().includes(email)) addToFile(email, reason);
    out.file = 'added';
  } catch (e) { out.file = 'failed'; out.errors.push('Local list: ' + e.message); }
  return out;
}

// True when the address is on any list. If a list is configured but unreadable the answer
// is "do not send" (an unreadable list must never look like an empty one).
async function isOptedOut(agent, emailRaw) {
  const email = norm(emailRaw);
  if (!email) return { out: true, why: 'no email' };
  if (fileEmails().includes(email)) return { out: true, why: 'local opt-out list' };
  if (agent && agent.store && agent.store.isSuppressed && await agent.store.isSuppressed(store.settings().crmClientId || 'default', email)) return { out: true, why: 'AgentLab opt-out list' };
  const t = await sheetEmails(agent);
  if (t && t.emails.includes(email)) return { out: true, why: 'Suppression sheet' };
  return { out: false };
}

// One-time: leads already marked Do Not Call before this existed.
async function backfill(agent) {
  const meta = store.load().meta;
  if (meta.optOutBackfilled) return null;
  const dnc = store.allLeads().filter(l => l.status === 'dnc' && l.email);
  let done = 0;
  for (const l of dnc) { const r = await recordOptOut(agent, l); if (!r.errors.length) done++; }
  if (done === dnc.length) { meta.optOutBackfilled = new Date().toISOString(); store.save(); }
  return { dnc: dnc.length, done };
}

module.exports = { recordOptOut, isOptedOut, backfill };
