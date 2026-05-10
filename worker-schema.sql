-- WFC Community — D1 schema (v3)
-- Deploy: npx wrangler d1 execute wfc-community --remote --file worker-schema.sql
--
-- Version history:
--   v1: tokens, votes, sightings, nonces
--   v2: rate_limits, telemetry
--   v3: licenses (short product codes WFC-XXXX-XXXX, generated at payment)
--
-- All target/token identifiers are stored as HMAC-SHA256(env.HMAC_SALT, ...)
-- — never as raw values nor as plain SHA-256. Even a full DB dump cannot be
-- reversed to recover usernames or session IDs without the server-side SALT.

CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,         -- HMAC(SALT, communityToken)
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS votes (
  target_hash  TEXT NOT NULL,          -- HMAC(SALT, sha256(username))
  token_hash   TEXT NOT NULL,          -- HMAC(SALT, communityToken)
  verdict      TEXT NOT NULL CHECK (verdict IN ('fake', 'ok', 'review')),
  score        INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  ts           INTEGER NOT NULL,
  nonce        TEXT NOT NULL,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (target_hash, token_hash)  -- one vote per (target, voter); last write wins
);

CREATE INDEX IF NOT EXISTS idx_votes_target ON votes(target_hash);

CREATE TABLE IF NOT EXISTS sightings (
  target_hash    TEXT NOT NULL,        -- HMAC(SALT, sha256(username))
  reporter_hash  TEXT NOT NULL,        -- HMAC(SALT, communityToken) of the reporter
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (target_hash, reporter_hash)  -- one report per (target, reporter)
);

CREATE INDEX IF NOT EXISTS idx_sightings_target ON sightings(target_hash);

CREATE TABLE IF NOT EXISTS nonces (
  nonce    TEXT PRIMARY KEY,
  used_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nonces_used_at ON nonces(used_at);

-- Per-token sliding-hour rate limit. New row per (token, hour); count auto-bumped.
CREATE TABLE IF NOT EXISTS rate_limits (
  token_hash   TEXT NOT NULL,
  hour_bucket  INTEGER NOT NULL,        -- floor(unix_ms / 3600000)
  endpoint     TEXT NOT NULL,           -- 'vote' | 'sightings'
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (token_hash, hour_bucket, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_rl_bucket ON rate_limits(hour_bucket);

-- Anonymous opt-in error telemetry. anon_hash is HMAC(SALT, randomUUID), so
-- a DB dump cannot link reports back to a user without the server-side salt.
CREATE TABLE IF NOT EXISTS telemetry (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  anon_hash   TEXT NOT NULL,                     -- HMAC(SALT, client anonId)
  v           TEXT NOT NULL,                     -- extension version (e.g. "2.0.3")
  lang        TEXT NOT NULL,
  category    TEXT,                              -- "fetch" | "clean" | "scan" | ...
  error_code  TEXT NOT NULL,                     -- "scroll_container_not_found" | ...
  reason      TEXT,                              -- "no_links" | ...
  stage       TEXT,                              -- "fetching" | "cleaning" | ...
  ts          INTEGER NOT NULL,                  -- client-side ms timestamp
  created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_telemetry_error ON telemetry(error_code);
CREATE INDEX IF NOT EXISTS idx_telemetry_anon ON telemetry(anon_hash);
CREATE INDEX IF NOT EXISTS idx_telemetry_created ON telemetry(created_at);

-- Short product codes issued at Stripe payment confirmation.
-- The code (WFC-XXXX-XXXX) is the user-facing licence identifier.
-- session_id_hash links it back to the original Stripe checkout session
-- so re-verification can be done if needed. revoked=1 disables a code
-- without deleting the row (chargebacks, etc.).
CREATE TABLE IF NOT EXISTS licenses (
  code             TEXT PRIMARY KEY,                 -- WFC-XXXX-XXXX
  session_id_hash  TEXT NOT NULL UNIQUE,             -- HMAC(SALT, cs_live_xxx)
  created_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  revoked          INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_licenses_session ON licenses(session_id_hash);
