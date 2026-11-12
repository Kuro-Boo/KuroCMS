-- 公開ページの要求ごとに走る 2 本の問い合わせを、表を丸ごと読まない形にする(2026-11-12)。
-- 公開の世代(public.ts fetchSettings の cache_gen)は 5 つの表の MAX(updated_at) を毎回取っていて、印が無いため
-- 毎回全部の行を読んでいた。サイト文字(fetchTemplateContent)も kind の印だけで、全言語の行を読んでいた。
-- 委託の口座で、1 つのサイトに 2 時間で約 1,900 回の要求が来ただけで 220 万行を読み、口座全体の無料枠
-- (1 日 500 万行)の 4 割を使った(2026-11-11)。MAX は印の端の 1 行で、サイト文字は要る言語の行だけで済む。
CREATE INDEX IF NOT EXISTS idx_documents_updated_at ON documents(updated_at);
CREATE INDEX IF NOT EXISTS idx_taxonomy_updated_at ON taxonomy_items(updated_at);
CREATE INDEX IF NOT EXISTS idx_page_templates_updated_at ON page_templates(updated_at);
CREATE INDEX IF NOT EXISTS idx_categories_updated_at ON categories(updated_at);
CREATE INDEX IF NOT EXISTS idx_page_build_cache_built_at ON page_build_cache(built_at);
CREATE INDEX IF NOT EXISTS idx_taxonomy_kind_lang ON taxonomy_items(kind, lang);
