const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const clean = require('./clean');

// Cold Call Dialer data store.
//
// Everything is held in memory (67k leads is a few dozen MB) so reads stay instant, and
// every change is persisted:
//
//   postgres (default on Railway, when init({ db }) is given the app's database)
//     leads, calls, settings and AI scripts live in dialer_* tables (migrations/002_dialer.sql).
//     Writes are batched about a second apart and only touch the rows that changed, so a
//     crash can lose at most the last second and never corrupts earlier history. The first
//     start imports the old dialer-data.json once; the file is left in place as a backup.
//
//   file (local use, or if no database is configured)
//     one JSON file, written atomically (temp file -> rename).
//     On Railway the container disk is wiped on every redeploy unless a Volume is mounted
//     at /data and DIALER_DATA_FILE=/data/dialer-data.json.

const DATA_FILE = process.env.DIALER_DATA_FILE
  ? path.resolve(process.env.DIALER_DATA_FILE)
  : path.join(__dirname, '..', 'dialer-data.json');
const AI_FILE = path.join(path.dirname(DATA_FILE), 'dialer-ai-scripts.json');

const SETTINGS_VERSION = 3;
const CLEAN_VERSION = 2;       // bump to re-run the lead cleanup once on next start
const OLD_GMAIL_ACCOUNT = 'info@thecdscloud.com';

const DEFAULT_SETTINGS = {
  dailyGoal: 60,
  maxAttempts: 3,          // no-answer / voicemail tries before a lead is retired
  retryDays: 2,            // wait before calling a no-answer / voicemail again
  gatekeeperRetryDays: 1,
  enforceCallWindow: true, // only serve leads inside their local calling hours
  callWindowStart: 9,      // lead's local time, 24h
  callWindowEnd: 17,
  callMethod: 'auto',      // auto | voice-web | tel
  voiceUrl: 'https://voice.google.com/u/0/calls',  // Google Voice on the web
  callbackNumber: '',      // your Google Voice number, read twice in the voicemail
  bookingLink: '',
  crmSync: true,           // push Interested / Meeting Booked / Closed-Won leads into AgentLab's CRM
  crmClientId: 'default',  // which AgentLab client receives them
  aiScripts: true,         // personalized AI script per lead (needs ANTHROPIC_API_KEY)
  aiSearchFallback: true,  // web search when the lead has no reachable website (~1 cent each)
  aiDailyCap: 200,         // max AI scripts generated per day
  gmailAccount: 'jason@realhelpstl.com', // Gmail / Calendar links open in this Google account
  senderName: 'Jason Griffin',
  senderCompany: 'The Real Help',
  website: 'https://www.therealhelp.com',
  postalAddress: '',       // CAN-SPAM: printed at the bottom of every follow-up email (required to send)
  unsubscribeUrl: '',      // optional https link added to the footer next to "reply unsubscribe"
  emailSubject: 'Following up from my call - {{businessName}}',
  emailTemplate:
    'Hi {{firstName}},\n\n' +
    'Thanks for taking a minute on the phone today. Here is the short version:\n\n' +
    'I build three things for small businesses. Each is $500 to build and $30 a month to host, run and support (up to 2 small changes a month included):\n\n' +
    '1. Website That Gets Calls - a mobile site with click-to-call and a contact form that emails you.\n' +
    '2. AI Lead Responder - every web form or email gets a reply in under 2 minutes, in your voice.\n' +
    '3. Paperwork Autopilot - one form that fills your estimate, intake or job sheet and sends the PDF.\n\n' +
    'Each one goes live within 5 business days of me receiving your materials. Anything bigger is a custom build with a fixed quote first.\n\n' +
    'You can see examples at {{website}}.{{bookingLine}}\n\n' +
    'Jason Griffin\n{{senderCompany}}',
  // ~20 seconds spoken. {{vmReason}} is picked from the lead's best-fit offer. The number is said twice.
  voicemailScript:
    '{{greeting}}, this is {{senderName}} with {{senderCompany}}. {{vmReason}} ' +
    'I would like to show {{businessName}} how it works - it takes about fifteen minutes. ' +
    'Call me back at {{callbackNumber}}. Again, that is {{callbackNumber}}. Thanks.',
  scriptVersion: 3,
  settingsVersion: SETTINGS_VERSION,
  script: [
    'OPENER',
    'Hi, is this {{ownerAsk}}? This is Jason Griffin with The Real Help. I know I\'m catching you in the middle of your day - can I have 30 seconds to tell you why I called, and you can tell me if it\'s worth another minute?',
    '',
    'REASON FOR THE CALL - give three choices, not a yes/no',
    'I build three things for small businesses, $500 each, done in under a week: a website that makes your phone ring, an assistant that answers every lead in two minutes, and paperwork that fills itself out. Which of those would help {{businessName}} most right now?',
    '',
    'IF THEY HESITATE - ask, then offer the match',
    'Do you have a website? (No / embarrassing -> offer 1)',
    'When someone fills out your form or emails at 9 p.m., what happens? ("I get to it tomorrow" -> offer 2)',
    'How do you send estimates or intake forms now? ("Word doc and email" -> offer 3)',
    '',
    'PITCH - say only the one that fits',
    '1) WEBSITE THAT GETS CALLS: A mobile site, up to five sections - services, about, photos and reviews, a contact form that emails you and logs to a sheet, click-to-call, basic local search setup, on your own domain.',
    '2) AI LEAD RESPONDER: Every web form or email gets a reply in under two minutes, in your voice, using your services, prices and hours. It pushes them to book or call, alerts you, and flags anything it is unsure of instead of guessing. First week is draft mode so you approve each reply.',
    '3) PAPERWORK AUTOPILOT: One form - quote request, intake, job sheet or application - fills your document template. The PDF goes to your customer and you, gets filed in Drive and tracked in a sheet.',
    'PRICE: $500 to build, $30 a month to host, run and support it, including up to two small changes a month. Live within five business days of getting your materials.',
    '',
    'CLOSE - pick one',
    'A) Book: Let\'s do 15 minutes on a screen-share so I can show you what that looks like for {{businessName}}. Does {{dayOne}} or {{dayTwo}} work better?',
    'B) Close now: I\'ll email you a one-page scope of exactly what is included and a payment link, and we start as soon as I have your logo, photos and services.',
    'DEMO CLOSE (offer 2): Email my demo address right now while we are on the phone and watch the reply land. Use the separate demo inbox, never your main one.',
    '',
    'NOTHING FITS?',
    'Tell me the biggest headache in your week and I\'ll tell you honestly if I can fix it for $500. Bigger jobs - customer portals, logins, several systems talking to each other - are a custom build with a fixed quote after a 20-minute scoping call.',
    '',
    'OBJECTIONS',
    'Send me something -> Happy to. What\'s the best email? And which of the three should I lead with?',
    'Not interested -> Understood. Is that because you have this covered already, or the timing isn\'t right?',
    'No budget -> That\'s why it\'s $500, not $5,000. If it saves you two hours a week or lands one extra job, it pays for itself fast.',
    'Already have a website / software -> Good. What does it still not do - the part you handle by hand or miss when you\'re out on a job? That\'s usually where I come in.',
    'Can you also do ___ (bigger) -> Possibly. That would be a custom build - a fixed quote after a short call, so there are no surprises.'
  ].join('\n')
};

const EMPTY = () => ({
  leads: {},      // id -> lead
  calls: [],      // newest-last call log
  imports: [],    // import history
  settings: { ...DEFAULT_SETTINGS },
  meta: { createdAt: new Date().toISOString() }
});

let cache = null;
let phoneIndex = null;   // phoneDigits -> lead id
let backend = 'file';    // 'file' | 'postgres'
let pg = null;           // { query(text, params) }
let aiCache = null;      // leadId -> AI script
const dirty = { leads: new Set(), kv: false, ai: new Set(), aiDel: new Set(), persistedCalls: 0 };
const health = { lastFlushAt: null, lastError: null, flushing: false };
let flushTimer = null;
let flushChain = Promise.resolve();

// ---- Loading ----------------------------------------------------------------------------
function readFileData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return null; }
}

function normalize(data) {
  cache = data || EMPTY();
  cache.leads = cache.leads || {};
  cache.calls = cache.calls || [];
  cache.imports = cache.imports || [];
  cache.meta = cache.meta || { createdAt: new Date().toISOString() };
  const saved = cache.settings || {};
  const savedScriptVersion = saved.scriptVersion || 1;
  const savedSettingsVersion = saved.settingsVersion || 1;
  cache.settings = { ...DEFAULT_SETTINGS, ...saved };
  const s = cache.settings;
  // One-time swap of the old single-offer defaults for the three-offer script/email,
  // only if the saved text is still the old default (never overwrites Jason's edits).
  if (savedScriptVersion < 2) {
    if (/on a list of certified businesses/.test(s.script || '')) s.script = DEFAULT_SETTINGS.script;
    if (/I build simple custom software for small businesses/.test(s.emailTemplate || '')) s.emailTemplate = DEFAULT_SETTINGS.emailTemplate;
  }
  // v3: "Hi, is this there?" when there is no first name, and a hardcoded "tomorrow or Thursday".
  // Patch just those two phrases so any other edits to the script survive.
  if (savedScriptVersion < 3) {
    s.script = String(s.script || '')
      .replace('is this {{firstName}}?', 'is this {{ownerAsk}}?')
      .replace('Does tomorrow or Thursday work better?', 'Does {{dayOne}} or {{dayTwo}} work better?');
    s.scriptVersion = 3;
  }
  // v3: Google Voice replaces TextNow; follow-up mail comes from the outreach mailbox.
  if (savedSettingsVersion < 3) {
    if (s.callMethod === 'textnow-web') s.callMethod = 'voice-web';
    if (s.gmailAccount === OLD_GMAIL_ACCOUNT) s.gmailAccount = DEFAULT_SETTINGS.gmailAccount;
    s.settingsVersion = SETTINGS_VERSION;
    dirty.kv = true;
  }
  delete s.textnowUrl;
  rebuildIndex();
}

// Sync load: file mode, tests, or before init() has run.
function load() {
  if (cache) return cache;
  normalize(readFileData());
  cleanupOnce();
  return cache;
}

function rebuildIndex() {
  phoneIndex = new Map();
  for (const lead of Object.values(cache.leads)) {
    if (lead.phoneDigits) phoneIndex.set(lead.phoneDigits, lead.id);
  }
}

// Idempotent lead cleanup (old review flags, city/owner spelling, blank counties).
function runCleanup() {
  const data = load();
  const { stats, changed } = clean.cleanAll(data.leads);
  for (const l of changed) touch(l);
  data.meta.cleanVersion = CLEAN_VERSION;
  data.meta.lastCleanup = { at: new Date().toISOString(), ...stats };
  save();
  return data.meta.lastCleanup;
}
function cleanupOnce() {
  if ((cache.meta.cleanVersion || 0) >= CLEAN_VERSION) return null;
  try {
    const r = runCleanup();
    console.log('[dialer] lead cleanup: ' + r.changed + ' leads updated, ' + r.flagsRemoved + ' with old review flags cleared, ' + r.countiesFilled + ' counties filled');
    return r;
  } catch (e) { console.error('[dialer] lead cleanup failed:', e.message); return null; }
}

// ---- Postgres ---------------------------------------------------------------------------------
async function init({ db } = {}) {
  if (!db || process.env.DIALER_STORAGE === 'file') {
    load();
    aiLoad();
    return { backend: 'file', leads: Object.keys(cache.leads).length };
  }
  pg = db;
  backend = 'postgres';
  const count = async t => Number((await pg.query('SELECT count(*)::int AS n FROM ' + t)).rows[0].n);
  const migrated = (await pg.query("SELECT 1 FROM dialer_kv WHERE key = 'migrated_from_file'")).rows.length > 0;
  let imported = null;
  if (!migrated && (await count('prospects')) === 0 && fs.existsSync(DATA_FILE)) {
    const fileData = readFileData();
    if (fileData && Object.keys(fileData.leads || {}).length) {
      normalize(fileData);
      for (const id of Object.keys(cache.leads)) dirty.leads.add(id);
      dirty.kv = true;
      dirty.persistedCalls = 0;
      await flush();
      imported = { leads: Object.keys(cache.leads).length, calls: cache.calls.length };
      await pg.query("INSERT INTO dialer_kv (key, value) VALUES ('migrated_from_file', $1::jsonb) ON CONFLICT (key) DO NOTHING", [JSON.stringify({ at: new Date().toISOString(), ...imported })]);
      console.log('[dialer] imported ' + imported.leads + ' leads and ' + imported.calls + ' calls from ' + DATA_FILE + ' into Postgres (file left in place as a backup)');
    }
  }
  if (!cache) {
    const data = EMPTY();
    for (const r of (await pg.query("SELECT data FROM prospects WHERE data->>'id' IS NOT NULL")).rows) data.leads[r.data.id] = r.data;
    data.calls = (await pg.query('SELECT data FROM dialer_calls ORDER BY at, id')).rows.map(r => r.data);
    const kv = {};
    for (const r of (await pg.query('SELECT key, value FROM dialer_kv')).rows) kv[r.key] = r.value;
    data.settings = kv.settings || {};
    data.imports = kv.imports || [];
    data.meta = kv.meta || { createdAt: new Date().toISOString() };
    normalize(data);
    dirty.persistedCalls = cache.calls.length;
  } else {
    dirty.persistedCalls = cache.calls.length;
  }
  aiCache = {};
  for (const r of (await pg.query('SELECT id, research FROM prospects WHERE research IS NOT NULL')).rows) aiCache[r.id] = r.research;
  cleanupOnce();
  // Persist the migration/cleanup results now rather than waiting for the timer; a failure retries on its own.
  try { await flush(); } catch (e) { console.error('[dialer] startup save failed, will retry:', e.message); scheduleFlush(); }
  return { backend: 'postgres', leads: Object.keys(cache.leads).length, calls: cache.calls.length, imported };
}

const CHUNK = 500;
const model = require('./prospect-model');
const toTs = v => { if (!v) return null; const t = new Date(v); return isNaN(t) ? null : t.toISOString(); };

// Map a dialer lead onto the prospects columns. Email-side columns (email_state, sent counts,
// approval, priority, holds, stop reasons, pending touch) are NOT written here: other systems
// own them and the dialer pulls them back (see prospects.pullEmailSide).
function prospectRow(l) {
  return {
    id: l.id,
    phone_digits: l.phoneDigits || null,
    email: model.emailOf(l) || null,
    business_key: model.businessKey(l) || null,
    business_name: l.businessName || null,
    city: l.city || null,
    state: l.state || null,
    stage: model.stageOf(l),
    call_status: l.status || null,
    call_attempts: l.attempts || 0,
    last_call_at: toTs(l.lastCalledAt),
    next_call_at: toTs(l.nextAttemptAt),
    callback_at: toTs(l.callbackAt),
    call_blocked: !!(l.callBlocked || l.status === 'dnc'),
    crm_contact_id: l.crmContactId || null,
    crm_deal_id: l.crmDealId || null,
    email_state: model.initialEmailState(l),
    data: l,
  };
}

async function upsertLeads(ids) {
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = ids.slice(i, i + CHUNK).map(id => cache.leads[id]).filter(Boolean).map(prospectRow);
    if (!rows.length) continue;
    await pg.query(
      `INSERT INTO prospects (id, phone_digits, email, business_key, business_name, city, state, stage, call_status, call_attempts,
                              last_call_at, next_call_at, callback_at, call_blocked, crm_contact_id, crm_deal_id, email_state, data)
       SELECT id, phone_digits, email, business_key, business_name, city, state, stage, call_status, call_attempts,
              last_call_at, next_call_at, callback_at, call_blocked, crm_contact_id, crm_deal_id, email_state, data
       FROM jsonb_to_recordset($1::jsonb) AS x(id text, phone_digits text, email text, business_key text, business_name text, city text, state text,
              stage text, call_status text, call_attempts int, last_call_at timestamptz, next_call_at timestamptz, callback_at timestamptz,
              call_blocked boolean, crm_contact_id bigint, crm_deal_id bigint, email_state text, data jsonb)
       ON CONFLICT (id) DO UPDATE SET
         phone_digits = EXCLUDED.phone_digits, email = EXCLUDED.email, business_key = EXCLUDED.business_key,
         business_name = EXCLUDED.business_name, city = EXCLUDED.city, state = EXCLUDED.state, stage = EXCLUDED.stage,
         call_status = EXCLUDED.call_status, call_attempts = EXCLUDED.call_attempts, last_call_at = EXCLUDED.last_call_at,
         next_call_at = EXCLUDED.next_call_at, callback_at = EXCLUDED.callback_at,
         call_blocked = prospects.call_blocked OR EXCLUDED.call_blocked,
         crm_contact_id = COALESCE(EXCLUDED.crm_contact_id, prospects.crm_contact_id),
         crm_deal_id = COALESCE(EXCLUDED.crm_deal_id, prospects.crm_deal_id),
         email_state = CASE WHEN prospects.email_state = 'none' AND EXCLUDED.email_state = 'ready' THEN 'ready'
                            WHEN prospects.email IS DISTINCT FROM EXCLUDED.email AND EXCLUDED.email_state = 'none' THEN 'none'
                            ELSE prospects.email_state END,
         data = EXCLUDED.data`,
      [JSON.stringify(rows)]);
  }
}

async function insertCalls(from, to) {
  for (let i = from; i < to; i += CHUNK) {
    const rows = cache.calls.slice(i, Math.min(to, i + CHUNK)).map(c => ({ id: c.id, lead_id: c.leadId, at: c.at, data: c }));
    await pg.query(
      'INSERT INTO dialer_calls (id, lead_id, at, data) ' +
      'SELECT id, lead_id, at::timestamptz, data FROM jsonb_to_recordset($1::jsonb) AS x(id text, lead_id text, at text, data jsonb) ' +
      'ON CONFLICT (id) DO NOTHING',
      [JSON.stringify(rows)]);
  }
}

const kvPut = (key, value) => pg.query(
  'INSERT INTO dialer_kv (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
  [key, JSON.stringify(value)]);

async function flushOnce() {
  if (backend !== 'postgres') return;
  const leadIds = [...dirty.leads]; dirty.leads = new Set();
  const kv = dirty.kv; dirty.kv = false;
  const aiPut = [...dirty.ai]; dirty.ai = new Set();
  const aiDel = [...dirty.aiDel]; dirty.aiDel = new Set();
  const callsTarget = cache.calls.length;
  try {
    await upsertLeads(leadIds);
    if (callsTarget > dirty.persistedCalls) { await insertCalls(dirty.persistedCalls, callsTarget); dirty.persistedCalls = callsTarget; }
    if (kv) { await kvPut('settings', cache.settings); await kvPut('imports', cache.imports); await kvPut('meta', cache.meta); }
    for (const id of aiPut) if (aiCache[id]) await pg.query('UPDATE prospects SET research = $2::jsonb WHERE id = $1', [id, JSON.stringify(aiCache[id])]);
    for (const id of aiDel) await pg.query('UPDATE prospects SET research = NULL WHERE id = $1', [id]);
    health.lastFlushAt = new Date().toISOString();
    health.lastError = null;
  } catch (e) {
    // Put everything back so the next attempt retries it.
    for (const id of leadIds) dirty.leads.add(id);
    if (kv) dirty.kv = true;
    for (const id of aiPut) dirty.ai.add(id);
    for (const id of aiDel) dirty.aiDel.add(id);
    health.lastError = e.message;
    throw e;
  }
}

function flush() {
  if (backend !== 'postgres') return Promise.resolve();
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  flushChain = flushChain.then(flushOnce, flushOnce);
  return flushChain;
}

function scheduleFlush() {
  if (backend !== 'postgres' || flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush().catch(e => {
      console.error('[dialer] database write failed, will retry in 5s:', e.message);
      flushTimer = setTimeout(() => { flushTimer = null; scheduleFlush(); flush().catch(() => {}); }, 5000);
    });
  }, 750);
}

// ---- Saving -----------------------------------------------------------------------------------
function touch(leadOrId) {
  const id = typeof leadOrId === 'string' ? leadOrId : leadOrId && leadOrId.id;
  if (id) dirty.leads.add(id);
}

function save() {
  const data = load();
  if (backend === 'postgres') { dirty.kv = true; scheduleFlush(); return; }
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, DATA_FILE);
}

function status() {
  return {
    backend,
    pendingLeads: dirty.leads.size,
    pendingCalls: cache ? Math.max(0, cache.calls.length - dirty.persistedCalls) : 0,
    lastFlushAt: health.lastFlushAt,
    lastError: health.lastError,
    dataFile: backend === 'file' ? DATA_FILE : null
  };
}

// ---- AI script cache ----------------------------------------------------------------------------
function aiLoad() {
  if (aiCache) return aiCache;
  try { aiCache = JSON.parse(fs.readFileSync(AI_FILE, 'utf8')); } catch { aiCache = {}; }
  return aiCache;
}
let aiTimer = null;
function aiSaveFileSoon() {
  if (aiTimer) return;
  aiTimer = setTimeout(() => {
    aiTimer = null;
    try {
      fs.mkdirSync(path.dirname(AI_FILE), { recursive: true });
      const tmp = AI_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(aiLoad()));
      fs.renameSync(tmp, AI_FILE);
    } catch (e) { console.error('[dialer] could not save AI scripts:', e.message); }
  }, 1500);
}
function aiGet(id) { return aiLoad()[id] || null; }
function aiPut(id, script) {
  aiLoad()[id] = script;
  if (backend === 'postgres') { dirty.ai.add(id); dirty.aiDel.delete(id); scheduleFlush(); } else aiSaveFileSoon();
}
function aiDel(id) {
  if (!aiLoad()[id]) return;
  delete aiCache[id];
  if (backend === 'postgres') { dirty.aiDel.add(id); dirty.ai.delete(id); scheduleFlush(); } else aiSaveFileSoon();
}

// ---- Accessors -------------------------------------------------------------------------------------
function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function pgHandle() { return backend === 'postgres' ? pg : null; }
function getLead(id) { return load().leads[id] || null; }
function allLeads() { return Object.values(load().leads); }
function leadByPhone(digits) {
  load();
  const id = phoneIndex.get(digits);
  return id ? cache.leads[id] : null;
}

function addLead(lead) {
  const data = load();
  data.leads[lead.id] = lead;
  if (lead.phoneDigits) phoneIndex.set(lead.phoneDigits, lead.id);
  touch(lead);
}

function addCall(call) {
  load().calls.push(call);
}

function settings() { return load().settings; }
function updateSettings(patch) {
  const data = load();
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (key === 'scriptVersion' || key === 'settingsVersion') continue;
    if (patch[key] === undefined) continue;
    const def = DEFAULT_SETTINGS[key];
    if (typeof def === 'number') {
      const n = Number(patch[key]);
      if (Number.isFinite(n)) data.settings[key] = n;
    } else if (typeof def === 'boolean') {
      data.settings[key] = patch[key] === true || patch[key] === 'true';
    } else {
      data.settings[key] = String(patch[key]);
    }
  }
  save();
  return data.settings;
}

// Everything, for the nightly backup and manual download.
function snapshot() {
  const d = load();
  return { exportedAt: new Date().toISOString(), backend, leads: d.leads, calls: d.calls, imports: d.imports, settings: d.settings, meta: d.meta, aiScripts: aiLoad() };
}

module.exports = {
  DATA_FILE, DEFAULT_SETTINGS,
  init, load, save, touch, flush, status, snapshot, runCleanup, newId,
  getLead, allLeads, leadByPhone, addLead, addCall,
  aiGet, aiPut, aiDel,
  settings, updateSettings,
  pgHandle,
  _reset() { cache = null; aiCache = null; backend = 'file'; pg = null; dirty.leads = new Set(); dirty.ai = new Set(); dirty.aiDel = new Set(); dirty.kv = false; dirty.persistedCalls = 0; }
};
