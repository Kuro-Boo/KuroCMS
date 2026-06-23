-- Templates are HTML data. TypeScript source is not part of the template contract.
ALTER TABLE page_templates DROP COLUMN template_source_ts;
