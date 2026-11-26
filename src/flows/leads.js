/**
 * Website lead form -> instant reply (speed to lead).
 * Payload (from the-real-help /api/lead, HMAC-signed):
 *   { leadId, name, contact, business, message, chore?, ref?, utm?, landingPage?, source? }
 * "contact" is an email or a phone number, as on the website form.
 */
const { z } = require('zod');
const { composeLeadReply } = require('../agent/decide');
const { render, firstName } = require('../lib/util');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const LeadSchema = z.object({
  leadId: z.string().min(6).max(100),
  name: z.string().max(100).default(''),
  contact: z.string().max(120).default(''),
  email: z.string().max(120).optional(),
  phone: z.string().max(40).optional(),
  business: z.string().max(120).optional().default(''),
  message: z.string().max(1500).optional().default(''),
  chore: z.string().max(300).optional().default(''),
  ref: z.string().max(40).optional().default(''),
  utm: z.record(z.string(), z.string()).optional().default({}),
  landingPage: z.string().max(300).optional().default(''),
  source: z.string().max(60).optional().default('website'),
});

/**
 * Maps the outbox row's final status to what actually happened to the lead's
 * reply, so the owner alert states the real outcome (never a false "queued").
 */
function describeResult(row) {
  switch (row && row.status) {
    case 'held':
      return 'skipped (agent OFF)';
    case 'logged':
      return 'logged only (client in log mode)';
    case 'pending_review':
      return 'draft created';
    case 'sent':
      return 'sent';
    case 'failed':
      return 'failed: ' + (row.error || row.reason || 'unknown error');
    case 'suppressed':
      return 'skipped (suppressed: ' + (row.reason || 'suppressed') + ')';
    case 'queued':
      return row.error ? 'queued (will retry): ' + row.error : 'queued (pending)';
    default:
      return row ? String(row.status) : 'not enqueued';
  }
}

/** One line per website lead. Identifiers and outcome only — never names, emails or phone numbers. */
function logLead(clientId, leadId, sendMode, result) {
  console.log(`[lead] id=${leadId} client=${clientId} sendMode=${sendMode} result=${result}`);
}

function createLeads({ db, store, outbox, sequences, getClient, llm, config }) {
  async function handleLead(clientId, payload) {
    const client = getClient(clientId);
    if (!client) throw Object.assign(new Error('unknown client'), { status: 404 });
    const parsed = LeadSchema.safeParse(payload);
    if (!parsed.success) throw Object.assign(new Error('invalid lead payload'), { status: 400 });
    const lead = parsed.data;

    const email = (lead.email || (EMAIL_RE.test(lead.contact) ? lead.contact : '')).trim().toLowerCase();
    const digits = (lead.phone || (!email ? lead.contact : '')).replace(/\D/g, '');
    const phone = digits.length >= 10 ? digits : '';
    if (!email && !phone) throw Object.assign(new Error('lead has no email or phone'), { status: 400 });

    // What the lead wants automated: the website sends a dedicated `chore` field
    // (and after the site fix also mirrors it into `message`). Prefer `chore`, fall
    // back to `message`. Store a bounded copy so follow-up templates stay short.
    const chore = lead.chore || lead.message;
    const storedChore = chore.slice(0, 300);
    // Phone-only leads have no email, so they can't be matched; dedupe on the event id instead.
    const contact = email
      ? await store.upsertContact(client.id, {
          email,
          name: lead.name,
          business: lead.business,
          phone,
          source: lead.source,
          ref: lead.ref,
          utm: lead.utm,
          landing_page: lead.landingPage,
          chore: storedChore,
        })
      : null;

    const event = await store.addEvent(client.id, {
      contactId: contact && contact.id,
      type: 'lead_form',
      externalId: lead.leadId,
      payload: { ...lead, email, phone },
    });
    if (!event) {
      logLead(client.id, lead.leadId, client.sendMode, 'duplicate');
      return { duplicate: true };
    }

    if (!email) {
      const phoneContact = await store.upsertContact(client.id, {
        name: lead.name,
        business: lead.business,
        phone,
        source: lead.source,
        ref: lead.ref,
        utm: lead.utm,
        landing_page: lead.landingPage,
        chore: storedChore,
      });
      await store.addTask(client.id, {
        contactId: phoneContact.id,
        kind: 'call_lead',
        title: `Call ${lead.name || 'new lead'} at ${phone} within 1 business hour`,
        details: `Business: ${lead.business}\nWants automated: ${chore}`,
        dueAt: new Date(Date.now() + 3600000),
        dedupeKey: `call_lead:${lead.leadId}`,
      });
      await outbox.notifyOwner(client.id, {
        subject: `Call this lead: ${lead.name || phone}`,
        body: `New phone-only lead from the website.\n\nName: ${lead.name}\nPhone: ${phone}\nBusiness: ${lead.business}\nWants automated: ${chore}\n\nCall within 1 business hour.`,
        dedupeKey: `alert:call_lead:${lead.leadId}`,
      });
      await outbox.processQueue();
      logLead(client.id, lead.leadId, client.sendMode, 'call_task');
      return { contactId: phoneContact.id, action: 'call_task' };
    }

    // Compose the reply. If the model is unavailable or its output is rejected, use the
    // client's fallback template so the lead still hears back within minutes.
    let subject;
    let body;
    let policy = 'auto';
    let reason = 'website lead';
    try {
      if (!llm.available) throw new Error('model unavailable');
      const r = await composeLeadReply({ llm, model: config.model, client, lead: { ...lead, chore } });
      if (!r.ok) throw new Error('invalid model output: ' + r.problems.join('; '));
      subject = r.decision.subject;
      body = r.decision.body;
      if (r.decision.needs_human || r.decision.confidence < (client.autoSendMinConfidence ?? 0.8)) {
        policy = 'review';
        reason = r.decision.needs_human_reason || `confidence ${r.decision.confidence}`;
      }
    } catch (err) {
      const t = client.templates.lead_reply_fallback;
      if (!t) {
        policy = 'review';
        reason = 'no fallback template: ' + err.message;
        subject = `Thanks for reaching out`;
        body = '';
      } else {
        const vars = {
          firstName: firstName(lead.name, email),
          choreLine: chore ? `You mentioned: "${chore.slice(0, 140)}". That's exactly the kind of thing we take off owners' plates.` : '',
          bookingUrl: client.bookingUrl,
          signature: '',
        };
        subject = render(t.subject, vars).text;
        body = render(t.body, vars).text;
        reason = 'fallback template (' + err.message + ')';
      }
    }

    // Enqueue the reply, run the outbox so its row reaches a real end state
    // (logged / draft / sent / held / failed), then report what actually happened.
    let result;
    if (body) {
      const row = await outbox.enqueue(client.id, {
        kind: 'lead_reply',
        contactId: contact.id,
        to: email,
        subject,
        body,
        policy,
        reason,
        dedupeKey: `lead_reply:${lead.leadId}`,
      });
      await outbox.processQueue();
      const final = row ? await db.one('SELECT * FROM outbox WHERE id = $1', [row.id]) : null;
      result = describeResult(final);
    } else {
      await store.addTask(client.id, {
        contactId: contact.id,
        kind: 'reply_needed',
        title: `Reply to new lead ${email}`,
        details: reason,
        dedupeKey: `lead_task:${lead.leadId}`,
      });
      result = 'no reply drafted (task created for review)';
    }
    await sequences.enroll(client.id, contact.id, 'no_booking');
    await outbox.notifyOwner(client.id, {
      subject: `New lead: ${lead.name || email}${lead.business ? ' (' + lead.business + ')' : ''}`,
      body: `Name: ${lead.name}\nEmail: ${email}\nPhone: ${phone || '-'}\nBusiness: ${lead.business}\nWants automated: ${chore}\nRef: ${lead.ref || '-'}\n\nResult: ${result}.`,
      dedupeKey: `alert:lead:${lead.leadId}`,
    });
    await outbox.processQueue();
    logLead(client.id, lead.leadId, client.sendMode, result);
    return { contactId: contact.id, policy, reason };
  }

  return { handleLead, LeadSchema };
}

module.exports = { createLeads, LeadSchema };
