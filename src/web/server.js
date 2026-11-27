/** HTTP layer: signed webhooks (public) and the Basic-auth dashboard API. */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { safeEqual, verifyTimestampedSignature, hmacHex } = require('../lib/util');
const { decideInbound } = require('../agent/decide');
const { decideRoute } = require('../agent/policy');
const mountDialer = require('../../dialer/routes');

function createServer(agent) {
  const { config, db, store } = agent;
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet());
  app.get('/favicon.ico', (req, res) => res.status(204).end());

  const hookLimiter = rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });
  const apiLimiter = rateLimit({ windowMs: 60000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false });
  const raw = express.raw({ type: '*/*', limit: '1mb' });

  // ---------- Public ----------
  app.get('/healthz', async (req, res) => {
    try {
      await db.query('SELECT 1');
      const lastPoll = await db.getState('health:lastPollOk');
      res.json({ ok: true, agentEnabled: agent.isAgentEnabled(), lastPollOk: lastPoll ? lastPoll.at : null });
    } catch (err) {
      res.status(503).json({ ok: false });
    }
  });

  const clientParam = (req) => String(req.query.client || 'default');

  app.post('/webhooks/lead', hookLimiter, raw, async (req, res) => {
    const body = req.body ? req.body.toString('utf8') : '';
    if (!verifyTimestampedSignature(config.leadWebhookSecret, body, req.get('X-Signature'))) return res.status(401).json({ ok: false, error: 'bad_signature' });
    let payload;
    try {
      payload = JSON.parse(body);
    } catch (_) {
      return res.status(400).json({ ok: false, error: 'bad_json' });
    }
    try {
      const result = await agent.leads.handleLead(clientParam(req), payload);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(err.status || 500).json({ ok: false, error: err.status ? err.message : 'internal_error' });
      if (!err.status) console.error('lead webhook error', err);
    }
  });

  app.post('/webhooks/cal', hookLimiter, raw, async (req, res) => {
    const body = req.body ? req.body.toString('utf8') : '';
    const sig = req.get('X-Cal-Signature-256') || '';
    if (!config.calWebhookSecret || !safeEqual(hmacHex(config.calWebhookSecret, body), sig)) return res.status(401).json({ ok: false, error: 'bad_signature' });
    try {
      const result = await agent.booking.handleCalWebhook(clientParam(req), JSON.parse(body));
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(err.status || 500).json({ ok: false, error: err.status ? err.message : 'internal_error' });
      if (!err.status) console.error('cal webhook error', err);
    }
  });

  app.post('/webhooks/stripe', hookLimiter, raw, async (req, res) => {
    let event;
    try {
      event = agent.stripe.constructEvent(req.body, req.get('Stripe-Signature'));
    } catch (err) {
      return res.status(400).json({ ok: false, error: 'bad_signature' });
    }
    try {
      const result = await agent.deals.handleStripeEvent(event);
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error('stripe webhook error', err);
      res.status(500).json({ ok: false });
    }
  });

  // ---------- Dashboard (Basic auth, fails closed) ----------
  function requireAuth(req, res, next) {
    if (!config.adminUser || !config.adminPassword) return res.status(503).send('Set ADMIN_USER and ADMIN_PASSWORD to use the dashboard.');
    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    const decoded = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '';
    const i = decoded.indexOf(':');
    const user = decoded.slice(0, i);
    const pass = decoded.slice(i + 1);
    if (scheme === 'Basic' && i > 0 && safeEqual(user, config.adminUser) && safeEqual(pass, config.adminPassword)) return next();
    res.set('WWW-Authenticate', 'Basic realm="AgentLab"');
    return res.status(401).send('Authentication required.');
  }

  const api = express.Router();
  api.use(apiLimiter, requireAuth, express.json({ limit: '200kb' }));
  const wrap = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  };
  const client = (req) => {
    const c = agent.getClient(String(req.query.client || req.body?.clientId || 'default'));
    if (!c) throw new Error('unknown client');
    return c;
  };

  // Kept from v1
  api.get('/clients', wrap(async () => agent.clients.map((c) => ({ id: c.id, businessName: c.businessName, sendMode: c.sendMode, mailbox: c.mailbox, intakeAlias: c.intakeAlias || '(default)', mailboxAuthorized: Boolean(agent.mailboxes[c.mailbox]) }))));
  api.get('/config', wrap(async () => ({
    agentEnabled: agent.isAgentEnabled(),
    pollEnabled: agent.isAgentEnabled() && config.pollEnabled,
    pollIntervalMs: config.pollIntervalMs,
    clientCount: agent.clients.length,
    mailboxes: Object.keys(agent.mailboxes),
    model: config.model,
    modelWriter: config.modelWriter,
    stripe: agent.stripe.available ? (agent.stripe.testMode ? 'test mode' : 'LIVE') : 'not configured',
    lastPollOk: (await db.getState('health:lastPollOk')) || null,
    lastPollError: (await db.getState('health:lastPollError')) || null,
  })));
  api.get('/agent-status', wrap(async () => ({ agentEnabled: agent.isAgentEnabled() })));
  api.post('/agent-toggle', wrap(async (req) => {
    const desired = typeof req.body.enabled === 'boolean' ? req.body.enabled : !agent.isAgentEnabled();
    return { agentEnabled: await agent.setAgentEnabled(desired, 'dashboard') };
  }));
  api.get('/poll-log', wrap(async () => agent.inbound.pollLog));
  api.post('/poll-now', wrap(async () => {
    if (!agent.isAgentEnabled()) throw new Error('Agent is off.');
    await agent.tick({ forcePoll: true });
    return agent.inbound.pollLog;
  }));
  // Manual test: decide only. Never drafts or sends.
  api.post('/run-agent', wrap(async (req) => {
    const c = agent.getClient(req.body.clientId) || agent.getClient('default');
    const result = await decideInbound({
      llm: agent.llm,
      model: config.model,
      client: c,
      message: { fromName: req.body.leadName || 'Test', fromEmail: req.body.leadEmail || 'test@example.com', subject: req.body.subject || '', body: req.body.inquiry || '' },
    });
    return { client: c.id, ...result, route: result.ok ? decideRoute(result.decision, c, req.body.inquiry || '') : null, action: 'test only, nothing drafted or sent' };
  }));

  // Review queue
  api.get('/review', wrap(async (req) => db.many(
    `SELECT o.*, c.name AS contact_name FROM outbox o LEFT JOIN contacts c ON c.id=o.contact_id
     WHERE o.client_id=$1 AND o.status IN ('pending_review','held','failed') ORDER BY o.created_at DESC LIMIT 100`, [client(req).id])));
  api.post('/review/:id/approve', wrap(async (req) => {
    const row = await db.one('SELECT client_id FROM outbox WHERE id=$1', [req.params.id]);
    if (!row || row.client_id !== client(req).id) throw new Error('not found');
    return agent.outbox.approve(Number(req.params.id), { subject: req.body.subject, body: req.body.body });
  }));
  api.post('/review/:id/discard', wrap(async (req) => {
    const row = await db.one('SELECT client_id FROM outbox WHERE id=$1', [req.params.id]);
    if (!row || row.client_id !== client(req).id) throw new Error('not found');
    await agent.outbox.discard(Number(req.params.id));
    return { ok: true };
  }));
  api.post('/review/:id/retry', wrap(async (req) => {
    const r = await db.query(`UPDATE outbox SET status='queued', attempts=0, error=NULL WHERE id=$1 AND client_id=$2 AND status IN ('failed','held') RETURNING id`, [req.params.id, client(req).id]);
    if (!r.rowCount) throw new Error('not found');
    await agent.outbox.processQueue();
    return { ok: true };
  }));
  api.get('/outbox', wrap(async (req) => db.many(`SELECT id, kind, to_email, subject, status, reason, created_at, sent_at FROM outbox WHERE client_id=$1 ORDER BY created_at DESC LIMIT 100`, [client(req).id])));

  // Tasks
  api.get('/tasks', wrap(async (req) => db.many(`SELECT * FROM tasks WHERE client_id=$1 AND status='open' ORDER BY due_at NULLS LAST, created_at DESC LIMIT 200`, [client(req).id])));
  api.post('/tasks/:id/done', wrap(async (req) => {
    await db.query(`UPDATE tasks SET status='done', done_at=now() WHERE id=$1 AND client_id=$2`, [req.params.id, client(req).id]);
    return { ok: true };
  }));

  // Pipeline and contacts
  api.get('/pipeline', wrap(async (req) => db.many(
    `SELECT d.*, c.name, c.email, c.business, c.phone FROM deals d JOIN contacts c ON c.id=d.contact_id
     WHERE d.client_id=$1 ORDER BY d.updated_at DESC LIMIT 200`, [client(req).id])));
  api.get('/contacts', wrap(async (req) => db.many(
    `SELECT id, name, email, phone, business, source, ref, status, do_not_email, chore, created_at FROM contacts
     WHERE client_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC LIMIT 200`, [client(req).id, req.query.status || null])));
  api.get('/contacts/:id', wrap(async (req) => {
    const c = client(req);
    const contact = await store.getContact(c.id, req.params.id);
    if (!contact) throw new Error('not found');
    const messages = await db.many(`SELECT direction, subject, body, category, status, created_at FROM messages WHERE client_id=$1 AND contact_id=$2 ORDER BY created_at`, [c.id, contact.id]);
    const outbox = await db.many(`SELECT id, kind, subject, status, reason, created_at, sent_at FROM outbox WHERE client_id=$1 AND contact_id=$2 ORDER BY created_at`, [c.id, contact.id]);
    const enrollments = await db.many(`SELECT sequence_key, step, status, stop_reason, next_run_at FROM enrollments WHERE client_id=$1 AND contact_id=$2`, [c.id, contact.id]);
    const deal = await store.openDealForContact(c.id, contact.id);
    return { contact, messages, outbox, enrollments, deal };
  }));
  api.post('/contacts/:id/deal', wrap(async (req) => agent.deals.createDeal(client(req).id, Number(req.params.id))));
  api.post('/contacts/:id/suppress', wrap(async (req) => {
    const c = client(req);
    const contact = await store.getContact(c.id, req.params.id);
    if (!contact) throw new Error('not found');
    await store.suppress(c.id, contact.email, 'manual');
    await store.stopEnrollments(c.id, contact.id, 'manual opt-out');
    return { ok: true };
  }));

  // Deals
  api.post('/deals/:id/notes', wrap(async (req) => agent.deals.saveNotes(client(req).id, Number(req.params.id), req.body)));
  api.post('/deals/:id/proposal', wrap(async (req) => agent.deals.draftProposal(client(req).id, Number(req.params.id))));
  api.post('/deals/:id/no-show', wrap(async (req) => { await agent.booking.markNoShow(client(req).id, Number(req.params.id)); return { ok: true }; }));
  api.post('/deals/:id/delivered', wrap(async (req) => { await agent.deals.markDelivered(client(req).id, Number(req.params.id), { happy: Boolean(req.body.happy) }); return { ok: true }; }));
  api.post('/deals/:id/lost', wrap(async (req) => { await agent.deals.markLost(client(req).id, Number(req.params.id)); return { ok: true }; }));

  // Reports
  api.get('/scorecard', wrap(async (req) => agent.reports.scorecard(client(req).id, Number(req.query.days || 7))));
  api.get('/digest-preview', wrap(async (req) => agent.reports.dailyDigest(client(req).id)));

  // Cold Call Dialer (dialer/*, public/dialer.html): same login and rate limit as the dashboard.
  mountDialer(app, apiLimiter, requireAuth);

  app.use('/api', api);
  app.use('/', apiLimiter, requireAuth, express.static(path.join(__dirname, '..', '..', 'public')));
  return app;
}

module.exports = { createServer };
