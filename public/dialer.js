(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = async (path, opts = {}) => {
    const res = await fetch('/api/dialer' + path, { headers: opts.body && !(opts.body instanceof Blob) && !(opts.body instanceof ArrayBuffer) ? { 'Content-Type': 'application/json' } : (opts.headers || {}), ...opts });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  };
  let toastTimer;
  const toast = (msg, err) => {
    let t = document.querySelector('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
    t.className = 'toast' + (err ? ' err' : '');
    t.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), err ? 5000 : 2200);
  };

  // Keyboard order for outcome buttons: 1-9 then 0.
  const OUTCOME_ORDER = ['no_answer', 'voicemail', 'gatekeeper', 'callback', 'interested', 'meeting_booked', 'closed_won', 'not_interested', 'bad_number', 'dnc'];
  const OUTCOME_STYLE = { interested: 'good', meeting_booked: 'good', closed_won: 'good', not_interested: 'bad', bad_number: 'bad', dnc: 'bad' };
  const STATUS_LABEL = { new: 'New', exhausted: 'Retired (max tries)' };
  let OUTCOMES = {};
  let settings = {};
  let lead = null;
  let recentIds = [];          // avoid re-serving the last few leads
  let callStart = null, timerInt = null;
  let pendingOutcome = null;
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (window.matchMedia && matchMedia('(pointer: coarse)').matches);

  // ---------- Tabs ----------
  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
  function showTab(name) {
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('section[id^="tab-"]').forEach(s => s.classList.toggle('hidden', s.id !== 'tab-' + name));
    if (name === 'pipeline') loadPipeline();
    if (name === 'import') loadImports();
    if (name === 'stats') loadStats();
    if (name === 'settings') fillSettings();
  }

  // ---------- Filters ----------
  const FILTER_KEYS = { source: 'fSource', state: 'fState', city: 'fCity', county: 'fCounty', ethnicity: 'fEthnicity', keyword: 'fKeyword' };
  function filterQuery() {
    const p = new URLSearchParams();
    for (const [k, id] of Object.entries(FILTER_KEYS)) { const v = $(id).value.trim(); if (v) p.set(k, v); }
    if (recentIds.length) p.set('exclude', recentIds.join(','));
    return p.toString();
  }
  function saveFilters() {
    const f = {}; for (const [k, id] of Object.entries(FILTER_KEYS)) f[k] = $(id).value;
    try { localStorage.setItem('dialerFilters', JSON.stringify(f)); } catch (e) {}
  }
  async function loadFilterOptions() {
    const o = await api('/filters');
    const fill = (id, list, all) => {
      const cur = $(id).value;
      $(id).innerHTML = '<option value="">' + all + '</option>' + list.map(x => '<option value="' + esc(x.value) + '">' + esc(x.value) + ' (' + x.count + ')</option>').join('');
      $(id).value = cur;
    };
    fill('fSource', o.sources, 'All lists');
    fill('fState', o.states, 'All states');
    fill('fCity', o.cities, 'All cities');
    fill('fCounty', o.counties, 'All counties');
    fill('fEthnicity', o.ethnicities, 'All owners');
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('dialerFilters') || '{}'); } catch (e) {}
    for (const [k, id] of Object.entries(FILTER_KEYS)) if (saved[k] && !$(id).value) $(id).value = saved[k];
  }
  ['fSource', 'fState', 'fCity', 'fCounty', 'fEthnicity'].forEach(id => $(id).addEventListener('change', () => { saveFilters(); next(true); }));
  $('fKeyword').addEventListener('keydown', e => { if (e.key === 'Enter') { saveFilters(); next(true); $('fKeyword').blur(); } });
  $('filterToggle').addEventListener('click', () => $('filtersBox').classList.toggle('open'));
  $('clearFilters').addEventListener('click', () => { for (const id of Object.values(FILTER_KEYS)) $(id).value = ''; saveFilters(); next(true); });

  // ---------- Lead card ----------
  function fmtDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function fmtDur(sec) { sec = Math.round(sec || 0); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); }
  function outcomeLabel(o) { return o === 'note' ? 'Note' : (OUTCOMES[o] ? OUTCOMES[o].label : (STATUS_LABEL[o] || o)); }

  function renderLead(l, reason, queue) {
    lead = l;
    stopTimer();
    $('timer').textContent = '';
    $('notes').value = '';
    closeExtra();
    $('emptyState').classList.add('hidden');
    $('dialView').classList.remove('hidden');
    const reasonText = { new: 'Fresh lead', retry: 'Retry #' + ((l.attempts || 0) + 1), callback_due: 'Callback due ' + fmtDate(l.callbackAt), opened: 'Opened manually' }[reason] || '';
    $('leadReason').innerHTML = reasonText ? '<span class="badge ' + (reason === 'callback_due' ? 'amber' : reason === 'retry' ? 'blue' : 'green') + '">' + esc(reasonText) + '</span>' : '';
    $('lBiz').textContent = l.businessName || '(no business name)';
    $('lContact').innerHTML = l.contactName ? esc(l.contactName) + (l.firstName ? ' <span class="dim">&middot; ask for ' + esc(l.firstName) + '</span>' : '') : '<span class="dim">No contact name &mdash; ask for the owner</span>';
    const b = [];
    b.push('<span class="badge">' + esc(outcomeLabel(l.status)) + '</span>');
    if (l.attempts) b.push('<span class="badge">' + l.attempts + ' call' + (l.attempts > 1 ? 's' : '') + '</span>');
    if (l.certification) b.push('<span class="badge">' + esc(l.certification.length > 40 ? l.certification.replace(/.*\((\w+)\).*/, '$1') : l.certification) + '</span>');
    for (const s of (l.sources || [])) b.push('<span class="badge">' + esc(s) + '</span>');
    if (l.status === 'dnc') b.push('<span class="badge red">DO NOT CALL</span>');
    $('lBadges').innerHTML = b.join('');
    $('lPhone').textContent = l.phone || '';
    $('callBtn').textContent = 'Call';
    $('callBtn').classList.remove('live');
    $('callBtn').disabled = l.status === 'dnc';
    $('lLocal').textContent = 'Their time ' + (l.localTime || '');
    const rows = [
      ['Alt phone', l.phoneAlt], ['Email', l.email], ['Website', l.website],
      ['Address', [l.address, [l.city, l.state].filter(Boolean).join(', '), l.zip].filter(Boolean).join(' ')],
      ['County', l.county], ['Industry', l.industry], ['Codes', l.codes],
      ['Cert expires', l.certExpires], ['Owner', [l.ownerGender, l.ownerEthnicity].filter(Boolean).join(', ')]
    ];
    for (const [k, v] of Object.entries(l.extra || {})) rows.push([k, v]);
    if (l.callbackAt) rows.unshift(['Callback', fmtDate(l.callbackAt)]);
    if (l.meetingAt) rows.unshift(['Meeting', fmtDate(l.meetingAt)]);
    $('lDetails').innerHTML = rows.filter(r => r[1]).map(([k, v]) => {
      let val = esc(v);
      if (k === 'Email') val = '<a href="mailto:' + esc(v) + '">' + esc(v) + '</a>';
      if (k === 'Website') val = '<a href="' + esc(/^https?:/i.test(v) ? v : 'https://' + v) + '" target="_blank" rel="noopener">' + esc(v) + '</a>';
      return '<dt>' + esc(k) + '</dt><dd>' + val + '</dd>';
    }).join('');
    const calls = l.calls || [];
    $('lHistory').innerHTML = calls.length
      ? '<div class="panel-label" style="margin-bottom:6px"><span>History</span></div>' + calls.map(c =>
          '<div class="h-item"><span class="when">' + esc(fmtDate(c.at)) + '</span><span class="what">' + esc(outcomeLabel(c.outcome)) + '</span>' +
          (c.durationSec ? ' <span class="dim mono" style="font-size:11px">' + fmtDur(c.durationSec) + '</span>' : '') +
          (c.callbackAt && c.outcome !== 'note' ? ' <span class="dim" style="font-size:11.5px">&rarr; ' + esc(fmtDate(c.callbackAt)) + '</span>' : '') +
          (c.note ? '<div class="note">' + esc(c.note) + '</div>' : '') + '</div>').join('')
      : '<div class="dim" style="font-size:12.5px">No calls yet. First touch.</div>';
    if (queue) $('queueLine').textContent = queue.matching + ' leads match · ' + queue.fresh + ' never called · ' + queue.retryLater + ' waiting on retry · ' + queue.callbacks + ' with a callback set';
    loadScript();
    remember(l.id);
    setTimeout(prefetchNext, 300);
  }

  function remember(id) {
    recentIds = [id, ...recentIds.filter(x => x !== id)].slice(0, 15);
  }

  async function loadScript() {
    try {
      const r = await api('/render', { method: 'POST', body: JSON.stringify({ leadId: lead && lead.id }) });
      $('script').innerHTML = esc(r.script).split('\n').map(line =>
        /^[A-Z]{3,}\b/.test(line.trim()) && !/[.?]/.test(line) ? '<span class="h">' + line + '</span>' : line).join('\n');
    } catch (e) { $('script').textContent = ''; }
    loadAiScript(false);
  }

  // ---------- Personalized AI script ----------
  const AI_MODE = { website: 'from their website', search: 'from a web search', list: 'from the list info only' };
  let aiSeq = 0;
  function renderAi(ai) {
    const box = $('aiBox');
    const row = (label, text) => text ? '<span class="lbl">' + label + '</span><div class="say">' + esc(text) + '</div>' : '';
    const hook = ai.hook
      ? '<div class="hook">Hook: ' + esc(ai.hook) + (ai.hookEvidence ? ' <span class="src">(' + esc(ai.hookEvidence) + ')</span>' : '') + '</div>'
      : '<div class="hook"><span class="src">No specific finding on this one, so it is written from the business type.</span></div>';
    const objs = (ai.objections || []).map(o => '<div class="obj"><b>' + esc(o.they_say) + '</b> &rarr; ' + esc(o.you_say) + '</div>').join('');
    box.innerHTML =
      '<div class="bar"><span class="dim" style="font-size:11.5px">Personalized ' + esc(AI_MODE[ai.mode] || '') + '</span><button class="qbtn" id="aiRegen">Rewrite</button></div>' +
      hook + row('OPENER', ai.opener) + row('ASK', ai.q1) + row('THEN', ai.q2) + row('BRIDGE', ai.bridge) +
      (objs ? '<span class="lbl">IF THEY SAY</span>' + objs : '') +
      (ai.voicemail ? '<details><summary>VOICEMAIL</summary><div class="say">' + esc(ai.voicemail) + '</div></details>' : '') +
      (ai.sourceUrl ? '<div class="dim" style="font-size:11.5px;margin-top:8px">Source: <a href="' + esc(ai.sourceUrl) + '" target="_blank" rel="noopener">' + esc(ai.sourceUrl) + '</a></div>' : '');
    box.classList.remove('hidden');
    $('aiRegen').addEventListener('click', () => loadAiScript(true));
  }
  async function loadAiScript(force) {
    const box = $('aiBox');
    if (!lead || !settings.aiScripts) { box.classList.add('hidden'); return; }
    const id = lead.id, seq = ++aiSeq;
    box.classList.remove('hidden');
    box.innerHTML = '<span class="dim" style="font-size:12.5px">Writing a personalized script&hellip;</span>';
    try {
      const r = await api('/lead/' + id + '/ai-script', { method: 'POST', body: JSON.stringify({ force: !!force }) });
      if (seq !== aiSeq || !lead || lead.id !== id) return;
      if (r.ai) renderAi(r.ai);
      else if (r.reason === 'no_key') box.innerHTML = '<span class="dim" style="font-size:12.5px">AI scripts are off: no Anthropic key is set on the server. Using the standard script.</span>';
      else if (r.reason === 'cap') box.innerHTML = '<span class="dim" style="font-size:12.5px">Daily AI script limit reached. Using the standard script.</span>';
      else box.classList.add('hidden');
    } catch (e) { if (seq === aiSeq) box.classList.add('hidden'); }
  }

  // Write the next lead's script while you are on the current call.
  let queued = null;
  function filterSig() { const p = new URLSearchParams(filterQuery()); p.delete('exclude'); return p.toString(); }
  async function prefetchNext() {
    queued = null;
    if (!lead || !settings.aiScripts) return;
    const sig = filterSig(), from = lead.id;
    try {
      const r = await api('/next?' + filterQuery());
      if (!r.lead || !lead || lead.id !== from) return;
      queued = { r, sig };
      api('/lead/' + r.lead.id + '/ai-script', { method: 'POST', body: '{}' }).catch(() => {});
    } catch (e) {}
  }

  function showEmpty(msg, queue) {
    lead = null;
    $('dialView').classList.add('hidden');
    $('emptyState').classList.remove('hidden');
    $('emptyState').innerHTML = esc(msg) + '<br><br><button class="btn ghost" id="emptyImport">Import a list</button>';
    $('emptyImport').addEventListener('click', () => showTab('import'));
    if (queue) $('queueLine').textContent = queue.matching + ' leads match these filters';
  }

  async function next(resetRecent) {
    if (resetRecent) recentIds = lead ? [lead.id] : [];
    try {
      let r;
      if (!resetRecent && queued && queued.sig === filterSig() && queued.r.lead && !recentIds.includes(queued.r.lead.id)) r = queued.r;
      else r = await api('/next?' + filterQuery());
      queued = null;
      if (r.lead) renderLead(r.lead, r.reason, r.queue);
      else showEmpty(r.reason, r.queue);
    } catch (e) { toast(e.message, true); }
  }

  async function openLead(id) {
    try {
      const r = await api('/lead/' + encodeURIComponent(id));
      showTab('dial');
      renderLead(r.lead, 'opened');
    } catch (e) { toast(e.message, true); }
  }

  // ---------- Calling ----------
  function startTimer() {
    callStart = Date.now();
    clearInterval(timerInt);
    timerInt = setInterval(() => { $('timer').textContent = fmtDur((Date.now() - callStart) / 1000); }, 500);
    $('callBtn').textContent = 'On call';
    $('callBtn').classList.add('live');
  }
  function stopTimer() {
    clearInterval(timerInt); timerInt = null;
    const sec = callStart ? (Date.now() - callStart) / 1000 : 0;
    callStart = null;
    return sec;
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (e) {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch (e2) {} ta.remove(); return ok;
    }
  }

  async function call() {
    if (!lead || !lead.phoneDigits) return;
    if (lead.status === 'dnc') return toast('This number is on Do Not Call.', true);
    const method = settings.callMethod === 'auto' ? (isMobile ? 'tel' : 'textnow-web') : settings.callMethod;
    if (!callStart) startTimer();
    if (method === 'tel') {
      window.location.href = 'tel:+1' + lead.phoneDigits;
      return;
    }
    const ok = await copy(lead.phoneDigits);
    // Reuse one TextNow tab: open it the first time, just focus it after that.
    let w = window.open('', 'textnow');
    try {
      if (w && (w.location.href === 'about:blank' || w.location.href === '')) w.location.href = settings.textnowUrl || 'https://www.textnow.com/messaging';
    } catch (e) { /* cross-origin = TextNow already loaded in that tab */ }
    if (w) w.focus();
    toast(ok ? lead.phone + ' copied — paste it into TextNow' : 'Copy failed — dial ' + lead.phone);
  }
  $('callBtn').addEventListener('click', call);

  // ---------- Outcomes ----------
  function buildOutcomeButtons() {
    $('outcomes').innerHTML = OUTCOME_ORDER.map((key, i) =>
      '<button class="oc ' + (OUTCOME_STYLE[key] || '') + '" data-o="' + key + '"><span>' + esc(OUTCOMES[key].label) + '</span><kbd>' + ((i + 1) % 10) + '</kbd></button>').join('');
    $('outcomes').querySelectorAll('.oc').forEach(b => b.addEventListener('click', () => chooseOutcome(b.dataset.o)));
  }

  function toLocalInput(d) {
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function nextWeekday(d) { while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1); return d; }
  function quickTimes() {
    const now = new Date();
    const at = (days, h, m) => { const d = new Date(now); d.setDate(d.getDate() + days); d.setHours(h, m || 0, 0, 0); return nextWeekday(d); };
    const inH = h => { const d = new Date(now.getTime() + h * 3600000); d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0); return d; };
    return [['In 1 hour', inH(1)], ['In 3 hours', inH(3)], ['Tomorrow 9am', at(1, 9)], ['Tomorrow 1pm', at(1, 13)], ['In 2 days 10am', at(2, 10)], ['Next week', at(7, 10)]];
  }

  function chooseOutcome(key) {
    if (!lead) return;
    const needsTime = key === 'callback' || key === 'meeting_booked';
    const optionalTime = key === 'interested' || key === 'gatekeeper';
    const needsAmount = key === 'closed_won';
    if (!needsTime && !optionalTime && !needsAmount) return saveOutcome(key, {});
    pendingOutcome = key;
    $('outcomes').querySelectorAll('.oc').forEach(b => b.classList.toggle('sel', b.dataset.o === key));
    $('extraTitle').textContent = {
      callback: 'When should this lead come back up?',
      meeting_booked: 'When is the meeting?',
      interested: 'Follow-up date (optional) — they come back up then',
      gatekeeper: 'Did they give a better time to reach the owner? (optional)',
      closed_won: 'Closed! Amount'
    }[key];
    $('extraWhen').classList.toggle('hidden', needsAmount);
    $('extraAmount').classList.toggle('hidden', !needsAmount);
    $('extraAt').value = '';
    $('quickTimes').innerHTML = quickTimes().map(([label, d], i) => '<button class="qbtn" data-i="' + i + '">' + label + '</button>').join('');
    const qt = quickTimes();
    $('quickTimes').querySelectorAll('.qbtn').forEach(b => b.addEventListener('click', () => { $('extraAt').value = toLocalInput(qt[+b.dataset.i][1]); }));
    $('extraPanel').classList.remove('hidden');
    $('extraSave').textContent = key === 'meeting_booked' ? 'Save, add to calendar & next' : 'Save & next';
  }
  function closeExtra() {
    pendingOutcome = null;
    $('extraPanel').classList.add('hidden');
    $('outcomes').querySelectorAll('.oc').forEach(b => b.classList.remove('sel'));
  }
  $('extraCancel').addEventListener('click', closeExtra);
  $('extraSave').addEventListener('click', () => {
    const key = pendingOutcome;
    if (!key) return;
    const at = $('extraAt').value ? new Date($('extraAt').value).toISOString() : null;
    if ((key === 'callback' || key === 'meeting_booked') && !at) return toast('Pick a date and time.', true);
    const extra = {};
    if (key === 'meeting_booked') { extra.meetingAt = at; extra.callbackAt = null; }
    else if (at) extra.callbackAt = at;
    if (key === 'closed_won') extra.amount = Number($('amount').value) || 0;
    if (key === 'meeting_booked') openCalendar(at);
    saveOutcome(key, extra);
  });

  function openCalendar(iso) {
    const start = new Date(iso), end = new Date(start.getTime() + 15 * 60000);
    const f = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const details = [lead.contactName, lead.phone, lead.email, '', $('notes').value.trim()].filter((x, i) => x || i === 3).join('\n');
    const url = 'https://calendar.google.com/calendar/render?action=TEMPLATE' +
      '&text=' + encodeURIComponent('Discovery call - ' + (lead.businessName || '')) +
      '&dates=' + f(start) + '/' + f(end) +
      '&details=' + encodeURIComponent(details) +
      (lead.email ? '&add=' + encodeURIComponent(lead.email) : '') +
      (settings.gmailAccount ? '&authuser=' + encodeURIComponent(settings.gmailAccount) : '');
    window.open(url, '_blank', 'noopener');
  }

  let saving = false;
  async function saveOutcome(key, extra) {
    if (!lead || saving) return;
    saving = true;
    const durationSec = stopTimer();
    try {
      await api('/lead/' + lead.id + '/outcome', { method: 'POST', body: JSON.stringify({ outcome: key, note: $('notes').value, durationSec, ...extra }) });
      toast(OUTCOMES[key].label + ' saved');
      loadStats(true);
      await next();
    } catch (e) {
      toast(e.message, true);
    } finally { saving = false; }
  }

  $('noteBtn').addEventListener('click', async () => {
    if (!lead) return;
    const note = $('notes').value.trim();
    if (!note) return toast('Type a note first.', true);
    try {
      const r = await api('/lead/' + lead.id + '/note', { method: 'POST', body: JSON.stringify({ note }) });
      renderLead(r.lead, 'opened');
      toast('Note saved');
    } catch (e) { toast(e.message, true); }
  });

  async function skipLead() {
    if (!lead) return next();
    const note = $('notes').value.trim();
    try {
      if (note) await api('/lead/' + lead.id + '/note', { method: 'POST', body: JSON.stringify({ note }) });
      await api('/lead/' + lead.id + '/skip', { method: 'POST', body: JSON.stringify({ hours: 4 }) });
    } catch (e) { toast(e.message, true); }
    stopTimer();
    next();
  }
  $('skipBtn').addEventListener('click', skipLead);
  // Next without an outcome doesn't count as a dial; typed notes are kept.
  async function nextLead() {
    const note = $('notes').value.trim();
    if (lead && note) { try { await api('/lead/' + lead.id + '/note', { method: 'POST', body: JSON.stringify({ note }) }); } catch (e) {} }
    stopTimer();
    next();
  }
  $('nextBtn').addEventListener('click', nextLead);

  $('emailBtn').addEventListener('click', emailFollowUp);
  async function emailFollowUp() {
    if (!lead) return;
    if (!lead.email) return toast('No email on this lead. Ask for one and add it to your notes.', true);
    try {
      const r = await api('/lead/' + lead.id + '/email', { method: 'POST', body: JSON.stringify({}) });
      const url = 'https://mail.google.com/mail/?view=cm&fs=1' +
        (settings.gmailAccount ? '&authuser=' + encodeURIComponent(settings.gmailAccount) : '') +
        '&to=' + encodeURIComponent(r.to) + '&su=' + encodeURIComponent(r.subject) + '&body=' + encodeURIComponent(r.body);
      window.open(url, '_blank', 'noopener');
      await api('/lead/' + lead.id + '/note', { method: 'POST', body: JSON.stringify({ note: 'Follow-up email opened in Gmail: ' + r.subject }) });
    } catch (e) { toast(e.message, true); }
  }

  // ---------- Keyboard ----------
  document.addEventListener('keydown', e => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if ($('tab-dial').classList.contains('hidden') || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'c') { e.preventDefault(); call(); }
    else if (k === 'n') { e.preventDefault(); nextLead(); }
    else if (k === 's') { e.preventDefault(); skipLead(); }
    else if (k === 'e') { e.preventDefault(); emailFollowUp(); }
    else if (k === '/') { e.preventDefault(); $('notes').focus(); }
    else if (/^[0-9]$/.test(k)) {
      e.preventDefault();
      const idx = k === '0' ? 9 : Number(k) - 1;
      if (OUTCOME_ORDER[idx]) chooseOutcome(OUTCOME_ORDER[idx]);
    } else if (k === 'enter' && pendingOutcome) { e.preventDefault(); $('extraSave').click(); }
  });

  // ---------- Search ----------
  let searchT;
  $('searchBox').addEventListener('input', () => {
    clearTimeout(searchT);
    const q = $('searchBox').value.trim();
    if (q.length < 2) { $('searchResults').classList.add('hidden'); return; }
    searchT = setTimeout(async () => {
      const r = await api('/search?q=' + encodeURIComponent(q)).catch(() => ({ results: [] }));
      $('searchResults').innerHTML = r.results.length ? r.results.map(x =>
        '<div data-id="' + esc(x.id) + '"><b>' + esc(x.businessName) + '</b><br><span class="dim">' + esc([x.contactName, x.phone, [x.city, x.state].filter(Boolean).join(', '), outcomeLabel(x.status)].filter(Boolean).join(' · ')) + '</span></div>').join('')
        : '<div class="dim">No match</div>';
      $('searchResults').classList.remove('hidden');
      $('searchResults').querySelectorAll('[data-id]').forEach(d => d.addEventListener('click', () => {
        $('searchResults').classList.add('hidden'); $('searchBox').value = ''; openLead(d.dataset.id);
      }));
    }, 200);
  });
  document.addEventListener('click', e => { if (!e.target.closest('.search')) $('searchResults').classList.add('hidden'); });

  // ---------- Pipeline ----------
  async function loadPipeline() {
    const r = await api('/pipeline').catch(e => { toast(e.message, true); return { leads: [] }; });
    $('pipeCount').textContent = r.leads.length + ' leads';
    $('pipeBody').innerHTML = r.leads.length ? r.leads.map(l => {
      const when = l.meetingAt ? 'Meeting ' + fmtDate(l.meetingAt) : (l.callbackAt ? fmtDate(l.callbackAt) : '');
      const overdue = l.callbackAt && Date.parse(l.callbackAt) < Date.now() && l.status !== 'closed_won';
      return '<tr class="click" data-id="' + esc(l.id) + '"><td><b>' + esc(l.businessName) + '</b></td><td>' + esc(l.contactName) + '</td><td class="mono">' + esc(l.phone) + '</td>' +
        '<td><span class="badge ' + (l.status === 'closed_won' ? 'green' : l.status === 'meeting_booked' ? 'blue' : 'amber') + '">' + esc(outcomeLabel(l.status)) + (l.amount ? ' $' + l.amount : '') + '</span></td>' +
        '<td' + (overdue ? ' style="color:var(--red)"' : '') + '>' + esc(when) + '</td><td class="dim">' + esc((l.lastNote || '').slice(0, 120)) + '</td></tr>';
    }).join('') : '<tr><td colspan="6" class="dim">Nothing yet. Callbacks, interested leads, meetings and wins show up here.</td></tr>';
    $('pipeBody').querySelectorAll('tr.click').forEach(tr => tr.addEventListener('click', () => openLead(tr.dataset.id)));
  }

  // ---------- Stats ----------
  async function loadStats(headerOnly) {
    const s = await api('/stats').catch(() => null);
    if (!s) return;
    $('sDials').textContent = s.today.dials;
    $('sGoal').textContent = s.dailyGoal;
    $('sGoalBar').style.width = Math.min(100, s.dailyGoal ? (s.today.dials / s.dailyGoal) * 100 : 0) + '%';
    $('sConvos').textContent = s.today.conversations;
    $('sMeetings').textContent = s.today.meetings;
    $('sWins').textContent = s.today.wins;
    if (headerOnly) return;
    const tile = (label, val, sub) => '<div class="panel"><div class="panel-label"><span>' + label + '</span></div><div class="stat-big">' + val + '</div><div class="dim" style="font-size:12px;margin-top:4px">' + (sub || '') + '</div></div>';
    $('statTiles').innerHTML =
      tile('All-time dials', s.total.dials, s.total.conversations + ' conversations') +
      tile('Dials per conversation', s.ratios.dialsPerConversation ?? '—', 'conversation = you reached a person who decided something') +
      tile('Dials per meeting', s.ratios.dialsPerMeeting ?? '—', s.total.meetings + ' meetings booked') +
      tile('Dials per win', s.ratios.dialsPerWin ?? '—', s.total.wins + ' closed') +
      tile('Today', s.today.dials + ' / ' + s.dailyGoal, fmtDur(s.today.talkSec) + ' talk time') +
      tile('Leads in system', s.leads.total, (s.leads.byStatus.new || 0) + ' never called');
    $('statDays').innerHTML = s.history.length ? s.history.map(d => '<tr><td class="mono">' + d.day + '</td><td>' + d.dials + '</td><td>' + d.conversations + '</td><td>' + d.meetings + '</td><td>' + d.wins + '</td><td class="mono">' + fmtDur(d.talkSec) + '</td></tr>').join('') : '<tr><td colspan="6" class="dim">No calls logged yet.</td></tr>';
    $('statPool').innerHTML = Object.entries(s.leads.byStatus).sort((a, b) => b[1] - a[1]).map(([k, v]) => '<span class="badge">' + esc(outcomeLabel(k)) + ': ' + v + '</span>').join('');
  }

  // ---------- Import ----------
  let preview = null;
  const FIELD_LABELS = { businessName: 'Business name', contactName: 'Contact name', phone: 'Phone', phoneAlt: 'Alt phone', email: 'Email', website: 'Website', address: 'Address', address2: 'Address line 2', city: 'City', state: 'State', zip: 'ZIP', county: 'County', industry: 'Industry / description', codes: 'NAICS / NIGP codes', certification: 'Certification', certExpires: 'Cert expires', ownerGender: 'Owner gender', ownerEthnicity: 'Owner ethnicity' };
  $('drop').addEventListener('click', () => $('fileInput').click());
  $('drop').addEventListener('dragover', e => { e.preventDefault(); $('drop').classList.add('over'); });
  $('drop').addEventListener('dragleave', () => $('drop').classList.remove('over'));
  $('drop').addEventListener('drop', e => { e.preventDefault(); $('drop').classList.remove('over'); if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]); });
  $('fileInput').addEventListener('change', () => { if ($('fileInput').files[0]) upload($('fileInput').files[0]); $('fileInput').value = ''; });

  async function upload(file) {
    $('importStatus').textContent = 'Reading ' + file.name + (file.name.toLowerCase().endsWith('.pdf') ? ' (PDFs take a few seconds)...' : '...');
    $('previewPanel').classList.add('hidden');
    try {
      const buf = await file.arrayBuffer();
      const res = await fetch('/api/dialer/import/preview?filename=' + encodeURIComponent(file.name), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      preview = data;
      $('importStatus').textContent = '';
      renderPreview();
    } catch (e) { $('importStatus').innerHTML = '<span style="color:var(--red)">' + esc(e.message) + '</span>'; }
  }

  function renderPreview() {
    const p = preview;
    $('previewPanel').classList.remove('hidden');
    $('previewMethod').textContent = { csv: 'CSV', xlsx: 'Excel', 'pdf-table': 'PDF table', 'pdf-ai': 'PDF (AI extraction — check rows carefully)' }[p.method] + (p.pages ? ' · ' + p.pages + ' pages' : '') + (p.headerRow ? ' · header on row ' + p.headerRow : '');
    $('impSource').value = $('impSource').value || p.suggestedSource;
    renderTotals(p.totals);
    const opts = ['<option value="">(ignore / keep as extra detail)</option>'].concat(p.fields.map(f => '<option value="' + f + '">' + esc(FIELD_LABELS[f] || f) + '</option>')).join('');
    $('mapGrid').innerHTML = p.headers.map((h, i) => '<div><label title="' + esc(h) + '">' + esc(h) + '</label><select data-h="' + i + '">' + opts + '</select></div>').join('');
    $('mapGrid').querySelectorAll('select').forEach(s => {
      s.value = p.mapping[p.headers[+s.dataset.h]] || '';
      s.addEventListener('change', remap);
    });
    renderSample(p.sample);
  }
  function currentMapping() {
    const m = {};
    $('mapGrid').querySelectorAll('select').forEach(s => { if (s.value) m[preview.headers[+s.dataset.h]] = s.value; });
    return m;
  }
  function renderTotals(t) {
    const tile = (label, val) => '<div class="panel" style="padding:12px"><div class="dim" style="font-size:11.5px">' + label + '</div><div class="stat-big" style="font-size:22px">' + val + '</div></div>';
    $('previewTotals').innerHTML = tile('Rows found', t.records) + tile('New leads', t.newLeads) + tile('Already in dialer (merge)', t.alreadyIn) + tile('Unique phones', t.uniquePhones) + tile('No phone (skipped)', t.noPhone) + tile('Rows with phone', t.withPhone);
  }
  function renderSample(rows) {
    $('previewRows').innerHTML = rows.map(r => '<tr><td>' + esc(r.businessName) + '</td><td>' + esc(r.contactName) + '</td><td class="mono">' + esc(r.phone) + '</td><td>' + esc(r.email) + '</td><td>' + esc(r.city) + '</td><td>' + esc(r.state) + '</td><td class="dim">' + esc(String(r.industry).slice(0, 80)) + '</td></tr>').join('');
  }
  let remapT;
  async function remap() {
    clearTimeout(remapT);
    remapT = setTimeout(async () => {
      try {
        const r = await api('/import/remap', { method: 'POST', body: JSON.stringify({ importId: preview.importId, mapping: currentMapping(), defaultState: $('impState').value.trim() }) });
        renderTotals(r.totals); renderSample(r.sample);
      } catch (e) { toast(e.message, true); }
    }, 250);
  }
  $('impState').addEventListener('input', remap);
  $('cancelImport').addEventListener('click', () => { preview = null; $('previewPanel').classList.add('hidden'); $('impSource').value = ''; });
  $('commitImport').addEventListener('click', async () => {
    if (!preview) return;
    $('commitImport').disabled = true;
    try {
      const r = await api('/import/commit', { method: 'POST', body: JSON.stringify({ importId: preview.importId, mapping: currentMapping(), source: $('impSource').value.trim(), defaultState: $('impState').value.trim() }) });
      toast(r.added + ' new leads added, ' + r.alreadyInDialer + ' merged');
      preview = null; $('previewPanel').classList.add('hidden'); $('impSource').value = ''; $('impState').value = '';
      loadImports(); loadFilterOptions();
      if (!lead) next(true);
    } catch (e) { toast(e.message, true); }
    finally { $('commitImport').disabled = false; }
  });
  async function loadImports() {
    const r = await api('/imports').catch(() => ({ imports: [] }));
    $('importHistory').innerHTML = r.imports.length ? r.imports.map(i => '<tr><td class="mono" style="font-size:12px">' + esc(fmtDate(i.at)) + '</td><td>' + esc(i.source) + '</td><td>' + i.added + '</td><td>' + (i.alreadyInDialer || 0) + '</td><td>' + (i.skippedNoPhone || 0) + '</td></tr>').join('') : '<tr><td colspan="5" class="dim">No imports yet.</td></tr>';
  }

  // ---------- Settings ----------
  const SETTING_IDS = ['dailyGoal', 'maxAttempts', 'retryDays', 'gatekeeperRetryDays', 'enforceCallWindow', 'aiScripts', 'aiSearchFallback', 'callWindowStart', 'callWindowEnd', 'callMethod', 'textnowUrl', 'bookingLink', 'gmailAccount', 'senderName', 'senderCompany', 'website', 'emailSubject', 'emailTemplate', 'script'];
  const sid = k => 'set' + k[0].toUpperCase() + k.slice(1);
  let dataFileInfo = '';
  function fillSettings() {
    for (const k of SETTING_IDS) {
      const el = $(sid(k)); if (!el) continue;
      if (el.type === 'checkbox') el.checked = !!settings[k]; else el.value = settings[k] == null ? '' : settings[k];
    }
    $('dataFile').textContent = dataFileInfo;
  }
  $('saveSettings').addEventListener('click', async () => {
    const patch = {};
    for (const k of SETTING_IDS) { const el = $(sid(k)); if (el) patch[k] = el.type === 'checkbox' ? el.checked : el.value; }
    try {
      const r = await api('/settings', { method: 'POST', body: JSON.stringify(patch) });
      settings = r.settings; toast('Settings saved'); loadStats(true); if (lead) loadScript();
    } catch (e) { toast(e.message, true); }
  });
  $('editScript').addEventListener('click', () => { showTab('settings'); setTimeout(() => $('setScript').focus(), 50); });

  // ---------- Boot ----------
  (async function boot() {
    try {
      OUTCOMES = await api('/outcomes');
      const s = await api('/settings');
      settings = s.settings;
      dataFileInfo = 'Data file: ' + s.dataFile;
      buildOutcomeButtons();
      await loadFilterOptions();
      loadStats(true);
      next(true);
    } catch (e) { toast(e.message, true); }
  })();
})();
