-- 公開の前のメディアを配らない（cms-cms-security・課題 d9968d85・2026-10-25 利用者の決定）。
--
-- メディアの公開の URL（/images/img-163.jpg など）は連番で、下書きの記事にだけ貼った画像も番号を推せば取れた。
-- 公開ページ（KV に書いた各頁）が参照するメディアだけを配る。
--   page_media       頁ごとに、その HTML が参照するメディアの R2 のキー（images/img-163.jpg）
--   page_media_scan  メディアを記録し終えた頁（ここに無い頁は、次の全体ビルドで飛ばさずに作り直す）
--   page_media_state 公開の頁がすべて記録し終えたか（ready = 1 になるまでは、前のとおり全部配る）
-- 管理画面にログインしている人には、公開の前のメディアも配る（記事の編集で見るため）。
--
-- restore: 不要 — ビルドが頁を書くたびに書き直す記録。バックアップに載せない（復元の後のビルドで作り直す）。
CREATE TABLE IF NOT EXISTS page_media (
  path      TEXT NOT NULL,
  media_key TEXT NOT NULL,
  PRIMARY KEY (path, media_key)
);
CREATE INDEX IF NOT EXISTS idx_page_media_key ON page_media (media_key);

CREATE TABLE IF NOT EXISTS page_media_scan (
  path TEXT NOT NULL PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS page_media_state (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  ready INTEGER NOT NULL DEFAULT 0
);
