-- Display-only SNS publication flags for services that do not yet have posting
-- integrations. Bluesky is populated by the existing auto-post flow.
ALTER TABLE documents ADD COLUMN sns_threads_posted_at TEXT;
ALTER TABLE documents ADD COLUMN sns_x_posted_at TEXT;
