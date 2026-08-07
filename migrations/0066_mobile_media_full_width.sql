-- スマホでのメディアレイアウト解除。ON にすると、サイトビルド時に生成される
-- 公開ページへ「幅 640px 以下ではメディアを常に 100% 幅・回り込みなし」にする
-- CSS が入る。著者が指定した幅・寄せ（[[img-x|50%,left]] 等）は PC ではそのまま
-- 効き、狭い画面でだけ無効化される。
-- 既定は 0（従来どおり著者指定をそのまま使う）。
ALTER TABLE site_settings ADD COLUMN mobile_media_full_width INTEGER NOT NULL DEFAULT 0;
