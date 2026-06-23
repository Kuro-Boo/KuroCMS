-- Add configurable category field mapping for Strapi import
ALTER TABLE site_settings ADD COLUMN strapi_field_categories TEXT NOT NULL DEFAULT 'categories';
