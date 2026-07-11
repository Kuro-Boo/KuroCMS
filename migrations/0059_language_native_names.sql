-- Fix seeded language display names: 0001_initial.sql seeded the 9 default
-- languages with ENGLISH exonyms ("Japanese", "German", …), but language names
-- are user-facing native labels (admin picker convention) and surface verbatim
-- in the SNS post language line ("🌐 日本語, English, …" — Bluesky/X/Threads).
-- Rewrite each name to its native label ONLY while it still holds the exact
-- 0001 seed value, so a name the user has since customized is left untouched.
UPDATE taxonomy_items SET name = '日本語'      WHERE kind = 'language' AND id = 'ja' AND name = 'Japanese';
UPDATE taxonomy_items SET name = 'Deutsch'    WHERE kind = 'language' AND id = 'de' AND name = 'German';
UPDATE taxonomy_items SET name = 'Français'   WHERE kind = 'language' AND id = 'fr' AND name = 'French';
UPDATE taxonomy_items SET name = 'Italiano'   WHERE kind = 'language' AND id = 'it' AND name = 'Italian';
UPDATE taxonomy_items SET name = 'Español'    WHERE kind = 'language' AND id = 'es' AND name = 'Spanish';
UPDATE taxonomy_items SET name = '中文'        WHERE kind = 'language' AND id = 'zh' AND name = 'Chinese';
UPDATE taxonomy_items SET name = '한국어'      WHERE kind = 'language' AND id = 'ko' AND name = 'Korean';
UPDATE taxonomy_items SET name = 'Українська' WHERE kind = 'language' AND id = 'uk' AND name = 'Ukrainian';
