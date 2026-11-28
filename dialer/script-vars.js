// Per-lead values for the call script, the voicemail and the follow-up email.

const USER_TZ = () => process.env.DIALER_USER_TZ || 'America/Chicago';

function ymdInTz(date, tz) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const g = t => Number(p.find(x => x.type === t).value);
  return { y: g('year'), m: g('month'), d: g('day') };
}

// The next `count` weekdays after today (in Jason's time zone), as calendar dates.
function nextBusinessDays(now = new Date(), count = 2, tz = USER_TZ()) {
  const { y, m, d } = ymdInTz(now, tz);
  const cur = new Date(Date.UTC(y, m - 1, d, 12));     // noon UTC: no DST edge cases
  const out = [];
  while (out.length < count) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    const wd = cur.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(new Date(cur));
  }
  return out;
}

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "tomorrow" when it really is tomorrow, otherwise "Monday, Nov 30".
function dayLabel(day, now = new Date(), tz = USER_TZ()) {
  const t = ymdInTz(now, tz);
  const tomorrow = new Date(Date.UTC(t.y, t.m - 1, t.d, 12)); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  if (day.getUTCFullYear() === tomorrow.getUTCFullYear() && day.getUTCMonth() === tomorrow.getUTCMonth() && day.getUTCDate() === tomorrow.getUTCDate()) return 'tomorrow';
  return WEEKDAY[day.getUTCDay()] + ', ' + MONTH[day.getUTCMonth()] + ' ' + day.getUTCDate();
}

function offeredDays(now = new Date(), tz = USER_TZ()) {
  const [a, b] = nextBusinessDays(now, 2, tz);
  return [dayLabel(a, now, tz), dayLabel(b, now, tz)];
}

const VM_REASON = {
  1: 'I am a small business consultant, starting with tech, like websites that get your phone ringing.',
  2: 'I am a small business consultant, starting with tech, like answering every web inquiry in two minutes.',
  3: 'I am a small business consultant, starting with tech, like turning estimate paperwork into one simple form.',
  0: 'I am a consultant who helps small businesses with whatever they need, starting with tech.'
};

function voicemailNumber(s) { return String(s.callbackNumber || '').trim(); }

function templateVars(lead, s, { ai, now } = {}) {
  const first = lead.firstName || '';
  const [dayOne, dayTwo] = offeredDays(now || new Date());
  const offer = ai && [1, 2, 3].includes(ai.offer) ? ai.offer : 0;
  const number = voicemailNumber(s);
  return {
    firstName: first || 'there',
    // "Hi, is this the owner of Acme Plumbing?" when we have no name to ask for.
    ownerAsk: first || ('the owner of ' + (lead.businessName || 'the business')),
    greeting: first ? 'Hi ' + first : 'Hello',
    businessName: lead.businessName || 'your business',
    contactName: lead.contactName || '',
    city: lead.city || '',
    source: (lead.sources || [])[0] || 'certified vendor',
    website: s.website || '',
    bookingLink: s.bookingLink || '',
    bookingLine: s.bookingLink ? '\n\nIf it is easier, grab a 15-minute time here: ' + s.bookingLink : '',
    senderName: s.senderName || '',
    senderCompany: s.senderCompany || '',
    dayOne, dayTwo,
    vmReason: VM_REASON[offer],
    callbackNumber: number || '[your Google Voice number - add it in Settings]'
  };
}

function fillTemplate(template, vars) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

// The 20-second voicemail: who you are, one reason, your number twice.
function voicemail(lead, s, ai) {
  const vars = templateVars(lead || {}, s, { ai });
  const text = fillTemplate(s.voicemailScript, vars).replace(/\s+/g, ' ').trim();
  return { text, words: text.split(/\s+/).length, numberSet: Boolean(voicemailNumber(s)) };
}

module.exports = { nextBusinessDays, dayLabel, offeredDays, templateVars, fillTemplate, voicemail };
