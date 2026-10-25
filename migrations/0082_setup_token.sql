-- 初期設定の鍵と、パスキー登録の証の結び付け（cms-cms-security・課題 4dea81be・c4974eea・2026-10-25）。
--
-- setup_tokens: 導入口（install.entamy.com）が導入の時に置く、初期設定の鍵のハッシュ。導入の完了画面の
-- リンク（{管理画面}#setup=…）を持つ人だけが、初期設定（最初の管理者）と最初のパスキー登録をできる。
-- 前は「利用者が 0 人なら誰でも」初期設定でき、公開された直後に第三者が先に管理者になれた。
-- 鍵の平文は置かない。最初のパスキーが登録できた時に 1 回で使い切る（used_at）。
--
-- webauthn_challenges.auth_kind / auth_hash: パスキー登録を何の証で始めたか（session / invitation /
-- recovery / setup）と、その証のハッシュ。完了の時に同じ証を照らし合わせ、証を使い切ってから資格情報を足す
-- （前は回復の証を始めの時だけ見て、完了では任意だった —— 証を残したまま登録できた）。
--
-- restore: 不要 — 初期設定の鍵と登録の途中の challenge は、その導入だけの一時の行。バックアップに載せない。
CREATE TABLE IF NOT EXISTS setup_tokens (
  token_hash TEXT NOT NULL PRIMARY KEY,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);

ALTER TABLE webauthn_challenges ADD COLUMN auth_kind TEXT;
ALTER TABLE webauthn_challenges ADD COLUMN auth_hash TEXT;
