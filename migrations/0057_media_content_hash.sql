-- Content-hash dedup for image uploads: identical bytes (SHA-256) reuse the
-- existing asset instead of inserting a duplicate row + R2 object. The hash is
-- computed on upload; rows created before this migration stay NULL (their
-- duplicates are not detected retroactively).
ALTER TABLE media_assets ADD COLUMN content_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_media_assets_content_hash
  ON media_assets (kind, content_hash);
