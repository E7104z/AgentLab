/* AgentLab dashboard. All untrusted text (emails, names) is rendered with textContent only. */
(function () {
  const $ = (id) => document.getElementById(id);
  let clientId = localStorage.getItem('agentlab.client') || 'default';

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return e;
  }
  const fmt = (d) => (d ? new Date(d).toLocaleString() : '');
  const money = (c) => (c || c === 0 ? '$' + (c / 100).toLocaleString() : '');

  async function api(method, path, body) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch('/api' + path + sep + 'client=' + encodeURIComponent(clientId), {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }
  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), 4000);
  }
  const act = (fn) => async (ev) => {
    const b = ev && ev.currentTarget;
    if (b) b.disabled = true;
    try {
      await fn();
    } catch (err) {
      toast(err.message);
    } finally {
      if (b) b.disabled = false;
    }
  };
  function kv(target, pairs) {
    target.replaceChildren(...pairs.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
  }
  const pillClass = (s) => ({ sent: 'ok', pending_review: 'warn', held: 'warn', failed: 'bad', suppressed: 'bad', won: 'ok', delivered: 'ok', lost: 'bad' }[s] || '');

  // ---------- header ----------
  async function loadHeader() {
    const [cfg, clients] = await Promise.all([api('GET', '/config'), api('GET', '/clients')]);
    const sel = $('clientSelect');
    sel.replaceChildren(...clients.map((c) => el('option', { value: c.id, selected: c.id === clientId }, `${c.businessName} (${c.sendMode})`)));
    const current = clients.find((c) => c.id === clientId) || clients[0];
    $('clientName').textContent = current ? '· ' + current.businessName : '';
    $('agentBadge').textContent = cfg.agentEnabled ? 'Agent ON' : 'Agent OFF';
    $('agentBadge').className = 'badge ' + (cfg.agentEnabled ? 'on' : 'off');
    $('toggleBtn').textContent = cfg.agentEnabled ? 'Turn off' : 'Turn on';
    $('toggleBtn').dataset.on = cfg.agentEnabled ? '1' : '';
    return { cfg, current };
  }

  // ---------- overview ----------
  async function loadOverview() {
    const { cfg, current } = await loadHeader();
    kv($('statusList'), [
      ['Agent', cfg.agentEnabled ? 'ON' : 'OFF (no automatic actions)'],
      ['Send mode', current ? current.sendMode : ''],
      ['Mailbox', current ? (current.mailboxAuthorized ? current.mailbox + ' (authorized)' : current.mailbox + ' (NOT authorized)') : ''],
      ['Inbox polling', cfg.pollEnabled ? `every ${Math.round(cfg.pollIntervalMs / 1000)}s` : 'off'],
      ['Last inbox check', cfg.lastPollOk ? fmt(cfg.lastPollOk.at) : 'never'],
      ['Last error', cfg.lastPollError ? `${fmt(cfg.lastPollError.at)}: ${cfg.lastPollError.error}` : 'none'],
      ['Models', `${cfg.model} / ${cfg.modelWriter}`],
      ['Stripe', cfg.stripe],
    ]);
    const s = await api('GET', '/scorecard?days=7');
    kv($('scoreList'), [
      ['Leads', s.leads],
      ['Median first reply', s.medianFirstReplyMs === null ? 'n/a' : Math.round(s.medianFirstReplyMs / 60000) + ' min'],
      ['Calls booked', `${s.booked} (${s.leadToBooked})`],
      ['Won', `${s.won} (${s.bookedToWon}), ${money(s.wonCents)}`],
      ['Monthly recurring', `${money(s.mrrCents)} from ${s.activeMonthly}`],
      ['Open tasks', s.openTasks],
    ]);
    const d = await api('GET', '/digest-preview');
    $('digest').textContent = d.body;
  }

  // ---------- review ----------
  async function loadReview() {
    const rows = await api('GET', '/review');
    $('reviewCount').textContent = rows.filter((r) => r.status === 'pending_review').length || '';
    $('reviewList').replaceChildren(
      ...(rows.length
        ? rows.map((r) => {
            const subject = el('input', { value: r.subject });
            const body = el('textarea', { rows: 8 });
            body.value = r.body;
            const buttons =
              r.status === 'pending_review'
                ? [
                    el('button', { class: 'btn primary', onclick: act(async () => { await api('POST', `/review/${r.id}/approve`, { subject: subject.value, body: body.value }); toast('Sent'); loadReview(); }) }, 'Send'),
                    el('button', { class: 'btn danger', onclick: act(async () => { await api('POST', `/review/${r.id}/discard`); toast('Discarded'); loadReview(); }) }, 'Discard'),
                  ]
                : [
                    el('button', { class: 'btn', onclick: act(async () => { await api('POST', `/review/${r.id}/retry`); toast('Queued'); loadReview(); }) }, 'Retry / queue'),
                    el('button', { class: 'btn danger', onclick: act(async () => { await api('POST', `/review/${r.id}/discard`); loadReview(); }) }, 'Discard'),
                  ];
            return el(
              'div',
              { class: 'item' },
              el('div', { class: 'meta' }, `${r.kind} → ${r.to_email}${r.contact_name ? ' (' + r.contact_name + ')' : ''} · ${fmt(r.created_at)}`, el('span', { class: 'pill ' + pillClass(r.status) }, r.status)),
              r.reason ? el('div', { class: 'meta' }, 'Why: ' + r.reason) : null,
              r.error ? el('div', { class: 'meta' }, 'Error: ' + r.error) : null,
              el('label', {}, 'Subject', subject),
              el('label', {}, 'Body', body),
              el('div', { class: 'actions' }, buttons)
            );
          })
        : [el('div', { class: 'empty' }, 'Nothing waiting for review.')])
    );
  }

  // ---------- tasks ----------
  async function loadTasks() {
    const rows = await api('GET', '/tasks');
    $('taskCount').textContent = rows.length || '';
    $('taskList').replaceChildren(
      ...(rows.length
        ? rows.map((t) =>
            el(
              'div',
              { class: 'item' },
              el('h3', {}, t.title),
              el('div', { class: 'meta' }, `${t.kind}${t.due_at ? ' · due ' + fmt(t.due_at) : ''} · ${fmt(t.created_at)}`),
              t.details ? el('pre', { class: 'pre' }, t.details) : null,
              el('div', { class: 'actions' }, el('button', { class: 'btn', onclick: act(async () => { await api('POST', `/tasks/${t.id}/done`); loadTasks(); }) }, 'Done'))
            )
          )
        : [el('div', { class: 'empty' }, 'No open tasks.')])
    );
  }

  // ---------- pipeline ----------
  function dealActions(d, refresh) {
    const notes = el('textarea', { rows: 3, placeholder: '3 lines of call notes: their business, the chore, what they want' });
    notes.value = d.call_notes || '';
    const offer = el('select', {}, el('option', { value: 'quick_fix', selected: d.offer !== 'custom' }, 'The Quick Fix ($500 + $30/mo)'), el('option', { value: 'custom', selected: d.offer === 'custom' }, 'Custom Build'));
    const amount = el('input', { type: 'number', min: '1', step: '1', placeholder: 'Custom price in dollars', value: d.offer === 'custom' && d.amount_cents ? d.amount_cents / 100 : '' });
    const monthly = el('input', { type: 'number', min: '0', step: '1', placeholder: 'Custom monthly in dollars (optional)', value: d.offer === 'custom' && d.monthly_cents ? d.monthly_cents / 100 : '' });
    const happy = el('input', { type: 'checkbox' });
    const save = () =>
      api('POST', `/deals/${d.id}/notes`, {
        notes: notes.value,
        offer: offer.value,
        amountCents: amount.value ? Math.round(Number(amount.value) * 100) : undefined,
        monthlyCents: monthly.value ? Math.round(Number(monthly.value) * 100) : undefined,
      });
    const out = [];
    if (['booked', 'call_done', 'proposal_draft', 'proposal_sent'].includes(d.stage)) {
      out.push(
        el('label', {}, 'Call notes', notes),
        el('div', { class: 'row' }, offer, amount, monthly),
        el('div', { class: 'actions' },
          el('button', { class: 'btn', onclick: act(async () => { await save(); toast('Notes saved'); refresh(); }) }, 'Save notes'),
          el('button', { class: 'btn primary', onclick: act(async () => { await save(); await api('POST', `/deals/${d.id}/proposal`); toast('Proposal drafted. Check the doc, then send it from Review.'); refresh(); }) }, 'Draft proposal'),
          el('button', { class: 'btn', onclick: act(async () => { await api('POST', `/deals/${d.id}/no-show`); toast('Reschedule email queued'); }) }, 'No-show'),
          el('button', { class: 'btn danger', onclick: act(async () => { await api('POST', `/deals/${d.id}/lost`); refresh(); }) }, 'Mark lost')
        )
      );
    }
    if (d.stage === 'won') {
      out.push(
        el('label', {}, el('span', {}, happy, ' Client is happy (allow the review request)')),
        el('div', { class: 'actions' }, el('button', { class: 'btn primary', onclick: act(async () => { await api('POST', `/deals/${d.id}/delivered`, { happy: happy.checked }); toast('Marked delivered'); refresh(); }) }, 'Mark delivered'))
      );
    }
    return out;
  }

  async function loadPipeline() {
    const rows = await api('GET', '/pipeline');
    $('pipelineList').replaceChildren(
      ...(rows.length
        ? rows.map((d) =>
            el(
              'div',
              { class: 'item' },
              el('h3', {}, `${d.name || d.email}${d.business ? ' · ' + d.business : ''}`, el('span', { class: 'pill ' + pillClass(d.stage) }, d.stage)),
              el('div', { class: 'meta' }, [d.email, d.booking_start ? 'call ' + fmt(d.booking_start) : null, d.amount_cents ? money(d.amount_cents) + (d.monthly_cents ? ' + ' + money(d.monthly_cents) + '/mo' : '') : null].filter(Boolean).join(' · ')),
              d.proposal_url ? el('div', {}, el('a', { href: d.proposal_url, target: '_blank', rel: 'noopener' }, 'Proposal doc'), ' · ', el('a', { href: d.checkout_url, target: '_blank', rel: 'noopener' }, 'Checkout link')) : null,
              dealActions(d, loadPipeline)
            )
          )
        : [el('div', { class: 'empty' }, 'No deals yet. Deals open when a call is booked, or from a contact.')])
    );
  }

  // ---------- contacts ----------
  async function loadContacts() {
    const status = $('contactStatus').value;
    const rows = await api('GET', '/contacts' + (status ? '?status=' + encodeURIComponent(status) : ''));
    $('contactList').replaceChildren(
      el(
        'table',
        {},
        el('thead', {}, el('tr', {}, ['Name', 'Email / phone', 'Business', 'Source', 'Status', 'Added'].map((h) => el('th', {}, h)))),
        el(
          'tbody',
          {},
          rows.map((c) =>
            el(
              'tr',
              { class: 'click', onclick: () => showContact(c.id) },
              el('td', {}, c.name || ''),
              el('td', {}, c.email || c.phone || ''),
              el('td', {}, c.business || ''),
              el('td', {}, c.ref || c.source || ''),
              el('td', {}, c.status, c.do_not_email ? el('span', { class: 'pill bad' }, 'no email') : null),
              el('td', {}, fmt(c.created_at))
            )
          )
        )
      )
    );
  }

  async function showContact(id) {
    const d = await api('GET', '/contacts/' + id);
    const box = $('contactDetail');
    box.hidden = false;
    box.replaceChildren(
      el('h2', {}, d.contact.name || d.contact.email || 'Contact'),
      el('dl', { class: 'kv' }, ...[['Email', d.contact.email], ['Phone', d.contact.phone], ['Business', d.contact.business], ['Chore', d.contact.chore], ['Ref', d.contact.ref], ['Referral code', d.contact.ref_code]].filter(([, v]) => v).flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])),
      el('h3', {}, 'Conversation'),
      ...(d.messages.length ? d.messages.map((m) => el('div', { class: 'msg ' + m.direction }, el('div', { class: 'meta' }, `${m.direction === 'in' ? 'Them' : 'Us'} · ${fmt(m.created_at)}${m.category ? ' · ' + m.category : ''}`), el('div', { class: 'pre' }, m.body || ''))) : [el('div', { class: 'muted' }, 'No email yet.')]),
      el('h3', {}, 'Follow-ups'),
      ...(d.enrollments.length ? d.enrollments.map((e) => el('div', { class: 'meta' }, `${e.sequence_key}: step ${e.step}, ${e.status}${e.stop_reason ? ' (' + e.stop_reason + ')' : ''}${e.next_run_at ? ', next ' + fmt(e.next_run_at) : ''}`)) : [el('div', { class: 'muted' }, 'None')]),
      el(
        'div',
        { class: 'actions' },
        d.deal ? el('span', { class: 'pill' }, 'Deal: ' + d.deal.stage) : el('button', { class: 'btn', onclick: act(async () => { await api('POST', `/contacts/${id}/deal`); toast('Deal opened. See Pipeline.'); showContact(id); }) }, 'Open a deal'),
        d.contact.do_not_email ? null : el('button', { class: 'btn danger', onclick: act(async () => { await api('POST', `/contacts/${id}/suppress`); toast('Opted out'); showContact(id); }) }, 'Opt out of email')
      )
    );
    box.scrollIntoView({ behavior: 'smooth' });
  }

  // ---------- test + activity ----------
  async function runTest() {
    const r = await api('POST', '/run-agent', { clientId, leadName: $('tName').value, leadEmail: $('tEmail').value, subject: $('tSubject').value, inquiry: $('tBody').value });
    $('tOut').textContent = JSON.stringify(r, null, 2);
  }

  async function loadActivity() {
    const [log, out] = await Promise.all([api('GET', '/poll-log'), api('GET', '/outbox')]);
    $('pollLog').replaceChildren(
      ...(log.length ? log.map((l) => el('div', { class: 'meta' }, `${fmt(l.time)} · ${l.mailbox || ''} · ${l.from || ''} · ${l.subject || ''} → ${JSON.stringify(l.result || l.error)}`)) : [el('div', { class: 'empty' }, 'No inbox checks yet.')])
    );
    $('outboxList').replaceChildren(
      el('table', {}, el('thead', {}, el('tr', {}, ['When', 'Kind', 'To', 'Subject', 'Status'].map((h) => el('th', {}, h)))), el('tbody', {}, out.map((o) => el('tr', {}, el('td', {}, fmt(o.sent_at || o.created_at)), el('td', {}, o.kind), el('td', {}, o.to_email), el('td', {}, o.subject), el('td', {}, el('span', { class: 'pill ' + pillClass(o.status) }, o.status))))))
    );
  }

  // ---------- wiring ----------
  const loaders = { overview: loadOverview, review: loadReview, tasks: loadTasks, pipeline: loadPipeline, contacts: loadContacts, test: async () => {}, activity: loadActivity };
  let current = 'overview';
  function show(tab) {
    current = tab;
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab').forEach((s) => (s.hidden = s.id !== 'tab-' + tab));
    loaders[tab]().catch((e) => toast(e.message));
  }
  document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
  $('toggleBtn').addEventListener('click', act(async () => {
    const on = !$('toggleBtn').dataset.on;
    if (!on && !confirm('Turn the agent OFF? Nothing will be sent or checked until it is turned back on.')) return;
    await api('POST', '/agent-toggle', { enabled: on });
    toast(on ? 'Agent is ON' : 'Agent is OFF');
    show(current);
  }));
  $('clientSelect').addEventListener('change', (e) => {
    clientId = e.target.value;
    localStorage.setItem('agentlab.client', clientId);
    show(current);
  });
  $('contactStatus').addEventListener('change', () => loadContacts().catch((e) => toast(e.message)));
  $('tRun').addEventListener('click', act(runTest));
  $('pollNow').addEventListener('click', act(async () => { await api('POST', '/poll-now'); loadActivity(); }));

  show('overview');
  Promise.all([loadReview(), loadTasks()]).catch(() => {});
  setInterval(() => { if (!document.hidden && ['overview', 'review', 'tasks', 'activity'].includes(current)) loaders[current]().catch(() => {}); }, 30000);
})();
