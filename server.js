/** AgentLab entry point. */
require('dotenv').config();
const { loadConfig } = require('./src/config');
const { createDb } = require('./src/db');
const { loadClients } = require('./src/clients');
const { createLlm } = require('./src/agent/llm');
const { createMailboxes } = require('./src/gmail/client');
const { createStripe } = require('./src/integrations/stripe');
const { createDocs } = require('./src/integrations/docs');
const { createSheets } = require('./src/integrations/sheets');
const { createPortal } = require('./src/integrations/portal');
const { createAgent } = require('./src/app');
const { createServer } = require('./src/web/server');
const dialerStore = require('./dialer/store');

async function main() {
  const config = loadConfig();
  if (!config.databaseUrl) {
    console.error('DATABASE_URL is required (add the Railway Postgres plugin).');
    process.exit(1);
  }
  const db = createDb(config.databaseUrl);
  const applied = await db.migrate();
  if (applied.length) console.log('Applied migrations:', applied.join(', '));
  await db.setState('health:startedAt', { at: new Date().toISOString() });

  // Cold Call Dialer data lives in Postgres (migrations/002_dialer.sql); the first start copies
  // the old dialer-data.json in. Set DIALER_STORAGE=file to keep the single-file store.
  const dialer = await dialerStore.init({ db });
  console.log(`Cold Call Dialer storage: ${dialer.backend}, ${dialer.leads} leads` + (dialer.imported ? `, imported ${dialer.imported.leads} leads from the old data file` : ''));

  const clients = loadClients();
  const mailboxes = createMailboxes(config, clients);
  const main = mailboxes.main || Object.values(mailboxes)[0];
  const unavailable = (what) => ({
    available: false,
    async fromTemplate() { throw new Error(what + ' needs an authorized mailbox'); },
    async fromScratch() { throw new Error(what + ' needs an authorized mailbox'); },
  });

  const agent = createAgent({
    config,
    db,
    clients,
    mailboxes,
    llm: createLlm({ apiKey: config.anthropicApiKey }),
    stripe: createStripe(config.stripe),
    docs: main ? createDocs({ auth: main.auth }) : unavailable('Proposals'),
    sheets: main ? createSheets({ auth: main.auth }) : null,
    portal: createPortal(config.portal),
  });

  const app = createServer(agent);
  app.listen(config.port, () => {
    console.log(`AgentLab running on :${config.port}`);
    console.log('Clients: ' + clients.map((c) => `${c.id} (${c.sendMode})`).join(', '));
    console.log('Authorized mailboxes: ' + (Object.keys(mailboxes).join(', ') || 'none'));
    console.log(`AGENT_ENABLED = ${agent.isAgentEnabled()}${agent.isAgentEnabled() ? '' : ' -- all automatic actions are OFF'}`);
    console.log(`Inbox polling ${config.pollEnabled ? 'armed every ' + config.pollIntervalMs / 1000 + 's' : 'OFF (POLL_ENABLED=false)'}`);
  });

  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await agent.tick();
    } catch (err) {
      console.error('tick error', err);
    } finally {
      running = false;
    }
  }, config.tickIntervalMs);

  const shutdown = async () => {
    await dialerStore.flush().catch((e) => console.error('dialer final save failed:', e.message));
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
