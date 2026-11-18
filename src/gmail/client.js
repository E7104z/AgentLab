/**
 * Thin wrapper over the Gmail API for one mailbox.
 * Everything Gmail-specific lives here so the rest of the app can be tested with a fake
 * that implements the same methods.
 */
const { google } = require('googleapis');
const { buildRawMessage } = require('./mime');

const LABELS = { processed: 'Agent-Processed', failed: 'Agent-Failed', escalated: 'Agent-Escalated' };

function header(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function decodePart(data) {
  return Buffer.from(String(data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function extractBody(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) return decodePart(payload.body.data);
  if (payload.parts) {
    for (const p of payload.parts) {
      const t = extractBody(p);
      if (t && (p.mimeType === 'text/plain' || p.mimeType.startsWith('multipart/'))) return t;
    }
    const html = payload.parts.find((p) => p.mimeType === 'text/html');
    if (html && html.body && html.body.data) return stripHtml(decodePart(html.body.data));
  }
  if (payload.mimeType === 'text/html' && payload.body && payload.body.data) return stripHtml(decodePart(payload.body.data));
  if (payload.body && payload.body.data) return decodePart(payload.body.data);
  return '';
}

function stripHtml(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Normalizes a Gmail API message resource into the shape the app uses. */
function normalizeMessage(m) {
  const h = (m.payload && m.payload.headers) || [];
  const fromRaw = header(h, 'From');
  const emailMatch = fromRaw.match(/<([^>]+)>/);
  return {
    id: m.id,
    threadId: m.threadId,
    labelIds: m.labelIds || [],
    internalDate: Number(m.internalDate || Date.now()),
    fromRaw,
    fromEmail: (emailMatch ? emailMatch[1] : fromRaw).trim().toLowerCase(),
    fromName: fromRaw.replace(/<[^>]+>/, '').replace(/"/g, '').trim(),
    to: header(h, 'To'),
    cc: header(h, 'Cc'),
    deliveredTo: header(h, 'Delivered-To'),
    subject: header(h, 'Subject'),
    messageIdHeader: header(h, 'Message-ID') || header(h, 'Message-Id'),
    references: header(h, 'References'),
    autoSubmitted: header(h, 'Auto-Submitted'),
    precedence: header(h, 'Precedence'),
    failedRecipients: header(h, 'X-Failed-Recipients'),
    body: extractBody(m.payload).slice(0, 8000),
  };
}

function createGmailMailbox({ name, email, oauth }) {
  const auth = new google.auth.OAuth2(oauth.clientId, oauth.clientSecret, oauth.redirectUri);
  auth.setCredentials({ refresh_token: oauth.refreshToken });
  const gmail = google.gmail({ version: 'v1', auth });
  const labelCache = {};

  async function labelId(labelName) {
    if (labelCache[labelName]) return labelCache[labelName];
    const list = await gmail.users.labels.list({ userId: 'me' });
    let found = (list.data.labels || []).find((l) => l.name === labelName);
    if (!found) {
      const created = await gmail.users.labels.create({
        userId: 'me',
        requestBody: { name: labelName, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
      });
      found = created.data;
    }
    labelCache[labelName] = found.id;
    return found.id;
  }

  return {
    name,
    email,
    auth,
    async getProfile() {
      const r = await gmail.users.getProfile({ userId: 'me' });
      return { email: r.data.emailAddress, historyId: r.data.historyId };
    },
    /** Returns { messageIds, historyId } or throws { code: 404 } when the cursor expired. */
    async listHistory(startHistoryId) {
      const ids = new Set();
      let pageToken;
      let latest = startHistoryId;
      do {
        const r = await gmail.users.history.list({
          userId: 'me',
          startHistoryId,
          historyTypes: ['messageAdded'],
          labelId: 'INBOX',
          pageToken,
        });
        for (const h of r.data.history || []) for (const a of h.messagesAdded || []) ids.add(a.message.id);
        latest = r.data.historyId || latest;
        pageToken = r.data.nextPageToken;
      } while (pageToken);
      return { messageIds: [...ids], historyId: latest };
    },
    async search(q, max = 100) {
      const r = await gmail.users.messages.list({ userId: 'me', q, maxResults: max });
      return (r.data.messages || []).map((m) => m.id);
    },
    async getMessage(id) {
      const r = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      return normalizeMessage(r.data);
    },
    async addLabel(messageId, key) {
      const id = await labelId(LABELS[key] || key);
      await gmail.users.messages.modify({ userId: 'me', id: messageId, requestBody: { addLabelIds: [id] } });
    },
    async send(msg) {
      const raw = buildRawMessage(msg);
      const r = await gmail.users.messages.send({ userId: 'me', requestBody: { raw, threadId: msg.threadId || undefined } });
      return { id: r.data.id, threadId: r.data.threadId };
    },
    async createDraft(msg) {
      const raw = buildRawMessage(msg);
      const r = await gmail.users.drafts.create({
        userId: 'me',
        requestBody: { message: { raw, threadId: msg.threadId || undefined } },
      });
      return { id: r.data.id };
    },
    async updateDraft(draftId, msg) {
      const raw = buildRawMessage(msg);
      await gmail.users.drafts.update({
        userId: 'me',
        id: draftId,
        requestBody: { id: draftId, message: { raw, threadId: msg.threadId || undefined } },
      });
    },
    async sendDraft(draftId) {
      const r = await gmail.users.drafts.send({ userId: 'me', requestBody: { id: draftId } });
      return { id: r.data.id, threadId: r.data.threadId };
    },
    async deleteDraft(draftId) {
      await gmail.users.drafts.delete({ userId: 'me', id: draftId }).catch(() => {});
    },
    async getSentMessageIdHeader(messageId) {
      const r = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'metadata', metadataHeaders: ['Message-ID'] });
      return header(r.data.payload && r.data.payload.headers, 'Message-ID');
    },
  };
}

/** Builds one mailbox per distinct client.mailbox name, using env refresh tokens. */
function createMailboxes(config, clients) {
  const out = {};
  for (const c of clients) {
    if (out[c.mailbox]) continue;
    const refreshToken = config.mailboxToken(c.mailbox);
    if (!refreshToken || !config.google.clientId) continue;
    out[c.mailbox] = createGmailMailbox({
      name: c.mailbox,
      email: c.fromEmail,
      oauth: { ...config.google, refreshToken },
    });
  }
  return out;
}

module.exports = { createGmailMailbox, createMailboxes, normalizeMessage, extractBody, LABELS };
