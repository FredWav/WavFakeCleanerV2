-- Migration v3 → v4: observability (WFC 3.0.0)
--
-- Adds the numeric `value` column to telemetry (drift rank, queue depth,
-- perf durations) and an index for the admin dashboard's per-category
-- aggregations.
--
-- ALTER TABLE is not idempotent in SQLite — run this file exactly once per
-- database. worker-schema.sql (v4) carries the same column inline for fresh
-- databases. See migrations/README.md for the deploy runbook.

ALTER TABLE telemetry ADD COLUMN value INTEGER;

CREATE INDEX IF NOT EXISTS idx_telemetry_category ON telemetry(category);
