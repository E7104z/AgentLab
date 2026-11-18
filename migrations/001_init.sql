-- AgentLab v2 schema. Every row is scoped by client_id.

CREATE TABLE contacts (
  id            BIGSERIAL PRIMARY KEY,
  client_id     TEXT NOT NULL,
  email         TEXT,
  name          TEXT,
  business      TEXT,
  phone         TEXT,
  source        TEXT,
  ref           TEXT,
  utm           JSONB NOT NULL DEFAULT '{}'::jsonb,
  landing_page  TEXT,
  chore         TEXT,
  status        TEXT NOT NULL DEFAULT 'new',
  ref_code      TEXT,
  do_not_email  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX contacts_client_email ON contacts (client_id, lower(email)) WHERE email IS NOT NULL;
CREATE INDEX contacts_client_status ON contacts (client_id, status);

CREATE TABLE conversations (
  id              BIGSERIAL PRIMARY KEY,
  client_id       TEXT NOT NULL,
  contact_id      BIGINT REFERENCES contacts(id),
  mailbox         TEXT NOT NULL,
  thread_id       TEXT NOT NULL,
  subject         TEXT,
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mailbox, thread_id)
);
CREATE INDEX conversations_contact ON conversations (contact_id, last_message_at DESC);

CREATE TABLE messages (
  id               BIGSERIAL PRIMARY KEY,
  client_id        TEXT,
  conversation_id  BIGINT REFERENCES conversations(id),
  contact_id       BIGINT REFERENCES contacts(id),
  mailbox          TEXT NOT NULL,
  direction        TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  gmail_message_id TEXT,
  gmail_thread_id  TEXT,
  rfc_message_id   TEXT,
  rfc_references   TEXT,
  subject          TEXT,
  from_email       TEXT,
  from_name        TEXT,
  to_header        TEXT,
  body             TEXT,
  category         TEXT,
  decision         JSONB,
  action           TEXT,
  status           TEXT NOT NULL DEFAULT 'received',
  attempts         INT NOT NULL DEFAULT 0,
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX messages_mailbox_gmail ON messages (mailbox, gmail_message_id) WHERE gmail_message_id IS NOT NULL;
CREATE INDEX messages_conversation ON messages (conversation_id, created_at);
CREATE INDEX messages_status ON messages (status) WHERE status = 'failed';

-- Every outbound email passes through the outbox. One sender, one set of checks.
CREATE TABLE outbox (
  id               BIGSERIAL PRIMARY KEY,
  client_id        TEXT NOT NULL,
  contact_id       BIGINT REFERENCES contacts(id),
  conversation_id  BIGINT REFERENCES conversations(id),
  deal_id          BIGINT,
  kind             TEXT NOT NULL,
  mailbox          TEXT NOT NULL,
  to_email         TEXT NOT NULL,
  subject          TEXT NOT NULL,
  body             TEXT NOT NULL,
  thread_id        TEXT,
  in_reply_to      TEXT,
  references_hdr   TEXT,
  policy           TEXT NOT NULL DEFAULT 'auto',   -- auto | review | internal
  status           TEXT NOT NULL DEFAULT 'queued', -- queued | held | pending_review | sent | logged | suppressed | discarded | failed
  reason           TEXT,
  gmail_draft_id   TEXT,
  gmail_message_id TEXT,
  attempts         INT NOT NULL DEFAULT 0,
  error            TEXT,
  dedupe_key       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at          TIMESTAMPTZ
);
CREATE UNIQUE INDEX outbox_dedupe ON outbox (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX outbox_status ON outbox (status, created_at);

CREATE TABLE events (
  id          BIGSERIAL PRIMARY KEY,
  client_id   TEXT NOT NULL,
  contact_id  BIGINT REFERENCES contacts(id),
  type        TEXT NOT NULL,
  external_id TEXT,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX events_external ON events (type, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX events_client_type ON events (client_id, type, created_at);

CREATE TABLE tasks (
  id          BIGSERIAL PRIMARY KEY,
  client_id   TEXT NOT NULL,
  contact_id  BIGINT REFERENCES contacts(id),
  deal_id     BIGINT,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  details     TEXT,
  due_at      TIMESTAMPTZ,
  status      TEXT NOT NULL DEFAULT 'open',
  dedupe_key  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX tasks_dedupe ON tasks (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX tasks_open ON tasks (client_id, status, due_at);

CREATE TABLE enrollments (
  id           BIGSERIAL PRIMARY KEY,
  client_id    TEXT NOT NULL,
  contact_id   BIGINT NOT NULL REFERENCES contacts(id),
  deal_id      BIGINT,
  sequence_key TEXT NOT NULL,
  step         INT NOT NULL DEFAULT 0,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_run_at  TIMESTAMPTZ,
  status       TEXT NOT NULL DEFAULT 'active', -- active | stopped | completed
  stop_reason  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX enrollments_one_active ON enrollments (client_id, contact_id, sequence_key) WHERE status = 'active';
CREATE INDEX enrollments_due ON enrollments (status, next_run_at);

CREATE TABLE suppressions (
  client_id  TEXT NOT NULL,
  email      TEXT NOT NULL,
  reason     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, email)
);

CREATE TABLE deals (
  id                     BIGSERIAL PRIMARY KEY,
  client_id              TEXT NOT NULL,
  contact_id             BIGINT NOT NULL REFERENCES contacts(id),
  stage                  TEXT NOT NULL DEFAULT 'booked', -- booked | call_done | proposal_draft | proposal_sent | won | delivered | lost
  offer                  TEXT,                            -- quick_fix | custom
  amount_cents           INT,
  monthly_cents          INT,
  call_notes             TEXT,
  booking_uid            TEXT,
  booking_start          TIMESTAMPTZ,
  proposal_doc_id        TEXT,
  proposal_url           TEXT,
  checkout_session_id    TEXT,
  checkout_url           TEXT,
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  won_at                 TIMESTAMPTZ,
  delivered_at           TIMESTAMPTZ,
  happy_confirmed        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX deals_client_stage ON deals (client_id, stage);

CREATE TABLE agent_state (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id         BIGSERIAL PRIMARY KEY,
  client_id  TEXT,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  details    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created ON audit_log (created_at DESC);
