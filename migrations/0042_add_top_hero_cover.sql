-- Add the `top-hero-cover` site-text key (cover image for the home hero) to the
-- default/system content keys so it appears in the site-text editor. Value is
-- empty by default (set a [[img_xxx]] media reference from the editor). Stored
-- as a kind='template' taxonomy item with lang='' (base), matching the other
-- seeded content keys (see 0001_initial.sql / 0015_template_kind.sql).
INSERT OR IGNORE INTO taxonomy_items (id, kind, lang, name, is_system, created_at, updated_at) VALUES
  ('top-hero-cover', 'template', '', '', 1, datetime('now'), datetime('now'));
