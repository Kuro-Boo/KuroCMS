-- 「Threads と接続」に使う Meta のアプリ(仕様 cms-cms-sns・旗 threads-connect・2026-11-06)。
--
-- 失効したトークンを、Meta の許可画面を通すボタン 1 つで取り直すため、アプリ ID とシークレットを持つ。
-- シークレットは code → 長期トークンの交換と、許可の往復の state の署名に使う。画面には再表示しない。
--
-- restore: 不要 — 列を足すだけ。
ALTER TABLE site_settings ADD COLUMN threads_app_id TEXT;
ALTER TABLE site_settings ADD COLUMN threads_app_secret TEXT;
