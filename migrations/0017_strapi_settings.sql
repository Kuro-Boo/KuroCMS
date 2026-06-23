-- Add Strapi import connection settings to site_settings
ALTER TABLE site_settings ADD COLUMN strapi_url TEXT NOT NULL DEFAULT '';
ALTER TABLE site_settings ADD COLUMN strapi_token TEXT NOT NULL DEFAULT '';
ALTER TABLE site_settings ADD COLUMN strapi_content_type TEXT NOT NULL DEFAULT 'articles';
ALTER TABLE site_settings ADD COLUMN strapi_field_title TEXT NOT NULL DEFAULT 'title';
ALTER TABLE site_settings ADD COLUMN strapi_field_slug TEXT NOT NULL DEFAULT 'slug';
ALTER TABLE site_settings ADD COLUMN strapi_field_summary TEXT NOT NULL DEFAULT 'description';
ALTER TABLE site_settings ADD COLUMN strapi_field_body TEXT NOT NULL DEFAULT 'content';
