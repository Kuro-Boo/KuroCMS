-- Fix theme_accent that was incorrectly defaulted to #8f3d2e on settings save.
-- Restores to the correct default green (#157a6e) for any site that was affected.
UPDATE site_settings SET theme_accent = '#157a6e' WHERE theme_accent = '#8f3d2e';
