# Connecting the therealhelp.com lead form to AgentLab

The website's `/api/lead` (repo `E7104z/the-real-help`, file `api/lead.js`) keeps writing to the Google Sheet as it does today and also forwards each lead to AgentLab.

## Contract

`POST {AGENTLAB_URL}/webhooks/lead?client=default`

Headers:
- `Content-Type: application/json`
- `X-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with LEAD_WEBHOOK_SECRET>`

Requests older than 5 minutes are rejected.

Body:

```json
{
  "leadId": "uuid generated once per submission (required, 6-100 chars; makes retries safe)",
  "name": "Ana Ruiz",
  "contact": "ana@shop.com or a phone number",
  "business": "Ruiz Cleaning",
  "message": "What they want automated",
  "chore": "optional: the one chore they'd hand off",
  "ref": "optional partner code from ?ref=",
  "utm": { "utm_source": "...", "utm_medium": "..." },
  "landingPage": "/industries/cleaning",
  "source": "homepage"
}
```

Responses: `200 {"ok":true,...}`, `200 {"ok":true,"duplicate":true}` for a repeated `leadId`, `401` bad signature, `400` invalid payload.

## Code to add to `api/lead.js` (after the Sheet write succeeds)

```js
import crypto from 'node:crypto';

async function forwardToAgentLab(lead) {
  const url = process.env.AGENTLAB_LEAD_URL;       // https://<railway-app>/webhooks/lead?client=default
  const secret = process.env.AGENTLAB_LEAD_SECRET; // same value as AgentLab's LEAD_WEBHOOK_SECRET
  if (!url || !secret) return;
  const raw = JSON.stringify(lead);
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Signature': `t=${t},v1=${v1}` },
      body: raw,
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) console.error('agentlab forward failed', r.status);
  } catch (err) {
    console.error('agentlab forward error', err instanceof Error ? err.message : err);
  }
}

// inside handler(), after the sheet write is confirmed and before returning 200:
await forwardToAgentLab({
  leadId: crypto.randomUUID(),
  name, contact, business, message,
  chore: clean(body.chore, 300),
  ref: clean(body.ref, 40),
  utm: typeof body.utm === 'object' && body.utm ? body.utm : {},
  landingPage: clean(body.landingPage, 300),
  source: clean(body.source, 60) || 'homepage',
});
```

A failed forward never blocks the visitor's success message, because the Sheet already has the lead. AgentLab's daily digest shows the leads it received, so a gap is visible.

Vercel env vars: `AGENTLAB_LEAD_URL`, `AGENTLAB_LEAD_SECRET`.
