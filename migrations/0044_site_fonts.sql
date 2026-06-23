-- Font management: let the site owner load web fonts (machine-independent
-- typography) and pick one base font that overrides the template font-family
-- site-wide. Stored on the single-row site_settings table (id=1), matching the
-- other site-level config columns.
--
-- fonts_json: ordered JSON array of loaded web fonts, e.g.
--   [{"family":"Noto Sans JP","weights":[400,700]}, ...]
--   Order is the load order shown in the admin "Font Management" tab.
-- base_font: identifier of the base font applied to <body>. Either a catalog
--   family name (e.g. "Noto Sans JP") or a built-in system stack id
--   ("__sys_sans__" / "__sys_serif__" / "__sys_mono__"). Empty = template default.
ALTER TABLE site_settings ADD COLUMN fonts_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE site_settings ADD COLUMN base_font TEXT NOT NULL DEFAULT '';
