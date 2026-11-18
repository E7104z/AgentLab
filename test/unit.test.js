const { matchClient } = require('../src/clients');
const { buildRawMessage, parseRawMessage, replySubject, buildReferences } = require('../src/gmail/mime');
const { validateDecision } = require('../src/agent/decide');
const { decideRoute } = require('../src/agent/policy');
const util = require('../src/lib/util');
const { placeholderRequests } = require('../src/integrations/docs');
const { unsupportedNumbers } = require('../src/flows/deals');
const { testClients } = require('./helpers');

const clients = testClients();
const def = clients.find((c) => c.id === 'default');

describe('client routing', () => {
  it('routes the base address to the default client', () => {
    expect(matchClient('Jason <info@thecdscloud.com>', clients).id).toBe('default');
  });
  it('routes a known plus-alias to its client', () => {
    expect(matchClient('info+demo@thecdscloud.com', clients).id).toBe('demo');
  });
  it('flags an unknown plus-alias as unrouted instead of guessing', () => {
    expect(matchClient('info+nobody@thecdscloud.com', clients)).toBeNull();
  });
});

describe('threaded MIME', () => {
  it('sets In-Reply-To, References and an encoded Re: subject', () => {
    const raw = buildRawMessage({
      fromEmail: 'info@thecdscloud.com',
      fromName: 'Jason Griffin, The Real Help',
      to: 'owner@shop.com',
      subject: replySubject('Need help with scheduling — urgent'),
      body: 'Hi there',
      inReplyTo: '<abc@mail.example.com>',
      references: buildReferences('<root@x>', '<abc@mail.example.com>'),
    });
    const { headers, body } = parseRawMessage(raw);
    expect(headers['in-reply-to']).toBe('<abc@mail.example.com>');
    expect(headers.references).toBe('<root@x> <abc@mail.example.com>');
    expect(headers.subject).toBe('Re: Need help with scheduling — urgent');
    expect(headers.from).toContain('<info@thecdscloud.com>');
    expect(body).toBe('Hi there');
  });
  it('does not stack Re:', () => {
    expect(replySubject('RE: hello')).toBe('RE: hello');
  });
  it('strips header injection', () => {
    const raw = buildRawMessage({ fromEmail: 'a@b.com', to: 'x@y.com\r\nBcc: evil@z.com', subject: 's', body: 'b' });
    const { headers } = parseRawMessage(raw);
    expect(headers.bcc).toBeUndefined();
  });
});

describe('decision validation', () => {
  const base = { category: 'new-lead', should_respond: true, needs_human: false, confidence: 0.9, reasoning: 'x' };
  it('accepts a reply that only uses listed prices', () => {
    const r = validateDecision({ ...base, body: 'The Quick Fix is $500 one time plus $30/month.' }, def);
    expect(r.ok).toBe(true);
    expect(r.decision.needs_human).toBe(false);
  });
  it('forces a human when the reply states a price not in the knowledge', () => {
    const r = validateDecision({ ...base, body: 'We can do it for $250 this week.' }, def);
    expect(r.decision.needs_human).toBe(true);
    expect(r.decision.needs_human_reason).toMatch(/\$250/);
  });
  it('forces a human on placeholders', () => {
    const r = validateDecision({ ...base, body: 'Hi [Your Name], thanks!' }, def);
    expect(r.decision.needs_human).toBe(true);
  });
  it('rejects malformed output', () => {
    expect(validateDecision({ category: 'nonsense' }, def).ok).toBe(false);
  });
});

describe('send policy', () => {
  const d = (x) => ({ category: 'new-lead', should_respond: true, needs_human: false, confidence: 0.9, body: 'Happy to help.', ...x });
  it('auto-sends confident lead replies', () => expect(decideRoute(d(), def).route).toBe('auto'));
  it('never answers spam, pitches or personal mail', () => {
    for (const category of ['spam', 'vendor-or-sales-pitch', 'personal']) expect(decideRoute(d({ category }), def).route).toBe('none');
  });
  it('always sends billing and support to a human', () => {
    expect(decideRoute(d({ category: 'billing' }), def).route).toBe('review');
    expect(decideRoute(d({ category: 'client-support' }), def).route).toBe('review');
  });
  it('reviews low confidence and needs_human', () => {
    expect(decideRoute(d({ confidence: 0.5 }), def).route).toBe('review');
    expect(decideRoute(d({ needs_human: true }), def).route).toBe('review');
  });
  it('reviews refunds, discounts and legal threats', () => {
    expect(decideRoute(d(), def, 'Can I get a discount?').route).toBe('review');
    expect(decideRoute(d(), def, 'My lawyer will be in touch').route).toBe('review');
  });
  it('creates a task when the model wants a human but has no draft', () => {
    expect(decideRoute(d({ should_respond: false, needs_human: true }), def).route).toBe('task');
  });
});

describe('utilities', () => {
  it('detects opt-outs only at the top of a reply', () => {
    expect(util.isOptOut('STOP')).toBe(true);
    expect(util.isOptOut('no thanks, not right now')).toBe(true);
    expect(util.isOptOut('Thanks! Can we talk Tuesday?\n> reply stop to opt out')).toBe(false);
  });
  it('strips quoted history', () => {
    expect(util.newestPart('New text\n\nOn Mon, Jan 1, 2026 at 9:00 AM Jason wrote:\n> old')).toBe('New text');
  });
  it('moves a weekend time into business hours', () => {
    const sat = new Date('2026-11-21T15:00:00Z'); // Saturday 9am Chicago
    const next = util.nextBusinessTime(sat, def);
    const p = util.localParts(next, 'America/Chicago');
    expect(p.weekday).toBe(1);
    expect(p.hour).toBe(8);
  });
  it('verifies timestamped HMAC signatures and rejects stale or tampered ones', () => {
    const body = '{"a":1}';
    const now = 1_800_000_000;
    const sig = util.signTimestamped('s3cret', body, now);
    expect(util.verifyTimestampedSignature('s3cret', body, sig, now)).toBe(true);
    expect(util.verifyTimestampedSignature('s3cret', body + ' ', sig, now)).toBe(false);
    expect(util.verifyTimestampedSignature('s3cret', body, sig, now + 3600)).toBe(false);
    expect(util.verifyTimestampedSignature('other', body, sig, now)).toBe(false);
  });
  it('renders templates and reports missing values', () => {
    const r = util.render('Hi {{firstName}}, {{bookingUrl}}', { firstName: 'Ana' });
    expect(r.text).toBe('Hi Ana,');
    expect(r.missing).toEqual(['bookingUrl']);
  });
});

describe('proposal helpers', () => {
  it('replaces placeholders back to front and bolds the values', () => {
    const doc = { body: { content: [{ paragraph: { elements: [{ startIndex: 1, textRun: { content: 'Hi {{ClientName}}, price {{Price}}\n' } }] } }] } };
    const { requests, filled } = placeholderRequests(doc, { ClientName: 'Ana', Price: '$500' });
    expect(filled).toEqual(['Price', 'ClientName']);
    expect(requests[0].deleteContentRange.range.startIndex).toBeGreaterThan(requests[3].deleteContentRange.range.startIndex);
    expect(requests.filter((r) => r.updateTextStyle).every((r) => r.updateTextStyle.textStyle.bold)).toBe(true);
  });
  it('flags numbers the notes do not support', () => {
    expect(unsupportedNumbers('Done in 2 weeks for $900', ['notes say 3 weeks'])).toEqual(['$900', '2 weeks']);
    expect(unsupportedNumbers('Done in 3 weeks', ['notes say 3 weeks'])).toEqual([]);
  });
});
