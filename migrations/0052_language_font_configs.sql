-- Language-specific font management.
--
-- Existing fonts_json/base_font remain the site-wide fallback for older
-- clients and for languages without an explicit font config.
--
-- font_configs_json maps a language code to:
--   {"fonts":[{"family":"Noto Sans JP","weights":[400,700]}],"base":"Noto Sans JP"}
ALTER TABLE site_settings ADD COLUMN font_configs_json TEXT NOT NULL DEFAULT '{}';
