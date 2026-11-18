const { buildAgent, fakeLlm, startServer, stripeSignature } = require('./helpers');
const { signTimestamped, hmacHex } = require('../src/lib/util');

const leadReply = {
  subject: 'Thanks for reaching out, Ana',
  body: 'Hi Ana, thanks for reaching out. Scheduling by group text is exactly what we fix. How many people are on the schedule each week? Grab a free call: https://cal.com/jason-griffin-0covhm',
  needs_human: false,
  confidence: 0.93,
  facts_used: ['booking link'],
};

let h;
let srv;
afterEach(async () => {
  if (srv) await srv.close();
  if (h) await h.db.close();
  srv = null;
});

function signedLead(payload) {
  const raw = JSON.stringify(payload);
  return { raw, headers: { 'X-Signature': signTimestamped('lead-secret', raw) } };
}

function calEvent(triggerEvent, { uid = 'bk1', email = 'ana@shop.com', start = '2026-11-24T16:00:00Z' } = {}) {
  const raw = JSON.stringify({
    triggerEvent,
    createdAt: new Date().toISOString() + Math.random(),
    payload: { uid, title: 'Intro call', startTime: start, endTime: start, attendees: [{ email, name: 'Ana Ruiz', timeZone: 'America/Chicago' }] },
  });
  return { raw, headers: { 'X-Cal-Signature-256': hmacHex('cal-secret', raw) } };
}

describe('lead webhook (speed to lead)', () => {
  it('rejects unsigned, wrongly signed and stale requests', async () => {
    h = await buildAgent({ llm: fakeLlm({ compose_lead_reply: leadReply }) });
    srv = await startServer(h.agent);
    const raw = JSON.stringify({ leadId: 'lead-0001', name: 'Ana', contact: 'ana@shop.com' });
    expect((await srv.post('/webhooks/lead', raw, {})).status).toBe(401);
    expect((await srv.post('/webhooks/lead', raw, { 'X-Signature': signTimestamped('wrong', raw) })).status).toBe(401);
    const stale = signTimestamped('lead-secret', raw, Math.floor(Date.now() / 1000) - 3600);
    expect((await srv.post('/webhooks/lead', raw, { 'X-Signature': stale })).status).toBe(401);
  });

  it('replies to an email lead within the same request, enrolls follow-ups, and alerts the owner', async () => {
    h = await buildAgent({ clientOverrides: { default: { sendMode: 'send' } }, llm: fakeLlm({ compose_lead_reply: leadReply }) });
    srv = await startServer(h.agent);
    const { raw, headers } = signedLead({ leadId: 'lead-0002', name: 'Ana Ruiz', contact: 'ana@shop.com', business: 'Ruiz Cleaning', message: 'Our schedule lives in a group text', ref: 'SBDC1' });
    const res = await srv.post('/webhooks/lead', raw, headers);
    expect(res.status).toBe(200);
    const toLead = h.mailbox.sent.filter((s) => s.msg.to === 'ana@shop.com');
    expect(toLead).toHaveLength(1);
    expect(toLead[0].parsed.body).toContain('cal.com/jason-griffin-0covhm');
    expect(toLead[0].parsed.headers.from).toContain('Jason Griffin, The Real Help');
    const alert = h.mailbox.sent.find((s) => s.msg.to === 'info@thecdscloud.com');
    expect(alert.parsed.headers.subject).toContain('New lead: Ana Ruiz');
    const contact = await h.agent.store.findContactByEmail('default', 'ana@shop.com');
    expect(contact).toMatchObject({ ref: 'SBDC1', business: 'Ruiz Cleaning', status: 'replied' });
    expect((await h.db.one(`SELECT sequence_key, status FROM enrollments`)).sequence_key).toBe('no_booking');

    const again = await srv.post('/webhooks/lead', raw, { 'X-Signature': signTimestamped('lead-secret', raw) });
    expect(again.json.duplicate).toBe(true);
    expect(h.mailbox.sent.filter((s) => s.msg.to === 'ana@shop.com')).toHaveLength(1);
  });

  it('falls back to the template when the model is down, so the lead still hears back', async () => {
    h = await buildAgent({ clientOverrides: { default: { sendMode: 'send' } }, llm: fakeLlm({ compose_lead_reply: new Error('overloaded') }) });
    await h.agent.leads.handleLead('default', { leadId: 'lead-0003', name: 'Bo', contact: 'bo@shop.com', message: 'Reports take my weekends' });
    const toLead = h.mailbox.sent.find((s) => s.msg.to === 'bo@shop.com');
    expect(toLead.parsed.body).toContain('Hi Bo');
    expect(toLead.parsed.body).toContain('Reports take my weekends');
    expect(toLead.parsed.body).not.toMatch(/\{\{/);
  });

  it('turns a phone-only lead into a call task and an alert, with no text message', async () => {
    h = await buildAgent({ llm: fakeLlm({}) });
    const r = await h.agent.leads.handleLead('default', { leadId: 'lead-0004', name: 'Cy', contact: '(314) 555-0199', message: 'Call me' });
    expect(r.action).toBe('call_task');
    const task = await h.db.one(`SELECT title FROM tasks WHERE kind='call_lead'`);
    expect(task.title).toContain('3145550199');
    expect(h.mailbox.sent.every((s) => s.msg.to === 'info@thecdscloud.com')).toBe(true);
  });
});

describe('Cal.com lifecycle', () => {
  it('verifies the signature, stops follow-ups, opens a deal and sends prep in the lead thread', async () => {
    h = await buildAgent({ clientOverrides: { default: { sendMode: 'send' } }, llm: fakeLlm({ compose_lead_reply: leadReply }) });
    srv = await startServer(h.agent);
    await h.agent.leads.handleLead('default', { leadId: 'lead-0010', name: 'Ana Ruiz', contact: 'ana@shop.com', message: 'Scheduling' });
    const leadMsg = h.mailbox.sent.find((s) => s.msg.to === 'ana@shop.com');

    const bad = calEvent('BOOKING_CREATED');
    expect((await srv.post('/webhooks/cal', bad.raw, { 'X-Cal-Signature-256': 'nope' })).status).toBe(401);

    const ev = calEvent('BOOKING_CREATED');
    const res = await srv.post('/webhooks/cal', ev.raw, ev.headers);
    expect(res.status).toBe(200);
    expect((await h.db.one(`SELECT status, stop_reason FROM enrollments`)).stop_reason).toBe('booked');
    expect((await h.db.one(`SELECT stage FROM deals`)).stage).toBe('booked');
    const prep = h.mailbox.sent.filter((s) => s.msg.to === 'ana@shop.com')[1];
    expect(prep.threadId).toBe(leadMsg.threadId);
    expect(prep.parsed.headers['in-reply-to']).toBe(leadMsg.rfcId);
    expect(prep.parsed.body).toContain("You're booked for");

    const ended = calEvent('MEETING_ENDED');
    await srv.post('/webhooks/cal', ended.raw, ended.headers);
    expect((await h.db.one(`SELECT stage FROM deals`)).stage).toBe('call_done');
    expect((await h.db.one(`SELECT kind FROM tasks WHERE kind='call_notes'`)).kind).toBe('call_notes');
  });

  it('sends one reschedule note on cancellation', async () => {
    h = await buildAgent({ clientOverrides: { default: { sendMode: 'send' } } });
    const ev = calEvent('BOOKING_CANCELLED', { uid: 'bk2' });
    await h.agent.booking.handleCalWebhook('default', JSON.parse(ev.raw));
    await h.agent.booking.handleCalWebhook('default', { ...JSON.parse(ev.raw), createdAt: 'other' });
    const notes = h.mailbox.sent.filter((s) => s.msg.to === 'ana@shop.com');
    expect(notes).toHaveLength(1);
    expect(notes[0].parsed.body).toContain('pick a new time');
  });
});

describe('follow-up sequences', () => {
  it('sends steps on schedule in business hours, threaded, and completes', async () => {
    let now = new Date('2026-11-23T15:00:00Z'); // Monday 9am Chicago
    h = await buildAgent({ clientOverrides: { default: { sendMode: 'send' } }, llm: fakeLlm({ compose_lead_reply: leadReply }), clock: () => now });
    await h.agent.leads.handleLead('default', { leadId: 'lead-0020', name: 'Ana Ruiz', contact: 'ana@shop.com', chore: 'scheduling' });
    const first = h.mailbox.sent.find((s) => s.msg.to === 'ana@shop.com');

    now = new Date('2026-11-24T15:00:00Z');
    await h.agent.sequences.runDue();
    await h.agent.outbox.processQueue();
    expect(h.mailbox.sent.filter((s) => s.msg.to === 'ana@shop.com')).toHaveLength(1);

    now = new Date('2026-11-25T15:30:00Z'); // day 2
    await h.agent.sequences.runDue();
    await h.agent.outbox.processQueue();
    const toAna = h.mailbox.sent.filter((s) => s.msg.to === 'ana@shop.com');
    expect(toAna).toHaveLength(2);
    expect(toAna[1].threadId).toBe(first.threadId);
    expect(toAna[1].parsed.body).toContain('scheduling');
    expect(toAna[1].parsed.body).toContain("Reply \"stop\" and I won't follow up again.");

    now = new Date('2026-12-08T16:00:00Z'); // past day 12
    await h.agent.sequences.runDue();
    await h.agent.sequences.runDue();
    await h.agent.outbox.processQueue();
    expect(h.mailbox.sent.filter((s) => s.msg.to === 'ana@shop.com')).toHaveLength(4);
    expect((await h.db.one(`SELECT status FROM enrollments`)).status).toBe('completed');
  });

  it('never sends to a suppressed contact', async () => {
    h = await buildAgent({ clientOverrides: { default: { sendMode: 'send' } } });
    const c = await h.agent.store.upsertContact('default', { email: 'x@shop.com', name: 'X' });
    await h.agent.outbox.enqueue('default', { kind: 'test', contactId: c.id, to: 'x@shop.com', subject: 's', body: 'b' });
    await h.agent.store.suppress('default', 'x@shop.com', 'manual');
    await h.agent.outbox.processQueue();
    expect(h.mailbox.sent).toHaveLength(0);
    expect((await h.db.one(`SELECT status FROM outbox`)).status).toBe('suppressed');
  });
});

describe('Stripe webhook', () => {
  it('rejects a bad signature and accepts a valid one', async () => {
    h = await buildAgent();
    srv = await startServer(h.agent);
    const raw = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1', metadata: {} } } });
    expect((await srv.post('/webhooks/stripe', raw, { 'Stripe-Signature': 't=1,v1=bad' })).status).toBe(400);
    const ok = await srv.post('/webhooks/stripe', raw, { 'Stripe-Signature': stripeSignature(raw) });
    expect(ok.status).toBe(200);
    expect(ok.json.ignored).toBeTruthy();
  });
});

describe('dashboard auth', () => {
  it('fails closed without credentials and keeps the v1 endpoints', async () => {
    h = await buildAgent();
    srv = await startServer(h.agent);
    expect((await fetch(srv.base + '/api/config')).status).toBe(401);
    for (const p of ['/api/config', '/api/clients', '/api/agent-status', '/api/poll-log']) expect((await srv.api('GET', p)).status).toBe(200);
    expect((await srv.api('POST', '/api/agent-toggle', { enabled: false })).json.agentEnabled).toBe(false);
    expect((await fetch(srv.base + '/healthz')).status).toBe(200);
  });
});
