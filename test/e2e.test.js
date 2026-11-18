const { buildAgent, fakeLlm, startServer, stripeSignature } = require('./helpers');
const { signTimestamped, hmacHex } = require('../src/lib/util');

const llmResponses = {
  compose_lead_reply: {
    subject: 'Thanks for reaching out, Ana',
    body: 'Hi Ana, thanks for reaching out. A schedule in a group text is exactly what we fix. How many people do you schedule each week? Grab a free call: https://cal.com/jason-griffin-0covhm',
    needs_human: false,
    confidence: 0.95,
  },
  record_decision: {
    category: 'active-conversation',
    should_respond: true,
    needs_human: false,
    confidence: 0.9,
    reasoning: 'question in an active thread',
    body: 'Good question. The $30 a month covers hosting plus small fixes and tweaks after launch.',
  },
  draft_proposal: {
    problem: 'The cleaning schedule lives in a group text and changes get missed.',
    solution: 'A schedule that builds itself from client bookings and texts nobody: staff get an email with their week.',
    deliverables: ['Booking form', 'Weekly schedule view', 'Automatic email to staff'],
    timeline: 'Live in weeks, not months.',
    next_steps: 'Pay below and book a kickoff call.',
  },
};

function signedCal(triggerEvent, extra = {}) {
  const raw = JSON.stringify({
    triggerEvent,
    createdAt: new Date().toISOString(),
    payload: { uid: 'bk-e2e', title: 'Intro call', startTime: '2026-11-24T16:00:00Z', attendees: [{ email: 'ana@shop.com', name: 'Ana Ruiz' }], ...extra },
  });
  return [raw, { 'X-Cal-Signature-256': hmacHex('cal-secret', raw) }];
}

describe('full lifecycle: form lead -> paid -> delivered -> review', () => {
  let h;
  let srv;
  afterAll(async () => {
    if (srv) await srv.close();
    if (h) await h.db.close();
  });

  it('runs end to end with one source of truth', async () => {
    let now = new Date('2026-11-23T15:00:00Z');
    h = await buildAgent({ clientOverrides: { default: { sendMode: 'send', reviewUrl: 'https://g.page/r/therealhelp/review' } }, llm: fakeLlm(llmResponses), clock: () => now });
    srv = await startServer(h.agent);
    const toAna = () => h.mailbox.sent.filter((s) => s.msg.to === 'ana@shop.com');

    // 1. Website form lead -> reply in seconds
    const lead = JSON.stringify({ leadId: 'e2e-lead-1', name: 'Ana Ruiz', contact: 'ana@shop.com', business: 'Ruiz Cleaning', message: 'Our schedule lives in a group text', chore: 'scheduling' });
    expect((await srv.post('/webhooks/lead', lead, { 'X-Signature': signTimestamped('lead-secret', lead) })).status).toBe(200);
    expect(toAna()).toHaveLength(1);
    const thread = toAna()[0].threadId;

    // 2. Ana replies with a question -> answered in the same thread
    h.mailbox.addInbound({ fromEmail: 'ana@shop.com', fromName: 'Ana Ruiz', threadId: thread, subject: 'Re: Thanks for reaching out, Ana', body: 'What does the monthly fee cover?' });
    await h.agent.inbound.pollAll();
    await h.agent.outbox.processQueue();
    expect(toAna()).toHaveLength(2);
    expect(toAna()[1].threadId).toBe(thread);
    expect((await h.db.one(`SELECT stop_reason FROM enrollments WHERE sequence_key='no_booking'`)).stop_reason).toBe('replied');

    // 3. Cal.com booking -> prep email, deal opened
    let [raw, hdr] = signedCal('BOOKING_CREATED');
    expect((await srv.post('/webhooks/cal', raw, hdr)).status).toBe(200);
    expect(toAna()).toHaveLength(3);
    const deal = await h.db.one('SELECT * FROM deals');
    expect(deal.stage).toBe('booked');

    // 4. Meeting ends -> notes task; Jason adds notes in the dashboard
    [raw, hdr] = signedCal('MEETING_ENDED');
    await srv.post('/webhooks/cal', raw, hdr);
    const notes = await srv.api('POST', `/api/deals/${deal.id}/notes`, { notes: 'Ruiz Cleaning, 6 staff, schedule by group text, wants a weekly email to staff.', offer: 'quick_fix' });
    expect(notes.status).toBe(200);
    expect(notes.json).toMatchObject({ amount_cents: 50000, monthly_cents: 3000 });

    // 5. Proposal drafted -> Google Doc + Stripe Checkout, email waits for review
    const prop = await srv.api('POST', `/api/deals/${deal.id}/proposal`, {});
    expect(prop.status).toBe(200);
    expect(prop.json.stage).toBe('proposal_draft');
    expect(h.stripe.checkouts[0].offer).toBe('quick_fix');
    expect(h.docs.created[0].sections.find((s) => s.label === 'Price').value).toBe('$500 one time, plus $30/month to keep it running.');
    const review = await srv.api('GET', '/api/review');
    const item = review.json.find((r) => r.kind === 'proposal');
    expect(item.status).toBe('pending_review');
    expect(toAna()).toHaveLength(3);

    // 6. Jason approves -> proposal sent, post-call follow-ups start
    expect((await srv.api('POST', `/api/review/${item.id}/approve`, {})).status).toBe(200);
    expect(toAna()).toHaveLength(4);
    expect(toAna()[3].parsed.body).toContain('https://checkout.stripe.com/c/pay/cs_test_1');
    expect((await h.db.one('SELECT stage FROM deals')).stage).toBe('proposal_sent');
    expect((await h.db.one(`SELECT status FROM enrollments WHERE sequence_key='post_call'`)).status).toBe('active');

    // 7. Stripe payment -> won, follow-ups stop, welcome + portal invite + build task
    const evt = JSON.stringify({
      id: 'evt_e2e_1',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_1', customer: 'cus_1', subscription: 'sub_1', metadata: { client_id: 'default', deal_id: String(deal.id), contact_id: String(deal.contact_id) } } },
    });
    expect((await srv.post('/webhooks/stripe', evt, { 'Stripe-Signature': stripeSignature(evt) })).json.won).toBe(Number(deal.id));
    // Stripe retries: idempotent
    expect((await srv.post('/webhooks/stripe', evt, { 'Stripe-Signature': stripeSignature(evt) })).json.duplicate).toBe(true);
    expect((await h.db.one('SELECT stage, stripe_subscription_id FROM deals')).stage).toBe('won');
    expect((await h.db.one(`SELECT stop_reason FROM enrollments WHERE sequence_key='post_call'`)).stop_reason).toBe('paid');
    expect(h.portal.invites).toEqual([{ name: 'Ana Ruiz', email: 'ana@shop.com', service: 'The Quick Fix' }]);
    expect(toAna()[4].parsed.body).toContain('Payment received');
    expect((await h.db.one(`SELECT count(*)::int AS n FROM tasks WHERE kind='build'`)).n).toBe(1);

    // 8. Delivered (client happy) -> review request on day 7, check-in day 30, referral day 45
    expect((await srv.api('POST', `/api/deals/${deal.id}/delivered`, { happy: true })).status).toBe(200);
    now = new Date('2026-12-01T16:00:00Z');
    await h.agent.sequences.runDue();
    await h.agent.outbox.processQueue();
    const reviewAsk = toAna()[toAna().length - 1];
    expect(reviewAsk.parsed.body).toContain('https://g.page/r/therealhelp/review');
    now = new Date('2027-01-08T16:00:00Z');
    await h.agent.sequences.runDue();
    await h.agent.sequences.runDue();
    await h.agent.outbox.processQueue();
    const last = toAna()[toAna().length - 1];
    expect(last.parsed.body).toMatch(/https:\/\/therealhelp\.com\/\?ref=[\w-]{8}/);

    // 9. Scorecard reflects real records
    const sc = await srv.api('GET', '/api/scorecard?days=90');
    expect(sc.json).toMatchObject({ leads: 1, booked: 1, won: 1, wonCents: 50000, mrrCents: 3000 });
    expect(sc.json.medianFirstReplyMs).not.toBeNull();
  });

  it('skips the review request when the client was not confirmed happy', async () => {
    let now = new Date('2026-11-23T15:00:00Z');
    const h2 = await buildAgent({ clientOverrides: { default: { sendMode: 'send', reviewUrl: 'https://g.page/r/x/review' } }, clock: () => now });
    const c = await h2.agent.store.upsertContact('default', { email: 'b@shop.com', name: 'B' });
    const d = await h2.db.one(`INSERT INTO deals (client_id, contact_id, stage) VALUES ('default',$1,'won') RETURNING *`, [c.id]);
    await h2.agent.deals.markDelivered('default', d.id, { happy: false });
    now = new Date('2026-12-01T16:00:00Z');
    await h2.agent.sequences.runDue();
    await h2.agent.outbox.processQueue();
    expect(h2.mailbox.sent.filter((s) => s.msg.to === 'b@shop.com')).toHaveLength(0);
    await h2.db.close();
  });

  it('refuses a proposal draft that invents numbers', async () => {
    const h3 = await buildAgent({ llm: fakeLlm({ draft_proposal: { ...llmResponses.draft_proposal, timeline: 'Live in 2 weeks.' } }) });
    const c = await h3.agent.store.upsertContact('default', { email: 'c@shop.com', name: 'C' });
    const d = await h3.db.one(`INSERT INTO deals (client_id, contact_id, stage) VALUES ('default',$1,'call_done') RETURNING *`, [c.id]);
    await h3.agent.deals.saveNotes('default', d.id, { notes: 'Wants a booking form, no deadline discussed.', offer: 'quick_fix' });
    await expect(h3.agent.deals.draftProposal('default', d.id)).rejects.toThrow(/2 weeks/);
    expect(h3.stripe.checkouts).toHaveLength(0);
    await h3.db.close();
  });
});
