-- Add SID column to site_settings for Bluesky SNS widget reference
ALTER TABLE site_settings ADD COLUMN bluesky_sid TEXT NOT NULL DEFAULT '';
