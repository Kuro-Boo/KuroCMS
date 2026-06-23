-- Add tags and background color/gradient to page_templates.
-- tags_json: JSON array of tag strings  e.g. '["blog","3-column"]'
-- bg: CSS gradient or color string used on the template library card
ALTER TABLE page_templates ADD COLUMN tags_json TEXT;
ALTER TABLE page_templates ADD COLUMN bg TEXT;
