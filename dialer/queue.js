// Cold-call queue: who comes up next, what each outcome does to a lead,
// imports with de-duplication, and the daily scoreboard.

const store = require('./store');
const { normalizeRecord, firstNameOf, looksGarbled } = require('./parse');
const clean = require('./clean');
const prospects = require('./prospects');

// ---- Outcomes ----------------------------------------------------------------
// kind: retry  -> comes back after retryDays until maxAttempts, then 'exhausted'
//       scheduled -> comes back at the chosen date/time
//       pipeline  -> stays in the pipeline list (comes back if a follow-up date is set)
//       closed    -> never served again
const OUTCOMES = {
  no_answer:      { label: 'No Answer',      kind: 'retry',     conversation: false },
  voicemail:      { label: 'Left Voicemail', kind: 'retry',     conversation: false },
  gatekeeper:     { label: 'Gatekeeper',     kind: 'retry',     conversation: false },
  callback:       { label: 'Call Back',      kind: 'scheduled', conversation: true },
  interested:     { label: 'Interested',     kind: 'pipeline',  conversation: true },
  meeting_booked: { label: 'Meeting Booked', kind: 'pipeline',  conversation: true },
  closed_won:     { label: 'Closed - Won',   kind: 'closed',    conversation: true },
  not_interested: { label: 'Not Interested', kind: 'closed',    conversation: true },
  bad_number:     { label: 'Bad Number',     kind: 'closed',    conversation: false },
  dnc:            { label: 'Do Not Call',    kind: 'closed',    conversation: true }
};
const RETRY_STATUSES = new Set(['no_answer', 'voicemail', 'gatekeeper']);
const TERMINAL = new Set(['closed_won', 'not_interested', 'bad_number', 'dnc', 'exhausted']);

// ---- Lead local time ---------------------------------------------------------
const STATE_TZ = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago',
  CA: 'America/Los_Angeles', CO: 'America/Denver', CT: 'America/New_York', DE: 'America/New_York',
  DC: 'America/New_York', FL: 'America/New_York', GA: 'America/New_York', HI: 'Pacific/Honolulu',
  ID: 'America/Boise', IL: 'America/Chicago', IN: 'America/Indiana/Indianapolis', IA: 'America/Chicago',
  KS: 'America/Chicago', KY: 'America/New_York', LA: 'America/Chicago', ME: 'America/New_York',
  MD: 'America/New_York', MA: 'America/New_York', MI: 'America/Detroit', MN: 'America/Chicago',
  MS: 'America/Chicago', MO: 'America/Chicago', MT: 'America/Denver', NE: 'America/Chicago',
  NV: 'America/Los_Angeles', NH: 'America/New_York', NJ: 'America/New_York', NM: 'America/Denver',
  NY: 'America/New_York', NC: 'America/New_York', ND: 'America/Chicago', OH: 'America/New_York',
  OK: 'America/Chicago', OR: 'America/Los_Angeles', PA: 'America/New_York', RI: 'America/New_York',
  SC: 'America/New_York', SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago',
  UT: 'America/Denver', VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles',
  WV: 'America/New_York', WI: 'America/Chicago', WY: 'America/Denver', PR: 'America/Puerto_Rico'
};
const DEFAULT_TZ = process.env.DIALER_DEFAULT_TZ || 'America/New_York';

function leadTimezone(lead) { return STATE_TZ[lead.state] || DEFAULT_TZ; }

function localParts(tz, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', weekday: 'short', hour12: false }).formatToParts(date);
  const get = t => (parts.find(p => p.type === t) || {}).value;
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0;
  return { hour, minute: Number(get('minute')), weekday: get('weekday') };
}

function localTimeLabel(lead) {
  return new Intl.DateTimeFormat('en-US', { timeZone: leadTimezone(lead), hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date());
}

// Cached per timezone for one queue pass (5,000 leads share a handful of zones).
function windowChecker(s) {
  const cache = new Map();
  return lead => {
    if (!s.enforceCallWindow) return true;
    const tz = leadTimezone(lead);
    if (!cache.has(tz)) {
      const { hour, weekday } = localParts(tz);
      cache.set(tz, weekday !== 'Sat' && weekday !== 'Sun' && hour >= s.callWindowStart && hour < s.callWindowEnd);
    }
    return cache.get(tz);
  };
}

// ---- Filters -----------------------------------------------------------------
function matchesFilters(lead, f) {
  if (!f) return true;
  if (f.source && !(lead.sources || []).includes(f.source)) return false;
  if (f.state && lead.state !== f.state) return false;
  // Compared by canonical spelling so "Saint Louis" and "ST. LOUIS" are one city.
  if (f.city && clean.normalizeCity(lead.city).toLowerCase() !== clean.normalizeCity(f.city).toLowerCase()) return false;
  if (f.county && clean.normalizeCounty(lead.county).toLowerCase() !== clean.normalizeCounty(f.county).toLowerCase()) return false;
  if (f.ethnicity && clean.normalizeOwnerEthnicity(lead.ownerEthnicity) !== clean.normalizeOwnerEthnicity(f.ethnicity)) return false;
  if (f.keyword) {
    const k = String(f.keyword).toLowerCase();
    const hay = [lead.businessName, lead.industry, lead.codes, lead.certification, lead.city].join(' ').toLowerCase();
    if (!hay.includes(k)) return false;
  }
  return true;
}

// ---- Next lead -----------------------------------------------------------------
function nextLead(filters = {}, excludeIds = []) {
  const s = store.settings();
  const now = Date.now();
  const exclude = new Set(excludeIds);
  const leads = store.allLeads().filter(l => !exclude.has(l.id) && l.phoneDigits && !l.callBlocked && matchesFilters(l, filters));
  const snoozed = l => l.snoozeUntil && Date.parse(l.snoozeUntil) > now;
  const inWindow = windowChecker(s);
  const callable = l => !snoozed(l) && inWindow(l);

  // 1. Callbacks / follow-ups that are due (ignore the call window: you promised a time).
  const due = leads
    .filter(l => !TERMINAL.has(l.status) && l.callbackAt && Date.parse(l.callbackAt) <= now + 5 * 60 * 1000 && !snoozed(l))
    .sort((a, b) => Date.parse(a.callbackAt) - Date.parse(b.callbackAt));
  if (due.length) return pack(due[0], 'callback_due', counts(leads, s));

  // 1b. Someone who just answered our email (or clicked the booking link): call them next.
  const hot = leads
    .filter(l => !TERMINAL.has(l.status) && l.status !== 'meeting_booked' && l.priorityAt && (!l.priorityHandledAt || Date.parse(l.priorityAt) > Date.parse(l.priorityHandledAt)) && !snoozed(l))
    .sort((a, b) => Date.parse(a.priorityAt) - Date.parse(b.priorityAt));
  if (hot.length) return pack(hot[0], 'email_reply', counts(leads, s));

  // 2. Retries whose wait is over.
  const retries = leads
    .filter(l => RETRY_STATUSES.has(l.status) && (l.attempts || 0) < s.maxAttempts && (!l.nextAttemptAt || Date.parse(l.nextAttemptAt) <= now) && callable(l))
    .sort((a, b) => Date.parse(a.nextAttemptAt || 0) - Date.parse(b.nextAttemptAt || 0));
  if (retries.length) return pack(retries[0], 'retry', counts(leads, s));

  // 3. A random fresh lead.
  const freshAll = leads.filter(l => l.status === 'new' && callable(l));
  const clean = freshAll.filter(l => !looksGarbled(l));
  const fresh = clean.length ? clean : freshAll;   // garbled names only when nothing clean is left
  if (fresh.length) return pack(fresh[Math.floor(Math.random() * fresh.length)], 'new', counts(leads, s));

  return { lead: null, reason: emptyReason(leads, s), queue: counts(leads, s) };
}

function emptyReason(leads, s) {
  if (!store.allLeads().length) return 'No leads yet. Import a list to start.';
  if (!leads.length) return 'No leads match these filters.';
  const fresh = leads.filter(l => l.status === 'new').length;
  if (fresh && s.enforceCallWindow) return 'Every remaining lead is outside its local calling hours (' + s.callWindowStart + ':00-' + s.callWindowEnd + ':00, weekdays). Turn off the call window in Settings to keep going.';
  return 'Queue is empty for these filters. Import more leads or widen the filters.';
}

function counts(leads, s) {
  const now = Date.now();
  let fresh = 0, retryLater = 0, callbacks = 0;
  for (const l of leads) {
    if (l.status === 'new') fresh++;
    else if (RETRY_STATUSES.has(l.status) && (l.attempts || 0) < s.maxAttempts) retryLater++;
    if (l.callbackAt && !TERMINAL.has(l.status)) callbacks++;
  }
  return { fresh, retryLater, callbacks, matching: leads.length };
}

function pack(lead, reason, queue) {
  return { lead: view(lead), reason, queue };
}

function view(lead) {
  const calls = store.load().calls.filter(c => c.leadId === lead.id).slice(-25).reverse();
  return { ...lead, localTime: localTimeLabel(lead), timezone: leadTimezone(lead), calls };
}

// ---- Logging an outcome --------------------------------------------------------
function logOutcome(leadId, { outcome, note, callbackAt, meetingAt, amount, durationSec }) {
  const lead = store.getLead(leadId);
  if (!lead) throw new Error('Lead not found');
  const def = OUTCOMES[outcome];
  if (!def) throw new Error('Unknown outcome: ' + outcome);
  const s = store.settings();
  const now = new Date();

  if (def.kind === 'scheduled' && !callbackAt) throw new Error('Pick a call-back date and time.');

  lead.attempts = (lead.attempts || 0) + 1;
  lead.lastCalledAt = now.toISOString();
  lead.lastOutcome = outcome;
  lead.snoozeUntil = null;
  lead.status = outcome;

  if (def.kind === 'retry') {
    const days = outcome === 'gatekeeper' ? s.gatekeeperRetryDays : s.retryDays;
    lead.nextAttemptAt = new Date(now.getTime() + days * 86400000).toISOString();
    lead.callbackAt = callbackAt ? new Date(callbackAt).toISOString() : null;
    if (lead.attempts >= s.maxAttempts && !lead.callbackAt) lead.status = 'exhausted';
  } else if (def.kind === 'scheduled') {
    lead.callbackAt = new Date(callbackAt).toISOString();
    lead.nextAttemptAt = null;
  } else if (def.kind === 'pipeline') {
    lead.callbackAt = callbackAt ? new Date(callbackAt).toISOString() : null;
    if (meetingAt) lead.meetingAt = new Date(meetingAt).toISOString();
    lead.nextAttemptAt = null;
  } else {
    lead.callbackAt = null;
    lead.nextAttemptAt = null;
    if (outcome === 'closed_won' && amount) lead.amount = Number(amount) || 0;
  }

  const call = {
    id: store.newId(), leadId, at: now.toISOString(), outcome,
    note: String(note || '').trim(), durationSec: Number(durationSec) || 0,
    callbackAt: lead.callbackAt || null, meetingAt: lead.meetingAt || null
  };
  store.addCall(call);
  if (lead.priorityAt) lead.priorityHandledAt = now.toISOString();   // you acted on the email signal
  store.touch(lead);
  store.save();
  prospects.onOutcome(lead, outcome, { callbackAt: lead.callbackAt });
  return { lead: view(lead), call };
}

function addNote(leadId, note) {
  const lead = store.getLead(leadId);
  if (!lead) throw new Error('Lead not found');
  const call = { id: store.newId(), leadId, at: new Date().toISOString(), outcome: 'note', note: String(note || '').trim(), durationSec: 0 };
  if (!call.note) throw new Error('Note is empty.');
  store.addCall(call);
  store.save();
  return { lead: view(lead), call };
}

function skip(leadId, hours = 4) {
  const lead = store.getLead(leadId);
  if (!lead) throw new Error('Lead not found');
  lead.snoozeUntil = new Date(Date.now() + hours * 3600000).toISOString();
  store.touch(lead);
  store.save();
  return { ok: true };
}

function updateLead(leadId, patch) {
  const lead = store.getLead(leadId);
  if (!lead) throw new Error('Lead not found');
  const editable = ['businessName', 'contactName', 'email', 'website', 'phoneAlt', 'address', 'city', 'state', 'zip', 'industry'];
  for (const k of editable) if (patch[k] !== undefined) lead[k] = String(patch[k]).trim();
  if (patch.contactName !== undefined) lead.firstName = firstNameOf(lead.contactName);
  if (patch.city !== undefined) lead.city = clean.normalizeCity(lead.city);
  store.touch(lead);
  store.save();
  return view(lead);
}

// ---- Import ----------------------------------------------------------------------
// De-dupe on the 10-digit phone number. A lead that already exists keeps its
// status, attempts and notes (so a Do Not Call stays Do Not Call forever); the
// new list only fills blank fields and adds its source tag.
function importRecords(records, mapping, { source, defaultState }) {
  const now = new Date().toISOString();
  let added = 0, merged = 0, noPhone = 0, dupInFile = 0, repaired = 0;
  const seenInFile = new Set();
  for (const rec of records) {
    const n = normalizeRecord(rec, mapping, { defaultState });
    if (!n.phoneDigits) { noPhone++; continue; }
    const repeatInFile = seenInFile.has(n.phoneDigits);
    seenInFile.add(n.phoneDigits);
    const existing = store.leadByPhone(n.phoneDigits);
    if (existing) {
      // An earlier import left this lead with a garbled name; this row is clean, so
      // take its name/location/contact fields. Calls, notes, status and ids stay.
      if (looksGarbled(existing) && !looksGarbled(n)) {
        for (const k of ['businessName', 'contactName', 'firstName', 'city', 'state', 'zip', 'county', 'address', 'industry', 'codes', 'website', 'email']) {
          if (n[k]) existing[k] = n[k];
        }
        repaired++;
        try { require('./ai-script').invalidate(existing.id); } catch {}
      }
      for (const [k, v] of Object.entries(n)) {
        if (k === 'extra') existing.extra = { ...v, ...(existing.extra || {}) };
        else if (v && !existing[k]) existing[k] = v;
      }
      existing.sources = [...new Set([...(existing.sources || []), source])];
      store.touch(existing);
      if (repeatInFile) dupInFile++; else merged++;
      continue;
    }
    store.addLead({
      id: store.newId(), ...n, sources: [source], status: 'new', attempts: 0,
      createdAt: now, lastCalledAt: null, nextAttemptAt: null, callbackAt: null, snoozeUntil: null
    });
    added++;
  }
  // Fill blank counties (from the leads' own city/ZIP data) and clear any flag text the file carried in.
  const cleaned = clean.cleanAll(store.allLeads());
  for (const l of cleaned.changed) store.touch(l);
  const entry = { at: now, source, records: records.length, added, alreadyInDialer: merged, duplicatesInFile: dupInFile, skippedNoPhone: noPhone, repaired, countiesFilled: cleaned.stats.countiesFilled };
  store.load().imports.push(entry);
  store.save();
  return entry;
}

// ---- Scoreboard ------------------------------------------------------------------
function dayKey(iso, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

function stats(tz = process.env.DIALER_USER_TZ || 'America/Chicago') {
  const s = store.settings();
  const calls = store.load().calls.filter(c => c.outcome !== 'note');
  const today = dayKey(new Date().toISOString(), tz);
  const days = {};
  for (const c of calls) {
    const k = dayKey(c.at, tz);
    const d = days[k] || (days[k] = { day: k, dials: 0, conversations: 0, meetings: 0, wins: 0, talkSec: 0, outcomes: {} });
    d.dials++;
    if (OUTCOMES[c.outcome] && OUTCOMES[c.outcome].conversation) d.conversations++;
    if (c.outcome === 'meeting_booked') d.meetings++;
    if (c.outcome === 'closed_won') d.wins++;
    d.talkSec += c.durationSec || 0;
    d.outcomes[c.outcome] = (d.outcomes[c.outcome] || 0) + 1;
  }
  const history = Object.values(days).sort((a, b) => b.day.localeCompare(a.day)).slice(0, 14);
  const total = calls.reduce((t, c) => {
    t.dials++;
    if (OUTCOMES[c.outcome] && OUTCOMES[c.outcome].conversation) t.conversations++;
    if (c.outcome === 'meeting_booked') t.meetings++;
    if (c.outcome === 'closed_won') t.wins++;
    return t;
  }, { dials: 0, conversations: 0, meetings: 0, wins: 0 });
  const leads = store.allLeads();
  const byStatus = {};
  for (const l of leads) byStatus[l.status] = (byStatus[l.status] || 0) + 1;
  return {
    today: days[today] || { day: today, dials: 0, conversations: 0, meetings: 0, wins: 0, talkSec: 0, outcomes: {} },
    dailyGoal: s.dailyGoal, history, total,
    ratios: {
      dialsPerConversation: total.conversations ? +(total.dials / total.conversations).toFixed(1) : null,
      dialsPerMeeting: total.meetings ? +(total.dials / total.meetings).toFixed(1) : null,
      dialsPerWin: total.wins ? +(total.dials / total.wins).toFixed(1) : null
    },
    leads: { total: leads.length, byStatus }
  };
}

// ---- Pipeline, search, filter options ----------------------------------------------
function pipeline() {
  const wanted = new Set(['callback', 'interested', 'meeting_booked', 'closed_won']);
  return store.allLeads()
    .filter(l => wanted.has(l.status) || (l.callbackAt && !TERMINAL.has(l.status)))
    .map(l => {
      const last = store.load().calls.filter(c => c.leadId === l.id && c.note).slice(-1)[0];
      return { id: l.id, businessName: l.businessName, contactName: l.contactName, phone: l.phone, status: l.status, callbackAt: l.callbackAt, meetingAt: l.meetingAt || null, amount: l.amount || null, lastCalledAt: l.lastCalledAt, lastNote: last ? last.note : '' };
    })
    .sort((a, b) => Date.parse(a.callbackAt || a.meetingAt || '2999-01-01') - Date.parse(b.callbackAt || b.meetingAt || '2999-01-01'));
}

function search(q) {
  const k = String(q || '').toLowerCase().trim();
  if (!k) return [];
  const digits = k.replace(/\D/g, '');
  return store.allLeads().filter(l =>
    (digits.length >= 4 && l.phoneDigits.includes(digits)) ||
    String(l.businessName).toLowerCase().includes(k) ||
    String(l.contactName).toLowerCase().includes(k) ||
    String(l.email).toLowerCase().includes(k)
  ).slice(0, 25).map(l => ({ id: l.id, businessName: l.businessName, contactName: l.contactName, phone: l.phone, city: l.city, state: l.state, status: l.status }));
}

function leadView(id) {
  const l = store.getLead(id);
  return l ? view(l) : null;
}

// Counts of leads with garbled names, by source list, so bad imports can be found.
function dataQuality() {
  const bySource = {};
  let garbled = 0, noName = 0;
  for (const l of store.allLeads()) {
    if (!l.businessName) noName++;
    if (looksGarbled(l)) { garbled++; for (const s of (l.sources || ['(none)'])) bySource[s] = (bySource[s] || 0) + 1; }
  }
  return { total: store.allLeads().length, garbled, noName, garbledBySource: bySource };
}

function filterOptions() {
  const leads = store.allLeads();
  const tally = key => {
    const m = {};
    for (const l of leads) {
      const vals = key === 'sources' ? (l.sources || []) : [key === 'city' ? clean.normalizeCity(l.city) : key === 'county' ? clean.normalizeCounty(l.county) : key === 'ownerEthnicity' ? clean.normalizeOwnerEthnicity(l.ownerEthnicity) : l[key]];
      for (const v of vals) if (v) m[v] = (m[v] || 0) + 1;
    }
    return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
  };
  return { sources: tally('sources'), states: tally('state'), cities: tally('city').slice(0, 150), counties: tally('county').slice(0, 100), ethnicities: tally('ownerEthnicity') };
}

module.exports = {
  OUTCOMES, nextLead, logOutcome, addNote, skip, updateLead, importRecords,
  stats, pipeline, search, leadView, filterOptions, leadTimezone, dataQuality
};
