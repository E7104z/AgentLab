// Cold Call Dialer API. Mounted with the dashboard's rate limiter and Basic-auth
// guard passed in (see src/web/server.js), so every route is behind the login.

const express = require('express');
const crypto = require('crypto');
const store = require('./store');
const queue = require('./queue');
const aiScript = require('./ai-script');
const crmSync = require('./crm-sync');
const { FIELDS, autoMap, parseFile, normalizeRecord, fillFromExtra } = require('./parse');

const PENDING_TTL_MS = 30 * 60 * 1000;
const pendingImports = new Map(); // importId -> { createdAt, filename, parsed }

function cleanupPending() {
  const now = Date.now();
  for (const [id, p] of pendingImports) if (now - p.createdAt > PENDING_TTL_MS) pendingImports.delete(id);
}

function fill(template, lead, s) {
  const vars = {
    firstName: lead.firstName || 'there',
    businessName: lead.businessName || 'your business',
    contactName: lead.contactName || '',
    city: lead.city || '',
    source: (lead.sources || [])[0] || 'certified vendor',
    website: s.website || '',
    bookingLink: s.bookingLink || '',
    bookingLine: s.bookingLink ? '\n\nIf it is easier, grab a 15-minute time here: ' + s.bookingLink : '',
    senderName: s.senderName || '',
    senderCompany: s.senderCompany || ''
  };
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

// Fix leads imported before the column mapping learned First/Last Name and
// "Vendor Formal Name": fill missing names from their saved extra columns.
function repairLeads() {
  let fixed = 0;
  for (const lead of store.allLeads()) {
    if ((lead.businessName && lead.contactName) || !lead.extra) continue;
    if (fillFromExtra(lead)) { fixed++; aiScript.invalidate(lead.id); }
  }
  if (fixed) store.save();
  return fixed;
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(rows, cols) {
  return [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\r\n');
}

function guessSource(filename) {
  return String(filename || 'Imported list')
    .replace(/^[0-9a-f]{6,}-/i, '')            // upload hash prefixes
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[_\-]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 60) || 'Imported list';
}

module.exports = function mountDialer(app, guards = [], deps = {}) {
  const r = express.Router();
  const send = fn => async (req, res) => {
    try { res.json(await fn(req, res)); }
    catch (err) { res.status(err.status || 400).json({ error: err.message }); }
  };

  r.post('/repair', send(() => ({ fixed: repairLeads() })));
  r.get('/outcomes', (req, res) => res.json(queue.OUTCOMES));

  r.get('/next', send(req => {
    const f = req.query || {};
    const exclude = String(f.exclude || '').split(',').filter(Boolean);
    return queue.nextLead({ source: f.source, state: f.state, city: f.city, county: f.county, ethnicity: f.ethnicity, keyword: f.keyword }, exclude);
  }));

  r.get('/lead/:id', send(req => {
    const lead = queue.leadView(req.params.id);
    if (!lead) throw Object.assign(new Error('Lead not found'), { status: 404 });
    return { lead };
  }));

  // Logs the outcome first (never blocked by the CRM), then pushes promising
  // leads into AgentLab's CRM and reports what happened.
  r.post('/lead/:id/outcome', express.json(), send(async req => {
    const body = req.body || {};
    const res = queue.logOutcome(req.params.id, body);
    try {
      const lead = store.getLead(req.params.id);
      res.crm = await crmSync.syncOutcome(deps.agent, lead, body.outcome, { meetingAt: body.meetingAt });
    } catch (e) {
      console.error('[dialer] CRM sync failed:', e.message);
      res.crm = { error: e.message };
    }
    return res;
  }));

  // Manual push for a lead already logged as Interested or better.
  r.post('/lead/:id/crm', express.json(), send(async req => {
    const lead = store.getLead(req.params.id);
    if (!lead) throw Object.assign(new Error('Lead not found'), { status: 404 });
    return { crm: await crmSync.syncOutcome(deps.agent, lead, lead.status) };
  }));
  r.post('/lead/:id/note', express.json(), send(req => queue.addNote(req.params.id, (req.body || {}).note)));
  r.post('/lead/:id/skip', express.json(), send(req => queue.skip(req.params.id, Number((req.body || {}).hours) || 4)));
  r.patch('/lead/:id', express.json(), send(req => ({ lead: queue.updateLead(req.params.id, req.body || {}) })));

  // Follow-up email: returns the filled subject/body and a mailto link. The
  // dialer screen opens it as a Gmail compose window (never sends by itself).
  r.post('/lead/:id/email', express.json(), send(async req => {
    const lead = store.getLead(req.params.id);
    if (!lead) throw Object.assign(new Error('Lead not found'), { status: 404 });
    if (!lead.email) throw new Error('This lead has no email address.');
    const s = store.settings();
    const subject = fill(s.emailSubject, lead, s);
    const body = fill(s.emailTemplate, lead, s);
    const mailto = 'mailto:' + encodeURIComponent(lead.email) + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
    const out = { to: lead.email, subject, body, mailto };
    return out;
  }));

  // Personalized AI script. Returns the cached one instantly, else generates it
  // (a few seconds). The screen also calls this for the NEXT lead ahead of time.
  r.post('/lead/:id/ai-script', express.json(), send(req => aiScript.getOrCreate(req.params.id, { force: !!(req.body || {}).force })));

  r.post('/render', express.json(), send(req => {
    const lead = store.getLead((req.body || {}).leadId);
    const s = store.settings();
    return { script: fill(s.script, lead || {}, s) };
  }));

  r.get('/search', send(req => ({ results: queue.search(req.query.q) })));
  r.get('/pipeline', send(() => ({ leads: queue.pipeline() })));
  r.get('/quality', send(() => queue.dataQuality()));
  r.get('/stats', send(() => queue.stats()));
  r.get('/filters', send(() => queue.filterOptions()));
  r.get('/imports', send(() => ({ imports: store.load().imports.slice().reverse() })));

  r.get('/settings', send(() => ({ settings: store.settings(), dataFile: store.DATA_FILE, aiPdfFallback: Boolean(process.env.ANTHROPIC_API_KEY), aiScripts: aiScript.enabled() })));
  r.post('/settings', express.json(), send(req => ({ settings: store.updateSettings(req.body || {}) })));

  // ---- Import: step 1, upload raw bytes and preview -------------------------
  r.post('/import/preview', express.raw({ type: 'application/octet-stream', limit: '40mb' }), send(async req => {
    cleanupPending();
    const filename = String(req.query.filename || 'upload');
    if (!req.body || !req.body.length) throw new Error('Empty upload.');
    const parsed = await parseFile(filename, req.body);
    const mapping = parsed.presetMapping || autoMap(parsed.headers);
    const importId = crypto.randomBytes(8).toString('hex');
    pendingImports.set(importId, { createdAt: Date.now(), filename, parsed });
    return { importId, ...summarize(parsed, mapping, ''), headers: parsed.headers, mapping, fields: FIELDS, method: parsed.method, pages: parsed.pages || null, headerRow: parsed.headerRow || null, suggestedSource: guessSource(filename) };
  }));

  // Re-run the preview with a corrected column mapping / default state.
  r.post('/import/remap', express.json(), send(req => {
    const { importId, mapping, defaultState } = req.body || {};
    const p = pendingImports.get(importId);
    if (!p) throw new Error('Import expired. Upload the file again.');
    return summarize(p.parsed, mapping || {}, defaultState || '');
  }));

  // ---- Import: step 2, commit ------------------------------------------------
  r.post('/import/commit', express.json(), send(req => {
    const { importId, mapping, source, defaultState } = req.body || {};
    const p = pendingImports.get(importId);
    if (!p) throw new Error('Import expired. Upload the file again.');
    const result = queue.importRecords(p.parsed.records, mapping || {}, { source: String(source || guessSource(p.filename)).trim(), defaultState: defaultState || '' });
    pendingImports.delete(importId);
    return result;
  }));

  // ---- Exports (backup / open in Sheets) ---------------------------------------
  r.get('/export/leads.csv', (req, res) => {
    const leads = store.allLeads();
    const calls = store.load().calls;
    const lastNote = {};
    for (const c of calls) if (c.note) lastNote[c.leadId] = c.note;
    const rows = leads.map(l => ({ ...l, sources: (l.sources || []).join('; '), lastNote: lastNote[l.id] || '' }));
    const cols = ['id', 'businessName', 'contactName', 'phone', 'phoneAlt', 'email', 'website', 'address', 'city', 'state', 'zip', 'county', 'industry', 'codes', 'certification', 'certExpires', 'ownerGender', 'ownerEthnicity', 'sources', 'status', 'attempts', 'lastCalledAt', 'nextAttemptAt', 'callbackAt', 'meetingAt', 'amount', 'lastNote', 'createdAt'];
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="dialer-leads-' + new Date().toISOString().slice(0, 10) + '.csv"');
    res.send('﻿' + toCsv(rows, cols));
  });

  r.get('/export/calls.csv', (req, res) => {
    const leads = store.load().leads;
    const rows = store.load().calls.map(c => ({ ...c, businessName: (leads[c.leadId] || {}).businessName || '', phone: (leads[c.leadId] || {}).phone || '' }));
    const cols = ['at', 'businessName', 'phone', 'outcome', 'note', 'durationSec', 'callbackAt', 'meetingAt', 'leadId'];
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="dialer-calls-' + new Date().toISOString().slice(0, 10) + '.csv"');
    res.send('﻿' + toCsv(rows, cols));
  });

  try { const n = repairLeads(); if (n) console.log('[dialer] filled missing names on ' + n + ' leads'); } catch (e) { console.error('[dialer] repair failed:', e.message); }
  app.use('/api/dialer', ...guards, r);
  store.load();
  console.log('Cold Call Dialer mounted at /dialer.html (data: ' + store.DATA_FILE + ', leads: ' + store.allLeads().length + ')');
};

function summarize(parsed, mapping, defaultState) {
  let withPhone = 0, alreadyIn = 0;
  const seen = new Set();
  const sample = [];
  for (const rec of parsed.records) {
    const n = normalizeRecord(rec, mapping, { defaultState });
    if (!n.phoneDigits) continue;
    withPhone++;
    if (!seen.has(n.phoneDigits) && store.leadByPhone(n.phoneDigits)) alreadyIn++;
    seen.add(n.phoneDigits);
    if (sample.length < 6) sample.push(n);
  }
  const newLeads = seen.size - alreadyIn;
  return { totals: { records: parsed.records.length, withPhone, uniquePhones: seen.size, newLeads, alreadyIn, noPhone: parsed.records.length - withPhone }, sample };
}
