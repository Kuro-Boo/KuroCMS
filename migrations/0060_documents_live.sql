-- The publish flag (documents.mode) becomes pure STATE: it only takes effect
-- when a build materializes it into this new `live` column. Serving (on-demand
-- category pages, KV-miss fallback, sitemap/RSS/llms.txt, nav counts) reads
-- live, never mode — so flag changes stay invisible to visitors until a build
-- runs. The full build syncs live on completion; POST /api/documents/:did/build
-- syncs one document.
ALTER TABLE documents ADD COLUMN live INTEGER NOT NULL DEFAULT 0;

-- Bootstrap: documents published under the OLD immediate-publish behavior are
-- already served (their pages sit in KV), so mark them live; a future-dated or
-- expired publish window follows the build's "window" rule.
UPDATE documents SET live = 1
 WHERE mode = 1
   AND datetime(publish_at) <= datetime('now')
   AND (unpublish_at IS NULL OR datetime(unpublish_at) > datetime('now'));
