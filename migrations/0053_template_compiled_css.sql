-- Static Tailwind CSS per template: replaces the render-blocking
-- cdn.tailwindcss.com runtime compiler on public pages (Core Web Vitals).
-- compiled_css    : the stylesheet compiled in the admin browser (Play CDN JIT)
-- compiled_tokens : JSON array of class-candidate tokens the CSS was compiled
--                   from; the build falls back to the CDN script when the
--                   current source contains tokens outside this set
-- compiled_hash   : cheapHash(compiled_css) — versions the immutable
--                   /_tw/{id}.{hash}.css URL
ALTER TABLE page_templates ADD COLUMN compiled_css TEXT;
ALTER TABLE page_templates ADD COLUMN compiled_tokens TEXT;
ALTER TABLE page_templates ADD COLUMN compiled_hash TEXT;
