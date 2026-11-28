-- Shared prospect master (cold call dialer + cold email). One row per business/person we
-- might contact. The dialer keeps its working set in memory and writes changed rows here;
-- real-help-agent (cold email) reads `emailable_prospects` and writes email-side results back
-- (see docs/PROSPECTS_CONTRACT.md). Not the CRM: a prospect becomes a CRM contact only on a
-- real signal (reply, Interested or better, a booking).

CREATE TABLE prospects (
  id               TEXT PRIMARY KEY,
  phone_digits     TEXT,                 -- 10 digits, matched first
  email            TEXT,                 -- lower-case, matched second
  business_key     TEXT,                 -- normalized business name + '|' + city, matched third
  business_name    TEXT,
  city             TEXT,
  state            TEXT,
  stage            TEXT NOT NULL DEFAULT 'new',   -- new, contacted, engaged, interested, booked, won, lost, suppressed

  -- phone channel (owned by the dialer)
  call_status      TEXT,                 -- new, no_answer, voicemail, callback, interested, ... (dialer outcomes)
  call_attempts    INT NOT NULL DEFAULT 0,
  last_call_at     TIMESTAMPTZ,
  next_call_at     TIMESTAMPTZ,
  callback_at      TIMESTAMPTZ,
  call_blocked     BOOLEAN NOT NULL DEFAULT FALSE,   -- do-not-call
  call_priority_at TIMESTAMPTZ,          -- set by a positive email signal; floats to the top of the call queue

  -- email channel (state changes by real-help-agent, plus suppression/holds from the dialer)
  email_state      TEXT NOT NULL DEFAULT 'none',     -- none, ready, sent, replied, bounced, suppressed, stopped
  email_approved_at TIMESTAMPTZ,         -- cold email only goes out after you approve (null = not approved)
  email_hold_until TIMESTAMPTZ,          -- callback pause: no cold email before this
  email_stop_reason TEXT,                -- interested, booked, replied, called-not-interested, ...
  pending_touch    TEXT,                 -- 'missed_you' = send the post-voicemail email next
  email_sent_count INT NOT NULL DEFAULT 0,
  last_email_at    TIMESTAMPTZ,
  next_email_at    TIMESTAMPTZ,
  email_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),   -- bumped by trigger when an email column changes

  crm_contact_id   BIGINT,
  crm_deal_id      BIGINT,
  research         JSONB,                -- shared business research (website facts, hook, best-fit offer)
  data             JSONB NOT NULL,       -- the full lead record the dialer works with
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX prospects_phone ON prospects (phone_digits) WHERE phone_digits IS NOT NULL;
CREATE INDEX prospects_email ON prospects (email) WHERE email IS NOT NULL;
CREATE INDEX prospects_business_key ON prospects (business_key);
CREATE INDEX prospects_call_status ON prospects (call_status);
CREATE INDEX prospects_email_state ON prospects (email_state, email_approved_at);
CREATE INDEX prospects_email_updated ON prospects (email_updated_at);

CREATE FUNCTION prospects_email_touch() RETURNS trigger AS $$
BEGIN
  IF NEW.email_state IS DISTINCT FROM OLD.email_state OR NEW.email_sent_count IS DISTINCT FROM OLD.email_sent_count
     OR NEW.last_email_at IS DISTINCT FROM OLD.last_email_at OR NEW.next_email_at IS DISTINCT FROM OLD.next_email_at
     OR NEW.pending_touch IS DISTINCT FROM OLD.pending_touch OR NEW.email_approved_at IS DISTINCT FROM OLD.email_approved_at THEN
    NEW.email_updated_at := now();
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER prospects_email_touch BEFORE UPDATE ON prospects FOR EACH ROW EXECUTE FUNCTION prospects_email_touch();

-- One opt-out list for both channels. A row can carry an email, a phone, or both.
--   block_email / block_phone : never contact on that channel
--   flag_phone                : phone stays callable, but the person asked off email (shown on the call screen)
CREATE TABLE opt_outs (
  id           BIGSERIAL PRIMARY KEY,
  email        TEXT,
  phone_digits TEXT,
  reason       TEXT NOT NULL,            -- dnc, not_interested, unsubscribe, complaint, bounce, manual
  block_email  BOOLEAN NOT NULL DEFAULT FALSE,
  block_phone  BOOLEAN NOT NULL DEFAULT FALSE,
  flag_phone   BOOLEAN NOT NULL DEFAULT FALSE,
  bad_email    BOOLEAN NOT NULL DEFAULT FALSE,   -- hard bounce: email address invalid
  source       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR phone_digits IS NOT NULL)
);
CREATE UNIQUE INDEX opt_outs_email ON opt_outs (email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX opt_outs_phone ON opt_outs (phone_digits) WHERE phone_digits IS NOT NULL;

-- One timeline per prospect: calls, notes, emails sent/opened/replied, bookings, system changes.
CREATE TABLE prospect_events (
  id           TEXT PRIMARY KEY,
  prospect_id  TEXT NOT NULL,
  at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  channel      TEXT NOT NULL,            -- call, email, note, booking, system
  kind         TEXT NOT NULL,            -- outcome key, sent, reply, bounce, click, unsubscribe, ...
  summary      TEXT,
  source       TEXT NOT NULL DEFAULT 'dialer',   -- dialer, agentlab, real-help-agent
  data         JSONB,
  seq          BIGSERIAL
);
CREATE INDEX prospect_events_prospect ON prospect_events (prospect_id, at);
CREATE INDEX prospect_events_seq ON prospect_events (seq);

-- Dialer call log (kept as its own table: it drives the scoreboard)
CREATE TABLE dialer_calls (
  id        TEXT PRIMARY KEY,
  lead_id   TEXT NOT NULL,
  at        TIMESTAMPTZ NOT NULL,
  data      JSONB NOT NULL
);
CREATE INDEX dialer_calls_lead ON dialer_calls (lead_id, at);
CREATE INDEX dialer_calls_at ON dialer_calls (at);

-- settings, imports history, meta
CREATE TABLE dialer_kv (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cold email reads this. A prospect is eligible only with a valid email, no suppression,
-- your approval, no stop/hold, and nothing but a clean (or already emailed) state.
CREATE VIEW emailable_prospects AS
SELECT p.id, p.email, p.business_name, p.city, p.state, p.email_state, p.email_sent_count, p.last_email_at,
       p.next_email_at, p.pending_touch, p.research, p.data
FROM prospects p
WHERE p.email IS NOT NULL
  AND p.email_approved_at IS NOT NULL
  AND p.email_state IN ('ready', 'sent')
  AND p.email_stop_reason IS NULL
  AND (p.email_hold_until IS NULL OR p.email_hold_until <= now())
  AND (p.call_status IS NULL OR p.call_status NOT IN ('dnc', 'not_interested', 'interested', 'meeting_booked', 'closed_won'))
  AND NOT EXISTS (SELECT 1 FROM opt_outs o WHERE o.block_email AND o.email = p.email);

-- "Missed you" emails after a voicemail. These answer your own call, so they do not need the
-- cold-email approval, but they never go to a suppressed, bounced or stopped address.
CREATE VIEW pending_touches AS
SELECT p.id, p.email, p.business_name, p.city, p.state, p.pending_touch, p.research, p.data
FROM prospects p
WHERE p.pending_touch IS NOT NULL
  AND p.email IS NOT NULL
  AND p.email_state NOT IN ('bounced', 'suppressed', 'stopped')
  AND p.call_blocked = FALSE
  AND NOT EXISTS (SELECT 1 FROM opt_outs o WHERE (o.block_email OR o.bad_email) AND o.email = p.email);
