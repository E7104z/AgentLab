# Lead Response Agent

A multi-client AI agent that reads a real inbox, decides which messages are genuine business inquiries, and drafts (or sends) a response in the right voice for the right client — running independently in the cloud, no laptop required.

## The 5-step loop

| Step | What it does | Where |
|---|---|---|
| **Trigger** | Inbox poller checks for unread mail every `POLL_INTERVAL_MS` | `server.js` → `pollInbox()` |
| **Context** | Routes mail to the right client by plus-alias, pulls their voice/services | `client-registry.js` |
| **Model call** | Sends the message to Claude with an injection-resistant system prompt | `server.js` → `decideAndAct()` |
| **Decision** | Claude returns structured JSON: respond or not, subject, body, reasoning | Claude Haiku via Anthropic API |
| **Action** | Creates a Gmail draft (or sends) with correct reply-to and sender name | `gmail-client.js` |

## Stack

- **Claude (Anthropic API)** — decision-making, model set via `MODEL` env var (defaults to Haiku for cost)
- **Gmail API (OAuth2 via `googleapis`)** — reads inbox, creates drafts, sends mail, labels for dedup
- **Node.js + Express** — server
- **Google Cloud Console** — OAuth client lives in a dedicated `real-help-internal-agents` project, Internal consent screen (Workspace-only, no Google verification needed)
- **Railway** — hosting, auto-deploys from GitHub on push

## Setup

1. `npm install`
2. Copy `.env.example` → `.env`, fill in `ANTHROPIC_API_KEY`
3. Google Cloud Console: enable Gmail API on your project, create an OAuth Desktop client, add `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` to `.env`
4. `npm run auth` — opens a consent URL, log in as the mailbox owner, approve. Paste the printed `GOOGLE_REFRESH_TOKEN` into `.env`
5. `npm start`

## Adding a client

1. Copy `clients/_example.json` → `clients/<id>.json`
2. Fill in `businessName`, `replyToEmail`, `intakeAlias` (e.g. `leads+acme@yourdomain.com`), `servicesDescription`, `voiceNotes`
3. Have the client forward their contact form (or inbox) to their `intakeAlias`
4. Restart the server — it auto-loads every `.json` in `clients/`
5. New clients start at `"sendMode": "log"` — graduate to `"draft"` then `"send"` only after reviewing real output

`clients/_default.json` is the first-party config (mail with no plus-alias, i.e. straight to the base inbox).

## Per-client fields

| Field | Purpose |
|---|---|
| `sendMode` | `"log"` (decide only) → `"draft"` (creates real Gmail draft) → `"send"` (actually sends) |
| `replyTo` | Leads reply straight to the client's own inbox, not yours |
| `fromDisplayName` | From name on outbound mail |
| `intakeAlias` | The plus-address substring used to route mail to this client |
| `servicesDescription` / `voiceNotes` / `tagline` | Feeds directly into the system prompt — this is the actual calibration work |

## Safety features

- **Prompt injection resistance** — inbound message text is explicitly framed as untrusted content to evaluate, never as instructions to follow. Tested against buried instructions, fake system messages, and prompts trying to extract the system prompt itself.
- **Noise pre-filter** (`NOISE_SENDER_PATTERNS` in `gmail-client.js`) — no-reply, mailer-daemon, DMARC reports, security alerts, etc. get skipped before any Claude call. Zero API cost on junk.
- **Unrouted safety net** — mail to an unrecognized `+alias` is flagged in the poll log, not guessed at. Silent misrouting between clients is the one failure mode that actually damages trust.
- **Dedup labeling** — `Agent-Processed` Gmail label prevents reprocessing the same message twice.
- **Staged rollout per client** — nothing reaches a real inbox unreviewed until `sendMode` is manually graduated.

## Endpoints

- `GET /api/clients` — list configured clients
- `GET /api/config` — poll status, interval, client count
- `POST /api/run-agent` — manual single-message test (used by `public/index.html`)
- `GET /api/poll-log` — last 100 poll cycle results (decisions, actions, filtered/unrouted flags)
- `POST /api/poll-now` — trigger an immediate poll cycle

## Known gaps / next steps

- **No crash/failure alerting yet** — if polling errors out repeatedly, nothing currently notifies anyone. Needed before this handles a paying client's leads unsupervised.
- Currently one client configured (`default`). Multi-client capacity is built, just not populated yet.
- `sendMode` for `default` is `"draft"` — has not been graduated to `"send"`.

## History

Originally a single-client Apps Script system, scrapped and rebuilt as a Node/Express app to support real infrastructure ownership (Railway hosting, multi-client routing) instead of per-client Apps Script duplication.
