ALTER TABLE users ADD COLUMN author_id TEXT;

UPDATE users
SET author_id = 'author_' || lower(hex(randomblob(12)))
WHERE author_id IS NULL OR TRIM(author_id) = '';

ALTER TABLE page_templates ADD COLUMN author_id TEXT;
