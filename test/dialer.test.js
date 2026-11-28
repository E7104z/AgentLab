/* Cold Call Dialer: cleanup, scripts, dates, voicemail, follow-up footer, opt-outs, storage. No network, no external DB. */
const fs = require('fs');
const os = require('os');
const path = require('path');
// vitest globals (describe/it/expect/vi) are enabled in vitest.config.mjs

const clean = require('../dialer/clean');
const { normalizeRecord, FIELDS } = require('../dialer/parse');
const sv = require('../dialer/script-vars');
const followup = require('../dialer/followup');
const ai = require('../dialer/ai-script');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dialer-'));
const lead = (o = {}) => ({ id: 'L' + Math.random().toString(36).slice(2, 8), businessName: 'Acme', phoneDigits: '3145550100', status: 'new', city: '', county: '', state: 'MO', zip: '', extra: {}, ...o });

describe('city / owner / county cleanup', () => {
  it('collapses every St. Louis spelling to one value', () => {
    for (const v of ['Saint Louis', 'St. Louis', 'ST Louis', 'St Louis', 'ST. Louis', 'ST. LOUIS', 'saint louis', 'St. Louis, MO']) expect(clean.normalizeCity(v)).toBe('St. Louis');
  });
  it('does not mangle names that merely start with St', () => {
    expect(clean.normalizeCity('Stanton')).toBe('Stanton');
    expect(clean.normalizeCity('Stillwater')).toBe('Stillwater');
    expect(clean.normalizeCity("O'FALLON")).toBe("O'Fallon");
    expect(clean.normalizeCity('Saint Charles')).toBe('St. Charles');
  });
  it('merges owner spellings', () => {
    for (const v of ['BLACK', 'Black', 'Black/African American', 'African-American', 'black or african american']) expect(clean.normalizeOwnerEthnicity(v)).toBe('Black/African American');
    expect(clean.normalizeOwnerEthnicity('HISPANIC')).toBe('Hispanic/Latino');
    expect(clean.normalizeOwnerGender('FEMALE')).toBe('Female');
  });
  it('fills blank Missouri counties from ZIP, built-in city table, and the data itself', () => {
    const leads = [
      lead({ city: 'St. Louis', zip: '63118' }), lead({ city: 'St. Louis', zip: '63130' }), lead({ city: 'Florissant', zip: '63033' }),
      lead({ city: 'Springfield', state: 'MO' }), lead({ city: 'Kansas City', zip: '64111' }),
      // learned: Tupelo MS rows that carry a county teach the blank one
      ...[1, 2, 3, 4].map(() => lead({ city: 'Tupelo', state: 'MS', zip: '38801', county: 'Lee' })), lead({ city: 'Tupelo', state: 'MS', zip: '38801' })
    ];
    const r = clean.cleanAll(leads);
    expect(leads[0].county).toBe('St. Louis City');
    expect(leads[1].county).toBe('St. Louis');
    expect(leads[2].county).toBe('St. Louis');
    expect(leads[3].county).toBe('Greene');
    expect(leads[4].county).toBe('');            // Kansas City spans counties: never guessed
    expect(leads[8].county).toBe('Lee');
    expect(r.stats.countiesFilled).toBe(5);
  });
});

describe('old HOLD / source-use flags', () => {
  it('removes them from every field and keeps unrelated data', () => {
    const l = lead({ extra: { 'Outreach status': 'HOLD - NOT APPROVED', Flags: 'source-use review required; Sunshine list', Notes: 'keep me' } });
    const r = clean.cleanAll([l]);
    expect(JSON.stringify(l)).not.toMatch(/HOLD|NOT APPROVED|source-use/i);
    expect(l.extra).toEqual({ Flags: 'Sunshine list', Notes: 'keep me' });
    expect(r.stats.flagsRemoved).toBe(1);
  });
  it('never lets a flag in through an import', () => {
    const mapping = { Name: 'businessName', Phone: 'phone', City: 'city' };
    const n = normalizeRecord({ Name: 'Zaffron LLC', Phone: '314-555-0199', City: 'SAINT LOUIS', 'Outreach status': 'HOLD - NOT APPROVED', Review: 'source-use review required' }, mapping, {});
    expect(n.city).toBe('St. Louis');
    expect(JSON.stringify(n)).not.toMatch(/HOLD|NOT APPROVED|source-use/i);
    expect(FIELDS).toContain('city');
  });
});

describe('script dates, owner line and voicemail', () => {
  const at = iso => new Date(iso);
  it('offers the next two real weekdays, never a fixed "Thursday"', () => {
    expect(sv.offeredDays(at('2026-11-25T18:00:00Z'))).toEqual(['tomorrow', 'Friday, Nov 27']);          // Wednesday
    expect(sv.offeredDays(at('2026-11-27T18:00:00Z'))).toEqual(['Monday, Nov 30', 'Tuesday, Dec 1']);    // Friday
    expect(sv.offeredDays(at('2026-11-28T18:00:00Z'))).toEqual(['Monday, Nov 30', 'Tuesday, Dec 1']);    // Saturday
    expect(sv.offeredDays(at('2026-11-29T18:00:00Z'))).toEqual(['tomorrow', 'Tuesday, Dec 1']);          // Sunday
  });
  it('the stored default script has no hardcoded days and no "is this there"', () => {
    const { DEFAULT_SETTINGS: d } = require('../dialer/store');
    expect(d.script).not.toMatch(/Thursday/);
    const filled = sv.fillTemplate(d.script, sv.templateVars(lead({ firstName: '' }), d));
    expect(filled).not.toMatch(/is this there/i);
    expect(filled).toMatch(/is this the owner of Acme\?/);
  });
  it('voicemail is ~20 seconds, names one reason and says the number twice', () => {
    const { DEFAULT_SETTINGS: d } = require('../dialer/store');
    const vm = sv.voicemail(lead({ firstName: 'Maria', businessName: 'Acme Plumbing' }), { ...d, callbackNumber: '(314) 555-0100' }, { offer: 2 });
    expect(vm.text.split('(314) 555-0100')).toHaveLength(3);
    expect(vm.words).toBeGreaterThanOrEqual(35);
    expect(vm.words).toBeLessThanOrEqual(55);
    expect(vm.text).toMatch(/^Hi Maria, this is Jason Griffin with The Real Help\./);
    expect(vm.text).not.toMatch(/there/i);
    expect(vm.numberSet).toBe(true);
  });
  it('flags a missing number instead of inventing one', () => {
    const { DEFAULT_SETTINGS: d } = require('../dialer/store');
    const vm = sv.voicemail(lead(), d, null);
    expect(vm.numberSet).toBe(false);
    expect(vm.text).toMatch(/Google Voice number/);
    expect(vm.text.startsWith('Hello, this is')).toBe(true);
  });
});

describe('follow-up email compliance', () => {
  const { DEFAULT_SETTINGS: d } = require('../dialer/store');
  it('refuses to build without a postal address', () => {
    expect(() => followup.build(lead({ firstName: 'Sam' }), d)).toThrow(/mailing address/);
    expect(() => followup.build(lead(), { ...d, postalAddress: 'PO Box' })).toThrow();
  });
  it('adds the address and an unsubscribe line', () => {
    const { body } = followup.build(lead({ firstName: 'Sam' }), { ...d, postalAddress: '123 Main St, St. Louis, MO 63101', unsubscribeUrl: 'https://example.com/u' });
    expect(body).toMatch(/123 Main St, St\. Louis, MO 63101/);
    expect(body).toMatch(/reply "unsubscribe"/);
    expect(body).toMatch(/https:\/\/example\.com\/u/);
  });
  it('defaults to sending from the outreach mailbox', () => {
    expect(d.gmailAccount).toBe('jason@realhelpstl.com');
  });
});

describe('AI hook wording guard', () => {
  const base = { opener: 'Hi Sam, Jason with The Real Help.', q1: 'q', q2: 'q', bridge: 'b', hookEvidence: null };
  it('rejects database talk', () => {
    expect(ai.isBadHook({ ...base, hook: 'I couldn\'t find a website for you in our data.', searched: true })).toBe(true);
    expect(ai.isBadHook({ ...base, hook: 'Your site is not provided in source.', searched: true })).toBe(true);
  });
  it('allows "no website" only when the web search also found nothing', () => {
    const hook = 'I looked for you online and did not see a website.';
    expect(ai.isBadHook({ ...base, hook, searched: false })).toBe(true);
    expect(ai.isBadHook({ ...base, hook, searched: undefined })).toBe(true);
    expect(ai.isBadHook({ ...base, hook, searched: true })).toBe(false);
  });
  it('does not trip on normal website talk', () => {
    expect(ai.isBadHook({ ...base, hook: 'Your site has no booking link on the home page.', searched: false })).toBe(false);
  });
  it('the facts line no longer says "in our data" and does not treat blank as "no site"', () => {
    const msg = ai.buildUserMessage(lead({ firstName: 'Sam' }), null, '');
    expect(msg).not.toMatch(/in our data/i);
    expect(msg).toMatch(/does NOT mean they have none/);
  });
});

// ---- stores: settings migration, file mode, Postgres ----
// The dialer modules are CommonJS and read env at load, so clear Node's require cache between stores.
function resetDialerModules() {
  for (const k of Object.keys(require.cache)) if (/[\\/]dialer[\\/]/.test(k) && !/[\\/]test[\\/]/.test(k)) delete require.cache[k];
}
async function freshStore(env = {}) {
  const dir = tmp();
  process.env.DIALER_DATA_FILE = path.join(dir, 'dialer-data.json');
  Object.assign(process.env, env);
  resetDialerModules();
  const store = require('../dialer/store');
  return { store, dir, file: process.env.DIALER_DATA_FILE };
}

describe('store: settings migration and cleanup (file mode)', () => {
  it('moves old TextNow / info@ settings to Google Voice / realhelpstl, keeps edits', async () => {
    const { store, file } = await freshStore();
    const oldScript = 'OPENER\nHi, is this {{firstName}}? This is Jason.\nCLOSE\nDoes tomorrow or Thursday work better? My custom line stays.';
    fs.writeFileSync(file, JSON.stringify({
      leads: { a: lead({ id: 'a', city: 'ST. Louis', ownerEthnicity: 'BLACK', extra: { 'Outreach status': 'HOLD - NOT APPROVED' } }) },
      calls: [], imports: [],
      settings: { callMethod: 'textnow-web', textnowUrl: 'https://www.textnow.com/messaging', gmailAccount: 'info@thecdscloud.com', script: oldScript, scriptVersion: 2 }
    }));
    const s = store.settings();
    expect(s.callMethod).toBe('voice-web');
    expect(s.textnowUrl).toBeUndefined();
    expect(s.gmailAccount).toBe('jason@realhelpstl.com');
    expect(s.script).toMatch(/is this \{\{ownerAsk\}\}\?/);
    expect(s.script).toMatch(/\{\{dayOne\}\} or \{\{dayTwo\}\}/);
    expect(s.script).toMatch(/My custom line stays/);
    const l = store.getLead('a');
    expect(l.city).toBe('St. Louis');
    expect(l.ownerEthnicity).toBe('Black/African American');
    expect(JSON.stringify(l)).not.toMatch(/HOLD/);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).leads.a.extra).toEqual({});   // persisted
  });
});

describe('store: Postgres', () => {
  async function pgDb() {
    const { PGlite } = await import('@electric-sql/pglite');
    const db = new PGlite();
    await db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '002_dialer.sql'), 'utf8'));
    return db;
  }

  it('imports the old file once, then survives a restart with every change', async () => {
    const db = await pgDb();
    const { store, file } = await freshStore();
    const leads = {};
    for (let i = 0; i < 1200; i++) leads['l' + i] = lead({ id: 'l' + i, phoneDigits: '31455' + String(10000 + i), businessName: 'Biz ' + i, city: i % 2 ? 'Saint Louis' : 'ST. Louis' });
    fs.writeFileSync(file, JSON.stringify({ leads, calls: [{ id: 'c0', leadId: 'l0', at: '2026-11-20T15:00:00Z', outcome: 'no_answer', note: 'old call' }], imports: [{ at: 'x', source: 's' }], settings: {} }));
    const r = await store.init({ db });
    expect(r.backend).toBe('postgres');
    expect(r.imported).toEqual({ leads: 1200, calls: 1 });
    expect((await db.query('SELECT count(*)::int AS n FROM dialer_leads')).rows[0].n).toBe(1200);
    expect((await db.query("SELECT count(DISTINCT data->>'city')::int AS n FROM dialer_leads")).rows[0].n).toBe(1);   // cleaned city persisted

    // a call, an edit, a new lead, a setting and an AI script, then "crash" (no graceful shutdown beyond flush)
    const q = require('../dialer/queue');
    q.logOutcome('l5', { outcome: 'interested', note: 'wants a site' });
    store.addLead(lead({ id: 'new1', phoneDigits: '3145559999', businessName: 'Fresh' }));
    store.updateSettings({ callbackNumber: '(314) 555-0100' });
    store.aiPut('l5', { opener: 'hi', bridge: 'b' });
    await store.flush();

    resetDialerModules();
    const store2 = require('../dialer/store');
    const r2 = await store2.init({ db });
    expect(r2.imported).toBeNull();                         // not imported a second time
    expect(r2.leads).toBe(1201);
    expect(store2.getLead('l5').status).toBe('interested');
    expect(store2.getLead('new1').businessName).toBe('Fresh');
    expect(store2.load().calls.map(c => c.note)).toEqual(['old call', 'wants a site']);
    expect(store2.settings().callbackNumber).toBe('(314) 555-0100');
    expect(store2.aiGet('l5').opener).toBe('hi');
    store2.aiDel('l5');
    await store2.flush();
    expect((await db.query('SELECT count(*)::int AS n FROM dialer_ai_scripts')).rows[0].n).toBe(0);
  }, 60000);

  it('keeps pending changes and retries when the database write fails', async () => {
    const db = await pgDb();
    const { store } = await freshStore();
    await store.init({ db });
    store.addLead(lead({ id: 'x1', phoneDigits: '3145551111' }));
    const real = db.query.bind(db);
    db.query = async () => { throw new Error('connection lost'); };
    await expect(store.flush()).rejects.toThrow(/connection lost/);
    expect(store.status().lastError).toMatch(/connection lost/);
    expect(store.status().pendingLeads).toBe(1);
    db.query = real;
    await store.flush();
    expect(store.status().lastError).toBeNull();
    expect((await db.query("SELECT 1 FROM dialer_leads WHERE id = 'x1'")).rows).toHaveLength(1);
  }, 30000);
});

describe('Do Not Call -> opt-out lists', () => {
  it('adds the email to the app list and the local file, and blocks later mail', async () => {
    const { store, dir } = await freshStore({ DIALER_SUPPRESSION_FILE: '', SUPPRESSION_SHEET_ID: '' });
    const optout = require('../dialer/optout');
    const suppressed = new Set();
    const agent = { store: { suppress: async (c, e, why) => { suppressed.add(e + '|' + why); }, isSuppressed: async (c, e) => [...suppressed].some(x => x.startsWith(e + '|')) } };
    const l = lead({ id: 'd1', email: 'Owner@Acme.com', status: 'dnc' });
    const r = await optout.recordOptOut(agent, l);
    expect(r).toMatchObject({ email: 'owner@acme.com', app: 'added', sheet: 'not configured', file: 'added', errors: [] });
    expect(fs.readFileSync(path.join(dir, 'suppression.jsonl'), 'utf8')).toMatch(/"email":"owner@acme.com"/);
    expect((await optout.isOptedOut(agent, 'OWNER@acme.com')).out).toBe(true);
    expect((await optout.isOptedOut({ store: { isSuppressed: async () => false } }, 'someone@else.com')).out).toBe(false);
  });
  it('writes to the same Suppression sheet the leads preflight reads, without duplicates', async () => {
    const { } = await freshStore({ SUPPRESSION_SHEET_ID: 'sheet123', SUPPRESSION_TAB: 'Suppression' });
    const optout = require('../dialer/optout');
    const rows = [['Email', 'Reason', 'Date', 'Source'], ['old@x.com', 'unsubscribe', '2026-01-01', 'manual']];
    const agent = {
      store: { suppress: async () => {}, isSuppressed: async () => false },
      sheets: { readTab: async () => rows, appendRow: async (id, tab, vals) => { rows.push(vals); } }
    };
    const l = lead({ email: 'new@acme.com' });
    expect((await optout.recordOptOut(agent, l)).sheet).toBe('added');
    expect(rows[2].slice(0, 2)).toEqual(['new@acme.com', 'unsubscribe']);
    expect(rows[2][3]).toBe('dialer-dnc');
    expect((await optout.recordOptOut(agent, l)).sheet).toBe('already listed');
    expect(rows).toHaveLength(3);
    // an unreadable list must stop mail, not look empty
    const broken = { ...agent, sheets: { readTab: async () => { throw new Error('quota'); } } };
    await expect(optout.isOptedOut(broken, 'a@b.com')).rejects.toThrow(/quota/);
  });
});

describe('queue: one St. Louis', () => {
  it('city filter matches every spelling; filter options show one city', async () => {
    const { store, file } = await freshStore();
    fs.writeFileSync(file, JSON.stringify({ leads: {
      a: lead({ id: 'a', city: 'Saint Louis' }), b: lead({ id: 'b', phoneDigits: '3145550101', city: 'ST Louis' }), c: lead({ id: 'c', phoneDigits: '3145550102', city: 'Kirkwood' })
    }, calls: [], imports: [], settings: {} }));
    const q = require('../dialer/queue');
    const opts = q.filterOptions();
    expect(opts.cities.map(c => c.value).sort()).toEqual(['Kirkwood', 'St. Louis']);
    expect(opts.cities.find(c => c.value === 'St. Louis').count).toBe(2);
    expect(q.nextLead({ city: 'ST. LOUIS' }).queue.matching).toBe(2);
    expect(store.allLeads().every(l => l.city !== 'Saint Louis')).toBe(true);
  });
});
