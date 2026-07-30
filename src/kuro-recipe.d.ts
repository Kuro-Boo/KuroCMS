// 型定義: src/recipe.js（DOM 非依存・外部依存ゼロの RecipeCard 純関数）。
// KuroEditor が単一の正として保守し、dist/kuro-recipe.js と対で emit する。
// ホスト（KuroCMS 等）はこれを vendored して、保存 API のサーバー側検証や
// 公開ページ生成でエディタと**同一の実装**を共有する。
//
// 仕様の正本は KuroCMS「レシピ専用タイプの追加の仕様」(2026-07-30)。

/** RecipeCard の保存データ（`data-recipe` にエンコードされる正本）。 */
export interface Recipe {
  version: number;
  /** 人数（自由文字列。Schema.org recipeYield）。 */
  yield: string;
  /** 下準備（分）。未入力ならキーごと無い。 */
  prepTimeMinutes?: number;
  /** 調理（分）。未入力ならキーごと無い。 */
  cookTimeMinutes?: number;
  ingredients: { name: string; amount?: string }[];
  instructions: { text: string }[];
}

/** カードの表示レイアウト。**レシピの内容ではない**（Schema.org へは出さない）。 */
export interface RecipeLayout {
  width: string;
  align: string;
}

export const RECIPE_VERSION: number;
/** `data-kuro-block` の値。 */
export const RECIPE_BLOCK: string;
/** RecipeCard を見つけるセレクタ（`div[data-kuro-block="recipe-card"]`）。 */
export const RECIPE_CARD_SEL: string;
export const RECIPE_WIDTHS: string[];
export const RECIPE_ALIGNS: string[];
export const RECIPE_LAYOUT_DEFAULT: RecipeLayout;
export const RECIPE_LIMITS: {
  yieldMax: number;
  timeMax: number;
  ingredientsMax: number;
  instructionsMax: number;
  instructionTextMax: number;
};

/** 入力を保存する形へ正規化する（空行落とし・trim・数値寄せ）。 */
export function normalizeRecipe(raw: unknown): Recipe;
/** 保存してよい形かを検査する。空配列なら OK。 */
export function validateRecipe(r: unknown): string[];
export function normalizeRecipeLayout(layout: unknown): RecipeLayout;
/** インライン style 文字列（左右寄せは float で回り込む）。 */
export function recipeLayoutStyle(layout: unknown): string;
/** 下準備 + 調理（どちらも未入力なら null）。保存はしない。 */
export function totalMinutes(r: unknown): number | null;
/** `data-recipe` へ入れる形。 */
export function encodeRecipe(r: Recipe): string;
/** `data-recipe` を読み戻す。壊れていれば null。 */
export function decodeRecipe(attr: unknown): Record<string, unknown> | null;
/** 「10 分」「1 時間 5 分」。0 以下は空文字。 */
export function formatMinutes(m: number): string;
/** 編集画面用プレビューの内側 HTML（JSON からのみ組み立てる）。 */
export function renderRecipePreview(r: Recipe): string;
/** RecipeCard ブロック 1 個ぶんの HTML。 */
export function buildRecipeCardHtml(r: Recipe, layout?: RecipeLayout): string;
/** 空のフォーム初期値。 */
export function emptyRecipe(): Recipe;
