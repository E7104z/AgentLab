/**
 * Follow-up sequences (inbound only). Steps are defined per client in client.json:
 *   sequences.<key>.steps[] = { day, subject, body, kind? }  (day = days after enrollment start)
 * Each due step renders real contact data. A step whose template would leave a required
 * value blank is skipped (never sent with a hole in it).
 */
const { render, firstName, nextBusinessTime } = require('../lib/util');
const { formatMoney } = require('../lib/util');

const DAY = 86400000;

function createSequences({ db, store, outbox, getClient, clock = () => new Date() }) {
  function dueAt(client, startedAt, day) {
    return nextBusinessTime(new Date(new Date(startedAt).getTime() + day * DAY), client);
  }

  async function enroll(clientId, contactId, sequenceKey, { dealId = null } = {}) {
    const client = getClient(clientId);
    const seq = client && client.sequences[sequenceKey];
    if (!seq || !seq.active || !seq.steps || !seq.steps.length) return null;
    const contact = await store.getContact(clientId, contactId);
    if (!contact || !contact.email || contact.do_not_email) return null;
    const now = clock();
    const r = await db.query(
      `INSERT INTO enrollments (client_id, contact_id, deal_id, sequence_key, step, started_at, next_run_at)
       VALUES ($1,$2,$3,$4,0,$5,$6)
       ON CONFLICT (client_id, contact_id, sequence_key) WHERE status='active' DO NOTHING RETURNING *`,
      [clientId, contactId, dealId, sequenceKey, now, dueAt(client, now, seq.steps[0].day)]
    );
    return r.rows[0] || null;
  }

  async function varsFor(client, contact, enrollment, threading) {
    const deal = enrollment.deal_id ? await store.getDeal(client.id, enrollment.deal_id) : null;
    return {
      firstName: firstName(contact.name, contact.email),
      chore: contact.chore || 'that chore',
      bookingUrl: client.bookingUrl,
      signature: client.signature,
      optOut: client.optOutLine || '',
      lastSubject: threading.lastSubject,
      proposalUrl: deal && deal.proposal_url,
      payUrl: deal && deal.checkout_url,
      reviewUrl: client.reviewUrl,
      referralUrl: client.referralBaseUrl && contact.ref_code ? `${client.referralBaseUrl}?ref=${contact.ref_code}` : '',
      price: deal && deal.amount_cents ? formatMoney(deal.amount_cents) : '',
    };
  }

  async function runStep(enrollment) {
    const client = getClient(enrollment.client_id);
    const seq = client && client.sequences[enrollment.sequence_key];
    if (!seq || !seq.active) {
      await db.query(`UPDATE enrollments SET status='stopped', stop_reason='sequence inactive', updated_at=now() WHERE id=$1`, [enrollment.id]);
      return { stopped: 'sequence inactive' };
    }
    const step = seq.steps[enrollment.step];
    if (!step) {
      await db.query(`UPDATE enrollments SET status='completed', updated_at=now() WHERE id=$1`, [enrollment.id]);
      return { completed: true };
    }
    const contact = await store.getContact(client.id, enrollment.contact_id);
    let outcome = 'sent';

    // Review requests only go to clients Jason confirmed are happy.
    let skip = null;
    if (!contact || !contact.email || contact.do_not_email) skip = 'contact cannot be emailed';
    if (!skip && step.kind === 'review_request') {
      const deal = enrollment.deal_id ? await store.getDeal(client.id, enrollment.deal_id) : null;
      if (!deal || !deal.happy_confirmed) skip = 'client not confirmed happy';
      if (!client.reviewUrl) skip = 'no reviewUrl configured';
    }

    if (!skip) {
      const threading = await outbox.threadingFor(client.id, contact.id, 'Following up');
      const vars = await varsFor(client, contact, enrollment, threading);
      const subject = render(step.subject, vars);
      // Outside a thread, a "Re:" subject would be misleading.
      if (!threading.threadId) subject.text = subject.text.replace(/^re:\s*/i, '');
      const body = render(step.body, vars);
      const required = ['firstName', 'bookingUrl', 'proposalUrl', 'payUrl', 'reviewUrl', 'referralUrl'];
      const holes = body.missing.filter((k) => required.includes(k)).concat(subject.missing.filter((k) => required.includes(k)));
      if (holes.length) {
        skip = 'missing ' + holes.join(', ');
      } else {
        await outbox.enqueue(client.id, {
          kind: `seq:${enrollment.sequence_key}:${enrollment.step}`,
          contactId: contact.id,
          dealId: enrollment.deal_id,
          to: contact.email,
          subject: threading.threadId ? threading.subject : subject.text,
          body: body.text,
          threadId: threading.threadId,
          conversationId: threading.conversationId,
          inReplyTo: threading.inReplyTo,
          references: threading.references,
          policy: 'auto',
          includeSignature: false,
          dedupeKey: `seq:${enrollment.id}:${enrollment.step}`,
        });
      }
    }
    if (skip) outcome = 'skipped: ' + skip;

    const nextIndex = enrollment.step + 1;
    const next = seq.steps[nextIndex];
    if (next) {
      await db.query(`UPDATE enrollments SET step=$2, next_run_at=$3, updated_at=now() WHERE id=$1`, [
        enrollment.id,
        nextIndex,
        dueAt(client, enrollment.started_at, next.day),
      ]);
    } else {
      await db.query(`UPDATE enrollments SET step=$2, status='completed', next_run_at=NULL, updated_at=now() WHERE id=$1`, [enrollment.id, nextIndex]);
    }
    return { step: enrollment.step, outcome };
  }

  async function runDue() {
    const due = await db.many(`SELECT * FROM enrollments WHERE status='active' AND next_run_at <= $1 ORDER BY next_run_at LIMIT 100`, [clock()]);
    const results = [];
    for (const e of due) results.push(await runStep(e));
    return results;
  }

  return { enroll, runDue, runStep };
}

module.exports = { createSequences };
