-- One-time passkey recovery tokens (emailed magic links). When all of a user's
-- devices are lost, they request recovery by email; the token authorizes
-- registering a NEW passkey for the existing account. Only the SHA-256 hash is
-- stored; the plaintext token lives only in the emailed link.
CREATE TABLE IF NOT EXISTS recovery_tokens (
  token_hash TEXT NOT NULL PRIMARY KEY,
  uid        TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recovery_uid ON recovery_tokens(uid);
