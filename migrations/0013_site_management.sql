-- Site management: extend page_templates and add single-type content support
ALTER TABLE page_templates ADD COLUMN author TEXT;
ALTER TABLE page_templates ADD COLUMN slug_definitions_json TEXT;
