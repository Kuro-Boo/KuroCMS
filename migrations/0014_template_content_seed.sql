-- Add template_id column to site_settings
ALTER TABLE site_settings ADD COLUMN template_id TEXT NOT NULL DEFAULT 'kuro-boo';

-- Update kuro-boo template with author and slug definitions
UPDATE page_templates SET
  author = 'KuroCMS',
  slug_definitions_json = '[{"slug":"top","role":"トップページ: title=サイト名, summary=ヒーローサブタイトル"},{"slug":"about","role":"Aboutページ: title=ページタイトル, summary=概要, body_html=本文"}]',
  updated_at = datetime('now')
WHERE id = 'kuro-boo';
