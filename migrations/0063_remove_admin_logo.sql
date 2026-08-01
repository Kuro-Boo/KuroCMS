-- 管理画面の KuroCMS ロゴは全インストールで共通とする。公開サイト設定と
-- 混在していた admin_logo は廃止する。
ALTER TABLE site_settings DROP COLUMN admin_logo;
