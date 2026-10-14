-- 記事末尾の筆者表示（「筆者: 表示名」）の on/off。会社・製品紹介のサイトなど
-- 筆者を出す必要のないサイトは 0 にする。0 のときは公開ページの構造化データの
-- author も、記事を作った人（Person）ではなくサイト名（Organization）になる
-- —— 画面に出さない人名を構造化データにだけ載せない。
-- 既定は 1（従来どおり表示する）。
ALTER TABLE site_settings ADD COLUMN show_byline INTEGER NOT NULL DEFAULT 1;
