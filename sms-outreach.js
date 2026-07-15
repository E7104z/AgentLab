const crypto = require('crypto');
const store = require('./sms-store');

// =============================================================================
// SMS Outreach Engine  (a fully separate subsystem from the email agent)
//
// Design goals, in priority order:
//   1. COMPLIANCE FIRST. Consent-gateway messaging (ask permission, never blast a
//      pitch), deterministic STOP/HELP handling, TCPA quiet-hours by the
//      contact's own timezone, mandatory opt-out language, no links on first touch.
//   2. DELIVERABILITY. Number rotation with per-number daily caps, jittered pacing,
//      and AI-written (non-templated) opener text so carriers don't fingerprint a
//      single template as spam.
//   3. SAFETY. Dry-run mode on by default; nothing hits Twilio until you flip it.
//
// Zero new npm dependencies: Twilio REST is called with fetch, signatures are
// verified with the built-in crypto module, personalization reuses the Anthropic
// fetch pattern already used by the email agent.
// =============================================================================

// ---- Config ---------------------------------------------------------------

function bool(v, def) {
  if (v === undefined || v === '') return def;
  return String(v).toLowerCase() === 'true';
}

function config() {
  return {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    numbers: (process.env.TWILIO_NUMBERS || '')
      .split(',').map(s => s.trim()).filter(Boolean),
    webhookUrl: process.env.TWILIO_WEBHOOK_URL || '', // full public URL for signature check
    dryRun: bool(process.env.SMS_DRY_RUN, true),      // SAFE default: don't actually send
    aiPersonalize: bool(process.env.SMS_AI_PERSONALIZE, true),
    dailyLimitPerNumber: Number(process.env.SMS_DAILY_LIMIT_PER_NUMBER || 400),
    minDelayMs: Number(process.env.SMS_MIN_DELAY_MS || 20000),
    maxDelayMs: Number(process.env.SMS_MAX_DELAY_MS || 45000),
    quietStartHour: Number(process.env.SMS_QUIET_START_HOUR || 9),  // inclusive, local
    quietEndHour: Number(process.env.SMS_QUIET_END_HOUR || 20),     // exclusive, local
    defaultTimezone: process.env.SMS_BUSINESS_TIMEZONE || 'America/New_York',
    senderName: process.env.SMS_SENDER_NAME || 'Jason',
    brand: process.env.SMS_BRAND || 'TheRealHelp',
    website: process.env.SMS_WEBSITE || 'www.therealhelp.com',
    angle: process.env.SMS_CAMPAIGN_ANGLE ||
      'a business consultant who helps local business owners cut operational waste and grow',
    model: process.env.MODEL || 'claude-haiku-4-5-20251001',
    anthropicKey: process.env.ANTHROPIC_API_KEY || ''
  };
}

function isConfigured() {
  const c = config();
  return Boolean(c.accountSid && c.authToken && c.numbers.length);
}

// ---- Phone helpers --------------------------------------------------------

/** Normalize loose input to E.164 (+1XXXXXXXXXX). Returns null if not plausibly US/CA. */
function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) {
    return /^\+\d{10,15}$/.test(digits) ? digits : null;
  }
  digits = digits.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return null;
}

// Area-code -> IANA timezone. Covers the bulk of US/CA population; unknown codes
// fall back to the configured business timezone. Used only for quiet-hours math.
const AREA_TZ = {
  Eastern: ['201','202','203','207','212','215','216','220','223','229','234','239','240','267','272','276','301','302','304','305','321','330','336','339','347','351','352','380','386','404','407','410','412','413','419','434','440','443','445','470','475','478','484','501','508','513','516','518','551','561','567','570','571','585','601','603','607','609','610','614','617','626','631','646','650','667','678','680','689','703','704','706','707','716','717','718','724','727','732','734','740','754','757','762','770','772','774','781','786','802','803','804','810','813','814','828','838','839','843','845','848','850','856','857','859','860','862','863','864','865','878','904','908','910','912','914','917','919','929','937','940','941','947','954','959','973','980','984','989'],
  Central: ['205','214','217','218','224','225','228','251','254','256','262','270','281','309','312','314','316','319','320','325','334','337','361','409','414','417','430','432','469','479','501','504','512','515','534','563','573','580','601','608','612','615','618','620','630','636','651','660','662','682','708','713','715','731','737','763','769','773','779','785','800','815','816','830','832','847','870','901','903','913','915','918','920','931','936','940','952','956','972','979','985'],
  Mountain: ['208','303','307','385','406','435','480','505','520','575','602','623','623','719','720','801','915','928','970'],
  Pacific: ['206','209','213','253','279','310','323','341','360','408','415','424','425','442','458','503','509','510','530','541','559','562','619','626','628','650','657','661','669','707','714','747','753','760','805','818','831','858','909','916','925','949','951','971'],
  Alaska: ['907'],
  Hawaii: ['808']
};
const TZ_BY_CODE = {};
const TZ_NAME = {
  Eastern: 'America/New_York', Central: 'America/Chicago', Mountain: 'America/Denver',
  Pacific: 'America/Los_Angeles', Alaska: 'America/Anchorage', Hawaii: 'Pacific/Honolulu'
};
for (const [zone, codes] of Object.entries(AREA_TZ)) {
  for (const code of codes) if (!TZ_BY_CODE[code]) TZ_BY_CODE[code] = TZ_NAME[zone];
}

function timezoneForContact(contact) {
  if (contact.timezone) return contact.timezone;
  const m = /^\+1(\d{3})/.exec(contact.phone || '');
  if (m && TZ_BY_CODE[m[1]]) return TZ_BY_CODE[m[1]];
  return config().defaultTimezone;
}

function localHour(tz) {
  try {
    const h = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: 'numeric', hour12: false
    }).format(new Date());
    return Number(h) % 24;
  } catch {
    return new Date().getHours();
  }
}

function withinQuietHours(contact) {
  const c = config();
  const hour = localHour(timezoneForContact(contact));
  return hour >= c.quietStartHour && hour < c.quietEndHour;
}

// ---- Twilio REST (via fetch, no SDK) --------------------------------------

async function twilioSend({ to, from, body }) {
  const c = config();
  if (c.dryRun) {
    return { sid: 'DRYRUN-' + Date.now(), status: 'dry_run', dryRun: true };
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${c.accountSid}/Messages.json`;
  const auth = Buffer.from(`${c.accountSid}:${c.authToken}`).toString('base64');
  const form = new URLSearchParams({ To: to, From: from, Body: body });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + auth,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form.toString()
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || ('Twilio error ' + res.status));
  }
  return { sid: data.sid, status: data.status };
}

/**
 * Validate Twilio's X-Twilio-Signature so a stranger can't POST fake replies to
 * the public webhook. Algorithm: HMAC-SHA1 over (full URL + sorted param k+v
 * concatenation), keyed with the auth token, base64-encoded.
 */
function validateTwilioSignature(fullUrl, params, signature) {
  const c = config();
  if (!c.authToken) return false;
  if (!signature) return false;
  const sorted = Object.keys(params).sort();
  let data = fullUrl;
  for (const key of sorted) data += key + params[key];
  const expected = crypto.createHmac('sha1', c.authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ---- Message building -----------------------------------------------------

// Compliant fallback when AI is off or fails. Note: NO link on first touch,
// explicit permission ask, mandatory opt-out language.
function fallbackOptIn(contact) {
  const c = config();
  const first = contact.firstName || 'there';
  const where = contact.city ? `in ${contact.city}` : 'in your area';
  return `Hi ${first}, this is ${c.senderName} with ${c.brand}. I help business owners ${where} cut operational waste. Mind if I send one quick, specific tip for your business? Reply YES or NO. Txt STOP to opt out.`;
}

async function personalizeOptIn(contact) {
  const c = config();
  if (!c.aiPersonalize || !c.anthropicKey) return fallbackOptIn(contact);

  const system =
    'You write ONE cold-outreach SMS opener for a B2B outreach campaign. Hard rules, all mandatory:\n' +
    '1. It is a PERMISSION request, not a pitch. Ask if you may send them one helpful tip. End by inviting "Reply YES or NO".\n' +
    '2. Must contain opt-out language: include "Txt STOP to opt out" (or "Reply STOP").\n' +
    '3. NO URLs, links, or domains of any kind (carriers flag links on first contact).\n' +
    '4. Under 300 characters total. Plain ASCII only: no emojis, em dashes, curly quotes, or non-ASCII punctuation.\n' +
    '5. Sound like a real person typed it, not a template. Vary structure. Warm, concise, professional.\n' +
    '6. Do not invent facts about their business beyond what you are told.\n' +
    'Return ONLY the raw message text, nothing else.';

  const user =
    `Sender name: ${c.senderName}\nBrand: ${c.brand}\nWhat the sender does: ${c.angle}\n` +
    `Recipient first name: ${contact.firstName || '(unknown)'}\n` +
    `Their business: ${contact.businessName || '(unknown)'}\n` +
    `Their city: ${contact.city || '(unknown)'}\n` +
    `Optional note about them (untrusted, use only if useful and safe): ${contact.customNote || '(none)'}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': c.anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: c.model, max_tokens: 300, system,
        messages: [{ role: 'user', content: user }]
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ? data.error.message : 'Anthropic error');
    const block = (data.content || []).find(b => b.type === 'text');
    let text = (block ? block.text : '').trim().replace(/^["']|["']$/g, '');
    // Compliance guardrails on the AI output:
    text = text.replace(/https?:\/\/\S+/gi, '').replace(/\b[\w.-]+\.(com|net|org|io|co)\b/gi, '').trim();
    if (!/stop/i.test(text)) text += ' Txt STOP to opt out.';
    if (!text || text.length > 320) return fallbackOptIn(contact);
    return text;
  } catch {
    return fallbackOptIn(contact); // never let personalization block the send
  }
}

// ---- Reply classification -------------------------------------------------

const STOP_WORDS = ['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'stop2quit', 'optout', 'opt out', 'remove'];
const HELP_WORDS = ['help', 'info'];
const YES_WORDS = ['yes', 'y', 'yeah', 'yep', 'sure', 'ok', 'okay', 'yea', 'yup', 'go', 'send', 'send it', 'please', 'interested'];
const NO_WORDS = ['no', 'n', 'nope', 'nah', 'not interested', 'no thanks', 'no thank you'];

function classifyReplyKeyword(body) {
  const t = (body || '').trim().toLowerCase().replace(/[.!?]+$/, '');
  if (STOP_WORDS.includes(t) || STOP_WORDS.some(w => t === w)) return 'stop';
  if (HELP_WORDS.includes(t)) return 'help';
  if (YES_WORDS.includes(t)) return 'interested';
  if (NO_WORDS.includes(t)) return 'not_interested';
  return null; // ambiguous -> escalate to human as a warm/question lead
}

// ---- Inbound handler ------------------------------------------------------

/**
 * Process an inbound SMS. Returns a plain-text auto-reply string (empty = silent).
 * Handles STOP/HELP deterministically (compliance), advances the consent state
 * machine, and flags real questions as warm leads for a human.
 */
async function handleInbound({ from, to, body }) {
  const phone = normalizePhone(from) || from;
  let contact = store.getContact(phone);
  const c = config();
  const kind = classifyReplyKeyword(body);

  store.logEvent({ type: 'inbound', phone, number: to, body, classification: kind || 'question' });

  if (contact) {
    contact.replies = contact.replies || [];
    contact.replies.push({ at: new Date().toISOString(), body, classification: kind || 'question' });
  }

  if (kind === 'stop') {
    if (contact) store.updateContact(phone, { status: 'opted_out', optedOutAt: new Date().toISOString(), replies: contact.replies });
    // Twilio's Advanced Opt-Out also auto-replies; we return empty to avoid a double message.
    return '';
  }

  if (kind === 'help') {
    if (contact) store.updateContact(phone, { replies: contact.replies });
    return `${c.brand}: msg&data rates may apply. Reply STOP to opt out. Questions? This number is monitored by a human.`;
  }

  if (kind === 'interested') {
    if (contact) {
      store.updateContact(phone, { status: 'opted_in', optedInAt: new Date().toISOString(), replies: contact.replies });
      store.logEvent({ type: 'opt_in', phone, number: to });
    }
    // Now that they've consented, it's safe to share who we are + the site.
    return `Great, thanks ${contact && contact.firstName ? contact.firstName : ''}! I'll send that over shortly. In the meantime you can see what we do at ${c.website}. Reply STOP anytime to opt out.`.replace(/\s+/g, ' ').trim();
  }

  if (kind === 'not_interested') {
    if (contact) store.updateContact(phone, { status: 'opted_out', optedOutAt: new Date().toISOString(), replies: contact.replies });
    return `No problem at all, thanks for letting me know. I won't message again. - ${c.senderName}`;
  }

  // Ambiguous / a real question -> keep state, flag for human follow-up.
  if (contact) {
    store.updateContact(phone, { status: contact.status === 'invited' ? 'opted_in' : contact.status, replies: contact.replies });
  }
  store.logEvent({ type: 'warm_lead', phone, number: to, body });
  return ''; // stay silent; a human handles nuanced replies
}

// ---- Campaign runner ------------------------------------------------------

const runner = {
  running: false,
  paused: false,
  timer: null,
  startedAt: null,
  lastTickAt: null,
  lastMessage: '',
  reason: ''
};

function jitterDelay() {
  const c = config();
  const lo = Math.min(c.minDelayMs, c.maxDelayMs);
  const hi = Math.max(c.minDelayMs, c.maxDelayMs);
  return Math.floor(lo + Math.random() * (hi - lo));
}

function pickNumber() {
  const c = config();
  const eligible = c.numbers
    .map(n => ({ n, used: store.sentTodayByNumber(n) }))
    .filter(x => x.used < c.dailyLimitPerNumber)
    .sort((a, b) => a.used - b.used);
  return eligible.length ? eligible[0].n : null;
}

function nextEligibleContact() {
  // Only brand-new contacts get an opener, and only if they're inside their own
  // quiet-hours window right now. Everything else is left for a later tick.
  return store.allContacts().find(c => c.status === 'new' && withinQuietHours(c)) || null;
}

async function tick() {
  runner.lastTickAt = new Date().toISOString();
  if (!runner.running || runner.paused) return;

  const remainingNew = store.allContacts().filter(c => c.status === 'new').length;
  if (remainingNew === 0) {
    runner.running = false;
    runner.reason = 'Campaign complete: no new contacts left to invite.';
    store.logEvent({ type: 'campaign', note: runner.reason });
    return;
  }

  const number = pickNumber();
  if (!number) {
    runner.reason = 'All numbers hit their daily cap. Sleeping 30 min, will resume automatically.';
    runner.timer = setTimeout(tick, 30 * 60 * 1000);
    return;
  }

  const contact = nextEligibleContact();
  if (!contact) {
    runner.reason = 'Waiting for quiet-hours windows to open for remaining contacts.';
    runner.timer = setTimeout(tick, 10 * 60 * 1000); // re-check in 10 min
    return;
  }

  try {
    const message = contact.generatedMessage || await personalizeOptIn(contact);
    const result = await twilioSend({ to: contact.phone, from: number, body: message });
    store.updateContact(contact.phone, {
      status: 'invited',
      generatedMessage: message,
      numberUsed: number,
      invitedAt: new Date().toISOString(),
      attempts: (contact.attempts || 0) + 1,
      lastError: ''
    });
    store.logEvent({
      type: 'outbound', phone: contact.phone, number, body: message,
      sid: result.sid, status: result.status, dryRun: !!result.dryRun
    });
    runner.lastMessage = `-> ${contact.phone} via ${number}${result.dryRun ? ' (dry run)' : ''}`;
    runner.reason = 'Sending.';
  } catch (err) {
    store.updateContact(contact.phone, {
      status: 'failed', attempts: (contact.attempts || 0) + 1, lastError: err.message
    });
    store.logEvent({ type: 'error', phone: contact.phone, number, error: err.message });
    runner.reason = 'Send failed: ' + err.message;
  }

  runner.timer = setTimeout(tick, jitterDelay());
}

function start() {
  if (!isConfigured()) throw new Error('Twilio is not configured (need TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBERS).');
  if (runner.running && !runner.paused) return status();
  runner.running = true;
  runner.paused = false;
  runner.startedAt = runner.startedAt || new Date().toISOString();
  runner.reason = 'Started.';
  store.logEvent({ type: 'campaign', note: 'Campaign started (dryRun=' + config().dryRun + ').' });
  clearTimeout(runner.timer);
  tick();
  return status();
}

function pause() {
  runner.paused = true;
  runner.running = false;
  clearTimeout(runner.timer);
  runner.reason = 'Paused by operator.';
  store.logEvent({ type: 'campaign', note: 'Campaign paused.' });
  return status();
}

function status() {
  const c = config();
  return {
    configured: isConfigured(),
    dryRun: c.dryRun,
    running: runner.running,
    paused: runner.paused,
    reason: runner.reason,
    startedAt: runner.startedAt,
    lastTickAt: runner.lastTickAt,
    lastMessage: runner.lastMessage,
    numbers: c.numbers,
    dailyLimitPerNumber: c.dailyLimitPerNumber,
    pacingSeconds: [Math.round(c.minDelayMs / 1000), Math.round(c.maxDelayMs / 1000)],
    quietHours: [c.quietStartHour, c.quietEndHour],
    aiPersonalize: c.aiPersonalize,
    numberUsageToday: c.numbers.map(n => ({ number: n, sent: store.sentTodayByNumber(n) })),
    stats: store.stats()
  };
}

// ---- CSV import -----------------------------------------------------------

// Minimal RFC-4180-ish parser: handles quoted fields, escaped quotes, CRLF.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch === '\r') { /* skip, handled by \n */ }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

// Header aliases so real-world spreadsheets import without renaming columns.
const FIELD_ALIASES = {
  firstName: ['first_name', 'firstname', 'first name', 'first', 'name', 'contact'],
  phone: ['phone', 'phone_number', 'phonenumber', 'mobile', 'cell', 'number', 'tel'],
  businessName: ['business_name', 'businessname', 'business', 'company', 'company_name', 'org'],
  city: ['city', 'town', 'location'],
  customNote: ['custom_note', 'note', 'notes', 'comment', 'detail'],
  timezone: ['timezone', 'tz', 'time_zone']
};

function importCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return { added: 0, updated: 0, skipped: 0, invalid: 0, error: 'No data rows found.' };
  const header = rows[0].map(h => h.trim().toLowerCase());
  const colOf = (field) => {
    for (const alias of FIELD_ALIASES[field]) {
      const idx = header.indexOf(alias);
      if (idx !== -1) return idx;
    }
    return -1;
  };
  const idx = {};
  for (const f of Object.keys(FIELD_ALIASES)) idx[f] = colOf(f);
  if (idx.phone === -1) return { added: 0, updated: 0, skipped: 0, invalid: 0, error: 'CSV must have a phone column.' };

  const parsed = [];
  let invalid = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const phone = normalizePhone((r[idx.phone] || '').trim());
    if (!phone) { invalid++; continue; }
    parsed.push({
      phone,
      firstName: idx.firstName !== -1 ? (r[idx.firstName] || '').trim() : '',
      businessName: idx.businessName !== -1 ? (r[idx.businessName] || '').trim() : '',
      city: idx.city !== -1 ? (r[idx.city] || '').trim() : '',
      customNote: idx.customNote !== -1 ? (r[idx.customNote] || '').trim() : '',
      timezone: idx.timezone !== -1 ? (r[idx.timezone] || '').trim() : ''
    });
  }
  const result = store.upsertContacts(parsed);
  return { ...result, invalid };
}

module.exports = {
  config, isConfigured, normalizePhone, timezoneForContact, withinQuietHours,
  validateTwilioSignature, personalizeOptIn, handleInbound,
  start, pause, status, importCsv, twilioSend
};
