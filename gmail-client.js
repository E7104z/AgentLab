const { google } = require('googleapis');

function getGmailClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

function buildRawMessage({ to, subject, body }) {
  const message = [
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
    'To: ' + to,
    'From: Jason Griffin <jason@therealhelp.com>',
    'Subject: ' + subject,
    '',
    body
  ].join('\n');

  return Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function createDraft({ to, subject, body }) {
  const gmail = getGmailClient();
  const raw = buildRawMessage({ to, subject, body });
  const result = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw } }
  });
  return { id: result.data.id, link: 'https://mail.google.com/mail/u/0/#drafts' };
}

async function sendEmail({ to, subject, body }) {
  const gmail = getGmailClient();
  const raw = buildRawMessage({ to, subject, body });
  const result = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw }
  });
  return { id: result.data.id };
}

async function ensureLabel_(gmail, name) {
  const list = await gmail.users.labels.list({ userId: 'me' });
  const existing = (list.data.labels || []).find(l => l.name === name);
  if (existing) return existing.id;
  const created = await gmail.users.labels.create({
    userId: 'me',
    requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }
  });
  return created.data.id;
}

function decodeBody_(payload) {
  if (payload.body && payload.body.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }
  if (payload.parts) {
    const plain = payload.parts.find(p => p.mimeType === 'text/plain');
    if (plain) return decodeBody_(plain);
    const first = payload.parts[0];
    if (first) return decodeBody_(first);
  }
  return '';
}

const NOISE_SENDER_PATTERNS = [
  /no-?reply/i,
  /noreply/i,
  /mailer-daemon/i,
  /donotreply/i,
  /notifications?@/i,
  /security@/i,
  /alerts?@/i,
  /@accounts\.google\.com$/i,
  /@login\.gov$/i,
  /dmarc/i,
  /postmaster@/i
];

function looksLikeNoise_(fromEmail) {
  return NOISE_SENDER_PATTERNS.some(rx => rx.test(fromEmail));
}

/** Finds unread mail in the inbox that hasn't already been processed. */
async function listUnprocessedLeads() {
  const gmail = getGmailClient();
  const list = await gmail.users.messages.list({
    userId: 'me',
    q: 'is:unread in:inbox -label:Agent-Processed'
  });
  const messages = list.data.messages || [];

  const results = [];
  const skipped = [];
  for (const m of messages) {
    const full = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
    const headers = full.data.payload.headers;
    const getHeader = (name) => (headers.find(h => h.name.toLowerCase() === name.toLowerCase()) || {}).value || '';
    const fromRaw = getHeader('From');
    const emailMatch = fromRaw.match(/<(.+)>/);
    const fromEmail = emailMatch ? emailMatch[1] : fromRaw;

    if (looksLikeNoise_(fromEmail)) {
      skipped.push({ id: m.id, fromEmail, subject: getHeader('Subject') });
      continue; // never reaches Claude -- no API call spent
    }

    results.push({
      id: m.id,
      threadId: m.threadId,
      fromName: fromRaw.replace(/<.+>/, '').replace(/"/g, '').trim() || fromRaw,
      fromEmail,
      subject: getHeader('Subject'),
      body: decodeBody_(full.data.payload).slice(0, 3000) // cap length sent to the model
    });
  }
  return { leads: results, skipped };
}

/** Marks a message as read and labels it so the poller never re-processes it. */
async function markProcessed(messageId) {
  const gmail = getGmailClient();
  const labelId = await ensureLabel_(gmail, 'Agent-Processed');
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { removeLabelIds: ['UNREAD'], addLabelIds: [labelId] }
  });
}

module.exports = { createDraft, sendEmail, listUnprocessedLeads, markProcessed };