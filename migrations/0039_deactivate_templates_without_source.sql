UPDATE page_templates
SET is_active = 0,
    updated_at = datetime('now')
WHERE is_active = 1
  AND (source_html IS NULL OR TRIM(source_html) = '');
