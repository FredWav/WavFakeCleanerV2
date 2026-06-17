-- Migration v4 → v5: licence recovery by email
--
-- Adds `email_hash` to licenses so a customer who lost their local storage
-- (browser reinstall, OS reset, switched browsers) can recover their code
-- by typing the email they paid with. We store only HMAC(SALT, email) —
-- never the raw address — consistent with the rest of the schema.
--
-- The matching index keeps /recover a single fast lookup.
--
-- ALTER TABLE is not idempotent in SQLite — run this file exactly once per
-- database. worker-schema.sql (v5) carries the same column inline for fresh
-- databases. See migrations/README.md for the deploy runbook.
--
-- Existing rows keep email_hash = NULL until backfilled: run
-- scripts/backfill-license-emails.mjs once after deploy to populate them from
-- Stripe (customer_details.email is present on every paid checkout session).

ALTER TABLE licenses ADD COLUMN email_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_licenses_email ON licenses(email_hash);
