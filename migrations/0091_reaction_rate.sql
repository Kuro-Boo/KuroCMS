-- 反応の書き込みの数え札(課題 b299a24e・2026-11-10)。Cookie は外から好きな値を名乗れるので、1 時間の上限を
-- Cookie ごとに数えても、値を替えるだけで抜けられた。接続元の回線ごと・サイト全体の 1 時間の数をここで数える。
-- bucket は「時間の区切り + 回線」を鍵付きのハッシュにしたもの。IP そのものは置かない。expires_at を過ぎた行は、
-- 次の投票のときに消す(1 時間より長くは残らない・cms-reaction-s04)。
-- ⚠ BACKUP_TABLES_INSERT_ORDER に載せない。1 時間で消える数え札で、失っても数え直すだけ。
CREATE TABLE IF NOT EXISTS reaction_rate (
  bucket TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reaction_rate_expires ON reaction_rate(expires_at);
