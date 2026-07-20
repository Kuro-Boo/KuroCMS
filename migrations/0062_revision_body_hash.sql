-- 3-way マージの base 検索用: リビジョンに body_html の SHA-256 (hex) を持たせる。
-- クライアント/AI が申告する baseBodyHash から「その版のリビジョン」を O(1) で
-- 引けるようにする (共同編集仕様書 C3/C4。無ければハッシュ再計算の全走査になる)。
-- 既存行は NULL のまま (マージ base として引けないだけで害はない。以後の
-- スナップショットから記録される)。
ALTER TABLE document_translation_revisions ADD COLUMN body_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_dtr_body_hash
  ON document_translation_revisions(did, lang, body_hash);
