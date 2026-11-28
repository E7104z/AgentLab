// Shared prospect logic: one opt-out list for phone and email, outcome-driven email actions,
// email signals that move the call queue, booking matching, one timeline, one funnel, and the
// daily limits. Everything here is a no-op on the file backend (no Postgres, no email side).
//
// Contract with real-help-agent (cold email): docs/PROSPECTS_CONTRACT.md

const crypto = require('crypto');
const store = require('./store');
const model = require('./prospect-model');

const db = () => store.pgHandle();
const eid = () => 'ev_' + crypto.randomBytes(8).toString('hex');
const digits = p => String(p || '').replace(/\D/g, '').slice(-10);
const lc = e => String(e || '').trim().toLowerCase();

// ---- Opt-out rules -----------------------------------------------------------
//   dnc, not_interested : block email AND phone
//   unsubscribe, complaint, manual-email : block email, flag phone (still callable, shown on the call screen)
//   bounce : email address is bad, phone untouched
const RULES = {
  dnc:            { block_email: true,  block_phone: true,  flag_phone: false, bad_email: false },
  not_interested: { block_email: true,  block_phone: true,  flag_phone: false, bad_email: false },
  unsubscribe:    { block_email: true,  block_phone: false, flag_phone: true,  bad_email: false },
  complaint:      { block_email: true,  block_phone: false, flag_phone: true,  bad_email: false },
  bounce:         { block_email: false, block_phone: false, flag_phone: false, bad_email: true  },
};

function leadsMatching({ email, phone }) {
  const e = lc(email), d = digits(phone);
  if (!e && !d) return [];
  return store.allLeads().filter(l => (e && lc(l.email) === e) || (d && l.phoneDigits === d));
}

// Record an opt-out once and apply it everywhere it reaches. Safe to call repeatedly.
async function applyOptOut({ email, phone, reason, source = 'dialer' }) {
  const rule = RULES[reason];
  if (!rule) throw new Error('Unknown opt-out reason: ' + reason);
  const e = lc(email) || null, d = digits(phone) || null;
  if (!e && !d) return { ok: false, skipped: 'no email or phone' };
  const affected = leadsMatching({ email: e, phone: d });
  for (const l of affected) {
    if (rule.block_phone) l.callBlocked = true;
    if (rule.flag_phone) l.emailOptOut = true;
    if (rule.block_email || rule.bad_email) l.emailState = rule.bad_email ? 'bounced' : 'suppressed';
    store.touch(l);
  }
  if (affected.length) store.save();
  const pg = db();
  if (!pg) return { ok: true, affected: affected.length, lists: 'memory only' };
  for (const [col, val] of [['email', e], ['phone_digits', d]]) {
    if (!val) continue;
    await pg.query(
      `INSERT INTO opt_outs (${col}, reason, block_email, block_phone, flag_phone, bad_email, source) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (${col}) WHERE ${col} IS NOT NULL DO UPDATE SET
         block_email = opt_outs.block_email OR EXCLUDED.block_email, block_phone = opt_outs.block_phone OR EXCLUDED.block_phone,
         flag_phone = opt_outs.flag_phone OR EXCLUDED.flag_phone, bad_email = opt_outs.bad_email OR EXCLUDED.bad_email,
         reason = CASE WHEN EXCLUDED.block_email OR EXCLUDED.block_phone THEN EXCLUDED.reason ELSE opt_outs.reason END`,
      [val, reason, rule.block_email, rule.block_phone, rule.flag_phone, rule.bad_email, source]);
  }
  await store.flush().catch(() => {});
  await pg.query(
    `UPDATE prospects SET
        email_state = CASE WHEN $3 THEN 'suppressed' WHEN $4 AND email_state <> 'suppressed' THEN 'bounced' ELSE email_state END,
        call_blocked = call_blocked OR $5,
        stage = CASE WHEN $3 OR $5 THEN 'suppressed' ELSE stage END,
        pending_touch = CASE WHEN $3 OR $4 OR $5 THEN NULL ELSE pending_touch END
      WHERE ($1::text IS NOT NULL AND email = $1) OR ($2::text IS NOT NULL AND phone_digits = $2)`,
    [e, d, rule.block_email, rule.bad_email, rule.block_phone]);
  for (const l of affected) await logEvent(l.id, { channel: 'system', kind: 'opt_out', summary: 'Opt-out recorded (' + reason + ') from ' + source, source });
  return { ok: true, affected: affected.length };
}

// ---- Timeline ----------------------------------------------------------------
async function logEvent(prospectId, { channel, kind, summary, source = 'dialer', data = null, at = null }) {
  const pg = db();
  if (!pg || !prospectId) return null;
  const id = eid();
  await pg.query('INSERT INTO prospect_events (id, prospect_id, at, channel, kind, summary, source, data) VALUES ($1,$2,COALESCE($3::timestamptz, now()),$4,$5,$6,$7,$8::jsonb)',
    [id, prospectId, at, channel, kind, summary || null, source, data ? JSON.stringify(data) : null]);
  return id;
}

async function timeline(leadId) {
  const calls = store.load().calls.filter(c => c.leadId === leadId)
    .map(c => ({ at: c.at, channel: 'call', kind: c.outcome, summary: c.note || '', source: 'dialer', durationSec: c.durationSec || 0 }));
  let events = [];
  const pg = db();
  if (pg) {
    events = (await pg.query("SELECT at, channel, kind, summary, source FROM prospect_events WHERE prospect_id = $1 AND channel <> 'call' ORDER BY at", [leadId]))
      .rows.map(r => ({ ...r, at: new Date(r.at).toISOString() }));
  }
  return [...calls, ...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

// ---- Outcome-driven email actions -----------------------------------------------
async function setEmailControls(leadId, sets) {
  const pg = db();
  if (!pg) return;
  await store.flush().catch(() => {});
  const cols = Object.keys(sets);
  await pg.query('UPDATE prospects SET ' + cols.map((c, i) => c + ' = $' + (i + 2)).join(', ') + ' WHERE id = $1', [leadId, ...cols.map(c => sets[c])]);
}

// Called after a call outcome is saved. Never throws into the call flow.
async function onOutcome(lead, outcome, { callbackAt } = {}) {
  try {
    const pg = db();
    const hasEmail = Boolean(lc(lead.email)) && !lead.emailOptOut && lead.emailState !== 'bounced' && lead.emailState !== 'suppressed';
    if (pg) await store.flush().catch(() => {});
    if (outcome === 'dnc' || outcome === 'not_interested') {
      await applyOptOut({ email: lead.email, phone: lead.phoneDigits, reason: outcome, source: 'dialer' });
      await setEmailControls(lead.id, { email_stop_reason: 'called-' + outcome, pending_touch: null });
    } else if (outcome === 'voicemail' && hasEmail && !lead.callBlocked) {
      await setEmailControls(lead.id, { pending_touch: 'missed_you' });
      await logEvent(lead.id, { channel: 'system', kind: 'queued_missed_you', summary: 'Voicemail left: "missed you" email queued with the booking link' });
    } else if (outcome === 'callback' && callbackAt) {
      await setEmailControls(lead.id, { email_hold_until: new Date(callbackAt).toISOString() });
      await logEvent(lead.id, { channel: 'system', kind: 'email_paused', summary: 'Cold email paused until the call-back' });
    } else if (outcome === 'interested') {
      await setEmailControls(lead.id, { email_stop_reason: 'interested', pending_touch: null });
      await logEvent(lead.id, { channel: 'system', kind: 'cold_stopped', summary: 'Interested on the phone: cold touches stopped' });
    } else if (outcome === 'meeting_booked' || outcome === 'closed_won') {
      await setEmailControls(lead.id, { email_stop_reason: outcome === 'closed_won' ? 'won' : 'booked', pending_touch: null });
      await logEvent(lead.id, { channel: 'system', kind: 'all_stopped', summary: 'Outreach stopped (' + outcome + ')' });
    }
    if (pg && lead.emailStopReason === undefined) { /* pulled back on the next sync */ }
  } catch (e) { console.error('[dialer] email action failed:', e.message); }
}

// ---- Signals from the email side ------------------------------------------------
// reply: a person answered a cold or CRM email. positive replies float to the top of the call queue.
async function onReply({ email, positive = false, summary = '' }) {
  const pg = db();
  const e = lc(email);
  if (!pg || !e) return { skipped: true };
  const r = await pg.query(
    `UPDATE prospects SET email_state = CASE WHEN email_state IN ('bounced','suppressed') THEN email_state ELSE 'replied' END,
        email_stop_reason = COALESCE(email_stop_reason, 'replied'), pending_touch = NULL,
        call_priority_at = CASE WHEN $2 AND NOT call_blocked THEN now() ELSE call_priority_at END
      WHERE email = $1 RETURNING id`, [e, positive]);
  for (const row of r.rows) await logEvent(row.id, { channel: 'email', kind: positive ? 'reply_positive' : 'reply', summary: summary || 'Replied to our email', source: 'agentlab' });
  return { ok: true, matched: r.rows.length };
}

// ---- Booking: match on email, then phone, then business name; clears the call queue ----------
async function onBooking({ email, phone, company, name, startTime }) {
  const e = lc(email), d = digits(phone);
  const leads = store.allLeads();
  let lead = (e && leads.find(l => lc(l.email) === e)) || (d && leads.find(l => l.phoneDigits === d)) || null;
  let matchedBy = lead ? (e && lc(lead.email) === e ? 'email' : 'phone') : null;
  if (!lead && company) {
    const want = model.businessKey({ businessName: company, city: 'x' }).split('|')[0];
    if (want) {
      const hits = leads.filter(l => model.businessKey({ businessName: l.businessName, city: 'x' }).split('|')[0] === want);
      if (hits.length === 1) { lead = hits[0]; matchedBy = 'company'; }
    }
  }
  if (!lead) return { matched: false };
  if (!['closed_won', 'dnc'].includes(lead.status)) lead.status = 'meeting_booked';
  lead.callbackAt = null; lead.nextAttemptAt = null;
  if (startTime) lead.meetingAt = new Date(startTime).toISOString();
  if (e && !lead.email) lead.email = e;
  store.touch(lead); store.save();
  if (db()) {
    await store.flush().catch(() => {});
    await setEmailControls(lead.id, { email_stop_reason: 'booked', pending_touch: null });
    await logEvent(lead.id, { channel: 'booking', kind: 'booked', summary: 'Booked a call (matched on ' + matchedBy + ')' + (name ? ' - ' + name : ''), source: 'agentlab' });
  }
  return { matched: true, leadId: lead.id, by: matchedBy };
}

// ---- Pulling the email side back into the dialer ----------------------------------
let watermark = null;
async function pullEmailSide() {
  const pg = db();
  if (!pg) return 0;
  if (!watermark) { watermark = new Date(Date.now() - 60000); return 0; }
  const since = watermark;
  watermark = new Date(Date.now() - 5000);
  const rows = (await pg.query(
    `SELECT id, email_state, email_sent_count, last_email_at, email_stop_reason, email_approved_at, call_priority_at, call_blocked, pending_touch
       FROM prospects WHERE updated_at > $1`, [since])).rows;
  let n = 0;
  for (const r of rows) {
    const l = store.getLead(r.id);
    if (!l) continue;
    l.emailState = r.email_state; l.emailSentCount = r.email_sent_count; l.lastEmailAt = r.last_email_at ? new Date(r.last_email_at).toISOString() : null;
    l.emailStopReason = r.email_stop_reason; l.emailApprovedAt = r.email_approved_at ? new Date(r.email_approved_at).toISOString() : null;
    l.priorityAt = r.call_priority_at ? new Date(r.call_priority_at).toISOString() : null;
    l.pendingTouch = r.pending_touch;
    if (r.call_blocked) l.callBlocked = true;
    n++;
  }
  return n;
}
let timer = null;
function startSync(ms = 30000) {
  if (timer || !db()) return;
  watermark = null;
  pullEmailSide().catch(() => {});
  timer = setInterval(() => pullEmailSide().catch(e => console.error('[dialer] email sync failed:', e.message)), ms);
  if (timer.unref) timer.unref();
}

// ---- Funnel and limits ------------------------------------------------------------
const STAGES = ['new', 'contacted', 'engaged', 'interested', 'booked', 'won', 'lost', 'suppressed'];
function startOfTodayChicago() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return new Date(parts + 'T00:00:00-06:00');   // close enough for a daily counter
}

async function funnel() {
  const stages = Object.fromEntries(STAGES.map(s => [s, 0]));
  for (const l of store.allLeads()) stages[model.stageOf(l)]++;
  const out = { stages, channels: { call: { attempts: 0, conversations: 0 }, email: { sent: 0, replies: 0, bounces: 0, complaints: 0, unsubscribes: 0 } } };
  const calls = store.load().calls;
  out.channels.call.attempts = calls.filter(c => c.outcome !== 'note').length;
  out.channels.call.conversations = calls.filter(c => ['callback', 'interested', 'meeting_booked', 'closed_won', 'not_interested', 'dnc'].includes(c.outcome)).length;
  const pg = db();
  if (pg) {
    const r = await pg.query("SELECT kind, count(*)::int AS n FROM prospect_events WHERE channel = 'email' GROUP BY kind");
    for (const x of r.rows) {
      if (x.kind === 'sent') out.channels.email.sent = x.n;
      else if (x.kind.startsWith('reply')) out.channels.email.replies += x.n;
      else if (x.kind === 'bounce') out.channels.email.bounces = x.n;
      else if (x.kind === 'complaint') out.channels.email.complaints = x.n;
      else if (x.kind === 'unsubscribe') out.channels.email.unsubscribes = x.n;
    }
  }
  return out;
}

// Daily caps. The ramp goes up only while bounces and complaints stay low and drops fast when they don't.
async function limits() {
  const base = Number(process.env.COLD_EMAIL_DAILY_CAP) || 10;
  const out = { calls: { today: 0 }, email: { baseCap: base, sentToday: 0, sent7d: 0, bounceRate7d: 0, complaintRate7d: 0, recommendedCap: base, note: 'Email not connected (file storage).' } };
  const since = startOfTodayChicago().getTime();
  out.calls.today = store.load().calls.filter(c => c.outcome !== 'note' && Date.parse(c.at) >= since).length;
  const pg = db();
  if (!pg) return out;
  const q = async (sql, args) => (await pg.query(sql, args)).rows[0];
  const today = await q("SELECT count(*)::int AS n FROM prospect_events WHERE channel='email' AND kind='sent' AND at >= $1", [new Date(since)]);
  const wk = await q(`SELECT count(*) FILTER (WHERE kind='sent')::int AS sent, count(*) FILTER (WHERE kind='bounce')::int AS bounces,
                             count(*) FILTER (WHERE kind='complaint')::int AS complaints
                        FROM prospect_events WHERE channel='email' AND at >= now() - interval '7 days'`);
  const bounceRate = wk.sent ? wk.bounces / wk.sent : 0, complaintRate = wk.sent ? wk.complaints / wk.sent : 0;
  let cap = base, note = 'Starting cap: not enough sends yet to judge.';
  if (wk.sent >= 30) {
    if (bounceRate >= 0.05 || complaintRate >= 0.003) { cap = Math.max(3, Math.floor(base / 2)); note = 'Bounces or complaints are high: cut the cap and clean the list.'; }
    else if (bounceRate < 0.02 && complaintRate < 0.001) { cap = Math.min(100, Math.ceil(Math.max(base, wk.sent / 7) * 1.5)); note = 'Bounce and complaint rates are low: safe to step up about 50%.'; }
    else { cap = Math.max(base, Math.ceil(wk.sent / 7)); note = 'Holding steady.'; }
  }
  Object.assign(out.email, { sentToday: today.n, sent7d: wk.sent, bounceRate7d: +bounceRate.toFixed(4), complaintRate7d: +complaintRate.toFixed(4), recommendedCap: cap, remainingToday: Math.max(0, cap - today.n), note });
  return out;
}

module.exports = { RULES, applyOptOut, logEvent, timeline, onOutcome, onReply, onBooking, pullEmailSide, startSync, funnel, limits, leadsMatching };
