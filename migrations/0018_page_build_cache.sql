-- Build cache: tracks source hash per page/lang to skip unchanged pages
CREATE TABLE IF NOT EXISTS page_build_cache (
  path        TEXT NOT NULL,
  lang        TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  built_at    TEXT NOT NULL,
  PRIMARY KEY (path, lang)
);
