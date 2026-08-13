-- ナビ用の短いラベル。
--
-- なぜ要るか: ナビのリンク文字は固定ページのタイトルを使っていたが、タイトルは
-- 見出し用で長い。kuro.boo の about は「黒兎の人物紹介」で、スマホのナビが
-- 折り返して崩れた（2026-08-13）。テンプレート宣言の navKey が指す先として、
-- 既定のサイトテキストを用意する。
--
-- ⚠ 既存サイトでは値が空のまま入る。空ならタイトルにフォールバックするので
--   表示は従来どおりで、運用者が短い語を入れた時点で切り替わる。
INSERT OR IGNORE INTO taxonomy_items (id, kind, lang, name, is_system, created_at, updated_at) VALUES
  ('about-nav', 'template', '', 'About', 1, datetime('now'), datetime('now'));
