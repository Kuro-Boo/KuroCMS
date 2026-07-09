-- Records which Tailwind version produced the stored compiled_css. The Play
-- CDN (cdn.tailwindcss.com, unpinned) silently serves the latest v3, so a
-- later self-heal recompile (triggered by a newly-added class) could pull a
-- BUMPED Tailwind and silently change how unrelated classes render — breaking
-- the site in places unrelated to the edit. Storing the version lets a
-- recompile PIN the same version (cdn.tailwindcss.com/{version}) as a stable
-- baseline. NULL = not yet recorded (backfilled from the CSS banner on the
-- next tw-tokens read).
ALTER TABLE page_templates ADD COLUMN compiled_tw_version TEXT;
