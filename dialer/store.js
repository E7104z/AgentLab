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
    'Thanks for taking a minute on the phone today. As promised, here is the short version:\n\n' +
    'I build simple custom software for small businesses - booking, intake, scheduling, follow-up and the busywork in between - ' +
    'for $500 up front plus $30 a month.\n\n' +
    'You can see examples at {{website}}.{{bookingLine}}\n\n' +
    'Jason Griffin\n{{senderCompany}}',
  script: [
    'OPENER',
    'Hi, is this {{firstName}}? This is Jason Griffin with The Real Help. I know I\'m catching you in the middle of your day - can I have 30 seconds to tell you why I called, and you can tell me if it\'s worth talking more?',
    '',
    'REASON FOR THE CALL',
    'I came across {{businessName}} on a list of certified businesses in the area. I build simple custom apps for small businesses - things like online booking, client intake, scheduling, invoices and follow-up texts and emails - so owners stop doing that work by hand.',
    '',
    'QUESTION (then listen)',
    'What\'s the one task in your week that eats the most time - the thing you wish just ran itself?',
    '',
    'PITCH',
    'That\'s exactly what I build. It\'s $500 to build it and $30 a month to keep it running and supported.',
    '',
    'CLOSE - pick one',
    'A) Book: Let\'s do a 15-minute screen-share so I can show you what that would look like for {{businessName}}. Does tomorrow or Thursday work better?',
    'B) Close now: If you want, I can lock in your build today - I\'ll email you the details and a payment link, and we get started.',
    '',
    'OBJECTIONS',
    'Send me something -> Happy to. What\'s the best email? And so I send the right thing - what would you want it to do first?',
    'Not interested -> Understood. Is that because you have something in place already, or the timing isn\'t right?',
    'No budget -> That\'s why it\'s $500, not $5,000. If it saves you two hours a week, it pays for itself in the first month.',
    'Already use software -> Good. Is there anything it doesn\'t do that you still handle by hand? That\'s usually where I come in.'
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
  cache.settings = { ...DEFAULT_SETTINGS, ...(cache.settings || {}) };
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
