-- 問い合わせフォーム(cms-contact・2026-11-21)。
-- contact_spent: 計算の課題の salt を 1 回だけ使わせる札。期限(exp)を過ぎた行は毎分の刻みで消す。
--   ⚠ BACKUP_TABLES_INSERT_ORDER に載せない。課題の期限(10 分)で要らなくなる札で、失っても困らない。
-- site_settings.contact_recipients_json: 届け先の管理者(uid の配列)。送り先は本文に書かせない。
--   回数の数え札は反応ボタンの reaction_rate を共に使う(鍵に「contact:」を付けて分ける)。
CREATE TABLE IF NOT EXISTS contact_spent (
  salt TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contact_spent_expires ON contact_spent(expires_at);
ALTER TABLE site_settings ADD COLUMN contact_recipients_json TEXT NOT NULL DEFAULT '[]';
