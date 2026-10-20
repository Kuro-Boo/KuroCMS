-- 委託から自社への引っ越し（仕様 cms-move-to-self・2026-10-20）。
--
-- 受付（install.entamy.com）が、移す元（委託）と移す先（自社）の両方に 1 行ずつ置く。
--   移す元: 受付がホスティング用アカウントの D1 へ直接書く（role='source'）。
--   移す先: 受付が導入の手順の中で、お客様の D1 へ直接書く（role='target'）。
-- 受付は、この行の鍵（kmove_…）で /api/system/move/* を叩き、表とメディアを写す。
-- 鍵はハッシュだけを置く。PAT とは別にする —— PAT は人に結び付き、使うたびに書き込む。
--
-- frozen    : 移す元だけ。最後の突き合わせの数分だけ書き込みとビルドを止める。
-- finished_at: 移す先だけ。仕上げ（アドレスの付け替え・パスキーの登録のメール）が済んだ時刻。
--              済むまで、移す先は初期化（最初の管理者の作成）を受け付けない。
--
-- restore: 不要 — 引っ越しの間だけの行。バックアップに載せない。
CREATE TABLE IF NOT EXISTS move_state (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  role         TEXT NOT NULL CHECK (role IN ('source', 'target')),
  token_hash   TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  frozen       INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  finished_at  INTEGER
);
