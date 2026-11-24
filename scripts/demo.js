/**
 * Local demo harness for AgentLab.
 *
 * Boots the ENTIRE app (inbound polling, website leads, outbox, sequences, reports,
 * dashboard API + UI) against your local Postgres, with every external service faked:
 *   - Gmail  -> an in-memory mailbox (sent mail and drafts stay in memory only)
 *   - Claude -> scripted responses (no API key, no network, no cost)
 *   - Stripe -> real signature checks, fake Checkout URLs
 *   - Docs / Portal -> in-memory
 *
 * Nothing here can send a real email, spend money, or call a real API.
 *
 * Usage:
 *   npm run demo                 # start (keeps your data between runs)
 *   npm run demo -- --reset      # start fresh (drops the demo schema first)
 *
 * Then open http://localhost:3456 and sign in with the credentials printed below.
 */
const { createDb } = require('../src/db');
const { loadConfig } = require('../src/config');
const { loadClients } = require('../src/clients');
const { createAgent } = require('../src/app');
const { createServer } = require('../src/web/server');
const { fakeMailbox, fakeDocs, fakePortal, fakeStripe } = require('../test/helpers');

const DB_URL = process.env.DEMO_DATABASE_URL || 'postgres://agentlab:agentlab@localhost:5432/agentlab_test';
const SCHEMA = 'demo';
const PORT = Number(process.env.DEMO_PORT || 3456);
const ADMIN_USER = process.env.DEMO_ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.DEMO_ADMIN_PASSWORD || 'demo1234';

// Scripted "Claude". Every decision/reply the app asks for returns one of these,
// so the demo runs with no Anthropic key and no network calls.
function demoLlm() {
  const llm = {
    available: true,
    calls: [],
    async callTool({ tool }) {
      llm.calls.push(tool.name);
      const byTool = {
        compose_lead_reply: {
          subject: 'Quick question about your workflow',
          body: 'Hi there, thanks for reaching out to The Real Help. The chore you described is exactly the kind of thing we take off owners\u2019 plates. What is the one step that eats the most time each week? When you are ready, grab a free intro call and I will give you a fixed price: https://cal.com/jason-griffin-0covhm',
          needs_human: false,
          needs_human_reason: '',
          confidence: 0.9,
          facts_used: ['free intro call', 'fixed price'],
        },
        record_decision: {
          category: 'new-lead',
          should_respond: true,
          needs_human: false,
          needs_human_reason: '',
          subject: 'Happy to help with scheduling',
          body: 'Thanks for writing in. A schedule that lives in a group text is exactly the kind of thing we turn into something that builds itself and nudges the right people. Want to hop on a free intro call so I can scope it and give you a fixed price? You can grab a time here: https://cal.com/jason-griffin-0covhm',
          facts_used: ['free intro call', 'fixed price'],
          next_step: 'lead books a call',
          confidence: 0.85,
          reasoning: 'New lead asking about scheduling automation; knowledge covers the answer.',
        },
        draft_proposal: {
          problem: 'Manual data entry and a schedule that lives in a group text are eating time every week.',
          solution: 'A small custom tool that captures the info once and routes it everywhere it needs to go, with a schedule that builds itself and nudges the right people.',
          deliverables: ['Working automation for the chore', 'Setup and handover', 'Ongoing hosting and small fixes'],
          timeline: 'Live in weeks, not months.',
          next_steps: 'Review the proposal and pay securely to get started.',
        },
      };
      const r = byTool[tool.name];
      if (r === undefined) throw new Error('demo LLM has no scripted response for ' + tool.name);
      return { input: r, usage: {} };
    },
  };
  return llm;
}

async function main() {
  const reset = process.argv.includes('--reset');
  const db = createDb(DB_URL, { schema: SCHEMA });

  if (reset) {
    process.stdout.write('Resetting demo schema\u2026\n');
    await db.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => {});
  }

  const applied = await db.migrate();
  if (applied.length) process.stdout.write('Applied migrations: ' + applied.join(', ') + '\n');

  const config = loadConfig({
    AGENT_ENABLED: 'true',
    POLL_ENABLED: 'true',
    POLL_INTERVAL_MS: '15000',
    TICK_INTERVAL_MS: '15000',
    ADMIN_USER,
    ADMIN_PASSWORD,
    ALERT_EMAIL: 'info@thecdscloud.com',
    APP_BASE_URL: `http://localhost:${PORT}`,
    LEAD_WEBHOOK_SECRET: 'demo-lead-secret',
    CAL_WEBHOOK_SECRET: 'demo-cal-secret',
    MODEL: 'claude-haiku-5-5',
    MODEL_WRITER: 'claude-sonnet-5-5',
  });

  // Show the human-review loop for the default client: its replies become
  // drafts that wait in "Review" instead of sending automatically.
  const clients = loadClients().map((c) => (c.id === 'default' ? { ...c, sendMode: 'draft' } : c));

  const mailbox = fakeMailbox({ name: 'main', email: 'info@thecdscloud.com' });
  const agent = createAgent({
    config,
    db,
    llm: demoLlm(),
    mailboxes: { main: mailbox },
    stripe: fakeStripe(),
    docs: fakeDocs(),
    portal: fakePortal(),
    clients,
    log: (m) => process.stdout.write('  [agent] ' + m + '\n'),
  });

  // --- Seed one of each kind of input so the dashboard is not empty ---

  // 1) An inbound email sitting in the fake inbox (picked up by the first poll).
  mailbox.addInbound({
    fromName: 'Sam Owner',
    fromEmail: 'sam@example.com',
    subject: 'Can you automate my scheduling?',
    body: 'Hi, I run a small landscaping business and our schedule lives in a group text. Can you help, and what does it cost?',
  });

  // 2) A website lead coming through the signed lead webhook flow.
  const lead = await agent.leads.handleLead('default', {
    leadId: 'demo-lead-1',
    name: 'Alex Rivera',
    contact: 'alex@example.com',
    business: 'Rivera Roofing',
    message: 'I retype the same info into three different places every day and it is killing my time.',
    chore: 'data entry',
    source: 'demo',
  });

  // 3) One scheduler tick so the inbound email above is processed now.
  await agent.tick({ forcePoll: true });

  // Keep the agent "running" so it behaves like production.
  const timer = setInterval(() => agent.tick().catch((e) => console.error('tick error', e)), config.tickIntervalMs);

  // Serve the dashboard.
  const app = createServer(agent);
  const server = await new Promise((resolve) => {
    const s = app.listen(PORT, () => resolve(s));
  });

  process.stdout.write('\n============================================================\n');
  process.stdout.write('  AgentLab is running LOCALLY with fake services.\n');
  process.stdout.write('  Nothing can send a real email or call a real API.\n');
  process.stdout.write('============================================================\n');
  process.stdout.write(`\n  Dashboard:  http://localhost:${PORT}\n`);
  process.stdout.write(`  Username:   ${ADMIN_USER}\n`);
  process.stdout.write(`  Password:   ${ADMIN_PASSWORD}\n`);
  process.stdout.write('\n  Seeded just now:\n');
  process.stdout.write(`    - Website lead: ${JSON.stringify(lead)}\n`);
  process.stdout.write(`    - Inbound email: ${JSON.stringify(agent.inbound.pollLog)}\n`);
  process.stdout.write('\n  Stop with Ctrl+C. Start fresh with:  npm run demo -- --reset\n\n');

  const shutdown = async () => {
    process.stdout.write('\nShutting down\u2026\n');
    clearInterval(timer);
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('\nFailed to start demo:', err);
  process.exit(1);
});

