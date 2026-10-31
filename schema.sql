-- CTaDI onboarding schema. Run once against your Postgres database:
--   npm run migrate          (reads DATABASE_URL from .env)
-- or paste this into the Vercel/Neon SQL editor.

CREATE TABLE IF NOT EXISTS applications (
  id            TEXT PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  email         TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL,
  role_label    TEXT NOT NULL,
  status        TEXT NOT NULL,
  application   JSONB NOT NULL,
  decision      TEXT,
  decided_at    TIMESTAMPTZ,
  decided_by    TEXT
);

CREATE INDEX IF NOT EXISTS idx_applications_status  ON applications (status);
CREATE INDEX IF NOT EXISTS idx_applications_created ON applications (created_at DESC);

-- One active application per email address. The partial index lets a rejected
-- applicant apply again later while still blocking a duplicate while pending.
CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_email_active
  ON applications (email) WHERE status IN ('received', 'pending_review');

CREATE TABLE IF NOT EXISTS audit_log (
  id             BIGSERIAL PRIMARY KEY,
  at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  application_id TEXT,
  action         TEXT NOT NULL,
  detail         JSONB
);

CREATE INDEX IF NOT EXISTS idx_audit_application ON audit_log (application_id, id DESC);

-- Distributed rate limiting, so the submit limit survives across the many
-- short-lived instances a serverless deployment runs.
CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,
  window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  count        INTEGER NOT NULL DEFAULT 0
);

-- Ordinary admin accounts, created by the master admin (the ADMIN_API_TOKEN
-- in the environment). Only the SHA-256 hash of a token is stored, never the
-- token itself; the plaintext is shown once, at creation.
CREATE TABLE IF NOT EXISTS admins (
  id           TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  token_prefix TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admins_token_hash ON admins (token_hash);
