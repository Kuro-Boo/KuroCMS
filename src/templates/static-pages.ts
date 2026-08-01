/** Template-declared standalone pages. Kept separate from the renderer so the
 * router, builder, sitemap and template model share one parsed definition. */
export interface StaticPageDefinition {
  slug: string;
  titleKey: string;
  bodyKey: string;
  nav: boolean;
}

const DECLARATION_RE = /<!--\s*kurocms-pages:\s*(\[[\s\S]*?\])\s*-->/i;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

export function parseStaticPages(sourceHtml: string): StaticPageDefinition[] {
  const match = sourceHtml.match(DECLARATION_RE);
  if (!match) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(match[1]);
  } catch {
    throw new Error("Invalid kurocms-pages JSON declaration.");
  }
  if (!Array.isArray(raw)) throw new Error("kurocms-pages must be an array.");
  const slugs = new Set<string>();
  return raw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error(`kurocms-pages[${index}] must be an object.`);
    const page = item as Record<string, unknown>;
    const slug = typeof page.slug === "string" ? page.slug : "";
    const titleKey = typeof page.titleKey === "string" ? page.titleKey : "";
    const bodyKey = typeof page.bodyKey === "string" ? page.bodyKey : "";
    if (
      !SLUG_RE.test(slug) ||
      !SLUG_RE.test(titleKey) ||
      !SLUG_RE.test(bodyKey)
    )
      throw new Error(`Invalid kurocms-pages entry at index ${index}.`);
    if (slugs.has(slug)) throw new Error(`Duplicate static page slug: ${slug}`);
    slugs.add(slug);
    return { slug, titleKey, bodyKey, nav: page.nav !== false };
  });
}

export function findStaticPage(
  pages: StaticPageDefinition[],
  path: string,
): StaticPageDefinition | undefined {
  const slug = path.replace(/^\/+|\/+$/g, "");
  return pages.find((page) => page.slug === slug);
}
