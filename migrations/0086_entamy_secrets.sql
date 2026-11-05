-- Entamy ID の資格(口座 ID・リフレッシュトークン・SAT・送信鍵)の置き場。
-- KV は結果整合で、回した後の古いトークンを読んで ID に断られていた(課題 4e784e65)。
-- 値は Secret ENTAMY_STORE_KEY があれば封じたまま置く(entamy-port.ts)。
-- ⚠ BACKUP_TABLES_INSERT_ORDER に載せない。バックアップに資格を入れない。失っても install_id から取り直せる。
CREATE TABLE IF NOT EXISTS entamy_secrets (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
