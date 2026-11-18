/* Test harness: real Postgres (one schema per test), fake Gmail / Claude / Docs / portal. */
const crypto = require('crypto');
const { createDb } = require('../src/db');
const { loadConfig } = require('../src/config');
const { loadClients } = require('../src/clients');
const { createAgent } = require('../src/app');
const { createServer } = require('../src/web/server');
const { createStripe } = require('../src/integrations/stripe');
const { buildRawMessage, parseRawMessage } = require('../src/gmail/mime');

const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://agentlab:agentlab@localhost:5432/agentlab_test';

async function freshDb() {
  const schema = 't_' + crypto.randomBytes(6).toString('hex');
  const db = createDb(TEST_DB, { schema });
  await db.migrate();
  const close = db.close;
  db.close = async () => {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => {});
    await close();
  };
  return db;
}

/** In-memory Gmail mailbox. Every outbound call is recorded in .calls. */
function fakeMailbox({ name = 'main', email = 'info@thecdscloud.com' } = {}) {
  let n = 0;
  const inbox = new Map();
  const mb = {
    name,
    email,
    calls: [],
    sent: [],
    drafts: new Map(),
    labels: {},
    historyId: '100',
    pending: [], // ids appearing in the next listHistory
    historyExpired: false,
    addInbound(msg) {
      const id = msg.id || 'in-' + ++n;
      const full = {
        id,
        threadId: msg.threadId || 'thr-' + id,
        labelIds: ['INBOX', 'UNREAD'],
        internalDate: Date.now(),
        fromRaw: `${msg.fromName || ''} <${msg.fromEmail}>`,
        fromEmail: msg.fromEmail.toLowerCase(),
        fromName: msg.fromName || '',
        to: msg.to || email,
        cc: '',
        deliveredTo: msg.deliveredTo || '',
        subject: msg.subject || 'Hello',
        messageIdHeader: msg.messageIdHeader || `<${id}@mail.example.com>`,
        references: msg.references || '',
        autoSubmitted: msg.autoSubmitted || '',
        precedence: '',
        failedRecipients: msg.failedRecipients || '',
        body: msg.body || '',
      };
      inbox.set(id, full);
      mb.pending.push(id);
      return full;
    },
    async getProfile() {
      mb.calls.push(['getProfile']);
      return { email, historyId: mb.historyId };
    },
    async listHistory(start) {
      mb.calls.push(['listHistory', start]);
      if (mb.historyExpired) throw Object.assign(new Error('expired'), { code: 404 });
      const ids = mb.pending.splice(0);
      mb.historyId = String(Number(mb.historyId) + 1);
      return { messageIds: ids, historyId: mb.historyId };
    },
    async search(q) {
      mb.calls.push(['search', q]);
      return mb.pending.splice(0);
    },
    async getMessage(id) {
      if (!inbox.has(id)) throw Object.assign(new Error('not found'), { code: 404 });
      return inbox.get(id);
    },
    async addLabel(id, key) {
      mb.calls.push(['addLabel', id, key]);
      mb.labels[id] = (mb.labels[id] || []).concat(key);
    },
    async send(msg) {
      mb.calls.push(['send', msg.to]);
      const raw = buildRawMessage(msg); // proves the message is buildable
      const id = 'out-' + ++n;
      const threadId = msg.threadId || 'thr-' + id;
      const rec = { id, threadId, msg, parsed: parseRawMessage(raw), rfcId: `<${id}@mail.gmail.com>` };
      mb.sent.push(rec);
      return { id, threadId };
    },
    async createDraft(msg) {
      mb.calls.push(['createDraft', msg.to]);
      buildRawMessage(msg);
      const id = 'draft-' + ++n;
      mb.drafts.set(id, msg);
      return { id };
    },
    async updateDraft(id, msg) {
      mb.calls.push(['updateDraft', id]);
      mb.drafts.set(id, msg);
    },
    async sendDraft(id) {
      mb.calls.push(['sendDraft', id]);
      const msg = mb.drafts.get(id);
      mb.drafts.delete(id);
      return mb.send(msg);
    },
    async deleteDraft(id) {
      mb.calls.push(['deleteDraft', id]);
      mb.drafts.delete(id);
    },
    async getSentMessageIdHeader(id) {
      const s = mb.sent.find((x) => x.id === id);
      return s ? s.rfcId : null;
    },
    outboundCalls() {
      return mb.calls.filter((c) => ['send', 'createDraft', 'updateDraft', 'sendDraft', 'addLabel'].includes(c[0]));
    },
  };
  return mb;
}

/** Fake Claude: responses keyed by tool name; each value is an object or (args) => object. */
function fakeLlm(responses = {}) {
  const llm = {
    available: true,
    calls: [],
    responses,
    async callTool(args) {
      llm.calls.push(args);
      const r = llm.responses[args.tool.name];
      if (r === undefined) throw new Error('no fake response for ' + args.tool.name);
      if (r instanceof Error) throw r;
      return { input: typeof r === 'function' ? r(args) : r, usage: {} };
    },
  };
  return llm;
}

function fakeDocs() {
  const docs = {
    created: [],
    async fromTemplate(args) {
      docs.created.push({ type: 'template', ...args });
      return { docId: 'doc-' + docs.created.length, url: `https://docs.google.com/document/d/doc-${docs.created.length}/edit` };
    },
    async fromScratch(args) {
      docs.created.push({ type: 'scratch', ...args });
      return { docId: 'doc-' + docs.created.length, url: `https://docs.google.com/document/d/doc-${docs.created.length}/edit` };
    },
  };
  return docs;
}

function fakePortal() {
  const p = { available: true, invites: [], async invite(x) { p.invites.push(x); return { id: 'inv-' + p.invites.length }; } };
  return p;
}

const STRIPE_CFG = {
  secretKey: 'sk_test_fake_for_signatures',
  webhookSecret: 'whsec_test_secret',
  priceSetup: 'price_setup',
  priceMonthly: 'price_monthly',
  successUrl: 'https://therealhelp.com/?paid=1',
  cancelUrl: 'https://therealhelp.com/',
};

/** Real Stripe signature verification (offline), fake Checkout creation. */
function fakeStripe() {
  const real = createStripe(STRIPE_CFG);
  const s = {
    ...real,
    checkouts: [],
    async createCheckout(args) {
      s.checkouts.push(args);
      const id = 'cs_test_' + s.checkouts.length;
      return { id, url: 'https://checkout.stripe.com/c/pay/' + id };
    },
  };
  return s;
}

function stripeSignature(payload) {
  const Stripe = require('stripe');
  return new Stripe(STRIPE_CFG.secretKey).webhooks.generateTestHeaderString({ payload, secret: STRIPE_CFG.webhookSecret });
}

function testClients(overrides = {}) {
  return loadClients().map((c) => ({ ...c, ...(overrides[c.id] || {}) }));
}

async function buildAgent({ enabled = true, clientOverrides = {}, llm = fakeLlm(), clock, env = {} } = {}) {
  const db = await freshDb();
  const config = loadConfig({
    AGENT_ENABLED: String(enabled),
    LEAD_WEBHOOK_SECRET: 'lead-secret',
    CAL_WEBHOOK_SECRET: 'cal-secret',
    ADMIN_USER: 'admin',
    ADMIN_PASSWORD: 'pw',
    ALERT_EMAIL: 'info@thecdscloud.com',
    APP_BASE_URL: 'https://agentlab.example.com',
    ...env,
  });
  const mailbox = fakeMailbox();
  const docs = fakeDocs();
  const portal = fakePortal();
  const stripe = fakeStripe();
  const agent = createAgent({
    config,
    db,
    llm,
    mailboxes: { main: mailbox },
    stripe,
    docs,
    portal,
    clients: testClients(clientOverrides),
    clock,
    log: () => {},
  });
  return { agent, db, mailbox, llm, docs, portal, stripe, config };
}

async function startServer(agent) {
  const app = createServer(agent);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = 'Basic ' + Buffer.from('admin:pw').toString('base64');
  return {
    base,
    close: () => new Promise((r) => server.close(r)),
    async api(method, path, body) {
      const res = await fetch(base + path, {
        method,
        headers: { authorization: auth, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    async post(path, raw, headers) {
      const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
  };
}

module.exports = { freshDb, fakeMailbox, fakeLlm, fakeDocs, fakePortal, fakeStripe, stripeSignature, testClients, buildAgent, startServer, STRIPE_CFG };
