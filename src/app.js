/**
 * Composition root. createAgent() wires every module from injected dependencies, so tests can
 * swap Gmail, Claude, Stripe, Docs and the portal for fakes while using a real Postgres.
 */
const { loadClients } = require('./clients');
const { createStore } = require('./store');
const { createOutbox } = require('./outbox');
const { createInbound } = require('./flows/inbound');
const { createSequences } = require('./flows/sequences');
const { createLeads } = require('./flows/leads');
const { createBooking } = require('./flows/booking');
const { createDeals } = require('./flows/deals');
const { createReports } = require('./reports/reports');

function createAgent({ config, db, llm, mailboxes = {}, stripe, docs, portal, sheets = null, clients = loadClients(), clock = () => new Date(), log = console.log }) {
  let agentEnabled = config.agentEnabledDefault;
  const isAgentEnabled = () => agentEnabled;
  const byId = Object.fromEntries(clients.map((c) => [c.id, c]));
  const getClient = (id) => byId[id] || null;

  const store = createStore(db);
  const hooks = {};
  const outbox = createOutbox({ db, store, mailboxes, getClient, isAgentEnabled, config, hooks, clock });
  const sequences = createSequences({ db, store, outbox, getClient, clock });
  const inbound = createInbound({ db, store, outbox, mailboxes, clients, getClient, llm, config, isAgentEnabled, log });
  const leads = createLeads({ db, store, outbox, sequences, getClient, llm, config });
  const booking = createBooking({ db, store, outbox, getClient });
  const deals = createDeals({ db, store, outbox, sequences, getClient, llm, config, docs, stripe, portal, isAgentEnabled });
  const reports = createReports({ db, outbox, getClient, clients, config, sheets, clock });

  hooks.onSent = async (row) => {
    if (row.kind === 'proposal') await deals.onProposalSent(row);
    if (row.kind === 'lead_reply' && row.contact_id) {
      const c = await store.getContact(row.client_id, row.contact_id);
      if (c && c.status === 'new') await store.setContactStatus(row.client_id, row.contact_id, 'replied');
    }
  };

  async function setAgentEnabled(on, actor = 'dashboard') {
    const was = agentEnabled;
    agentEnabled = Boolean(on);
    await db.audit(actor, agentEnabled ? 'agent.on' : 'agent.off', {});
    log(`AGENT switched ${agentEnabled ? 'ON' : 'OFF'} by ${actor} at ${new Date().toISOString()}`);
    if (agentEnabled && !was) {
      await outbox.releaseHeld();
      await outbox.processQueue();
    }
    return agentEnabled;
  }

  let lastPollAt = 0;
  /** One scheduler tick. Safe to call often; jobs dedupe themselves. */
  async function tick({ forcePoll = false } = {}) {
    if (!agentEnabled) return { skipped: 'agent is off' };
    return db.withLock('agentlab:tick', async () => {
      const out = {};
      const now = clock().getTime();
      if (forcePoll || (config.pollEnabled && now - lastPollAt >= config.pollIntervalMs)) {
        lastPollAt = now;
        out.poll = await inbound.pollAll();
      }
      out.sequences = await sequences.runDue();
      out.reports = await reports.runScheduled();
      out.heartbeat = await reports.heartbeat({ pollingActive: config.pollEnabled && Object.keys(mailboxes).length > 0 });
      out.outbox = await outbox.processQueue();
      return out;
    });
  }

  return {
    config,
    db,
    clients,
    getClient,
    store,
    outbox,
    sequences,
    inbound,
    leads,
    booking,
    deals,
    reports,
    mailboxes,
    llm,
    stripe,
    isAgentEnabled,
    setAgentEnabled,
    tick,
  };
}

module.exports = { createAgent };
