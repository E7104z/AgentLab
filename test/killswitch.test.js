const { buildAgent, fakeLlm, startServer, stripeSignature } = require('./helpers');
const { signTimestamped, hmacHex } = require('../src/lib/util');

const llm = () =>
  fakeLlm({
    compose_lead_reply: { subject: 'Thanks', body: 'Hi, thanks. Book: https://cal.com/jason-griffin-0covhm', needs_human: false, confidence: 0.95 },
    record_decision: { category: 'new-lead', should_respond: true, needs_human: false, confidence: 0.95, reasoning: 'x', body: 'Happy to help.' },
  });

describe('master kill switch', () => {
  let h;
  let srv;
  afterEach(async () => {
    if (srv) await srv.close();
    if (h) await h.db.close();
    srv = null;
  });

  it('with the agent OFF, every flow produces zero outbound actions', async () => {
    let now = new Date('2026-11-23T13:00:00Z'); // 7am Chicago Monday: digest + scorecard due
    h = await buildAgent({ enabled: false, clientOverrides: { default: { sendMode: 'send', reviewUrl: 'https://g.page/r/x' } }, llm: llm(), clock: () => now, env: { POLL_ENABLED: 'true' } });
    srv = await startServer(h.agent);

    // lead webhook (email + phone)
    let raw = JSON.stringify({ leadId: 'killswitch-1', name: 'Ana', contact: 'ana@shop.com', message: 'help' });
    await srv.post('/webhooks/lead', raw, { 'X-Signature': signTimestamped('lead-secret', raw) });
    raw = JSON.stringify({ leadId: 'killswitch-2', name: 'Bo', contact: '3145550100', message: 'call me' });
    await srv.post('/webhooks/lead', raw, { 'X-Signature': signTimestamped('lead-secret', raw) });

    // inbound mail waiting + poll attempts
    h.mailbox.addInbound({ fromEmail: 'owner@shop.com', body: 'hello' });
    await h.agent.inbound.pollAll();
    await h.agent.tick({ forcePoll: true });
    expect((await srv.api('POST', '/api/poll-now')).status).toBe(400);

    // Cal.com
    raw = JSON.stringify({ triggerEvent: 'BOOKING_CREATED', createdAt: 'x', payload: { uid: 'k1', startTime: '2026-11-24T16:00:00Z', attendees: [{ email: 'ana@shop.com', name: 'Ana' }] } });
    await srv.post('/webhooks/cal', raw, { 'X-Cal-Signature-256': hmacHex('cal-secret', raw) });

    // Stripe payment for a deal
    const deal = await h.db.one('SELECT * FROM deals LIMIT 1');
    const evt = JSON.stringify({ id: 'evt_ks', type: 'checkout.session.completed', data: { object: { id: 'cs', metadata: { client_id: 'default', deal_id: String(deal.id), contact_id: String(deal.contact_id) } } } });
    await srv.post('/webhooks/stripe', evt, { 'Stripe-Signature': stripeSignature(evt) });

    // Due sequences, reports and the queue
    now = new Date('2026-12-30T15:00:00Z');
    await h.agent.tick();
    await h.agent.sequences.runDue();
    await h.agent.outbox.processQueue();

    // Manual approval is refused too
    const pending = await h.db.one(`SELECT id FROM outbox LIMIT 1`);
    await h.db.query(`UPDATE outbox SET status='pending_review' WHERE id=$1`, [pending.id]);
    expect((await srv.api('POST', `/api/review/${pending.id}/approve`, {})).status).toBe(400);

    expect(h.mailbox.outboundCalls()).toEqual([]);
    expect(h.mailbox.calls.filter((c) => ['listHistory', 'search', 'getProfile'].includes(c[0]))).toEqual([]);
    expect(h.portal.invites).toEqual([]);
    expect(h.llm.calls.filter((c) => c.tool.name === 'record_decision')).toHaveLength(0);
    const sent = await h.db.one(`SELECT count(*)::int AS n FROM outbox WHERE status='sent'`);
    expect(sent.n).toBe(0);
    // Data was still captured, so nothing is lost
    expect((await h.db.one(`SELECT count(*)::int AS n FROM contacts`)).n).toBeGreaterThanOrEqual(2);
    expect((await h.db.one(`SELECT count(*)::int AS n FROM tasks WHERE kind IN ('call_lead','portal_invite')`)).n).toBe(2);
  });

  it('turning it ON releases fresh held mail and routes stale held mail to review', async () => {
    h = await buildAgent({ enabled: false, clientOverrides: { default: { sendMode: 'send' } }, llm: llm() });
    await h.agent.leads.handleLead('default', { leadId: 'killswitch-3', name: 'Ana', contact: 'ana@shop.com', message: 'help' });
    await h.agent.leads.handleLead('default', { leadId: 'killswitch-4', name: 'Old', contact: 'old@shop.com', message: 'help' });
    await h.db.query(`UPDATE outbox SET created_at = now() - interval '2 days' WHERE to_email='old@shop.com'`);
    expect(h.mailbox.outboundCalls()).toEqual([]);

    await h.agent.setAgentEnabled(true, 'test');
    expect(h.mailbox.sent.filter((s) => s.msg.to === 'ana@shop.com')).toHaveLength(1);
    expect(h.mailbox.sent.filter((s) => s.msg.to === 'old@shop.com')).toHaveLength(0);
    expect((await h.db.one(`SELECT status FROM outbox WHERE to_email='old@shop.com' AND kind='lead_reply'`)).status).toBe('pending_review');
  });
});
