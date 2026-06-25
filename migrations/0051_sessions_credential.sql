-- Track which passkey credential authenticated a session, so the admin can
-- show a "current passkey" badge in the device list. Nullable: existing
-- sessions and non-passkey sessions (PAT/local) leave it NULL.
ALTER TABLE sessions ADD COLUMN credential_id TEXT;
