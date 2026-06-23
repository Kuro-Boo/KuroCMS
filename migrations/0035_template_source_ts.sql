-- Store the original TypeScript source and its API contract version.
ALTER TABLE page_templates ADD COLUMN template_source_ts TEXT;
ALTER TABLE page_templates ADD COLUMN template_api_version INTEGER NOT NULL DEFAULT 1;
