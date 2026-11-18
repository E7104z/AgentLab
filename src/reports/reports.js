/** Daily digest, weekly scorecard and per-client weekly reports, all from real records. */
const { localParts, formatMoney } = require('../lib/util');

function minutes(ms) {
  if (ms === null || ms === undefined) return 'n/a';
  const m = Math.round(ms / 60000);
  return m < 120 ? `${m} min` : `${(m / 60).toFixed(1)} h`;
}

function createReports({ db, outbox, getClient, clients, config, sheets = null, clock = () => new Date() }) {
  async function scorecard(clientId, sinceDays = 7) {
    const since = new Date(clock().getTime() - sinceDays * 86400000);
    const leadsBySource = await db.many(
      `SELECT COALESCE(NULLIF(c.ref,''), c.source, 'unknown') AS source, count(*)::int AS n
       FROM contacts c WHERE c.client_id=$1 AND c.created_at >= $2 GROUP BY 1 ORDER BY 2 DESC`,
      [clientId, since]
    );
    const leads = leadsBySource.reduce((a, r) => a + r.n, 0);
    const resp = await db.one(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_sent - c.created_at) * 1000) AS median_ms
       FROM contacts c
       JOIN LATERAL (SELECT min(o.sent_at) AS first_sent FROM outbox o
                     WHERE o.client_id=c.client_id AND o.contact_id=c.id AND o.status='sent' AND o.policy <> 'internal') f ON f.first_sent IS NOT NULL
       WHERE c.client_id=$1 AND c.created_at >= $2`,
      [clientId, since]
    );
    const replied = await db.one(
      `SELECT count(DISTINCT contact_id)::int AS n FROM messages WHERE client_id=$1 AND direction='in' AND created_at >= $2 AND contact_id IS NOT NULL`,
      [clientId, since]
    );
    const booked = await db.one(`SELECT count(*)::int AS n FROM deals WHERE client_id=$1 AND created_at >= $2`, [clientId, since]);
    const won = await db.one(`SELECT count(*)::int AS n, COALESCE(sum(amount_cents),0)::int AS cents FROM deals WHERE client_id=$1 AND won_at >= $2`, [clientId, since]);
    const mrr = await db.one(
      `SELECT COALESCE(sum(monthly_cents),0)::int AS cents, count(*)::int AS n FROM deals
       WHERE client_id=$1 AND stage IN ('won','delivered') AND monthly_cents IS NOT NULL`,
      [clientId]
    );
    const openTasks = await db.one(`SELECT count(*)::int AS n FROM tasks WHERE client_id=$1 AND status='open'`, [clientId]);
    const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : 'n/a');
    return {
      since,
      leads,
      leadsBySource,
      medianFirstReplyMs: resp && resp.median_ms !== null ? Number(resp.median_ms) : null,
      repliedContacts: replied.n,
      booked: booked.n,
      won: won.n,
      wonCents: won.cents,
      mrrCents: mrr.cents,
      activeMonthly: mrr.n,
      openTasks: openTasks.n,
      leadToBooked: pct(booked.n, leads),
      bookedToWon: pct(won.n, booked.n),
    };
  }

  async function dailyDigest(clientId) {
    const client = getClient(clientId);
    const since = new Date(clock().getTime() - 86400000);
    const newLeads = await db.many(
      `SELECT name, email, phone, business, COALESCE(NULLIF(ref,''), source) AS source FROM contacts WHERE client_id=$1 AND created_at >= $2 ORDER BY created_at`,
      [clientId, since]
    );
    const sent = await db.one(`SELECT count(*)::int AS n FROM outbox WHERE client_id=$1 AND status='sent' AND policy<>'internal' AND sent_at >= $2`, [clientId, since]);
    const review = await db.one(`SELECT count(*)::int AS n FROM outbox WHERE client_id=$1 AND status='pending_review'`, [clientId]);
    const held = await db.one(`SELECT count(*)::int AS n FROM outbox WHERE client_id=$1 AND status='held'`, [clientId]);
    const failed = await db.one(
      `SELECT (SELECT count(*) FROM outbox WHERE client_id=$1 AND status='failed' AND updated_at >= $2)::int +
              (SELECT count(*) FROM messages WHERE client_id=$1 AND status='failed' AND created_at >= $2)::int AS n`,
      [clientId, since]
    );
    const tasks = await db.many(`SELECT title FROM tasks WHERE client_id=$1 AND status='open' ORDER BY due_at NULLS LAST, created_at LIMIT 15`, [clientId]);
    const p = localParts(clock(), client.timezone);
    const calls = await db.many(
      `SELECT d.booking_start, c.name, c.email FROM deals d JOIN contacts c ON c.id=d.contact_id
       WHERE d.client_id=$1 AND d.booking_start IS NOT NULL
         AND to_char(d.booking_start AT TIME ZONE $2, 'YYYY-MM-DD') = $3 ORDER BY d.booking_start`,
      [clientId, client.timezone, p.dateKey]
    );
    const lastPoll = await db.getState('health:lastPollOk');
    const lastErr = await db.getState('health:lastPollError');

    const lines = [
      `Daily digest for ${client.businessName}`,
      '',
      `New leads (24h): ${newLeads.length}`,
      ...newLeads.map((l) => `  - ${l.name || '(no name)'} ${l.email || l.phone || ''}${l.business ? ' | ' + l.business : ''} [${l.source || 'unknown'}]`),
      `Replies sent (24h): ${sent.n}`,
      `Waiting for your review: ${review.n}`,
      held.n ? `Held while the agent was off: ${held.n}` : null,
      `Failed items (24h): ${failed.n}`,
      '',
      `Today's calls: ${calls.length}`,
      ...calls.map((c) => `  - ${new Intl.DateTimeFormat('en-US', { timeZone: client.timezone, hour: 'numeric', minute: '2-digit' }).format(new Date(c.booking_start))} ${c.name || ''} <${c.email}>`),
      '',
      `Open tasks: ${tasks.length}`,
      ...tasks.map((t) => `  - ${t.title}`),
      '',
      `System: last successful inbox check ${lastPoll ? lastPoll.at : 'never'}${lastErr && (!lastPoll || lastErr.at > lastPoll.at) ? ` | last error: ${lastErr.error}` : ' | all systems OK'}`,
      config.appBaseUrl ? `Dashboard: ${config.appBaseUrl}` : null,
    ].filter((l) => l !== null);
    return { subject: `Daily digest: ${newLeads.length} new lead${newLeads.length === 1 ? '' : 's'}, ${review.n} to review`, body: lines.join('\n') };
  }

  function scorecardText(client, s) {
    return [
      `Weekly scorecard for ${client.businessName} (since ${s.since.toISOString().slice(0, 10)})`,
      '',
      `Leads: ${s.leads}`,
      ...s.leadsBySource.map((r) => `  - ${r.source}: ${r.n}`),
      `Median time to first reply: ${minutes(s.medianFirstReplyMs)}`,
      `Calls booked: ${s.booked} (${s.leadToBooked} of leads)`,
      `Won: ${s.won} (${s.bookedToWon} of booked), ${formatMoney(s.wonCents)} one-time`,
      `Monthly recurring revenue: ${formatMoney(s.mrrCents)} from ${s.activeMonthly} active client${s.activeMonthly === 1 ? '' : 's'}`,
      `Open tasks: ${s.openTasks}`,
    ].join('\n');
  }

  async function clientReport(clientId) {
    const client = getClient(clientId);
    const s = await scorecard(clientId, 7);
    return {
      subject: `Your weekly lead report from The Real Help`,
      body: [
        `Hi,`,
        '',
        `Here's what your AI assistant handled for ${client.businessName} this week:`,
        `- New inquiries answered: ${s.leads}`,
        `- Median time to first reply: ${minutes(s.medianFirstReplyMs)}`,
        `- Calls or appointments booked: ${s.booked}`,
        '',
        'Questions or tweaks? Just reply.',
      ].join('\n'),
    };
  }

  /** Called every tick. Sends each report once per local day / week at 7 a.m. in the client's timezone. */
  async function runScheduled() {
    const sent = [];
    for (const client of clients) {
      if (client.demo) continue;
      const p = localParts(clock(), client.timezone || 'America/Chicago');
      if (p.hour !== 7) continue;
      const dKey = `digest:${client.id}:${p.dateKey}`;
      if (!(await db.getState(dKey))) {
        const d = await dailyDigest(client.id);
        await outbox.notifyOwner(client.id, { subject: d.subject, body: d.body, dedupeKey: dKey, kind: 'digest' });
        await db.setState(dKey, { at: clock().toISOString() });
        sent.push(dKey);
      }
      if (p.weekday === 1) {
        const wKey = `scorecard:${client.id}:${p.dateKey}`;
        if (!(await db.getState(wKey))) {
          const s = await scorecard(client.id, 7);
          await outbox.notifyOwner(client.id, { subject: `Weekly scorecard: ${s.leads} leads, ${s.booked} booked, ${s.won} won`, body: scorecardText(client, s), dedupeKey: wKey, kind: 'scorecard' });
          if (sheets && config.scorecardSheetId && client.id === 'default') {
            try {
              await sheets.appendRow(config.scorecardSheetId, 'Scorecard', [
                p.dateKey, s.leads, minutes(s.medianFirstReplyMs), s.booked, s.won, s.wonCents / 100, s.mrrCents / 100, s.openTasks,
              ]);
            } catch (err) {
              await db.audit('system', 'scorecard.sheet_failed', { error: err.message }, client.id);
            }
          }
          if (client.reportEmail) {
            const r = await clientReport(client.id);
            await outbox.enqueue(client.id, { kind: 'client_report', to: client.reportEmail, subject: r.subject, body: r.body, policy: 'internal', dedupeKey: `client_report:${client.id}:${p.dateKey}` });
          }
          await db.setState(wKey, { at: clock().toISOString() });
          sent.push(wKey);
        }
      }
    }
    return sent;
  }

  /** Heartbeat: alert once per outage if no successful inbox check for 15 minutes while polling is on. */
  async function heartbeat({ pollingActive }) {
    if (!pollingActive) return null;
    const last = await db.getState('health:lastPollOk');
    const started = await db.getState('health:startedAt');
    const ref = last ? Date.parse(last.at) : started ? Date.parse(started.at) : clock().getTime();
    if (clock().getTime() - ref < 15 * 60000) return null;
    const anyClient = clients.find((c) => !c.demo) || clients[0];
    const key = `alert:heartbeat:${new Date(ref).toISOString().slice(0, 13)}`;
    await outbox.notifyOwner(anyClient.id, {
      subject: 'Inbox checks have stopped',
      body: `No successful inbox check since ${last ? last.at : 'startup'}. Last error: ${((await db.getState('health:lastPollError')) || {}).error || 'none recorded'}.`,
      dedupeKey: key,
    });
    return key;
  }

  return { scorecard, dailyDigest, clientReport, scorecardText, runScheduled, heartbeat };
}

module.exports = { createReports };
