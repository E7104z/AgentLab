const { buildAgent, fakeLlm } = require('./helpers');

const leadDecision = (body = 'Happy to help. Grab a time: https://cal.com/jason-griffin-0covhm') => ({
  category: 'new-lead',
  should_respond: true,
  needs_human: false,
  confidence: 0.92,
  reasoning: 'lead asking about services',
  body,
  facts_used: ['booking link'],
});

let h;
afterEach(async () => h && h.db.close());

describe('inbound mail', () => {
  it('initializes the cursor with a bounded search, then uses the history API', async () => {
    h = await buildAgent({ clientOverrides: { default: { sendMode: 'send' } }, llm: fakeLlm({ record_decision: leadDecision() }) });
    h.mailbox.addInbound({ fromEmail: 'owner@shop.com', fromName: 'Ana Ruiz', subject: 'Scheduling help', body: 'Can you automate our schedule?' });
    await h.agent.inbound.pollAll();
    expect(h.mailbox.calls.some((c) => c[0] === 'search')).toBe(true);
    expect(await h.db.getState('gmail:main')).toMatchObject({ historyId: '100' });

    h.mailbox.addInbound({ fromEmail: 'second@shop.com', subject: 'Question', body: 'How much?' });
    await h.agent.inbound.pollAll();
    expect(h.mailbox.calls.some((c) => c[0] === 'listHistory' && c[1] === '100')).toBe(true);
    const n = await h.db.one(`SELECT count(*)::int AS n FROM messages WHERE direction='in' AND status='processed'`);
    expect(n.n).toBe(2);
  });

  it('falls back to a search when the history cursor has expired', async () => {
    h = await buildAgent({ llm: fakeLlm({ record_decision: leadDecision() }) });
    await h.db.setState('gmail:main', { historyId: '5', lastPollAt: new Date().toISOString() });
    h.mailbox.historyExpired = true;
    h.mailbox.addInbound({ fromEmail: 'x@shop.com', body: 'hi' });
    const r = await h.agent.inbound.pollAll();
    expect(r.results[0].mode).toBe('fallback');
    expect(r.results[0].handled).toBe(1);
  });

  it('sends a threaded reply (same thread, In-Reply-To, References, Re:) in send mode', async () => {
    h = await buildAgent({ clientOverrides: { default: { sendMode: 'send' } }, llm: fakeLlm({ record_decision: leadDecision() }) });
    const m = h.mailbox.addInbound({ fromEmail: 'owner@shop.com', fromName: 'Ana', subject: 'Scheduling help', references: '<root@x>', body: 'Can you help?' });
    await h.agent.inbound.pollAll();
    await h.agent.outbox.processQueue();
    expect(h.mailbox.sent).toHaveLength(1);
    const s = h.mailbox.sent[0];
    expect(s.threadId).toBe(m.threadId);
    expect(s.parsed.headers['in-reply-to']).toBe(m.messageIdHeader);
    expect(s.parsed.headers.references).toBe(`<root@x> ${m.messageIdHeader}`);
    expect(s.parsed.headers.subject).toBe('Re: Scheduling help');
    expect(s.parsed.body).toContain('Jason Griffin\nThe Real Help');
    expect(h.mailbox.labels[m.id]).toContain('processed');
  });

  it('creates a Gmail draft (not a send) in draft mode, and never marks mail read', async () => {
    h = await buildAgent({ clientOverrides: { default: { sendMode: 'draft' } }, llm: fakeLlm({ record_decision: leadDecision() }) });
    h.mailbox.addInbound({ fromEmail: 'owner@shop.com', body: 'Hello' });
    await h.agent.inbound.pollAll();
    await h.agent.outbox.processQueue();
    expect(h.mailbox.sent).toHaveLength(0);
    expect(h.mailbox.drafts.size).toBe(1);
    const row = await h.db.one(`SELECT status FROM outbox WHERE kind='reply'`);
    expect(row.status).toBe('pending_review');
    expect(h.mailbox.calls.some((c) => c[0] === 'markRead')).toBe(false);
  });

  it('records but never touches Gmail in log mode', async () => {
    h = await buildAgent({ clientOverrides: { default: { sendMode: 'log' } }, llm: fakeLlm({ record_decision: leadDecision() }) });
    h.mailbox.addInbound({ fromEmail: 'owner@shop.com', body: 'Hello' });
    await h.agent.inbound.pollAll();
    await h.agent.outbox.processQueue();
    expect(h.mailbox.calls.filter((c) => ['send', 'createDraft'].includes(c[0]))).toHaveLength(0);
    expect((await h.db.one(`SELECT status FROM outbox WHERE kind='reply'`)).status).toBe('logged');
  });

  it('sends invented prices and refund requests to review even in send mode', async () => {
    h = await buildAgent({ clientOverrides: { default: { sendMode: 'send' } }, llm: fakeLlm({ record_decision: leadDecision('Sure, we can do it for $250.') }) });
    h.mailbox.addInbound({ fromEmail: 'owner@shop.com', body: 'What would it cost?' });
    await h.agent.inbound.pollAll();
    await h.agent.outbox.processQueue();
    const row = await h.db.one(`SELECT status, policy, reason FROM outbox WHERE kind='reply'`);
    expect(row.policy).toBe('review');
    expect(row.reason).toMatch(/\$250/);
    expect(h.mailbox.sent.filter((s) => s.msg.to === 'owner@shop.com')).toHaveLength(0);
  });

  it('is idempotent: the same message is never handled twice', async () => {
    h = await buildAgent({ clientOverrides: { default: { sendMode: 'send' } }, llm: fakeLlm({ record_decision: leadDecision() }) });
    const m = h.mailbox.addInbound({ fromEmail: 'owner@shop.com', body: 'Hello' });
    await h.agent.inbound.pollAll();
    h.mailbox.pending.push(m.id);
    await h.agent.inbound.pollAll();
    expect(h.llm.calls).toHaveLength(1);
    expect((await h.db.one(`SELECT count(*)::int AS n FROM outbox WHERE kind='reply'`)).n).toBe(1);
  });

  it('filters noise, skips our own mail, and never calls the model for either', async () => {
    h = await buildAgent({ llm: fakeLlm({ record_decision: leadDecision() }) });
    h.mailbox.addInbound({ fromEmail: 'no-reply@vendor.com', body: 'newsletter' });
    h.mailbox.addInbound({ fromEmail: 'info@thecdscloud.com', body: 'note to self' });
    await h.agent.inbound.pollAll();
    expect(h.llm.calls).toHaveLength(0);
  });

  it('suppresses bounced addresses and stops their follow-ups', async () => {
    h = await buildAgent({ llm: fakeLlm({}) });
    const contact = await h.agent.store.upsertContact('default', { email: 'gone@shop.com', name: 'Gone' });
    await h.agent.sequences.enroll('default', contact.id, 'no_booking');
    h.mailbox.addInbound({ fromEmail: 'mailer-daemon@googlemail.com', failedRecipients: 'gone@shop.com', body: 'Delivery failed' });
    await h.agent.inbound.pollAll();
    expect(await h.agent.store.isSuppressed('default', 'gone@shop.com')).toBe(true);
    expect((await h.db.one(`SELECT status FROM enrollments`)).status).toBe('stopped');
  });

  it('honors opt-out replies without answering', async () => {
    h = await buildAgent({ clientOverrides: { default: { sendMode: 'send' } }, llm: fakeLlm({ record_decision: leadDecision() }) });
    h.mailbox.addInbound({ fromEmail: 'owner@shop.com', body: 'Stop\n\nOn Mon Jason wrote:\n> hi' });
    await h.agent.inbound.pollAll();
    expect(h.llm.calls).toHaveLength(0);
    expect(await h.agent.store.isSuppressed('default', 'owner@shop.com')).toBe(true);
  });

  it('stops follow-up sequences when the contact replies', async () => {
    h = await buildAgent({ llm: fakeLlm({ record_decision: leadDecision() }) });
    const c = await h.agent.store.upsertContact('default', { email: 'owner@shop.com', name: 'Ana' });
    await h.agent.sequences.enroll('default', c.id, 'no_booking');
    h.mailbox.addInbound({ fromEmail: 'owner@shop.com', body: 'Thanks, one question' });
    await h.agent.inbound.pollAll();
    expect((await h.db.one(`SELECT status, stop_reason FROM enrollments`)).stop_reason).toBe('replied');
  });

  it('retries model failures up to 3 times, then makes a task and alerts', async () => {
    h = await buildAgent({ llm: fakeLlm({ record_decision: new Error('overloaded') }) });
    h.mailbox.addInbound({ fromEmail: 'owner@shop.com', subject: 'Help', body: 'Hello' });
    await h.agent.inbound.pollAll();
    await h.agent.inbound.pollAll();
    await h.agent.inbound.pollAll();
    expect(h.llm.calls).toHaveLength(3);
    const msg = await h.db.one(`SELECT status, attempts FROM messages WHERE direction='in'`);
    expect(msg).toMatchObject({ status: 'failed', attempts: 3 });
    expect((await h.db.one(`SELECT count(*)::int AS n FROM tasks WHERE kind='inbound_failed'`)).n).toBe(1);
    await h.agent.inbound.pollAll();
    expect(h.llm.calls).toHaveLength(3);
  });

  it('routes the demo alias to the demo client, adds the AI disclosure, and enforces demo limits', async () => {
    h = await buildAgent({
      llm: fakeLlm({ record_decision: { ...leadDecision('Drain cleaning starts at $149.'), category: 'new-lead' } }),
    });
    for (let i = 0; i < 4; i++) h.mailbox.addInbound({ fromEmail: 'tester@gmail.com', to: 'info+demo@thecdscloud.com', subject: 'Clogged drain ' + i, body: 'How much for a drain?' });
    await h.agent.inbound.pollAll();
    await h.agent.outbox.processQueue();
    const demoSent = h.mailbox.sent.filter((s) => s.msg.to === 'tester@gmail.com');
    expect(demoSent).toHaveLength(3);
    expect(demoSent[0].parsed.body).toContain('This reply was written by an AI assistant');
    const blocked = await h.db.one(`SELECT count(*)::int AS n FROM outbox WHERE client_id='demo' AND status='suppressed'`);
    expect(blocked.n).toBe(1);
  });
});
