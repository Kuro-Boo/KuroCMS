/** Template-declared standalone pages. Kept separate from the renderer so the
 * router, builder, sitemap and template model share one parsed definition. */
export interface StaticPageDefinition {
  slug: string;
  titleKey: string;
  bodyKey: string;
  nav: boolean;
  /** Former public paths that permanently redirect to this fixed page. */
  redirectFrom: string[];
}

const DECLARATION_RE = /<!--\s*kurocms-pages:\s*(\[[\s\S]*?\])\s*-->/i;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const REDIRECT_PATH_RE = /^\/[a-z0-9][a-z0-9_/-]*\/$/;

function normalizeRedirectPath(value: string): string | null {
  if (!value.startsWith("/")) return null;
  const path = value.endsWith("/") ? value : `${value}/`;
  return REDIRECT_PATH_RE.test(path) ? path : null;
}

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
  const redirects = new Set<string>();
  return raw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error(`kurocms-pages[${index}] must be an object.`);
    const page = item as Record<string, unknown>;
    const slug = typeof page.slug === "string" ? page.slug : "";
    const titleKey = typeof page.titleKey === "string" ? page.titleKey : "";
    const bodyKey = typeof page.bodyKey === "string" ? page.bodyKey : "";
    const redirectFrom =
      page.redirectFrom === undefined ? [] : page.redirectFrom;
    if (
      !SLUG_RE.test(slug) ||
      !SLUG_RE.test(titleKey) ||
      !SLUG_RE.test(bodyKey)
    )
      throw new Error(`Invalid kurocms-pages entry at index ${index}.`);
    if (slugs.has(slug)) throw new Error(`Duplicate static page slug: ${slug}`);
    if (!Array.isArray(redirectFrom))
      throw new Error(`Invalid redirectFrom at index ${index}.`);
    const normalizedRedirects = redirectFrom.map((value) =>
      typeof value === "string" ? normalizeRedirectPath(value) : null,
    );
    if (normalizedRedirects.some((value) => !value))
      throw new Error(`Invalid redirectFrom at index ${index}.`);
    for (const path of normalizedRedirects as string[]) {
      if (path === `/${slug}/` || redirects.has(path))
        throw new Error(`Duplicate static page redirect: ${path}`);
      redirects.add(path);
    }
    slugs.add(slug);
    return {
      slug,
      titleKey,
      bodyKey,
      nav: page.nav !== false,
      redirectFrom: normalizedRedirects as string[],
    };
  });
}

export function findStaticPage(
  pages: StaticPageDefinition[],
  path: string,
): StaticPageDefinition | undefined {
  const slug = path.replace(/^\/+|\/+$/g, "");
  return pages.find((page) => page.slug === slug);
}

export function findStaticPageRedirect(
  pages: StaticPageDefinition[],
  path: string,
): StaticPageDefinition | undefined {
  const normalized = normalizeRedirectPath(path);
  return normalized
    ? pages.find((page) => page.redirectFrom.includes(normalized))
    : undefined;
}
