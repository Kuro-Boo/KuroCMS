/** Template-declared standalone pages. Kept separate from the renderer so the
 * router, builder, sitemap and template model share one parsed definition. */
export interface StaticPageDefinition {
  slug: string;
  titleKey: string;
  bodyKey: string;
  /**
   * 任意。リード文と表紙のサイトテキストキー。
   *
   * ⚠ これが無かったため、テンプレートは `[[html:content.about-summary]]` の
   *   ように【about のキーを直書き】していた。`[[#if page.isStatic]]` は宣言した
   *   すべての固定ページで真になるので、recruit を足すと Recruit ページに About の
   *   要約と表紙が出る（2026-08 に公開テンプレート 19 件で確認）。パーサーに等値
   *   比較が無くテンプレート側で slug を判定できないため、契約側で入り口を用意する。
   */
  summaryKey?: string;
  coverKey?: string;
  /**
   * ナビに出す【短いラベル】のサイトテキストキー。省略時はページタイトルを使う。
   *
   * ⚠ タイトルをそのままナビに出すと長すぎる。kuro.boo の about は
   *   「黒兎の人物紹介」で、スマホのナビが折り返して崩れた（2026-08-13）。
   *   §6.1 でナビを [[#each navigation.pages]] に統一する前は、テンプレートに
   *   `About` と直書きされた短い語が入っていた — その役割をここが引き継ぐ。
   */
  navKey?: string;
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
    // 任意キー。省略可・空文字は未指定扱い。形式は他のキーと同じ規則。
    const optionalKey = (value: unknown, field: string): string | undefined => {
      if (value === undefined || value === null || value === "")
        return undefined;
      if (typeof value !== "string" || !SLUG_RE.test(value))
        throw new Error(`Invalid ${field} at index ${index}.`);
      return value;
    };
    slugs.add(slug);
    return {
      slug,
      titleKey,
      bodyKey,
      navKey: optionalKey(page.navKey, "navKey"),
      summaryKey: optionalKey(page.summaryKey, "summaryKey"),
      coverKey: optionalKey(page.coverKey, "coverKey"),
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
