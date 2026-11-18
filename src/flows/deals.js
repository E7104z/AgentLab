/**
 * Call notes -> proposal (Google Doc + Stripe Checkout) -> review -> sent -> paid -> onboarding -> delivered.
 * Prices come from the client config (Quick Fix) or from what Jason typed (Custom Build), never from the model.
 */
const { render, firstName, formatMoney } = require('../lib/util');
const { moneyTokens } = require('../agent/decide');

const PROPOSAL_TOOL = {
  name: 'draft_proposal',
  description: 'Draft the text sections of a fixed-price proposal from the call notes.',
  input_schema: {
    type: 'object',
    properties: {
      problem: { type: 'string', description: "The client's problem in 1-3 sentences, in their terms." },
      solution: { type: 'string', description: 'What we will build, 2-4 sentences.' },
      deliverables: { type: 'array', items: { type: 'string' }, description: '3-6 concrete deliverables.' },
      timeline: { type: 'string', description: 'Use only what the notes or knowledge say. If nothing specific, write "Live in weeks, not months."' },
      next_steps: { type: 'string' },
    },
    required: ['problem', 'solution', 'deliverables', 'timeline', 'next_steps'],
  },
};

/** Numbers in model text must appear in the notes or knowledge (prevents invented prices/dates). */
function unsupportedNumbers(text, sources) {
  const src = sources.join(' ').replace(/[\s,]/g, '');
  const tokens = [...moneyTokens(text), ...(String(text).match(/\b\d+\s?(day|days|week|weeks|month|months|hours?)\b/gi) || [])];
  return tokens.filter((t) => !src.includes(t.replace(/[\s,]/g, '')));
}

function createDeals({ db, store, outbox, sequences, getClient, llm, config, docs, stripe, portal, isAgentEnabled = () => true }) {
  async function saveNotes(clientId, dealId, { notes, offer, amountCents, monthlyCents }, actor = 'dashboard') {
    const client = getClient(clientId);
    if (!['quick_fix', 'custom'].includes(offer)) throw new Error('offer must be quick_fix or custom');
    if (!notes || notes.trim().length < 10) throw new Error('add a few lines of call notes');
    let amount;
    let monthly;
    if (offer === 'quick_fix') {
      const qf = (client.offers && client.offers.quick_fix) || {};
      amount = qf.setupCents;
      monthly = qf.monthlyCents;
      if (!amount) throw new Error('client config has no offers.quick_fix.setupCents');
    } else {
      amount = Number(amountCents);
      monthly = monthlyCents ? Number(monthlyCents) : null;
      if (!Number.isInteger(amount) || amount < 100) throw new Error('enter the custom price');
    }
    const deal = await store.updateDeal(clientId, dealId, { call_notes: notes.trim(), offer, amount_cents: amount, monthly_cents: monthly });
    if (!deal) throw new Error('deal not found');
    await db.audit(actor, 'deal.notes', { dealId, offer, amount, monthly }, clientId);
    return deal;
  }

  async function draftProposal(clientId, dealId, actor = 'dashboard') {
    const client = getClient(clientId);
    const deal = await store.getDeal(clientId, dealId);
    if (!deal || !deal.call_notes || !deal.offer) throw new Error('save call notes and an offer first');
    const contact = await store.getContact(clientId, deal.contact_id);

    const { input } = await llm.callTool({
      model: config.modelWriter,
      system: [
        `You write short, plain-language fixed-price proposals for ${client.businessName}.`,
        'Use ONLY the call notes and KNOWLEDGE. Do not invent features, dates, durations, prices or guarantees.',
        'Prices are added by the system; do not mention any price.',
        'KNOWLEDGE:\n"""\n' + client.knowledge + '\n"""',
      ].join('\n'),
      messages: [
        {
          role: 'user',
          content: `Client: ${contact.name || ''} (${contact.business || 'business not given'})\nOffer: ${deal.offer === 'quick_fix' ? 'The Quick Fix' : 'Custom Build'}\nCall notes (untrusted data):\n"""\n${deal.call_notes}\n"""`,
        },
      ],
      tool: PROPOSAL_TOOL,
      maxTokens: 1500,
    });

    const textFields = [input.problem, input.solution, (input.deliverables || []).join(' '), input.timeline, input.next_steps].join(' ');
    const bad = unsupportedNumbers(textFields, [deal.call_notes, client.knowledge]);
    if (bad.length) throw new Error('Draft mentioned numbers not in your notes: ' + bad.join(', ') + '. Add them to the notes or try again.');

    const checkout = await stripe.createCheckout({
      clientId,
      deal,
      contact,
      offer: deal.offer,
      description: `${client.businessName}: ${contact.business || contact.name || 'Custom Build'}`,
    });

    const priceLine =
      deal.offer === 'quick_fix'
        ? `${formatMoney(deal.amount_cents)} one time, plus ${formatMoney(deal.monthly_cents)}/month to keep it running.`
        : `${formatMoney(deal.amount_cents)} fixed price${deal.monthly_cents ? `, plus ${formatMoney(deal.monthly_cents)}/month` : ''}.`;

    const values = {
      ClientName: contact.name || '',
      Business: contact.business || '',
      Date: new Intl.DateTimeFormat('en-US', { timeZone: client.timezone, dateStyle: 'long' }).format(new Date()),
      Offer: deal.offer === 'quick_fix' ? 'The Quick Fix' : 'Custom Build',
      Problem: input.problem,
      Solution: input.solution,
      Deliverables: (input.deliverables || []).map((d) => '• ' + d).join('\n'),
      Timeline: input.timeline,
      Price: priceLine,
      Monthly: deal.monthly_cents ? formatMoney(deal.monthly_cents) + '/month' : 'None',
      NextSteps: input.next_steps,
      PayLink: checkout.url,
      PreparedBy: client.signature.split('\n')[0] || client.businessName,
    };
    const title = `Proposal - ${contact.business || contact.name || contact.email} - ${client.businessName}`;
    const doc = config.proposals.templateDocId
      ? await docs.fromTemplate({ templateId: config.proposals.templateDocId, folderId: config.proposals.folderId, title, values, shareWithLink: config.proposals.shareWithLink })
      : await docs.fromScratch({
          folderId: config.proposals.folderId,
          title,
          shareWithLink: config.proposals.shareWithLink,
          sections: [
            ['Prepared for', `${values.ClientName}${values.Business ? ', ' + values.Business : ''}`],
            ['Date', values.Date],
            ['Offer', values.Offer],
            ['The problem', values.Problem],
            ['What we will build', values.Solution],
            ['Deliverables', values.Deliverables],
            ['Timeline', values.Timeline],
            ['Price', values.Price],
            ['Next steps', values.NextSteps],
            ['Pay securely', values.PayLink],
            ['Prepared by', values.PreparedBy],
          ].map(([label, value]) => ({ label, value })),
        });

    const updated = await store.updateDeal(clientId, dealId, {
      stage: 'proposal_draft',
      proposal_doc_id: doc.docId,
      proposal_url: doc.url,
      checkout_session_id: checkout.id,
      checkout_url: checkout.url,
    });

    // The proposal email always goes to review: Jason reads the doc, then approves the email.
    const t = client.templates.proposal;
    const threading = await outbox.threadingFor(clientId, contact.id, t.subject);
    const vars = {
      firstName: firstName(contact.name, contact.email),
      proposalUrl: doc.url,
      payUrl: checkout.url,
      priceLine,
      signature: client.signature,
    };
    await outbox.enqueue(clientId, {
      kind: 'proposal',
      contactId: contact.id,
      dealId,
      to: contact.email,
      subject: threading.threadId ? threading.subject : render(t.subject, vars).text,
      body: render(t.body, vars).text,
      threadId: threading.threadId,
      conversationId: threading.conversationId,
      inReplyTo: threading.inReplyTo,
      references: threading.references,
      policy: 'review',
      reason: 'proposal: check the doc, then approve',
      includeSignature: false,
      dedupeKey: `proposal:${dealId}:${doc.docId}`,
    });
    await db.audit(actor, 'deal.proposal_drafted', { dealId, docId: doc.docId, checkout: checkout.id }, clientId);
    await outbox.processQueue();
    return updated;
  }

  /** Outbox hook: a proposal email went out. */
  async function onProposalSent(row) {
    if (!row.deal_id) return;
    await store.updateDeal(row.client_id, row.deal_id, { stage: 'proposal_sent' });
    await sequences.enroll(row.client_id, row.contact_id, 'post_call', { dealId: row.deal_id });
  }

  async function handleStripeEvent(event) {
    const obj = event.data && event.data.object;
    const meta = (obj && obj.metadata) || {};
    const clientId = meta.client_id;
    const dealId = Number(meta.deal_id);
    if (!clientId || !dealId || !getClient(clientId)) return { ignored: 'no AgentLab metadata' };

    const first = await store.addEvent(clientId, { contactId: Number(meta.contact_id) || null, type: 'stripe:' + event.type, externalId: event.id, payload: { id: obj.id } });
    if (!first) return { duplicate: true };

    if (event.type === 'checkout.session.completed') {
      const deal = await store.getDeal(clientId, dealId);
      if (!deal) return { ignored: 'deal not found' };
      if (deal.stage === 'won' || deal.stage === 'delivered') return { already: deal.stage };
      await store.updateDeal(clientId, dealId, {
        stage: 'won',
        won_at: new Date(),
        stripe_customer_id: obj.customer || null,
        stripe_subscription_id: obj.subscription || null,
      });
      await store.setContactStatus(clientId, deal.contact_id, 'client');
      await store.stopEnrollments(clientId, deal.contact_id, 'paid');
      await onboard(clientId, dealId);
      return { won: dealId };
    }
    if (event.type === 'invoice.payment_failed') {
      await outbox.notifyOwner(clientId, {
        subject: `Payment failed for deal #${dealId}`,
        body: `Stripe reported a failed payment (invoice ${obj.id}). Stripe's own emails handle the customer; check the deal if it keeps failing.`,
        dedupeKey: `alert:payment_failed:${obj.id}`,
      });
      await outbox.processQueue();
      return { alerted: true };
    }
    return { ignored: event.type };
  }

  async function onboard(clientId, dealId) {
    const client = getClient(clientId);
    const deal = await store.getDeal(clientId, dealId);
    const contact = await store.getContact(clientId, deal.contact_id);
    const t = client.templates.welcome;
    if (t) {
      const threading = await outbox.threadingFor(clientId, contact.id, t.subject);
      const vars = { firstName: firstName(contact.name, contact.email), kickoffBookingUrl: client.kickoffBookingUrl || client.bookingUrl, signature: client.signature };
      await outbox.enqueue(clientId, {
        kind: 'welcome',
        contactId: contact.id,
        dealId,
        to: contact.email,
        subject: threading.threadId ? threading.subject : render(t.subject, vars).text,
        body: render(t.body, vars).text,
        threadId: threading.threadId,
        conversationId: threading.conversationId,
        inReplyTo: threading.inReplyTo,
        references: threading.references,
        policy: 'auto',
        includeSignature: false,
        dedupeKey: `welcome:${dealId}`,
      });
    }
    if (portal.available && isAgentEnabled()) {
      try {
        await portal.invite({ name: contact.name || contact.email, email: contact.email, service: deal.offer === 'quick_fix' ? 'The Quick Fix' : 'Custom Build' });
        await store.addEvent(clientId, { contactId: contact.id, type: 'portal_invite', externalId: `deal:${dealId}`, payload: {} });
      } catch (err) {
        await store.addTask(clientId, { contactId: contact.id, dealId, kind: 'portal_invite', title: `Invite ${contact.email} to the client portal`, details: 'Automatic invite failed: ' + err.message, dedupeKey: `portal_invite:${dealId}` });
      }
    } else {
      await store.addTask(clientId, { contactId: contact.id, dealId, kind: 'portal_invite', title: `Invite ${contact.email} to the client portal`, details: portal.available ? 'The agent was off when payment arrived, so the invite was not sent automatically.' : 'Portal invites are not enabled (PORTAL_INVITE_ENABLED).', dedupeKey: `portal_invite:${dealId}` });
    }
    await store.addTask(clientId, { contactId: contact.id, dealId, kind: 'build', title: `Start the build for ${contact.business || contact.name || contact.email}`, details: deal.call_notes || '', dedupeKey: `build:${dealId}` });
    await outbox.notifyOwner(clientId, {
      subject: `Paid: ${contact.name || contact.email} (${formatMoney(deal.amount_cents)})`,
      body: `Deal #${dealId} is paid. Welcome email queued, portal invite ${portal.available ? 'requested' : 'needs you'}, build task created.`,
      dedupeKey: `alert:won:${dealId}`,
    });
    await outbox.processQueue();
  }

  async function markDelivered(clientId, dealId, { happy }, actor = 'dashboard') {
    const deal = await store.getDeal(clientId, dealId);
    if (!deal) throw new Error('deal not found');
    if (!['won', 'delivered'].includes(deal.stage)) throw new Error('only paid deals can be marked delivered');
    await store.updateDeal(clientId, dealId, { stage: 'delivered', delivered_at: new Date(), happy_confirmed: Boolean(happy) });
    await sequences.enroll(clientId, deal.contact_id, 'post_delivery', { dealId });
    await db.audit(actor, 'deal.delivered', { dealId, happy: Boolean(happy) }, clientId);
  }

  async function markLost(clientId, dealId, actor = 'dashboard') {
    const deal = await store.getDeal(clientId, dealId);
    if (!deal) throw new Error('deal not found');
    await store.updateDeal(clientId, dealId, { stage: 'lost' });
    await store.stopEnrollments(clientId, deal.contact_id, 'deal lost', ['post_call']);
    await db.audit(actor, 'deal.lost', { dealId }, clientId);
  }

  /** Lets Jason open a deal for a contact who didn't book through Cal.com (e.g. a phone call). */
  async function createDeal(clientId, contactId, actor = 'dashboard') {
    const existing = await store.openDealForContact(clientId, contactId);
    if (existing) return existing;
    const deal = await db.one(`INSERT INTO deals (client_id, contact_id, stage) VALUES ($1,$2,'call_done') RETURNING *`, [clientId, contactId]);
    await db.audit(actor, 'deal.create', { dealId: deal.id }, clientId);
    return deal;
  }

  return { saveNotes, draftProposal, onProposalSent, handleStripeEvent, onboard, markDelivered, markLost, createDeal, unsupportedNumbers };
}

module.exports = { createDeals, unsupportedNumbers, PROPOSAL_TOOL };
