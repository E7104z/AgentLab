# AgentLab

The automation engine behind therealhelp.com, and the product The Real Help sells: an AI assistant that answers every lead in minutes, books the call, follows up, drafts the proposal, takes payment, onboards the client, asks for the review and reports on all of it. Multi-client: The Real Help is client #1.

## What it does

| Step | What happens | Where |
|---|---|---|
| Website lead | Signed webhook → contact saved → AI reply in the same minute (template fallback if the model is down) → follow-ups enrolled → owner alerted. Phone-only leads become a "call within 1 hour" task. No texting. | `src/flows/leads.js` |
| Email | Gmail history API (never `is:unread`, never marks mail read) → route by alias → opt-outs and bounces handled → Claude decides with a forced tool call → validated → policy → threaded reply | `src/flows/inbound.js`, `src/agent/*` |
| Booking | Cal.com webhook: booked stops follow-ups, opens a deal and sends prep questions in the lead's thread; cancelled sends a reschedule link; ended creates a "call notes" task. Reminders are Cal.com workflows. | `src/flows/booking.js` |
| Follow-up | Per-client sequences (day 2/5/12 after a lead, day 3/10 after a proposal, day 7/30/45 after delivery). Business hours only. Stop on reply, booking, payment, opt-out or bounce. | `src/flows/sequences.js` |
| Proposal | Call notes → Claude drafts sections (numbers checked against notes) → Google Doc with bold filled values → Stripe Checkout link → email waits in Review for approval | `src/flows/deals.js` |
| Payment | Stripe webhook (signature verified, idempotent): won → follow-ups stop → welcome email → client portal invite → build task | `src/flows/deals.js` |
| After delivery | Review request (only if marked happy), check-in, referral link with the client's own `?ref=` code | sequences |
| Reports | 7 a.m. daily digest, Monday scorecard (leads by source, median first reply, booked and won rates, MRR), optional Sheet row, per-client weekly report | `src/reports/reports.js` |
| Dashboard | Kill switch, review queue, tasks, pipeline with deal actions, contacts and conversations, test runner, activity | `public/` |

## Safety model

- **Master kill switch.** `AGENT_ENABLED` defaults to `false`, and a redeploy resets it. While off, nothing touches Gmail and nothing is invited or sent; leads and bookings are still recorded and items are held. Turning it on sends fresh held items and routes anything older than 12 hours to Review. A test proves zero outbound actions while off.
- **Staged rollout per client.** `sendMode`: `log` (decide only) → `draft` (Gmail draft + Review) → `send`.
- **One outbox.** Every email is a row in `outbox` and passes one processor: kill switch, suppression list, demo limits, sendMode, then Gmail. Dedupe keys make every flow safe to retry.
- **No invented facts.** The model answers only from `clients/<id>/knowledge.md`. A reply that states a price or percentage not in the knowledge, or contains a placeholder, goes to a human. Proposals reject numbers not in the call notes. Prices come from config or from what Jason typed.
- **Always a human for** billing, client support, refunds, discounts, legal threats, complaints, low confidence, and every proposal email.
- **Prompt-injection resistance.** Inbound text is framed as untrusted data, and the model can only fill a fixed tool schema.
- **Webhooks** are HMAC-verified (lead: timestamped, 5-minute window; Cal.com: `X-Cal-Signature-256`; Stripe: official verification). The dashboard uses Basic auth and refuses to open without credentials. Helmet security headers, rate limits.
- **Client isolation.** Every row carries `client_id`, and every dashboard query is scoped to it.

## Setup

1. `npm install`
2. Copy `env.example` to `.env` (or set Railway Variables). `DATABASE_URL` is required; migrations run on start.
3. Google Cloud Console: enable the Gmail, Docs, Drive and Sheets APIs; create an OAuth Desktop client; set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
4. `npm run auth`, sign in as **info@thecdscloud.com**, and set the printed `GMAIL_REFRESH_TOKEN_MAIN`.
5. `npm start`, open the dashboard, test with **Test agent**, then turn the agent on.

The full go-live checklist is in `docs/GO-LIVE.md`. The website change is in `docs/WEBSITE_HOOK.md`.

## Adding a client

`npm run client:new -- acme "Acme Plumbing"` creates `clients/acme/client.json` (log mode, sequences off) and `knowledge.md`, and prints the onboarding checklist. The knowledge file is the calibration work you're charging for.

## Endpoints

Public: `GET /healthz`, `POST /webhooks/lead?client=<id>`, `POST /webhooks/cal?client=<id>`, `POST /webhooks/stripe`.

Dashboard API (Basic auth): `/api/config`, `/api/clients`, `/api/agent-status`, `/api/agent-toggle`, `/api/run-agent` (decide only), `/api/poll-log`, `/api/poll-now`, `/api/review` (+ `approve`, `discard`, `retry`), `/api/tasks`, `/api/pipeline`, `/api/contacts`, `/api/deals/:id/{notes,proposal,no-show,delivered,lost}`, `/api/scorecard`, `/api/digest-preview`, `/api/outbox`.

## Tests

`npm test` runs 51 tests against a real Postgres (`TEST_DATABASE_URL`, default `postgres://agentlab:agentlab@localhost:5432/agentlab_test`) with fake Gmail, Claude, Docs and portal, plus Stripe's own signature code. They cover routing, threading, the history cursor and fallback, idempotency, retries, opt-outs, bounces, the send policy, invented-price blocking, demo limits, every webhook signature, the booking lifecycle, sequences, the kill switch, and a full lead → paid → delivered → review run.

## History

v1 (July 2026): one inbox, one client, JSON scraped from free text, an unused SMS subsystem. v2 (Nov 2026): Postgres, the outbox, threading, the full lifecycle, the dashboard and tests. SMS was removed.
