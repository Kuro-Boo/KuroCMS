-- SNS auto-post on first publish + per-article posted flag (Bluesky for now).
--
-- documents.sns_bsky_posted_at: NULL = never posted to Bluesky. Once set (by the
-- first-publish auto-post, or via the REST API), the article is NOT re-posted —
-- even after unpublish -> draft -> re-publish. This is the single source of truth
-- that prevents duplicate posts. Per-network column so Threads/X can be added
-- later (sns_threads_posted_at, ...).
ALTER TABLE documents ADD COLUMN sns_bsky_posted_at TEXT;

-- site_settings: master switch for auto-posting on publish, and the Bluesky app
-- password (the handle is already stored in bluesky_handle).
ALTER TABLE site_settings ADD COLUMN sns_auto_post INTEGER NOT NULL DEFAULT 0;
ALTER TABLE site_settings ADD COLUMN bluesky_token TEXT;
