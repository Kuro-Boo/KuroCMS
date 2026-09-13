-- restore: 対応済み — reapplyRestoreBootstraps() に同じ整備を入れた
-- Article IDs, rather than slugs, keep votes stable across renames/translations.
CREATE TABLE IF NOT EXISTS article_reactions (
  id TEXT NOT NULL PRIMARY KEY,
  did TEXT NOT NULL,
  reaction_type TEXT NOT NULL CHECK (reaction_type IN ('like', 'useful', 'excellent')),
  voter_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (did, voter_hash),
  FOREIGN KEY (did) REFERENCES documents(did) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_article_reactions_did_type
  ON article_reactions(did, reaction_type);
CREATE INDEX IF NOT EXISTS idx_article_reactions_voter_time
  ON article_reactions(voter_hash, created_at);

-- A fixed site-text key: editors can change the heading, never the executable UI.
-- Other languages intentionally inherit the site's default-language value.
INSERT OR IGNORE INTO taxonomy_items
  (id, kind, lang, name, is_system, created_at, updated_at)
SELECT 'article-reactions', 'template', id,
       CASE id
         WHEN 'ja' THEN '<h2>この記事はいかがでしたか？</h2>'
         WHEN 'en' THEN '<h2>How was this article?</h2>'
         ELSE ''
       END,
       1, datetime('now'), datetime('now')
FROM taxonomy_items WHERE kind = 'language';
