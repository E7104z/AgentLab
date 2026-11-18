/**
 * The outbox: every outbound email is a row here first, and one processor decides what happens:
 *
 *   kill switch OFF           -> held (nothing touches Gmail)
 *   recipient suppressed      -> suppressed
 *   demo limits exceeded      -> suppressed (reason recorded)
 *   policy=internal           -> sent (notices to the owner)
 *   client sendMode=log       -> logged (decision recorded, no Gmail action)
 *   policy=review or draft    -> pending_review (+ a Gmail draft Jason can also send from Gmail)
 *   policy=auto and send      -> sent
 *
 * When the switch is turned back on, held items older than HELD_STALE_HOURS go to review instead of sending.
 */
const { replySubject } = require('./gmail/mime');

const HELD_STALE_HOURS = 12;

function createOutbox({ db, store, mailboxes, getClient, isAgentEnabled, config, hooks = {}, clock = () => new Date() }) {
  function composeBody(client, body, { includeSignature = true } = {}) {
    let text = String(body || '').trim();
    if (includeSignature && client.signature && !text.includes(client.signature)) text += '\n\n' + client.signature;
    if (client.aiDisclosure && client.aiDisclosureLine && !text.includes(client.aiDisclosureLine)) text += '\n\n' + client.aiDisclosureLine;
    return text;
  }

  async function enqueue(clientId, item) {
    const client = getClient(clientId);
    if (!client) throw new Error('Unknown client ' + clientId);
    const r = await db.query(
      `INSERT INTO outbox (client_id, contact_id, conversation_id, deal_id, kind, mailbox, to_email, subject, body,
                           thread_id, in_reply_to, references_hdr, policy, reason, dedupe_key, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING *`,
      [
        clientId,
        item.contactId || null,
        item.conversationId || null,
        item.dealId || null,
        item.kind,
        client.mailbox,
        item.to,
        item.subject,
        item.policy === 'internal' ? item.body : composeBody(client, item.body, item),
        item.threadId || null,
        item.inReplyTo || null,
        item.references || null,
        item.policy || 'auto',
        item.reason || null,
        item.dedupeKey || null,
        // While the kill switch is off nothing is even queued: it is held for review on restart.
        isAgentEnabled() ? 'queued' : 'held',
      ]
    );
    return r.rows[0] || null;
  }

  /** Enqueue a message to the owner (alerts, digests). */
  function notifyOwner(clientId, { subject, body, dedupeKey, kind = 'internal' }) {
    const client = getClient(clientId);
    const to = client.alertEmail || config.alertEmail;
    return enqueue(clientId, { kind, to, subject: '[AgentLab] ' + subject, body, policy: 'internal', dedupeKey });
  }

  /**
   * Reply in the contact's latest conversation when one exists, so follow-ups thread.
   * Returns the threading fields to spread into enqueue().
   */
  async function threadingFor(clientId, contactId, fallbackSubject) {
    const conv = contactId ? await store.latestConversation(clientId, contactId) : null;
    if (!conv) return { subject: fallbackSubject, lastSubject: fallbackSubject };
    const last = await store.lastThreadMessage(conv.id);
    const baseSubject = conv.subject || fallbackSubject;
    return {
      conversationId: conv.id,
      threadId: conv.thread_id,
      inReplyTo: last ? last.rfc_message_id : null,
      references: last ? [last.rfc_references, last.rfc_message_id].filter(Boolean).join(' ') : null,
      subject: replySubject(baseSubject),
      lastSubject: baseSubject.replace(/^re:\s*/i, ''),
    };
  }

  async function demoBlocked(client, row) {
    if (!client.demo) return null;
    const perSender = await db.one(
      `SELECT count(*)::int AS n FROM outbox WHERE client_id=$1 AND lower(to_email)=lower($2) AND status='sent' AND sent_at > now() - interval '1 day'`,
      [client.id, row.to_email]
    );
    if (perSender.n >= (client.demo.perSenderDaily || 3)) return 'demo per-sender daily limit reached';
    const total = await db.one(
      `SELECT count(*)::int AS n FROM outbox WHERE client_id=$1 AND status='sent' AND sent_at > now() - interval '1 day'`,
      [client.id]
    );
    if (total.n >= (client.demo.totalDaily || 50)) return 'demo daily limit reached';
    return null;
  }

  function messageFor(client, row) {
    return {
      fromEmail: client.fromEmail,
      fromName: row.policy === 'internal' && row.kind !== 'client_report' ? 'AgentLab' : client.fromDisplayName,
      replyTo: client.replyTo,
      to: row.to_email,
      subject: row.subject,
      body: row.body,
      threadId: row.thread_id,
      inReplyTo: row.in_reply_to,
      references: row.references_hdr,
    };
  }

  async function setStatus(id, status, extra = {}) {
    const keys = Object.keys(extra);
    const sets = keys.map((k, i) => `${k}=$${i + 3}`).join(', ');
    await db.query(`UPDATE outbox SET status=$2${sets ? ', ' + sets : ''}, updated_at=now() WHERE id=$1`, [
      id,
      status,
      ...keys.map((k) => extra[k]),
    ]);
  }

  /** Records a sent message in the conversation so later replies and follow-ups can thread on it. */
  async function recordSent(client, row, sent, mailbox) {
    let rfcId = null;
    try {
      if (mailbox.getSentMessageIdHeader) rfcId = await mailbox.getSentMessageIdHeader(sent.id);
    } catch (_) {
      rfcId = null;
    }
    let conversationId = row.conversation_id;
    if (row.policy !== 'internal' && sent.threadId) {
      const conv = await store.upsertConversation(client.id, {
        contactId: row.contact_id,
        mailbox: client.mailbox,
        threadId: sent.threadId,
        subject: row.subject.replace(/^re:\s*/i, ''),
      });
      conversationId = conv.id;
    }
    if (row.policy !== 'internal') {
      await db.query(
        `INSERT INTO messages (client_id, conversation_id, contact_id, mailbox, direction, gmail_message_id, gmail_thread_id,
                               rfc_message_id, rfc_references, subject, from_email, to_header, body, status, action)
         VALUES ($1,$2,$3,$4,'out',$5,$6,$7,$8,$9,$10,$11,$12,'sent',$13)
         ON CONFLICT DO NOTHING`,
        [
          client.id,
          conversationId,
          row.contact_id,
          client.mailbox,
          sent.id,
          sent.threadId,
          rfcId,
          [row.references_hdr].filter(Boolean).join(' ') || null,
          row.subject,
          client.fromEmail,
          row.to_email,
          row.body,
          row.kind,
        ]
      );
    }
    await setStatus(row.id, 'sent', { gmail_message_id: sent.id, sent_at: clock(), conversation_id: conversationId });
    if (hooks.onSent) {
      try {
        await hooks.onSent({ ...row, conversation_id: conversationId, status: 'sent' });
      } catch (err) {
        await db.audit('system', 'outbox.onSent_failed', { id: row.id, error: err.message }, row.client_id);
      }
    }
  }

  async function processOne(row) {
    const client = getClient(row.client_id);
    if (!client) return setStatus(row.id, 'failed', { error: 'unknown client' });
    if (!isAgentEnabled()) return setStatus(row.id, 'held', { reason: 'agent is off' });

    if (row.policy !== 'internal') {
      if (await store.isSuppressed(client.id, row.to_email)) return setStatus(row.id, 'suppressed', { reason: 'recipient opted out or bounced' });
      const demo = await demoBlocked(client, row);
      if (demo) return setStatus(row.id, 'suppressed', { reason: demo });
    }

    const mailbox = mailboxes[client.mailbox];
    const mode = client.sendMode;

    if (row.policy !== 'internal' && mode === 'log') return setStatus(row.id, 'logged', { reason: row.reason || 'client sendMode is log' });
    if (!mailbox) return setStatus(row.id, 'failed', { error: `mailbox "${client.mailbox}" is not authorized`, attempts: row.attempts + 1 });

    try {
      if (row.policy === 'review' || (row.policy === 'auto' && mode !== 'send')) {
        const draft = await mailbox.createDraft(messageFor(client, row));
        return setStatus(row.id, 'pending_review', { gmail_draft_id: draft.id, reason: row.reason || `client sendMode is ${mode}` });
      }
      const sent = await mailbox.send(messageFor(client, row));
      return recordSent(client, row, sent, mailbox);
    } catch (err) {
      const attempts = row.attempts + 1;
      return setStatus(row.id, attempts >= 3 ? 'failed' : 'queued', { error: String(err.message || err).slice(0, 500), attempts });
    }
  }

  async function processQueue() {
    if (!isAgentEnabled()) return { processed: 0, skipped: 'agent is off' };
    const rows = await db.many(`SELECT * FROM outbox WHERE status='queued' ORDER BY created_at LIMIT 50`);
    for (const row of rows) await processOne(row);
    return { processed: rows.length };
  }

  /** Called when the kill switch is turned on: fresh held items queue, stale ones go to review. */
  async function releaseHeld() {
    await db.query(
      `UPDATE outbox SET status='queued', policy = CASE WHEN policy='auto' AND created_at < now() - ($1 || ' hours')::interval THEN 'review' ELSE policy END,
              reason = CASE WHEN policy='auto' AND created_at < now() - ($1 || ' hours')::interval THEN 'held while agent was off; review before sending' ELSE reason END,
              updated_at=now()
       WHERE status='held'`,
      [String(HELD_STALE_HOURS)]
    );
  }

  /** Dashboard approval: send the reviewed item (edited text allowed). */
  async function approve(id, { subject, body } = {}, actor = 'dashboard') {
    const row = await db.one('SELECT * FROM outbox WHERE id=$1', [id]);
    if (!row || row.status !== 'pending_review') throw new Error('Item is not waiting for review');
    if (!isAgentEnabled()) throw new Error('Agent is off. Turn it on to send.');
    const client = getClient(row.client_id);
    const mailbox = mailboxes[client.mailbox];
    if (!mailbox) throw new Error(`Mailbox "${client.mailbox}" is not authorized`);
    if (await store.isSuppressed(client.id, row.to_email)) {
      await setStatus(id, 'suppressed', { reason: 'recipient opted out or bounced' });
      throw new Error('Recipient has opted out or bounced');
    }
    const edited = { ...row, subject: subject || row.subject, body: body || row.body };
    if (subject || body) await db.query('UPDATE outbox SET subject=$2, body=$3 WHERE id=$1', [id, edited.subject, edited.body]);
    let sent;
    if (row.gmail_draft_id) {
      if (subject || body) await mailbox.updateDraft(row.gmail_draft_id, messageFor(client, edited));
      sent = await mailbox.sendDraft(row.gmail_draft_id);
    } else {
      sent = await mailbox.send(messageFor(client, edited));
    }
    await recordSent(client, edited, sent, mailbox);
    await db.audit(actor, 'outbox.approve', { id }, client.id);
    return { ok: true };
  }

  async function discard(id, actor = 'dashboard') {
    const row = await db.one('SELECT * FROM outbox WHERE id=$1', [id]);
    if (!row) throw new Error('Not found');
    const client = getClient(row.client_id);
    if (row.gmail_draft_id && mailboxes[client.mailbox]) await mailboxes[client.mailbox].deleteDraft(row.gmail_draft_id);
    await setStatus(id, 'discarded');
    await db.audit(actor, 'outbox.discard', { id }, row.client_id);
  }

  return { enqueue, notifyOwner, threadingFor, processQueue, processOne, releaseHeld, approve, discard, composeBody };
}

module.exports = { createOutbox, HELD_STALE_HOURS };
