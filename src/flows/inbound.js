/**
 * Inbound mail: reads each mailbox with the Gmail history API, routes each message
 * to a client, records it, and drafts or sends a threaded reply through the outbox.
 */
const { matchClient } = require('../clients');
const { decideInbound } = require('../agent/decide');
const { decideRoute } = require('../agent/policy');
const { replySubject, buildReferences } = require('../gmail/mime');
const { isOptOut, newestPart } = require('../lib/util');

const NOISE_SENDER_PATTERNS = [
  /no-?reply/i,
  /donotreply/i,
  /mailer-daemon/i,
  /postmaster@/i,
  /notifications?@/i,
  /security@/i,
  /alerts?@/i,
  /@accounts\.google\.com$/i,
  /@login\.gov$/i,
  /dmarc/i,
  /calendar-notification@google\.com$/i,
];

const MAX_ATTEMPTS = 3;
const FALLBACK_WINDOW_DAYS = 3;

function looksLikeNoise(msg) {
  if (NOISE_SENDER_PATTERNS.some((rx) => rx.test(msg.fromEmail))) return true;
  if (/auto-(generated|replied)/i.test(msg.autoSubmitted || '')) return true;
  if (/^(bulk|list|junk)$/i.test(msg.precedence || '')) return true;
  return false;
}

function isBounce(msg) {
  return /mailer-daemon|postmaster@/i.test(msg.fromEmail) && Boolean(msg.failedRecipients);
}

function createInbound({ db, store, outbox, mailboxes, clients, getClient, llm, config, isAgentEnabled, log = () => {} }) {
  const pollLog = [];
  const pushLog = (entry) => {
    pollLog.unshift({ time: new Date().toISOString(), ...entry });
    pollLog.length = Math.min(pollLog.length, 100);
  };

  async function alreadyHandled(mailboxName, gmailId) {
    const row = await db.one('SELECT status, attempts FROM messages WHERE mailbox=$1 AND gmail_message_id=$2', [mailboxName, gmailId]);
    if (!row) return { handled: false, attempts: 0 };
    if (row.status === 'failed' && row.attempts < MAX_ATTEMPTS) return { handled: false, attempts: row.attempts, retry: true };
    return { handled: true };
  }

  async function recordInbound(mailboxName, msg, fields) {
    return db.one(
      `INSERT INTO messages (client_id, conversation_id, contact_id, mailbox, direction, gmail_message_id, gmail_thread_id,
                             rfc_message_id, rfc_references, subject, from_email, from_name, to_header, body, status, category, decision, action, attempts, error)
       VALUES ($1,$2,$3,$4,'in',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (mailbox, gmail_message_id) WHERE gmail_message_id IS NOT NULL DO UPDATE SET
         client_id=EXCLUDED.client_id, conversation_id=EXCLUDED.conversation_id, contact_id=EXCLUDED.contact_id,
         status=EXCLUDED.status, category=EXCLUDED.category, decision=EXCLUDED.decision, action=EXCLUDED.action,
         attempts=EXCLUDED.attempts, error=EXCLUDED.error
       RETURNING *`,
      [
        fields.clientId || null,
        fields.conversationId || null,
        fields.contactId || null,
        mailboxName,
        msg.id,
        msg.threadId,
        msg.messageIdHeader || null,
        msg.references || null,
        msg.subject,
        msg.fromEmail,
        msg.fromName,
        [msg.to, msg.cc].filter(Boolean).join(', '),
        msg.body,
        fields.status,
        fields.category || null,
        fields.decision ? JSON.stringify(fields.decision) : null,
        fields.action || null,
        fields.attempts || 0,
        fields.error || null,
      ]
    );
  }

  /** Handles one Gmail message end to end. Returns a short result for the poll log. */
  async function handleMessage(mailbox, msg, attempts = 0) {
    const own = new Set(clients.filter((c) => c.mailbox === mailbox.name).map((c) => (c.fromEmail || '').toLowerCase()));
    if (own.has(msg.fromEmail)) {
      await recordInbound(mailbox.name, msg, { status: 'own' });
      return { skipped: 'own message' };
    }

    if (isBounce(msg)) {
      const failed = msg.failedRecipients.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      for (const c of clients.filter((x) => x.mailbox === mailbox.name)) {
        for (const email of failed) {
          const contact = await store.findContactByEmail(c.id, email);
          await store.suppress(c.id, email, 'bounce');
          if (contact) await store.stopEnrollments(c.id, contact.id, 'bounced');
        }
      }
      await recordInbound(mailbox.name, msg, { status: 'bounce', action: 'suppressed ' + failed.join(', ') });
      await mailbox.addLabel(msg.id, 'processed');
      return { bounce: failed };
    }

    if (looksLikeNoise(msg)) {
      await recordInbound(mailbox.name, msg, { status: 'filtered' });
      await mailbox.addLabel(msg.id, 'processed');
      return { filtered: true };
    }

    const client = matchClient([msg.to, msg.cc, msg.deliveredTo].join(', '), clients, mailbox.name);
    if (!client) {
      await recordInbound(mailbox.name, msg, { status: 'unrouted' });
      await mailbox.addLabel(msg.id, 'escalated');
      const anyClient = clients.find((c) => c.mailbox === mailbox.name);
      if (anyClient) {
        await store.addTask(anyClient.id, {
          kind: 'unrouted',
          title: `Unrouted email from ${msg.fromEmail}`,
          details: `To: ${msg.to}\nSubject: ${msg.subject}`,
          dedupeKey: `unrouted:${mailbox.name}:${msg.id}`,
        });
      }
      return { unrouted: true };
    }

    const contact = await store.upsertContact(client.id, { email: msg.fromEmail, name: msg.fromName, source: 'email' });
    const conv = await store.upsertConversation(client.id, {
      contactId: contact.id,
      mailbox: mailbox.name,
      threadId: msg.threadId,
      subject: (msg.subject || '').replace(/^re:\s*/i, ''),
    });

    // Any reply stops automated follow-ups.
    await store.stopEnrollments(client.id, contact.id, 'replied', ['no_booking', 'post_call']);
    await store.hook('onReply', { email: msg.fromEmail, positive: false, summary: 'Replied: ' + String(msg.subject || '').slice(0, 120) });

    const fresh = newestPart(msg.body);
    if (isOptOut(fresh)) {
      await store.suppress(client.id, msg.fromEmail, 'opt-out reply');
      await store.stopEnrollments(client.id, contact.id, 'opted out');
      await recordInbound(mailbox.name, msg, { clientId: client.id, conversationId: conv.id, contactId: contact.id, status: 'opt_out', category: 'opt-out' });
      await mailbox.addLabel(msg.id, 'processed');
      return { client: client.id, optOut: true };
    }

    const history = await store.threadHistory(conv.id, 6);
    let result;
    try {
      result = await decideInbound({ llm, model: config.model, client, message: { ...msg, body: fresh || msg.body }, history });
    } catch (err) {
      const n = attempts + 1;
      await recordInbound(mailbox.name, msg, {
        clientId: client.id,
        conversationId: conv.id,
        contactId: contact.id,
        status: 'failed',
        attempts: n,
        error: String(err.message || err).slice(0, 500),
      });
      await mailbox.addLabel(msg.id, 'failed');
      if (n >= MAX_ATTEMPTS) {
        await store.addTask(client.id, {
          contactId: contact.id,
          kind: 'inbound_failed',
          title: `Couldn't process email from ${msg.fromEmail}`,
          details: `Subject: ${msg.subject}\nError: ${err.message}`,
          dedupeKey: `inbound_failed:${mailbox.name}:${msg.id}`,
        });
        await outbox.notifyOwner(client.id, {
          subject: `Email needs you: ${msg.subject || '(no subject)'}`,
          body: `AgentLab couldn't process an email after ${n} tries.\n\nFrom: ${msg.fromEmail}\nSubject: ${msg.subject}\nError: ${err.message}`,
          dedupeKey: `alert:inbound_failed:${msg.id}`,
        });
      }
      return { client: client.id, error: err.message, attempts: n };
    }

    if (!result.ok) {
      await recordInbound(mailbox.name, msg, {
        clientId: client.id,
        conversationId: conv.id,
        contactId: contact.id,
        status: 'escalated',
        error: result.problems.join('; '),
      });
      await mailbox.addLabel(msg.id, 'escalated');
      await store.addTask(client.id, {
        contactId: contact.id,
        kind: 'reply_needed',
        title: `Reply needed: ${msg.fromEmail}`,
        details: `Subject: ${msg.subject}\nThe model output was invalid: ${result.problems.join('; ')}`,
        dedupeKey: `reply_needed:${msg.id}`,
      });
      return { client: client.id, invalid: result.problems };
    }

    const decision = result.decision;
    const route = decideRoute(decision, client, fresh);
    let action = route.route;

    if (route.route === 'auto' || route.route === 'review') {
      await outbox.enqueue(client.id, {
        kind: 'reply',
        contactId: contact.id,
        conversationId: conv.id,
        to: msg.fromEmail,
        subject: replySubject(msg.subject),
        body: decision.body,
        threadId: msg.threadId,
        inReplyTo: msg.messageIdHeader || null,
        references: buildReferences(msg.references, msg.messageIdHeader),
        policy: route.route,
        reason: route.reason,
        dedupeKey: `reply:${mailbox.name}:${msg.id}`,
      });
      if (route.route === 'review') {
        await outbox.notifyOwner(client.id, {
          subject: `Review needed: ${msg.fromEmail}`,
          body: `A reply is waiting for your review.\n\nFrom: ${msg.fromEmail}\nSubject: ${msg.subject}\nWhy: ${route.reason}\n\nOpen the dashboard: ${config.appBaseUrl || '(set APP_BASE_URL)'}`,
          dedupeKey: `alert:review:${msg.id}`,
        });
      }
    } else if (route.route === 'task') {
      await store.addTask(client.id, {
        contactId: contact.id,
        kind: 'reply_needed',
        title: `Needs you: ${msg.fromEmail}`,
        details: `Subject: ${msg.subject}\n${route.reason}`,
        dedupeKey: `reply_needed:${msg.id}`,
      });
    }

    // A real interested reply floats the business to the top of the call queue.
    if (['new-lead', 'booking', 'active-conversation'].includes(decision.category)) {
      await store.hook('onReply', { email: msg.fromEmail, positive: true, summary: 'Positive reply (' + decision.category + '): ' + String(msg.subject || '').slice(0, 100) });
    }
    if (decision.category === 'new-lead' && contact.status === 'new') await store.setContactStatus(client.id, contact.id, 'replied');

    await recordInbound(mailbox.name, msg, {
      clientId: client.id,
      conversationId: conv.id,
      contactId: contact.id,
      status: 'processed',
      category: decision.category,
      decision: { ...decision, route },
      action,
    });
    await mailbox.addLabel(msg.id, route.route === 'auto' ? 'processed' : route.route === 'none' ? 'processed' : 'escalated');
    return { client: client.id, category: decision.category, route: route.route, reason: route.reason };
  }

  async function messageIdsFor(mailbox) {
    const key = `gmail:${mailbox.name}`;
    const state = (await db.getState(key)) || {};
    if (!state.historyId) {
      const profile = await mailbox.getProfile();
      const since = Math.floor((Date.now() - FALLBACK_WINDOW_DAYS * 86400000) / 1000);
      const ids = await mailbox.search(`in:inbox after:${since} -label:Agent-Processed -label:Agent-Escalated`);
      return { ids, nextHistoryId: profile.historyId, mode: 'initial' };
    }
    try {
      const { messageIds, historyId } = await mailbox.listHistory(state.historyId);
      return { ids: messageIds, nextHistoryId: historyId, mode: 'history' };
    } catch (err) {
      const code = err.code || (err.response && err.response.status);
      if (code !== 404) throw err;
      const profile = await mailbox.getProfile();
      const since = Math.floor(((state.lastPollAt ? Date.parse(state.lastPollAt) : Date.now()) - 86400000) / 1000);
      const ids = await mailbox.search(`in:inbox after:${since} -label:Agent-Processed -label:Agent-Escalated`);
      return { ids, nextHistoryId: profile.historyId, mode: 'fallback' };
    }
  }

  async function pollMailbox(mailbox) {
    const key = `gmail:${mailbox.name}`;
    const { ids, nextHistoryId, mode } = await messageIdsFor(mailbox);

    // Retry earlier failures too.
    const failed = await db.many(
      `SELECT gmail_message_id FROM messages WHERE mailbox=$1 AND direction='in' AND status='failed' AND attempts < $2`,
      [mailbox.name, MAX_ATTEMPTS]
    );
    const all = [...new Set([...ids, ...failed.map((f) => f.gmail_message_id)])];

    let handled = 0;
    for (const id of all) {
      const seen = await alreadyHandled(mailbox.name, id);
      if (seen.handled) continue;
      let msg;
      try {
        msg = await mailbox.getMessage(id);
      } catch (err) {
        if ((err.code || (err.response && err.response.status)) === 404) continue; // deleted
        throw err;
      }
      if (!msg.labelIds.includes('INBOX') && !seen.retry) continue;
      const result = await handleMessage(mailbox, msg, seen.attempts || 0);
      pushLog({ mailbox: mailbox.name, from: msg.fromEmail, subject: msg.subject, result });
      handled++;
    }
    await db.setState(key, { historyId: String(nextHistoryId), lastPollAt: new Date().toISOString(), lastMode: mode });
    return { mailbox: mailbox.name, mode, found: all.length, handled };
  }

  async function pollAll() {
    if (!isAgentEnabled()) return { skipped: 'agent is off' };
    const results = [];
    for (const mailbox of Object.values(mailboxes)) {
      try {
        results.push(await pollMailbox(mailbox));
        await db.setState('health:lastPollOk', { at: new Date().toISOString() });
      } catch (err) {
        log('poll error', err.message);
        pushLog({ mailbox: mailbox.name, error: err.message });
        results.push({ mailbox: mailbox.name, error: err.message });
        await db.setState('health:lastPollError', { at: new Date().toISOString(), error: err.message });
      }
    }
    return { results };
  }

  return { pollAll, pollMailbox, handleMessage, pollLog, looksLikeNoise };
}

module.exports = { createInbound, looksLikeNoise, NOISE_SENDER_PATTERNS };
