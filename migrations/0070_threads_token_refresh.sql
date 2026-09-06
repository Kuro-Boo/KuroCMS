-- Threads の長期アクセストークンを cron で安全に更新するための時刻。
--
-- updated_at は手動登録または Meta の更新 API が成功した日時。
-- attempted_at は毎分 cron の重複配信・多重実行から Meta API を守る日次ロック。
-- 既存トークンの発行日は推測しない。NULL のまま移行し、最初の日次確認で更新する。
ALTER TABLE site_settings ADD COLUMN threads_token_updated_at TEXT;
ALTER TABLE site_settings ADD COLUMN threads_token_refresh_attempted_at TEXT;
