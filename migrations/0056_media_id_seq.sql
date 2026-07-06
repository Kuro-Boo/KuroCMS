-- Media ID sequence: remembers the highest media number ever issued per kind,
-- so deleting the newest asset can never cause its mid to be re-issued.
-- (Re-issuing a mid reuses its /images/{mid}.{ext} URL, which browsers/CDN
-- hold with a 1-year immutable cache — the new content then LOOKS like the
-- old image everywhere in the admin. Happened on kuro.boo with img-941.)
CREATE TABLE IF NOT EXISTS media_id_seq (
  kind TEXT PRIMARY KEY,
  last_n INTEGER NOT NULL
);

-- Seed from the current maximum of each kind so the very next upload starts
-- above every EXISTING mid (numbers of previously deleted assets stay burned
-- only from now on; historical gaps below the max are unaffected anyway).
INSERT OR REPLACE INTO media_id_seq (kind, last_n)
SELECT kind, MAX(CAST(substr(mid, instr(mid, '-') + 1) AS INTEGER))
FROM media_assets
WHERE mid LIKE '%-%'
GROUP BY kind;
