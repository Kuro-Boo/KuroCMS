// Data contract passed to the HTML template parser.

export interface ArticleCardData {
  slug: string;
  tid: string;
  title: string;
  summary: string;
  publishAt: string;
  /** Build-time fallback date. Public templates hydrate it from publishAt in the browser timezone. */
  date: string;
  /** Build-time fallback day of month without leading zero. */
  dateDay: string;
  /** Build-time fallback year + month label. */
  dateYm: string;
  /** Build-time fallback weekday label. */
  dateWeekday: string;
  coverUrl: string | null;
  categories: CategoryItem[];
}

export interface TypeItem {
  id: string;
  name: string;
  slug: string;
  count: number;
}

export interface CategoryItem {
  id: string;
  name: string;
  slug: string;
  count: number;
}

export interface Pagination {
  page: number;
  totalPages: number;
  prevUrl: string | null;
  nextUrl: string | null;
}

/** A single article's data, available on article pages. */
export interface ArticleData {
  slug: string;
  type: string;
  title: string;
  summary: string;
  bodyHtml: string;
  publishAt: string;
  updatedAt: string;
  /** Cover image URL (from seo_json.coverPath) — for the article header. */
  coverUrl?: string | null;
  /** Build-time fallback date for the article header. */
  date?: string;
  /** Author display name (users.display_name via documents.created_by).
   *  Empty/undefined when the creating user has no display name. */
  authorName?: string | null;
  /**
   * レシピ記事（type = "recipe"）の RecipeCard の内容。本文 HTML に埋まっている
   * `data-recipe`（正本）をビルド時に読み出したもの。テンプレートは型比較を
   * せず `page.isRecipe` で分岐する（仕様「レシピ専用タイプ」§7）。
   * カードが無い/壊れている記事では undefined。
   */
  recipe?: RecipeData | null;
}

/** RecipeCard の内容（KuroEditor の共有純関数が正規化した形）。 */
export interface RecipeData {
  /** 人数（自由文字列。Schema.org recipeYield）。 */
  yield: string;
  /** 下準備（分）。未入力なら無い。 */
  prepTimeMinutes?: number;
  /** 調理（分）。未入力なら無い。 */
  cookTimeMinutes?: number;
  /** 下準備 + 調理。保存はせず表示のたびに導出する。 */
  totalMinutes: number | null;
  ingredients: { name: string; amount?: string }[];
  instructions: { text: string }[];
}

/**
 * Passed to every render() call.
 * content holds all expanded site-text values (user-editable [[...]] refs)
 * plus CMS-injected values prefixed with "_" (read-only computed data).
 *
 * Stable contract: fields are only ever added, never removed or renamed.
 */
export interface RenderContext {
  /** URL path, e.g. "/", "/about/", "/:type/page/2/" */
  path: string;
  /** URL segments, e.g. { type: "blog", slug: "my-post", page: "2" } */
  params: Record<string, string>;
  /**
   * All data for the template:
   *   - User-editable site text (keys from taxonomy_items KIND='template'),
   *     with [[...]] refs already expanded.
   *   - CMS-injected computed data (underscore-prefixed, read-only):
   *       _site-name, _nav-types, _nav-categories, _articles, _pagination,
   *       _type-name, _category-name, _bluesky-handle, _article-summary
   */
  content: Record<string, string>;
  /** Article data — only present on article pages. */
  article?: ArticleData;
  lang: string;
  basePath: string;
}
