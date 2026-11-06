-- 「Threads と接続」が保存した投稿先の ID を消す(仕様 cms-cms-sns・2026-11-06)。
--
-- 交換の応答の user_id は 17 桁の数値で届き、JSON.parse で末尾が丸まって存在しない ID になっていた
-- (投稿が code 100 / subcode 33 で断られた)。ID は投稿の時に /me から文字列で引き直す(空なら引く)。
-- 手動で登録したサイトの正しい ID も消えるが、次の投稿で引き直すだけで害は無い。
--
-- restore: 不要 — 消すのは /me から引き直せる控えだけ。
UPDATE site_settings SET threads_user_id = NULL;
