-- Normalize bluesky_show_feed / threads_show_feed to INTEGER 1/0.
-- Earlier builds wrote the string "true"/"false" into these INTEGER columns,
-- which SQLite stored as text. That left the admin GET (`=== 1`) and the public
-- read (truthy) disagreeing. Coerce any legacy text value back to 1/0.
UPDATE site_settings
SET bluesky_show_feed = CASE
  WHEN bluesky_show_feed IN (1, '1', 'true') THEN 1 ELSE 0 END
WHERE id = 1;

UPDATE site_settings
SET threads_show_feed = CASE
  WHEN threads_show_feed IN (1, '1', 'true') THEN 1 ELSE 0 END
WHERE id = 1;
