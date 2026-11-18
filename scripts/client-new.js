/**
 * Scaffold a new client:  npm run client:new -- <id> "<Business Name>"
 * Creates clients/<id>/client.json (sendMode "log", sequences inactive) and knowledge.md,
 * and prints the onboarding checklist.
 */
const fs = require('fs');
const path = require('path');

const [id, ...nameParts] = process.argv.slice(2);
const businessName = nameParts.join(' ').trim();
if (!id || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(id) || !businessName) {
  console.error('Usage: npm run client:new -- <id> "<Business Name>"   (id: lowercase letters, numbers, dashes)');
  process.exit(1);
}
const dir = path.join(__dirname, '..', 'clients', id);
if (fs.existsSync(dir)) {
  console.error(`clients/${id} already exists.`);
  process.exit(1);
}

const base = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'clients', 'default', 'client.json'), 'utf8'));
const cfg = {
  ...JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'clients', '_example.client.json'), 'utf8')),
  id,
  businessName,
  fromDisplayName: businessName,
  intakeAlias: `info+${id}@thecdscloud.com`,
  sendMode: 'log',
  sequences: Object.fromEntries(
    Object.entries(base.sequences)
      .filter(([k]) => k === 'no_booking')
      .map(([k, v]) => [k, { ...v, active: false }])
  ),
  templates: { lead_reply_fallback: base.templates.lead_reply_fallback },
};

fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'client.json'), JSON.stringify(cfg, null, 2) + '\n');
fs.writeFileSync(
  path.join(dir, 'knowledge.md'),
  `# ${businessName}: knowledge\n\nOnly facts in this file may be stated to a customer. Fill every section with the client's real information.\n\n## Who we are\n- \n\n## Services and prices\n- \n\n## Service area and hours\n- \n\n## Booking\n- \n\n## FAQ\n- \n\n## Never say\n- Never promise a specific date, discount, refund or guarantee.\n`
);

console.log(`Created clients/${id}/client.json and knowledge.md

Onboarding checklist for ${businessName}:
  1. Fill clients/${id}/knowledge.md with the client's real services, prices, hours and FAQs.
  2. Set fromEmail, fromDisplayName, replyTo, signature, bookingUrl, timezone and businessHours in client.json.
  3. Inbox: either have the client forward their contact form/inbox to ${cfg.intakeAlias},
     or connect their own mailbox: set "mailbox": "${id}", run \`npm run auth -- ${id}\` signed in as their mailbox,
     and add GMAIL_REFRESH_TOKEN_${id.toUpperCase().replace(/-/g, '_')} to the env.
  4. Website form: point it at POST /webhooks/lead?client=${id} with the shared LEAD_WEBHOOK_SECRET signature.
  5. Booking: add a Cal.com webhook to /webhooks/cal?client=${id} (if they use Cal.com).
  6. Set reportEmail for their weekly report.
  7. Deploy, run in "log" for a day, then "draft" and review 10 replies, then "send".
  8. Turn on sequences ("active": true) once the copy is approved.`);
