-- 問い合わせフォームの送り先(cms-contact v2・2026-11-22)。
-- 送り先のアドレスはサイト文字 mail-to-<名前> に置く(頁には出さない)。サイトのドメインの外のアドレス
-- (Gmail など)は、届いた確認のメールのボタンが押されるまで送らない。押されたアドレスをここに控える。
--   ⚠ アドレスで控える(名前では控えない)。サイト文字のアドレスを書き換えたら、新しいアドレスはまた確認が要る。
--   バックアップに載せる(復元で確認をやり直させない)。
CREATE TABLE IF NOT EXISTS contact_verified (
  email TEXT PRIMARY KEY,
  verified_at TEXT NOT NULL
);
