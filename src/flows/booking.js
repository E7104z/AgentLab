/**
 * Cal.com booking lifecycle. Webhook body:
 *   { triggerEvent, createdAt, payload: { uid, title, startTime, endTime, attendees: [{ email, name, timeZone }], ... } }
 * Reminders (24h / 1h) are Cal.com's own workflows, not rebuilt here.
 */
const { render, firstName } = require('../lib/util');

function formatCallTime(iso, tz) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'America/Chicago',
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(new Date(iso));
  } catch (_) {
    return iso;
  }
}

function createBooking({ db, store, outbox, getClient }) {
  async function templated(client, contact, key, extraVars, { kind, dealId, dedupeKey }) {
    const t = client.templates[key];
    if (!t) return null;
    const threading = await outbox.threadingFor(client.id, contact.id, render(t.subject, { lastSubject: 'Your call with ' + client.businessName }).text);
    const vars = {
      firstName: firstName(contact.name, contact.email),
      bookingUrl: client.bookingUrl,
      kickoffBookingUrl: client.kickoffBookingUrl || client.bookingUrl,
      signature: client.signature,
      lastSubject: threading.lastSubject,
      ...extraVars,
    };
    const subject = threading.threadId ? threading.subject : render(t.subject, vars).text.replace(/^re:\s*/i, '');
    return outbox.enqueue(client.id, {
      kind,
      contactId: contact.id,
      dealId,
      to: contact.email,
      subject,
      body: render(t.body, vars).text,
      threadId: threading.threadId,
      conversationId: threading.conversationId,
      inReplyTo: threading.inReplyTo,
      references: threading.references,
      policy: 'auto',
      includeSignature: false,
      dedupeKey,
    });
  }

  async function handleCalWebhook(clientId, body) {
    const client = getClient(clientId);
    if (!client) throw Object.assign(new Error('unknown client'), { status: 404 });
    const trigger = body.triggerEvent;
    const p = body.payload || {};
    if (trigger === 'PING') return { ok: true, ping: true };
    const attendee = (p.attendees || [])[0];
    if (!p.uid || !attendee || !attendee.email) return { ignored: 'no uid or attendee' };

    const contact = await store.upsertContact(client.id, { email: attendee.email, name: attendee.name, source: 'cal.com' });
    const event = await store.addEvent(client.id, {
      contactId: contact.id,
      type: 'cal:' + trigger,
      externalId: `${p.uid}:${p.startTime || ''}:${body.createdAt || ''}`,
      payload: { uid: p.uid, startTime: p.startTime, endTime: p.endTime, title: p.title },
    });
    if (!event) return { duplicate: true };

    let deal = await store.openDealForContact(client.id, contact.id);

    switch (trigger) {
      case 'BOOKING_CREATED':
      case 'BOOKING_RESCHEDULED': {
        await store.hook('onBooking', {
          email: attendee.email, name: attendee.name, startTime: p.startTime,
          phone: attendee.phoneNumber || (p.responses && p.responses.phone && p.responses.phone.value) || null,
          company: (p.responses && (p.responses.company || p.responses.Company || p.responses.business) && (p.responses.company || p.responses.Company || p.responses.business).value) || null,
        });
        await store.stopEnrollments(client.id, contact.id, 'booked', ['no_booking']);
        await store.setContactStatus(client.id, contact.id, 'booked');
        if (!deal) {
          deal = await db.one(
            `INSERT INTO deals (client_id, contact_id, stage, booking_uid, booking_start) VALUES ($1,$2,'booked',$3,$4) RETURNING *`,
            [client.id, contact.id, p.uid, p.startTime || null]
          );
        } else {
          deal = await store.updateDeal(client.id, deal.id, { booking_uid: p.uid, booking_start: p.startTime || null });
        }
        const when = formatCallTime(p.startTime, client.timezone);
        if (trigger === 'BOOKING_CREATED') {
          await templated(client, contact, 'booking_prep', { callTime: when }, { kind: 'booking_prep', dealId: deal.id, dedupeKey: `booking_prep:${p.uid}` });
        }
        await outbox.notifyOwner(client.id, {
          subject: `${trigger === 'BOOKING_CREATED' ? 'Call booked' : 'Call rescheduled'}: ${attendee.name || attendee.email}`,
          body: `${attendee.name || ''} <${attendee.email}>\nWhen: ${when}\nTitle: ${p.title || ''}`,
          dedupeKey: `alert:cal:${trigger}:${p.uid}:${p.startTime}`,
        });
        break;
      }
      case 'BOOKING_CANCELLED': {
        await templated(client, contact, 'booking_cancelled', {}, { kind: 'booking_cancelled', dealId: deal && deal.id, dedupeKey: `booking_cancelled:${p.uid}` });
        await outbox.notifyOwner(client.id, {
          subject: `Call cancelled: ${attendee.name || attendee.email}`,
          body: `${attendee.name || ''} <${attendee.email}> cancelled ${formatCallTime(p.startTime, client.timezone)}.`,
          dedupeKey: `alert:cal:cancel:${p.uid}`,
        });
        break;
      }
      case 'MEETING_ENDED': {
        if (deal) deal = await store.updateDeal(client.id, deal.id, { stage: 'call_done' });
        await store.addTask(client.id, {
          contactId: contact.id,
          dealId: deal && deal.id,
          kind: 'call_notes',
          title: `Add 3-line call notes for ${attendee.name || attendee.email}`,
          details: 'Open the deal in the dashboard, add notes and choose the offer to draft the proposal.',
          dedupeKey: `call_notes:${p.uid}`,
        });
        break;
      }
      default:
        return { ignored: trigger };
    }
    await outbox.processQueue();
    return { ok: true, trigger, contactId: contact.id, dealId: deal && deal.id };
  }

  async function markNoShow(clientId, dealId, actor = 'dashboard') {
    const client = getClient(clientId);
    const deal = await store.getDeal(clientId, dealId);
    if (!deal) throw new Error('deal not found');
    const contact = await store.getContact(clientId, deal.contact_id);
    await templated(client, contact, 'no_show', {}, { kind: 'no_show', dealId, dedupeKey: `no_show:${dealId}:${deal.booking_uid || ''}` });
    await store.addEvent(clientId, { contactId: contact.id, type: 'no_show', payload: { dealId } });
    await db.audit(actor, 'deal.no_show', { dealId }, clientId);
    await outbox.processQueue();
  }

  return { handleCalWebhook, markNoShow, templated };
}

module.exports = { createBooking, formatCallTime };
