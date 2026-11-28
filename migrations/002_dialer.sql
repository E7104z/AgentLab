-- Cold Call Dialer storage. The dialer keeps its working set in memory and writes
-- changed rows here about a second after each change (see dialer/store.js).

CREATE TABLE dialer_leads (
  id            TEXT PRIMARY KEY,
  phone_digits  TEXT,
  status        TEXT,
  data          JSONB NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX dialer_leads_phone ON dialer_leads (phone_digits);
CREATE INDEX dialer_leads_status ON dialer_leads (status);

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

CREATE TABLE dialer_ai_scripts (
  lead_id     TEXT PRIMARY KEY,
  data        JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
