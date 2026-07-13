-- Owner-identity column for templates/users (author_id).
--
-- HISTORY: this migration originally ran
--   ALTER TABLE users          ADD COLUMN author_id TEXT;
--   ALTER TABLE page_templates ADD COLUMN author_id TEXT;
-- Both columns were later folded into the consolidated 0001_initial.sql, so on
-- a fresh install the ALTERs raised "duplicate column" and the whole batch was
-- skipped by the runner's error tolerance (harmless on an empty DB, but noisy
-- and it relied on the swallow behaviour). The ALTERs are removed: every live
-- instance has already applied 0040 (self-update applies migrations by name),
-- and fresh installs get both columns from 0001.
--
-- The backfill below is kept as the migration's single statement: a no-op on
-- fresh DBs (no rows), and still correct if it ever meets a pre-0040 dataset.
UPDATE users
SET author_id = 'author_' || lower(hex(randomblob(12)))
WHERE author_id IS NULL OR TRIM(author_id) = '';
