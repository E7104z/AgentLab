const fs = require('fs');
const path = require('path');

// Single-file JSON store, kept deliberately dependency-free to match the rest of
// Agent Lab. All writes are atomic (write temp -> rename) so a crash mid-write
// can never corrupt the campaign state. For 2k contacts this is plenty fast.

const DATA_FILE = process.env.SMS_DATA_FILE
  ? path.resolve(process.env.SMS_DATA_FILE)
  : path.join(__dirname, 'sms-data.json');

const EVENT_CAP = 1000; // most recent outbound/inbound events kept for the dashboard

const EMPTY = () => ({
  contacts: {},   // keyed by E.164 phone
  events: [],     // newest-first activity log (send / reply / opt-out ...)
  meta: { createdAt: new Date().toISOString() }
});

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!cache.contacts) cache.contacts = {};
    if (!cache.events) cache.events = [];
    if (!cache.meta) cache.meta = { createdAt: new Date().toISOString() };
  } catch {
    cache = EMPTY();
  }
  return cache;
}

function save() {
  const data = load();
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// ---- Contacts -------------------------------------------------------------

function getContact(phone) {
  return load().contacts[phone] || null;
}

function allContacts() {
  return Object.values(load().contacts);
}

/**
 * Insert new contacts or refresh the mergeable fields of existing ones.
 * Never downgrades consent state: an existing opted_in / opted_out contact
 * keeps its status even if re-imported.
 */
function upsertContacts(rows) {
  const data = load();
  let added = 0, updated = 0, skipped = 0;
  for (const row of rows) {
    if (!row.phone) { skipped++; continue; }
    const existing = data.contacts[row.phone];
    if (existing) {
      existing.firstName = row.firstName || existing.firstName;
      existing.businessName = row.businessName || existing.businessName;
      existing.city = row.city || existing.city;
      existing.customNote = row.customNote || existing.customNote;
      if (row.timezone) existing.timezone = row.timezone;
      updated++;
    } else {
      data.contacts[row.phone] = {
        phone: row.phone,
        firstName: row.firstName || '',
        businessName: row.businessName || '',
        city: row.city || '',
        customNote: row.customNote || '',
        timezone: row.timezone || '',
        status: 'new',            // new -> invited -> opted_in | opted_out | failed
        generatedMessage: '',
        numberUsed: '',
        attempts: 0,
        invitedAt: null,
        optedInAt: null,
        optedOutAt: null,
        lastError: '',
        replies: [],
        createdAt: new Date().toISOString()
      };
      added++;
    }
  }
  save();
  return { added, updated, skipped };
}

function updateContact(phone, patch) {
  const data = load();
  const c = data.contacts[phone];
  if (!c) return null;
  Object.assign(c, patch);
  save();
  return c;
}

// ---- Events ---------------------------------------------------------------

function logEvent(event) {
  const data = load();
  data.events.unshift({ time: new Date().toISOString(), ...event });
  if (data.events.length > EVENT_CAP) data.events = data.events.slice(0, EVENT_CAP);
  save();
}

function recentEvents(limit = 100) {
  return load().events.slice(0, limit);
}

// ---- Derived stats --------------------------------------------------------

function todayKey(tz) {
  // YYYY-MM-DD in the given tz (defaults to server tz) for daily-cap accounting.
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** How many outbound messages a given number has sent today (server-local day). */
function sentTodayByNumber(number) {
  const day = todayKey();
  return load().events.filter(e =>
    e.type === 'outbound' && e.number === number && (e.time || '').slice(0, 10) === day
  ).length;
}

function stats() {
  const contacts = allContacts();
  const by = { new: 0, invited: 0, opted_in: 0, opted_out: 0, failed: 0 };
  for (const c of contacts) by[c.status] = (by[c.status] || 0) + 1;
  return {
    total: contacts.length,
    ...by,
    sentToday: load().events.filter(e =>
      e.type === 'outbound' && (e.time || '').slice(0, 10) === todayKey()
    ).length
  };
}

function resetAll() {
  cache = EMPTY();
  save();
}

module.exports = {
  DATA_FILE, load, save,
  getContact, allContacts, upsertContacts, updateContact,
  logEvent, recentEvents,
  sentTodayByNumber, stats, resetAll
};
