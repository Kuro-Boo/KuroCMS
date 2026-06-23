-- Add content_keys_json column to page_templates for storing template content key definitions.
ALTER TABLE page_templates ADD COLUMN content_keys_json TEXT;
