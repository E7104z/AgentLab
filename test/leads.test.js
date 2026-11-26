const { buildAgent, fakeLlm } = require('./helpers');

const leadReply = (body = 'Thanks for reaching out! Grab a free intro call here: https://cal.com/jason-griffin-0covhm') => ({
  subject: 'Thanks for reaching out',
  body,
  needs_human: false,
  confidence: 0.95,
  facts_used: ['booking link'],
});

function validLead(overrides = {}) {
  return {
    leadId: 'lead_' + Math.random().toString(36).slice(2, 10),
    name: 'Jordan Example',
    contact: 'jordan@example.com',
    business: 'Example Co',
    message: 'I want to automate my monthly reports',
    ...overrides,
  };
}

async function alertBody(db, subjectLike) {
  const row = await db.one(`SELECT body FROM outbox WHERE policy='internal' AND subject LIKE $1 ORDER BY id DESC LIMIT 1`, [subjectLike]);
  return row && row.body;
}

let h;
afterEach(async () => h && h.db.close());

describe('website lead webhook', () => {
  it('reports "logged only (client in log mode)" instead of "queued to send"', async () => {
    h = await buildAgent({ clientOverrides: { default: { sendMode: 'log' } }, llm: fakeLlm({ compose_lead_reply: leadReply() }) });
    await h.agent.leads.handleLead('default', validLead());

    const body = await alertBody(h.db, '%New lead:%');
    expect(body).toContain('Result: logged only (client in log mode).');
    expect(body).not.toContain('queued to send');

    const row = await h.db.one(`SELECT status FROM outbox WHERE kind='lead_reply'`);
    expect(row.status).toBe('logged');
  });

  it('reports "draft created" in draft mode', async () => {
    h = await buildAgent({ clientOverrides: { default: { sendMode: 'draft' } }, llm: fakeLlm({ compose_lead_reply: leadReply() }) });
    await h.agent.leads.handleLead('default', validLead());

    expect(await alertBody(h.db, '%New lead:%')).toContain('Result: draft created.');
    const row = await h.db.one(`SELECT status FROM outbox WHERE kind='lead_reply'`);
    expect(row.status).toBe('pending_review');
    expect(h.mailbox.drafts.size).toBe(1);
  });

  it('reports "sent" in send mode', async () => {
    h = await buildAgent({ clientOverrides: { default: { sendMode: 'send' } }, llm: fakeLlm({ compose_lead_reply: leadReply() }) });
    await h.agent.leads.handleLead('default', validLead());

    expect(await alertBody(h.db, '%New lead:%')).toContain('Result: sent.');
    const row = await h.db.one(`SELECT status FROM outbox WHERE kind='lead_reply'`);
    expect(row.status).toBe('sent');
  });

  it('reports "skipped (agent OFF)" when the agent is off', async () => {
    h = await buildAgent({ enabled: false, clientOverrides: { default: { sendMode: 'send' } }, llm: fakeLlm({ compose_lead_reply: leadReply() }) });
    await h.agent.leads.handleLead('default', validLead());

    expect(await alertBody(h.db, '%New lead:%')).toContain('Result: skipped (agent OFF).');
    const row = await h.db.one(`SELECT status FROM outbox WHERE kind='lead_reply'`);
    expect(row.status).toBe('held');
  });

  it('uses the chore field for "Wants automated" and the AI prompt', async () => {
    h = await buildAgent({ clientOverrides: { default: { sendMode: 'log' } }, llm: fakeLlm({ compose_lead_reply: leadReply() }) });
    await h.agent.leads.handleLead('default', validLead({ chore: 'reconcile bank statements' }));

    const userContent = h.llm.calls[0].messages[0].content;
    expect(userContent).toContain('What they want automated: reconcile bank statements');
    expect(userContent).not.toContain('Chore:');

    const body = await alertBody(h.db, '%New lead:%');
    expect(body).toContain('Wants automated: reconcile bank statements');
  });

  it('falls back to message when no chore field is present', async () => {
    h = await buildAgent({ clientOverrides: { default: { sendMode: 'log' } }, llm: fakeLlm({ compose_lead_reply: leadReply() }) });
    await h.agent.leads.handleLead('default', validLead({ message: 'Automate my scheduling please' }));

    expect(h.llm.calls[0].messages[0].content).toContain('What they want automated: Automate my scheduling please');
  });

  it('logs each lead with id, client, sendMode and result, and never PII', async () => {
    h = await buildAgent({ clientOverrides: { default: { sendMode: 'log' } }, llm: fakeLlm({ compose_lead_reply: leadReply() }) });
    const logs = [];
    const orig = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      await h.agent.leads.handleLead('default', validLead({ name: 'Jordan Example', contact: 'jordan@example.com', phone: '3145551234' }));
    } finally {
      console.log = orig;
    }

    const leadLog = logs.find((l) => l.startsWith('[lead] '));
    expect(leadLog).toBeTruthy();
    expect(leadLog).toContain('sendMode=log');
    expect(leadLog).toContain('result=logged only (client in log mode)');
    expect(leadLog).not.toMatch(/jordan|@|314/i);
  });

  it('creates a call task for phone-only leads and uses the chore', async () => {
    h = await buildAgent({ clientOverrides: { default: { sendMode: 'log' } }, llm: fakeLlm({}) });
    await h.agent.leads.handleLead('default', { leadId: 'lead_phone_1', name: 'Jordan', phone: '3145551234', message: 'Call me about automation' });

    const task = await h.db.one(`SELECT details FROM tasks WHERE kind='call_lead'`);
    expect(task.details).toContain('Wants automated: Call me about automation');
  });
});
