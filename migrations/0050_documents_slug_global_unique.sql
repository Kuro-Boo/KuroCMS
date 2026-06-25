-- Make documents.slug GLOBALLY unique.
-- Previously the constraint was UNIQUE(tid, slug), so the same slug could exist
-- under different types. We now require slug to identify a document on its own
-- (enables slug-addressed REST endpoints and slug-keyed upsert).
--
-- Self-healing: if an instance already holds cross-type duplicate slugs, rename
-- the 2nd+ occurrence (keep the earliest per slug; suffix the rest with their
-- unique did) BEFORE creating the unique index, so this migration never fails on
-- existing data. Instances with no duplicates (the normal case) are unaffected.
UPDATE documents
SET slug = slug || '-' || did
WHERE did IN (
  SELECT did FROM (
    SELECT did, ROW_NUMBER() OVER (PARTITION BY slug ORDER BY created_at, did) AS rn
    FROM documents
  ) WHERE rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_slug_unique ON documents (slug);
