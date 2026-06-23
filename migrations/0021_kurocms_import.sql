-- KuroCMS-to-KuroCMS import settings
ALTER TABLE site_settings ADD COLUMN kurocms_import_url TEXT NOT NULL DEFAULT '';
ALTER TABLE site_settings ADD COLUMN kurocms_import_pat TEXT NOT NULL DEFAULT '';
