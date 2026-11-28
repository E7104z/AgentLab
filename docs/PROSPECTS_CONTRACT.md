# Prospects contract: dialer, AgentLab and real-help-agent

One Postgres database, one `prospects` table (migration `002_dialer.sql`). Cold email sending stays in
real-help-agent; it reads and writes the same rows.

## Who owns what
| Columns | Owner | Notes |
|---|---|---|
| phone, email, business, city, state, call_*, stage, `data` | dialer | the dialer's save never touches the email columns below |
| `email_state`, `email_sent_count`, `last_email_at`, `next_email_at`, `email_approved_at` | real-help-agent (and you, for approval) | `email_state`: none, ready, sent, replied, bounced, suppressed, stopped |
| `email_hold_until`, `email_stop_reason`, `pending_touch`, `call_priority_at` | dialer / AgentLab actions | set by call outcomes and email replies |
| `opt_outs` | everyone, via `applyOptOut` | one list for phone and email |
| `research` | dialer (Haiku business research) | reuse for first-touch email copy |

## What real-help-agent reads
- `emailable_prospects`: valid email, `email_approved_at` set, state `ready`/`sent`, no stop reason, no hold, no call outcome of dnc / not_interested / interested / meeting_booked / closed_won, and not in `opt_outs`.
- `pending_touches`: voicemail follow-ups (`pending_touch = 'missed_you'`) with the booking link. These answer your own call and skip the cold-email approval, but never go to suppressed, bounced or stopped addresses.
- `GET /api/dialer/limits` (or compute the same from `prospect_events`): `recommendedCap` for today. Starts at `COLD_EMAIL_DAILY_CAP` (default 10); steps up about 50% only when 7-day bounces < 2% and complaints < 0.1% over 30+ sends; halves at bounces >= 5% or complaints >= 0.3%.

## What real-help-agent must write back
For every send, bounce, complaint, open/click, unsubscribe, reply it sees:
1. `INSERT INTO prospect_events (id, prospect_id, channel, kind, summary, source)` with `channel='email'`, `kind` one of `sent`, `reply`, `reply_positive`, `bounce`, `complaint`, `click`, `unsubscribe`, `source='real-help-agent'`. The funnel and the ramp count these.
2. `UPDATE prospects SET email_state, email_sent_count, last_email_at, next_email_at` after a send (clear `pending_touch` after sending a "missed you").
3. For bounce / complaint / unsubscribe, call the same rule set as the dialer by inserting into `opt_outs` (`block_email` for unsubscribe and complaint, `bad_email` for bounce) and set `email_state` to `suppressed` / `bounced`.
4. A click on the booking link: `UPDATE prospects SET call_priority_at = now()` (floats the lead to the top of the call queue).

The dialer re-reads changed rows every 30 seconds.

## Opt-out rules
- Do Not Call, Not Interested: block email and phone.
- Unsubscribe, complaint: block email; phone stays callable, shown as "NO EMAIL" on the call screen.
- Bounce: email marked bad; phone untouched.

## Not built yet (real-help-agent side, TypeScript)
A Postgres adapter in real-help-agent (add `pg`, read the two views, write events back), a `DATABASE_URL` reachable from the machine it runs on, and loading its 2,084 staged leads into `prospects`. Until then nothing emails from this table.
