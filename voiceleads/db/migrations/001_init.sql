-- VoiceLeads core schema (portable SQL; works on SQLite and Postgres)
-- Idempotent-ish: runner tracks applied migrations in _migrations.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,               -- scrypt
  name          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,               -- random 32-byte token (hashed server-side not needed; it IS the secret)
  user_id    TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,               -- epoch ms
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE workspaces (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES users(id),
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  role         TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE plans (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  amount_bdt    INTEGER NOT NULL,            -- monthly price in BDT poisha-free whole taka
  included_minutes INTEGER NOT NULL,
  included_seats   INTEGER NOT NULL DEFAULT 3,
  active        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE subscriptions (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id),
  plan_id            TEXT NOT NULL REFERENCES plans(id),
  status             TEXT NOT NULL CHECK (status IN ('trialing','pending_payment','active','past_due','canceled')),
  bkash_agreement_id TEXT,
  current_period_end INTEGER,                -- epoch ms
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_subs_ws ON subscriptions(workspace_id, status);

CREATE TABLE payments (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  subscription_id TEXT REFERENCES subscriptions(id),
  provider     TEXT NOT NULL DEFAULT 'bkash',
  kind         TEXT NOT NULL CHECK (kind IN ('agreement','auto_capture','manual','refund')),
  amount_bdt   INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('initiated','complete','failed','refunded')),
  external_ref TEXT,                          -- bKash paymentID / trxID
  raw          TEXT,                           -- last webhook payload (json text)
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, external_ref, kind)
);

CREATE TABLE credentials (
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  provider      TEXT NOT NULL,                -- anthropic | elevenlabs | vapi | twilio
  secret_enc    TEXT NOT NULL,                -- AES-256-GCM ciphertext
  hint          TEXT,                         -- last 4 chars only, for the UI
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, provider)
);

CREATE TABLE campaigns (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('draft','scheduled','running','paused','completed','canceled')),
  goal_prompt  TEXT NOT NULL,                 -- what the AI should achieve on each call
  voice_id     TEXT,
  scheduled_at INTEGER,
  timezone     TEXT DEFAULT 'Asia/Dhaka',
  max_minutes_per_day INTEGER NOT NULL DEFAULT 120,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE leads (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  campaign_id  TEXT REFERENCES campaigns(id),
  phone        TEXT NOT NULL,
  name         TEXT,
  company      TEXT,
  source       TEXT NOT NULL DEFAULT 'import',   -- import | inbound | referral
  score        INTEGER,                          -- 0..100, set by Claude extraction
  intent       TEXT,                             -- hot | warm | cold
  tags         TEXT,                             -- json array
  custom       TEXT,                             -- json object (structured extraction)
  consented_at TEXT,                             -- proof of opt-in for outbound dialing
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workspace_id, phone)
);
CREATE INDEX idx_leads_ws_intent ON leads(workspace_id, intent);

CREATE TABLE calls (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  campaign_id     TEXT REFERENCES campaigns(id),
  lead_id         TEXT REFERENCES leads(id),
  direction       TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  status          TEXT NOT NULL CHECK (status IN ('queued','ringing','in_progress','completed','failed','no_answer')),
  from_number     TEXT,
  to_number       TEXT,
  started_at      INTEGER,
  ended_at        INTEGER,
  duration_sec    INTEGER NOT NULL DEFAULT 0,
  recording_url   TEXT,
  transcript      TEXT,
  summary         TEXT,                        -- Claude-generated recap
  extracted_json  TEXT,                        -- Claude-extracted lead data
  cost_cents      INTEGER NOT NULL DEFAULT 0,
  provider_call_id TEXT,
  error           TEXT
);
CREATE INDEX idx_calls_ws ON calls(workspace_id, status);
CREATE INDEX idx_calls_provider ON calls(provider_call_id);

CREATE TABLE usage_events (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  type         TEXT NOT NULL CHECK (type IN ('call_minute','llm_token','tts_char','sms')),
  qty          REAL NOT NULL,
  cost_cents   INTEGER NOT NULL DEFAULT 0,
  ref_id       TEXT,                            -- call id etc.
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_usage_ws_time ON usage_events(workspace_id, created_at);

CREATE TABLE webhooks_log (
  id         TEXT PRIMARY KEY,
  source     TEXT NOT NULL,                     -- bkash | elevenlabs | vapi | twilio
  event_type TEXT,
  payload    TEXT,
  processed  INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE audit_log (
  id         TEXT PRIMARY KEY,
  workspace_id TEXT,
  user_id    TEXT,
  action     TEXT NOT NULL,                     -- login | subscribe | key_rotate | export ...
  ip         TEXT,
  meta       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
