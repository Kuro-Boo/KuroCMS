-- 管理画面の接続元の登録（IP 制限・cms-cms-security「IP 制限」・2026-10-17）。
--
-- ip_allow: 管理者ごとの登録した回線（IPv6 は /64、IPv4 は 1 つ）。照合・登録は
--   entamy-connect の ip-gate.ts（Admin と同じ処理）。列の形は Admin の admin_ip_allow と同じ。
--   登録は全自動 —— パスキーでログインした回線を登録し、使うたびに期限を延ばす。
-- ip_confirmations: 登録の無い回線からログイン済みのクッキーが使われたときに、
--   本人へメールした確認のリンク（トークンはハッシュだけ）。申請した回線から押したときだけ登録する。
--
-- restore: 不要 — どちらも次のログインで作り直される（登録が 1 つも無い人は、次の要求の回線を
--   自動で登録する）。バックアップに載せない。
CREATE TABLE IF NOT EXISTS ip_allow (
  id           TEXT PRIMARY KEY,
  scope        TEXT NOT NULL,
  subject      TEXT NOT NULL,
  net          TEXT NOT NULL,
  family       TEXT NOT NULL CHECK (family IN ('v4', 'v6')),
  label        TEXT NOT NULL,
  note         TEXT,
  pinned       INTEGER NOT NULL DEFAULT 0,
  added_by     TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_ip      TEXT,
  UNIQUE (scope, subject, net)
);
CREATE INDEX IF NOT EXISTS ip_allow_net ON ip_allow (scope, net);
CREATE INDEX IF NOT EXISTS ip_allow_expiry ON ip_allow (expires_at);

CREATE TABLE IF NOT EXISTS ip_confirmations (
  token_hash   TEXT PRIMARY KEY,
  subject      TEXT NOT NULL,
  net          TEXT NOT NULL,
  family       TEXT NOT NULL CHECK (family IN ('v4', 'v6')),
  ip           TEXT NOT NULL,
  label        TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  used_at      INTEGER
);
CREATE INDEX IF NOT EXISTS ip_confirmations_subject ON ip_confirmations (subject, net, requested_at);
CREATE INDEX IF NOT EXISTS ip_confirmations_expiry ON ip_confirmations (expires_at);
