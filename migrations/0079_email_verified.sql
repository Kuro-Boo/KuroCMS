-- メールアドレスを確かめた日時（プロフィール → アカウントの「確認済み」・2026-10-22）。
--
-- そのアドレスに届いたリンクを開けた時に入れる: 招待を受けた・パスキーの再設定のリンクを使った・
-- プロフィールの「確認メールを送る」のリンクを開いた。アドレスを変えたら NULL に戻す（新しいアドレスは
-- まだ確かめていない）。
--
-- 既にいる人: 招待を受けて入った人は、その招待のアドレスに届いたリンクで入っているので、招待を使った
-- 日時で埋める。再設定のリンクを使った人も同じ。どちらも無い人（最初の管理者など）は未確認のまま。
--
-- restore: 不要 — 古いバックアップから戻すと未確認に戻るだけで、確認メールで確かめ直せる。
ALTER TABLE users ADD COLUMN email_verified_at TEXT;

UPDATE users SET email_verified_at = (
  SELECT MAX(used_at) FROM invitation_tokens
   WHERE invitation_tokens.used_at IS NOT NULL AND lower(invitation_tokens.email) = lower(users.email)
) WHERE email_verified_at IS NULL;

UPDATE users SET email_verified_at = (
  SELECT MAX(used_at) FROM recovery_tokens
   WHERE recovery_tokens.used_at IS NOT NULL AND recovery_tokens.uid = users.uid
     AND lower(recovery_tokens.email) = lower(users.email)
) WHERE email_verified_at IS NULL;

-- 「確認メールを送る」のリンク（1 回だけ・24 時間）。トークンはハッシュだけを置く。
CREATE TABLE IF NOT EXISTS email_verify_tokens (
  token_hash TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_verify_tokens_uid ON email_verify_tokens(uid, created_at);
