ALTER TABLE page_templates ADD COLUMN community_published INTEGER NOT NULL DEFAULT 0;
ALTER TABLE page_templates ADD COLUMN community_id TEXT;
