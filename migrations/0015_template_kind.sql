-- Restructure: add 'template' kind to taxonomy_items, remove source_type from documents
PRAGMA foreign_keys = OFF;

-- Recreate taxonomy_items with 'template' added to kind CHECK
CREATE TABLE IF NOT EXISTS taxonomy_items_v2 (
  id          TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('type','category','language','template')),
  lang        TEXT NOT NULL DEFAULT '',
  name        TEXT NOT NULL,
  slug        TEXT,
  source_type TEXT,
  schema_json TEXT,
  is_system   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (id, kind, lang)
);
INSERT INTO taxonomy_items_v2 SELECT * FROM taxonomy_items;
DROP TABLE taxonomy_items;
ALTER TABLE taxonomy_items_v2 RENAME TO taxonomy_items;
CREATE INDEX IF NOT EXISTS idx_taxonomy_kind ON taxonomy_items(kind);

PRAGMA foreign_keys = ON;

-- Remove old Single documents (replaced by taxonomy_items kind='template')
DELETE FROM document_translations WHERE did IN ('doc_single_top','doc_single_about','sys_top_001','sys_about_001');
DELETE FROM documents WHERE did IN ('doc_single_top','doc_single_about','sys_top_001','sys_about_001');

-- Remove 'top' and 'about' from taxonomy_items type (they were single-type placeholders)
DELETE FROM taxonomy_items WHERE kind = 'type' AND id IN ('top','about');

-- Seed template content (kuro-boo template, Blog Type 001)
INSERT OR IGNORE INTO taxonomy_items (id, kind, lang, name, is_system, created_at, updated_at) VALUES
  ('top-hero-title',  'template', '', 'Blog Type 001',                                    1, datetime('now'), datetime('now')),
  ('top-hero-sub',    'template', '', '技術・インフラ・AI の最新情報をお届けするメディア', 1, datetime('now'), datetime('now')),
  ('top-section',     'template', '', 'Latest Articles',                                   1, datetime('now'), datetime('now')),
  ('about-title',     'template', '', 'About',                                             1, datetime('now'), datetime('now')),
  ('about-summary',   'template', '', 'このサイトについて',                                1, datetime('now'), datetime('now')),
  ('about-body',      'template', '', '<p>KuroCMS で構築されたサイトです。</p>',           1, datetime('now'), datetime('now'));
