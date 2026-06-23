-- preview_url が旧パス /api/site/templates/ のままになっているテンプレートを /api/v1/templates/ に修正
UPDATE page_templates
SET preview_url = '/api/v1/templates/' || id || '/thumbnail'
WHERE preview_url LIKE '/api/site/templates/%';
