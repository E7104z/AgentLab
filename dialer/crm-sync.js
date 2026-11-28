// Pushes promising dialer leads into AgentLab's CRM (contacts, deals, tasks).
//
//   Interested      -> contact + a "follow up" task
//   Meeting Booked  -> contact + deal at stage "booked" (with the meeting time)
//   Closed - Won    -> contact + deal + a task to send the $500 / $30-a-month
//                      checkout link. The deal is NOT marked won here: AgentLab
//                      marks it won itself when Stripe confirms payment, so the
//                      revenue numbers stay real.
//
// Nothing here sends email or enrolls anyone in a sequence. Cold leads only get
// a record Jason can work. Matching is by email, then phone, so repeat outcomes
// update the same contact instead of creating duplicates.

const store = require('./store');

const SYNC_OUTCOMES = new Set(['interested', 'meeting_booked', 'closed_won']);

function noteLines(leadId) {
  return store.load().calls
    .filter(c => c.leadId === leadId && c.note)
    .slice(-5)
    .map(c => '- ' + c.note.replace(/\s+/g, ' ').slice(0, 300))
    .join('\n');
}

async function findOrCreateContact(agent, clientId, lead) {
  const { db, store: crm } = agent;
  const email = String(lead.email || '').trim().toLowerCase();
  const phone = String(lead.phoneDigits || '').replace(/\D/g, '').slice(-10);
  let contact = null;
  if (email) contact = await crm.findContactByEmail(clientId, email);
  if (!contact && phone) contact = await db.one('SELECT * FROM contacts WHERE client_id=$1 AND phone=$2 ORDER BY id LIMIT 1', [clientId, phone]);
  if (contact) {
    const sets = {
      name: contact.name || lead.contactName || null,
      business: contact.business || lead.businessName || null,
      phone: contact.phone || phone || null,
      email: contact.email || email || null
    };
    // Only fill the email if no other contact already owns it (unique index).
    if (!contact.email && email) {
      const owner = await crm.findContactByEmail(clientId, email);
      if (owner && owner.id !== contact.id) sets.email = null;
    }
    return db.one('UPDATE contacts SET name=$2, business=$3, phone=$4, email=COALESCE($5, email), updated_at=now() WHERE id=$1 RETURNING *',
      [contact.id, sets.name, sets.business, sets.phone, sets.email]);
  }
  return crm.upsertContact(clientId, {
    email: email || null,
    name: lead.contactName || null,
    business: lead.businessName || null,
    phone: phone || null,
    source: 'dialer'
  });
}

function summary(lead, notes) {
  return [
    'Business: ' + (lead.businessName || '-'),
    'Contact: ' + (lead.contactName || '-'),
    'Phone: ' + (lead.phone || '-') + (lead.email ? '   Email: ' + lead.email : ''),
    lead.website ? 'Website: ' + lead.website : '',
    lead.industry ? 'Industry: ' + String(lead.industry).slice(0, 160) : '',
    notes ? '\nCall notes:\n' + notes : ''
  ].filter(Boolean).join('\n');
}

async function syncOutcome(agent, lead, outcome, { meetingAt } = {}) {
  const s = store.settings();
  if (!SYNC_OUTCOMES.has(outcome)) return { skipped: 'not a pipeline outcome' };
  if (s.crmSync === false) return { skipped: 'CRM sync is off' };
  if (!agent || !agent.db || !agent.store || typeof agent.getClient !== 'function') return { skipped: 'CRM not available' };
  const clientId = s.crmClientId || 'default';
  if (!agent.getClient(clientId)) return { error: 'AgentLab client "' + clientId + '" not found' };

  const { db, store: crm } = agent;
  const contact = await findOrCreateContact(agent, clientId, lead);
  const notes = noteLines(lead.id);
  const body = summary(lead, notes);
  let dealId = null;

  if (outcome === 'interested') {
    await crm.addTask(clientId, {
      contactId: contact.id, kind: 'dialer_followup',
      title: 'Follow up: ' + (lead.businessName || lead.contactName || lead.phone) + ' (interested on the phone)',
      details: body, dueAt: new Date(Date.now() + 86400000),
      dedupeKey: 'dialer:' + lead.id + ':interested'
    });
  } else {
    let deal = await crm.openDealForContact(clientId, contact.id);
    if (!deal) deal = await db.one(`INSERT INTO deals (client_id, contact_id, stage) VALUES ($1,$2,'call_done') RETURNING *`, [clientId, contact.id]);
    dealId = deal.id;
    if (outcome === 'meeting_booked') {
      const fields = { call_notes: [deal.call_notes, body].filter(Boolean).join('\n\n').slice(0, 4000) };
      if (['call_done', 'booked'].includes(deal.stage)) fields.stage = 'booked';
      if (meetingAt || lead.meetingAt) fields.booking_start = new Date(meetingAt || lead.meetingAt);
      await crm.updateDeal(clientId, deal.id, fields);
      await crm.setContactStatus(clientId, contact.id, 'booked');
    } else {
      await crm.updateDeal(clientId, deal.id, {
        offer: deal.offer || 'custom',
        amount_cents: deal.amount_cents || Math.round((lead.amount || 500) * 100),
        monthly_cents: deal.monthly_cents || 3000,
        call_notes: [deal.call_notes, body].filter(Boolean).join('\n\n').slice(0, 4000)
      });
      await crm.addTask(clientId, {
        contactId: contact.id, dealId: deal.id, kind: 'dialer_close',
        title: 'Send checkout link: ' + (lead.businessName || lead.contactName || lead.phone) + ' said yes on the phone',
        details: body, dueAt: new Date(),
        dedupeKey: 'dialer:' + lead.id + ':closed_won'
      });
    }
  }
  try { await db.audit('dialer', 'dialer.' + outcome, { leadId: lead.id, contactId: contact.id, dealId }, clientId); } catch {}
  lead.crmContactId = contact.id;
  if (dealId) lead.crmDealId = dealId;
  store.touch(lead);
  store.save();
  return { ok: true, contactId: contact.id, dealId, client: clientId };
}

module.exports = { syncOutcome, SYNC_OUTCOMES };
