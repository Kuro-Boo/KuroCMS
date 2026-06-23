-- KuroCMS complete schema v2
-- 18 tables: auth(6) + taxonomy(1) + content(4) + media(1) + search(1) + settings(1) + ops(2) + sns(1) + templates(1)

-- ── Auth & Users ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  uid          TEXT NOT NULL PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  display_name TEXT,
  author_id    TEXT,
  is_admin     INTEGER NOT NULL DEFAULT 0,
  is_author    INTEGER NOT NULL DEFAULT 0,
  disabled_at  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS personal_access_tokens (
  token_id    TEXT NOT NULL PRIMARY KEY,
  uid         TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  last_used_at TEXT,
  expires_at  TEXT,
  revoked_at  TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pat_uid ON personal_access_tokens(uid);

CREATE TABLE IF NOT EXISTS sessions (
  session_id     TEXT NOT NULL PRIMARY KEY,
  uid            TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  expires_at     TEXT,
  created_at     TEXT,
  last_active_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_uid        ON sessions(uid);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS passkey_credentials (
  credential_id   TEXT NOT NULL PRIMARY KEY,
  uid             TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  public_key_spki TEXT NOT NULL,
  sign_count      INTEGER NOT NULL DEFAULT 0,
  aaguid          TEXT,
  display_name    TEXT,
  created_at      TEXT,
  last_used_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_passkey_uid ON passkey_credentials(uid);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  challenge_id   TEXT NOT NULL PRIMARY KEY,
  challenge      TEXT UNIQUE,
  uid            TEXT,
  challenge_type TEXT CHECK (challenge_type IN ('register','authenticate')),
  expires_at     TEXT,
  created_at     TEXT
);

CREATE TABLE IF NOT EXISTS invitation_tokens (
  token      TEXT NOT NULL PRIMARY KEY,
  email      TEXT,
  is_admin   INTEGER NOT NULL DEFAULT 0,
  is_author  INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT,
  used_at    TEXT,
  created_at TEXT,
  created_by TEXT
);

-- ── Taxonomy (types + categories + languages unified) ─────────────────────────

CREATE TABLE IF NOT EXISTS taxonomy_items (
  id          TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('type','category','language','template')),
  lang        TEXT NOT NULL DEFAULT '',
  name        TEXT NOT NULL,
  slug        TEXT,
  source_type TEXT,
  schema_json TEXT,
  is_system   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (id, kind, lang)
);
CREATE INDEX IF NOT EXISTS idx_taxonomy_kind ON taxonomy_items(kind);

-- Default types (collection)
INSERT OR IGNORE INTO taxonomy_items (id, kind, lang, name, slug, source_type, schema_json, is_system, created_at, updated_at) VALUES
  ('news', 'type', '', 'News', 'news', 'collection', '{}', 0, datetime('now'), datetime('now')),
  ('blog', 'type', '', 'Blog', 'blog', 'collection', '{}', 0, datetime('now'), datetime('now'));

-- Default categories
INSERT OR IGNORE INTO taxonomy_items (id, kind, lang, name, slug, created_at, updated_at) VALUES
  ('business', 'category', '', 'Business', 'business', datetime('now'), datetime('now')),
  ('hobby',    'category', '', 'Hobby',    'hobby',    datetime('now'), datetime('now')),
  ('sports',   'category', '', 'Sports',   'sports',   datetime('now'), datetime('now')),
  ('money',    'category', '', 'Money',    'money',    datetime('now'), datetime('now')),
  ('life',     'category', '', 'Life',     'life',     datetime('now'), datetime('now'));

-- Managed languages
INSERT OR IGNORE INTO taxonomy_items (id, kind, lang, name, created_at, updated_at) VALUES
  ('en', 'language', '', 'English',    datetime('now'), datetime('now')),
  ('ja', 'language', '', 'Japanese',   datetime('now'), datetime('now')),
  ('de', 'language', '', 'German',     datetime('now'), datetime('now')),
  ('fr', 'language', '', 'French',     datetime('now'), datetime('now')),
  ('it', 'language', '', 'Italian',    datetime('now'), datetime('now')),
  ('es', 'language', '', 'Spanish',    datetime('now'), datetime('now')),
  ('zh', 'language', '', 'Chinese',    datetime('now'), datetime('now')),
  ('ko', 'language', '', 'Korean',     datetime('now'), datetime('now')),
  ('uk', 'language', '', 'Ukrainian',  datetime('now'), datetime('now'));

-- ── Content ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS documents (
  did          TEXT NOT NULL PRIMARY KEY,
  slug         TEXT NOT NULL,
  tid          TEXT NOT NULL,
  mode         INTEGER NOT NULL DEFAULT 0,
  initial_lang TEXT NOT NULL,
  fallback_lang TEXT NOT NULL,
  publish_at   TEXT NOT NULL,
  unpublish_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  created_by   TEXT,
  updated_by   TEXT,
  UNIQUE (tid, slug)
);
CREATE INDEX IF NOT EXISTS idx_documents_tid        ON documents(tid);
CREATE INDEX IF NOT EXISTS idx_documents_mode       ON documents(mode);
CREATE INDEX IF NOT EXISTS idx_documents_publish_at ON documents(publish_at);

CREATE TABLE IF NOT EXISTS document_translations (
  did           TEXT NOT NULL,
  lang          TEXT NOT NULL,
  title         TEXT NOT NULL,
  summary       TEXT,
  body_html     TEXT NOT NULL,
  seo_json      TEXT,
  hashtag_json  TEXT,
  metadata_json TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  created_by    TEXT,
  updated_by    TEXT,
  PRIMARY KEY (did, lang),
  FOREIGN KEY (did) REFERENCES documents(did)
);
CREATE INDEX IF NOT EXISTS idx_translations_lang ON document_translations(lang);

CREATE TABLE IF NOT EXISTS document_categories (
  did TEXT NOT NULL,
  cid TEXT NOT NULL,
  PRIMARY KEY (did, cid),
  FOREIGN KEY (did) REFERENCES documents(did)
);

CREATE TABLE IF NOT EXISTS document_translation_revisions (
  revision_id TEXT NOT NULL PRIMARY KEY,
  did         TEXT NOT NULL,
  lang        TEXT NOT NULL,
  revision_no INTEGER NOT NULL,
  title       TEXT NOT NULL,
  body_html   TEXT NOT NULL,
  seo_json    TEXT,
  hashtag_json TEXT,
  snapshot_at TEXT NOT NULL,
  snapshot_by TEXT,
  FOREIGN KEY (did) REFERENCES documents(did),
  UNIQUE (did, lang, revision_no)
);
CREATE INDEX IF NOT EXISTS idx_revisions_did_lang ON document_translation_revisions(did, lang);

-- Template content (kuro-boo / Blog Type 001 initial values)
INSERT OR IGNORE INTO taxonomy_items (id, kind, lang, name, is_system, created_at, updated_at) VALUES
  ('top-hero-title', 'template', '', '<h1>Blog Type 001</h1>',                                    1, datetime('now'), datetime('now')),
  ('top-hero-sub',   'template', '', '<p>技術・インフラ・AI の最新情報をお届けするメディア</p>',  1, datetime('now'), datetime('now')),
  ('top-section',    'template', '', 'Latest Articles',                                            1, datetime('now'), datetime('now')),
  ('about-title',    'template', '', '<h1>About</h1>',                                    1, datetime('now'), datetime('now')),
  ('about-summary',  'template', '', '<p>このサイトについて</p>',                         1, datetime('now'), datetime('now')),
  ('about-body',     'template', '', '<p>KuroCMS で構築されたサイトです。</p>',           1, datetime('now'), datetime('now'));

-- ── Media ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS media_assets (
  mid           TEXT NOT NULL PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('image','video','audio')),
  filename      TEXT NOT NULL,
  ext           TEXT NOT NULL,
  mime          TEXT NOT NULL,
  width         INTEGER,
  height        INTEGER,
  size_bytes    INTEGER NOT NULL,
  public_path   TEXT NOT NULL,
  cache_version TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  created_by    TEXT
);

-- ── Search ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS search_entries (
  id            TEXT NOT NULL PRIMARY KEY,
  did           TEXT NOT NULL,
  lang          TEXT NOT NULL,
  tid           TEXT NOT NULL,
  title         TEXT NOT NULL,
  body_text     TEXT NOT NULL,
  category_text TEXT,
  hashtag_text  TEXT,
  updated_at    TEXT NOT NULL,
  FOREIGN KEY (did) REFERENCES documents(did)
);
CREATE INDEX IF NOT EXISTS idx_search_did  ON search_entries(did);
CREATE INDEX IF NOT EXISTS idx_search_lang ON search_entries(lang);
CREATE INDEX IF NOT EXISTS idx_search_tid  ON search_entries(tid);

-- ── Site Settings (single row, column per setting) ────────────────────────────

CREATE TABLE IF NOT EXISTS site_settings (
  id                         INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  site_name                  TEXT NOT NULL DEFAULT 'KuroCMS',
  public_domain              TEXT NOT NULL DEFAULT '',
  development_domain         TEXT NOT NULL DEFAULT '',
  default_lang               TEXT NOT NULL DEFAULT 'en',
  initial_lang               TEXT NOT NULL DEFAULT 'en',
  enabled_languages          TEXT NOT NULL DEFAULT 'en',
  admin_logo                 TEXT NOT NULL DEFAULT '',
  theme_accent               TEXT NOT NULL DEFAULT '#157a6e',
  theme_sidebar              TEXT NOT NULL DEFAULT '#ffffff',
  theme_main_pane            TEXT NOT NULL DEFAULT '#f7f8fb',
  bluesky_handle             TEXT NOT NULL DEFAULT '',
  bluesky_show_feed          INTEGER NOT NULL DEFAULT 0,
  bluesky_feed_position      TEXT NOT NULL DEFAULT 'left',
  threads_handle             TEXT NOT NULL DEFAULT '',
  threads_show_feed          INTEGER NOT NULL DEFAULT 0,
  license_accepted_at        TEXT NOT NULL DEFAULT '',
  license_accepted_by        TEXT NOT NULL DEFAULT '',
  license_name               TEXT NOT NULL DEFAULT 'Kuro License',
  license_attribution_phrase TEXT NOT NULL DEFAULT 'with KuroCMS',
  setup_completed_at         TEXT NOT NULL DEFAULT '',
  updated_at                 TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO site_settings (id) VALUES (1);

-- ── Audit & Operations ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS activity_logs (
  id          TEXT NOT NULL PRIMARY KEY,
  actor_uid   TEXT,
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT,
  detail_json TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs(created_at);

CREATE TABLE IF NOT EXISTS build_jobs (
  build_id         TEXT NOT NULL PRIMARY KEY,
  trigger_type     TEXT NOT NULL CHECK (trigger_type IN ('manual','schedule','webhook','api','backup')),
  target_scope     TEXT NOT NULL DEFAULT 'full',
  status           TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','canceled')),
  request_json     TEXT,
  result_json      TEXT,
  error_message    TEXT,
  idempotency_key  TEXT UNIQUE,
  created_at       TEXT NOT NULL,
  started_at       TEXT,
  finished_at      TEXT,
  created_by       TEXT
);
CREATE INDEX IF NOT EXISTS idx_build_jobs_status     ON build_jobs(status);
CREATE INDEX IF NOT EXISTS idx_build_jobs_created_at ON build_jobs(created_at);

-- ── External Connections (SNS) ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS external_connections (
  id               TEXT NOT NULL PRIMARY KEY,
  service          TEXT NOT NULL,
  label            TEXT NOT NULL,
  handle           TEXT,
  account_id       TEXT,
  access_token     TEXT,
  token_secret     TEXT,
  token_expires_at TEXT,
  endpoint_url     TEXT,
  scope_json       TEXT,
  extra_json       TEXT,
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  created_by       TEXT
);
CREATE INDEX IF NOT EXISTS idx_ext_conn_service ON external_connections(service);

-- ── Page Templates ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS page_templates (
  id           TEXT NOT NULL PRIMARY KEY,
  name         TEXT NOT NULL,
  source_url   TEXT,
  preview_url  TEXT,
  version      TEXT,
  description  TEXT,
  author_id    TEXT,
  is_active    INTEGER NOT NULL DEFAULT 0,
  installed_at TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
