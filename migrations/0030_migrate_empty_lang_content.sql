-- Migrate template content from lang='' to the site's default language.
-- lang='' was a legacy concept; all content must live under a real language code.
-- INSERT OR IGNORE: if a lang-specific entry already exists for a key, keep it (don't overwrite).
INSERT OR IGNORE INTO taxonomy_items (id, kind, lang, name, is_system, created_at, updated_at)
SELECT
  t.id,
  t.kind,
  (SELECT COALESCE(default_lang, 'en') FROM site_settings WHERE id = 1 LIMIT 1),
  t.name,
  t.is_system,
  t.created_at,
  t.updated_at
FROM taxonomy_items t
WHERE t.kind = 'template' AND t.lang = ''
  AND (SELECT COALESCE(default_lang, 'en') FROM site_settings WHERE id = 1 LIMIT 1) != '';

-- Remove all empty-lang template entries
DELETE FROM taxonomy_items WHERE kind = 'template' AND lang = '';
