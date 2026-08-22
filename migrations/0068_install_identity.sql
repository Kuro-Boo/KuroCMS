-- この導入を表す識別子（Entamy ID の install_id）の置き場。
--
-- なぜ D1 で、なぜこのテーブルなのか:
--   KV に置くと消える。PUBLIC_PAGES を prefix なしで全消しする経路が 2 つあり
--   （siteUnpublish / restoreWipePages）、「サイトを非公開」を押すか
--   バックアップから復元するだけで identity が消えていた。消えると
--   /v1/accounts/anonymous が新しい口座を作り、**導入が二重に数え直される**。
--
-- ⚠ **BACKUP_TABLES_INSERT_ORDER に載せてはいけない。** 載せると:
--     1. 復元の DELETE 対象になり、KV と同じ問題に戻る
--     2. バックアップに含まれ、**他インストールのバックアップを復元したときに
--        相手の身元が流入する** → 2 つの導入が同じ install_id を名乗る。
--        失うより悪い壊れ方になる。
--
-- restore: 不要 — BACKUP_TABLES_INSERT_ORDER の外なので wipe/restore の対象外。
--          値は api.ts の ensureInstallIdentity() が「無ければ導出値で埋める」
--          形で冪等に用意する（採番でも整備でもないので復元側の手当ては不要）。
CREATE TABLE IF NOT EXISTS install_identity (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  install_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
