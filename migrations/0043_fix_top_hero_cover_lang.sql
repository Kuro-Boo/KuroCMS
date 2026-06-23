-- Fix 0042: it inserted `top-hero-cover` at the legacy lang='' which the content
-- API never lists (it reads base.lang = default_lang; see 0030). Insert the key
-- at the site's default language (the base entry other langs inherit from), then
-- remove the stray lang='' row. Idempotent (INSERT OR IGNORE).
INSERT OR IGNORE INTO taxonomy_items (id, kind, lang, name, is_system, created_at, updated_at)
SELECT 'top-hero-cover', 'template',
  (SELECT COALESCE(default_lang, 'en') FROM site_settings WHERE id = 1 LIMIT 1),
  '', 1, datetime('now'), datetime('now')
WHERE (SELECT COALESCE(default_lang, 'en') FROM site_settings WHERE id = 1 LIMIT 1) != '';

DELETE FROM taxonomy_items WHERE id = 'top-hero-cover' AND kind = 'template' AND lang = '';
