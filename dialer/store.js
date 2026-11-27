const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Single-file JSON store for the Cold Call Dialer, same pattern as sms-store.js:
// dependency-free, atomic writes (temp file -> rename) so a crash mid-write can
// never corrupt the call history.
//
// IMPORTANT (Railway): the container filesystem is wiped on every redeploy.
// Mount a Railway Volume (e.g. at /data) and set DIALER_DATA_FILE=/data/dialer-data.json
// or every note and call outcome is lost on the next push.

const DATA_FILE = process.env.DIALER_DATA_FILE
  ? path.resolve(process.env.DIALER_DATA_FILE)
  : path.join(__dirname, '..', 'dialer-data.json');

const DEFAULT_SETTINGS = {
  dailyGoal: 60,
  maxAttempts: 3,          // no-answer / voicemail tries before a lead is retired
  retryDays: 2,            // wait before calling a no-answer / voicemail again
  gatekeeperRetryDays: 1,
  enforceCallWindow: true, // only serve leads inside their local calling hours
  callWindowStart: 9,      // lead's local time, 24h
  callWindowEnd: 17,
  callMethod: 'auto',      // auto | textnow-web | tel
  textnowUrl: 'https://www.textnow.com/messaging',
  bookingLink: '',
  crmSync: true,           // push Interested / Meeting Booked / Closed-Won leads into AgentLab's CRM
  crmClientId: 'default',  // which AgentLab client receives them
  aiScripts: true,         // personalized AI script per lead (needs ANTHROPIC_API_KEY)
  aiSearchFallback: true,  // web search when the lead has no reachable website (~1 cent each)
  aiDailyCap: 200,         // max AI scripts generated per day
  gmailAccount: 'info@thecdscloud.com', // Gmail / Calendar links open in this Google account
  senderName: 'Jason Griffin',
  senderCompany: 'The Real Help',
  website: 'https://www.therealhelp.com',
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
  scriptVersion: 2,
  script: [
    'OPENER',
    'Hi, is this {{firstName}}? This is Jason Griffin with The Real Help. I know I\'m catching you in the middle of your day - can I have 30 seconds to tell you why I called, and you can tell me if it\'s worth another minute?',
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
    'A) Book: Let\'s do 15 minutes on a screen-share so I can show you what that looks like for {{businessName}}. Does tomorrow or Thursday work better?',
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
let phoneIndex = null; // phoneDigits -> lead id

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    cache = EMPTY();
  }
  cache.leads = cache.leads || {};
  cache.calls = cache.calls || [];
  cache.imports = cache.imports || [];
  const savedScriptVersion = (cache.settings && cache.settings.scriptVersion) || 1;
  cache.settings = { ...DEFAULT_SETTINGS, ...(cache.settings || {}) };
  // One-time swap of the old single-offer defaults for the three-offer script/email,
  // only if the saved text is still the old default (never overwrites Jason's edits).
  if (savedScriptVersion < DEFAULT_SETTINGS.scriptVersion) {
    if (/on a list of certified businesses/.test(cache.settings.script || '')) cache.settings.script = DEFAULT_SETTINGS.script;
    if (/I build simple custom software for small businesses/.test(cache.settings.emailTemplate || '')) cache.settings.emailTemplate = DEFAULT_SETTINGS.emailTemplate;
    cache.settings.scriptVersion = DEFAULT_SETTINGS.scriptVersion;
  }
  cache.meta = cache.meta || { createdAt: new Date().toISOString() };
  rebuildIndex();
  return cache;
}

function rebuildIndex() {
  phoneIndex = new Map();
  for (const lead of Object.values(cache.leads)) {
    if (lead.phoneDigits) phoneIndex.set(lead.phoneDigits, lead.id);
  }
}

function save() {
  const data = load();
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, DATA_FILE);
}

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

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
}

function addCall(call) {
  load().calls.push(call);
}

function settings() { return load().settings; }
function updateSettings(patch) {
  const data = load();
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
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

module.exports = {
  DATA_FILE, DEFAULT_SETTINGS,
  load, save, newId,
  getLead, allLeads, leadByPhone, addLead, addCall,
  settings, updateSettings
};
