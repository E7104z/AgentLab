/** Builds RFC 5322 plain-text messages for the Gmail API. */

function encodeHeader(value) {
  const v = String(value || '');
  // RFC 2047 always: model output often has em dashes or curly quotes.
  return '=?UTF-8?B?' + Buffer.from(v, 'utf8').toString('base64') + '?=';
}

function formatAddress(name, email) {
  if (!name) return email;
  return encodeHeader(name) + ' <' + email + '>';
}

function sanitizeHeaderValue(v) {
  return String(v || '').replace(/[\r\n]+/g, ' ').trim();
}

/** "Re: Subject" without stacking "Re: Re:". */
function replySubject(subject) {
  const s = String(subject || '').trim();
  return /^re:/i.test(s) ? s : 'Re: ' + s;
}

/** References header for a reply: existing chain + the message being answered. */
function buildReferences(existingReferences, inReplyTo) {
  const ids = String(existingReferences || '').match(/<[^>]+>/g) || [];
  if (inReplyTo && !ids.includes(inReplyTo)) ids.push(inReplyTo);
  return ids.slice(-20).join(' ');
}

function buildRawMessage({ fromEmail, fromName, to, replyTo, subject, body, inReplyTo, references, extraHeaders = {} }) {
  if (!fromEmail) throw new Error('fromEmail is required');
  if (!to) throw new Error('to is required');
  const headers = [
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    'From: ' + formatAddress(sanitizeHeaderValue(fromName), sanitizeHeaderValue(fromEmail)),
    'To: ' + sanitizeHeaderValue(to),
  ];
  if (replyTo && replyTo.toLowerCase() !== fromEmail.toLowerCase()) headers.push('Reply-To: ' + sanitizeHeaderValue(replyTo));
  headers.push('Subject: ' + encodeHeader(sanitizeHeaderValue(subject)));
  if (inReplyTo) headers.push('In-Reply-To: ' + sanitizeHeaderValue(inReplyTo));
  if (references) headers.push('References: ' + sanitizeHeaderValue(references));
  for (const [k, v] of Object.entries(extraHeaders)) headers.push(k + ': ' + sanitizeHeaderValue(v));

  const bodyB64 = Buffer.from(String(body || '').replace(/\r?\n/g, '\r\n'), 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n');
  const message = headers.join('\r\n') + '\r\n\r\n' + bodyB64;
  return Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decodes a raw message back to headers + body (used in tests and the dashboard preview). */
function parseRawMessage(raw) {
  const text = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  const [head, ...rest] = text.split('\r\n\r\n');
  const headers = {};
  for (const line of head.split('\r\n')) {
    const i = line.indexOf(':');
    headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  const decodeWord = (v) =>
    String(v || '').replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, b) => Buffer.from(b, 'base64').toString('utf8'));
  headers.subject = decodeWord(headers.subject);
  headers.from = decodeWord(headers.from);
  const body = Buffer.from(rest.join('\r\n\r\n').replace(/\r\n/g, ''), 'base64').toString('utf8').replace(/\r\n/g, '\n');
  return { headers, body };
}

module.exports = { buildRawMessage, parseRawMessage, replySubject, buildReferences, encodeHeader };
