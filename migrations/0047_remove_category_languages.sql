-- Categories are language-independent. Older API versions created one extra
-- taxonomy row per category/language, which duplicated category data in article
-- queries because document_categories identifies a category by cid only.

CREATE TABLE IF NOT EXISTS categories (
  id         TEXT NOT NULL PRIMARY KEY,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Prefer the canonical row. If it is absent, preserve one deterministic legacy
-- language row so existing article-category links remain resolvable.
INSERT OR IGNORE INTO categories (id, name, slug, created_at, updated_at)
SELECT
  source.id,
  source.name,
  COALESCE(source.slug, source.id),
  source.created_at,
  source.updated_at
FROM taxonomy_items source
WHERE source.kind = 'category'
  AND source.lang = (
    SELECT candidate.lang
    FROM taxonomy_items candidate
    WHERE candidate.kind = 'category' AND candidate.id = source.id
    ORDER BY CASE WHEN candidate.lang = '' THEN 0 ELSE 1 END, candidate.lang
    LIMIT 1
  );

DELETE FROM taxonomy_items WHERE kind = 'category';

-- Repair article taxonomy data that cannot resolve to a migrated category.
DELETE FROM document_categories
WHERE NOT EXISTS (
  SELECT 1 FROM categories WHERE categories.id = document_categories.cid
);

DELETE FROM page_build_cache;

-- The historical taxonomy table still accepts kind='category'; reject it so
-- every future category is stored in the language-free categories table.
CREATE TRIGGER IF NOT EXISTS taxonomy_category_insert_guard
BEFORE INSERT ON taxonomy_items
WHEN NEW.kind = 'category'
BEGIN
  SELECT RAISE(ABORT, 'categories must be stored in the categories table');
END;

CREATE TRIGGER IF NOT EXISTS taxonomy_category_update_guard
BEFORE UPDATE OF kind ON taxonomy_items
WHEN NEW.kind = 'category'
BEGIN
  SELECT RAISE(ABORT, 'categories must be stored in the categories table');
END;
