-- SEO / distribution metadata settings (引き継ぎ-001):
-- site_description: site-wide meta/OGP description fallback (used when an
--   article has no summary, and for home / index / about pages). Plain text.
-- ga4_measurement_id: Google Analytics 4 measurement ID (e.g. "G-XXXXXXXXXX")
--   entered in the admin "Analytics" tab. When set (and matching G-[A-Z0-9]+),
--   the public renderer emits the standard gtag.js snippet. Empty = no analytics.
-- Both live on the single-row site_settings table (id=1) like the other
-- site-level config columns.
ALTER TABLE site_settings ADD COLUMN site_description TEXT NOT NULL DEFAULT '';
ALTER TABLE site_settings ADD COLUMN ga4_measurement_id TEXT NOT NULL DEFAULT '';
