-- Monotonic revision counter for the article dataset.
--
-- The admin article list is a snapshot taken when the screen mounts. If an
-- article is created/updated/deleted out-of-band while it is open — e.g. AI via
-- the REST/MCP API — the list would not reflect it until a manual reload. To fix
-- that, every admin API response is stamped with this counter (x-kurocms-docrev)
-- and the client re-fetches the list whenever it changes.
--
-- A single set of triggers on `documents` is enough: translation, category, SNS,
-- mode and timestamp edits all bump documents.updated_at (an UPDATE), so they
-- fire the AFTER UPDATE trigger too. The value is only ever compared for change,
-- never interpreted, so it seeds at 0. Triggers are written on one line so the
-- migration runner's ";"-splitter does not break their BEGIN..END body.
CREATE TABLE IF NOT EXISTS data_revision (name TEXT NOT NULL PRIMARY KEY, rev INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO data_revision (name, rev) VALUES ('documents', 0);
CREATE TRIGGER IF NOT EXISTS documents_rev_ins AFTER INSERT ON documents BEGIN UPDATE data_revision SET rev = rev + 1 WHERE name = 'documents'; END;
CREATE TRIGGER IF NOT EXISTS documents_rev_upd AFTER UPDATE ON documents BEGIN UPDATE data_revision SET rev = rev + 1 WHERE name = 'documents'; END;
CREATE TRIGGER IF NOT EXISTS documents_rev_del AFTER DELETE ON documents BEGIN UPDATE data_revision SET rev = rev + 1 WHERE name = 'documents'; END;
