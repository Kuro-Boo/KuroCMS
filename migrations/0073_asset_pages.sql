-- 公開ページを Workers Static Assets に置くための索引（cms-cms-build「公開ページを
-- Workers Static Assets に置く」）。
--
-- asset_pages: KV に書いた公開ページの各言語の版と、その中身のハッシュ・大きさ。
--   資産の一覧（manifest）はここだけから作る —— KV を数えて回ると list の枠を焼き、
--   ページを読み直すと読み出しが増える。KV に書く 1 か所（kvPutBundle）が一緒に書き、
--   ページを消す所が一緒に消す。
-- asset_publish: 最後に終わったビルドの目印(requested_at = 時刻#一意な値)と、最後に
--   番人へ渡せたビルドの目印(published_for)。違えば、登録の済んでいないビルドがある。
--   資産を変えるのはビルドを明示したときだけ(保存のときの KV の作り直しは渡さない)。
--
-- restore: 不要 — どちらも KV のページから作り直せる派生データ。バックアップに載せない
--   （復元は KV のページも消し、次のビルドで作り直す）。
CREATE TABLE IF NOT EXISTS asset_pages (
  path TEXT NOT NULL,
  lang TEXT NOT NULL,
  hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (path, lang)
);

CREATE TABLE IF NOT EXISTS asset_publish (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  requested_at TEXT NOT NULL DEFAULT '',
  published_for TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT ''
);
