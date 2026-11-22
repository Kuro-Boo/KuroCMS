-- 問い合わせフォームの送り先(cms-contact v7・2026-11-22)。設定の「問い合わせ」で登録する(サイト文字 mail-to- はやめた ——
-- 利用者「CMS にサイトごとの独自のものを入れたくない。メール送信はどのサイトでも使うので、登録も確認も設定画面に纏める」)。
--   name: 送り先の ID。画像の img-023 と同じく、CMS が登録した順に mail-001・mail-002… と付ける(画面では入力させない)。
--         フォーム(data-contact の to)はこの ID で送り先を指す。登録した後は変えない。
--   contact_recipient_ids: 一度使った ID の控え。消した送り先の番号を使い回さない(古いフォームが別の送り先を指さないように)。
--   アドレスの確認は contact_verified(アドレスで控える)。どちらの表もバックアップに載せる。
CREATE TABLE IF NOT EXISTS contact_recipients (
  name TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contact_recipient_ids (
  name TEXT PRIMARY KEY
);
