const crypto = require('crypto');

/** Replaces {{key}} with values. Unknown keys become ''. Returns { text, missing }. */
function render(template, vars) {
  const missing = [];
  const text = String(template || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => {
    const v = vars[k];
    if (v === undefined || v === null || v === '') {
      missing.push(k);
      return '';
    }
    return String(v);
  });
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), missing };
}

function firstName(name, email) {
  const n = String(name || '').trim();
  if (n) return n.split(/\s+/)[0].replace(/[^\p{L}'-]/gu, '') || 'there';
  return 'there';
}

/** Constant-time comparison of two hex/base64 strings. */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ab.length === bb.length && ab.length > 0 && crypto.timingSafeEqual(ab, bb);
}

function hmacHex(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Lead webhook signature: header X-Signature: t=<unix seconds>,v1=<hex hmac of "<t>.<raw body>">
 * Rejects anything older than toleranceSec.
 */
function verifyTimestampedSignature(secret, rawBody, headerValue, nowSec = Math.floor(Date.now() / 1000), toleranceSec = 300) {
  if (!secret || !headerValue) return false;
  const parts = Object.fromEntries(
    String(headerValue)
      .split(',')
      .map((p) => p.trim().split('='))
      .filter((p) => p.length === 2)
  );
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(nowSec - t) > toleranceSec) return false;
  return safeEqual(hmacHex(secret, `${t}.${rawBody}`), parts.v1);
}

function signTimestamped(secret, rawBody, nowSec = Math.floor(Date.now() / 1000)) {
  return `t=${nowSec},v1=${hmacHex(secret, `${nowSec}.${rawBody}`)}`;
}

/** Local parts (y, m, d, hour, weekday) of a Date in an IANA timezone. */
function localParts(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, weekday, dateKey: `${p.year}-${p.month}-${p.day}` };
}

function inBusinessHours(date, client) {
  const bh = client.businessHours || { start: 8, end: 18, days: [1, 2, 3, 4, 5] };
  const p = localParts(date, client.timezone || 'America/Chicago');
  return bh.days.includes(p.weekday) && p.hour >= bh.start && p.hour < bh.end;
}

/** Earliest moment >= date inside the client's business hours (15-minute steps, max 8 days). */
function nextBusinessTime(date, client) {
  let t = new Date(date.getTime());
  for (let i = 0; i < 8 * 24 * 4; i++) {
    if (inBusinessHours(t, client)) return t;
    t = new Date(t.getTime() + 15 * 60 * 1000);
    t.setUTCSeconds(0, 0);
  }
  return new Date(date.getTime());
}

function refCode(clientId, contactId) {
  return crypto.createHash('sha256').update(`${clientId}:${contactId}`).digest('base64url').slice(0, 8);
}

function formatMoney(cents) {
  const d = cents / 100;
  return '$' + (Number.isInteger(d) ? d.toLocaleString('en-US') : d.toLocaleString('en-US', { minimumFractionDigits: 2 }));
}

const STOP_RE = /^\s*(stop|unsubscribe|remove me|opt[\s-]?out|no thanks|not interested|please remove)\b/i;

function isOptOut(body) {
  const firstLines = String(body || '')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith('>'))
    .slice(0, 2)
    .join(' ');
  return STOP_RE.test(firstLines) && firstLines.length < 200;
}

/** Strips quoted history so the model sees the new message first. */
function newestPart(body) {
  const lines = String(body || '').split(/\r?\n/);
  const out = [];
  for (const l of lines) {
    if (/^On .+wrote:\s*$/.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l.trim())) break;
    if (l.trim().startsWith('>')) continue;
    out.push(l);
  }
  return out.join('\n').trim();
}

module.exports = {
  render,
  firstName,
  safeEqual,
  hmacHex,
  verifyTimestampedSignature,
  signTimestamped,
  localParts,
  inBusinessHours,
  nextBusinessTime,
  refCode,
  formatMoney,
  isOptOut,
  newestPart,
};
