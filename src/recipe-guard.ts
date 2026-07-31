// RecipeCard のサーバー側検証（仕様「レシピ専用タイプの追加の仕様」§7・§10）。
//
// 本文 HTML は誰でも書ける（管理画面のエディタ・REST/MCP・インポート）。
// エディタ側の検証は「親切」であって「保証」ではないので、**保存 API で必ず
// 検証し直す**。ここが最後の砦。
//
// ⚠ 判定ロジックは KuroEditor 上流の共有純関数（src/kuro-recipe.js）に委譲する。
//   エディタとサーバーで別実装を持つと、片方だけ通る本文が必ず生まれる。
// ⚠ HTML は単一の正規表現で走査しない（属性値内の `>` でタグ境界を誤る）。
//   トップレベル分解は共有 tokenizer（parseBlocks）に任せ、開始タグの中だけを
//   属性抽出の対象にする。

import { parseBlocks } from "./kuro-blocks.js";
import {
  RECIPE_BLOCK,
  decodeRecipe,
  normalizeRecipe,
  validateRecipe,
} from "./kuro-recipe.js";

// v1.8.78 で `RECIPE_TYPE_ID = "recipe"`（レシピ専用タイプ）を撤去した。
// `recipe` はもう予約 ID ではない — 同名のタイプを普通のタイプとして自由に
// 作ってよい（レシピ判定には一切影響しない）。

/**
 * RecipeCard の開始タグに置いてよい属性（仕様 §7 の allowlist）。
 * 知らない属性を弾くのは、本文経由で任意の属性（onclick 等）を持ち込ませないため。
 */
const ALLOWED_ATTRS = new Set([
  "data-kuro-block",
  "data-recipe-version",
  "data-recipe",
  "data-width",
  "data-align",
  "style",
  "contenteditable",
  "role",
  "aria-label",
  "data-bid", // ブロック契約の内部 id（保存 HTML には残る）
]);

/** 開始タグ（`<div …>`）だけを取り出す。無ければ空文字。 */
function openingTag(html: string): string {
  const m = /^\s*<[a-zA-Z][^\s/>]*(?:"[^"]*"|'[^']*'|[^>"'])*>/.exec(html);
  return m ? m[0] : "";
}

/** 開始タグの属性名を列挙する（引用符の中を読み飛ばす）。 */
function attrNames(tag: string): string[] {
  const names: string[] = [];
  const re =
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"[^"]*"|'[^']*'|[^\s>]*))?/g;
  // 先頭のタグ名を飛ばす
  const body = tag.replace(/^\s*<[a-zA-Z][^\s/>]*/, "").replace(/\/?>$/, "");
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) names.push(m[1].toLowerCase());
  return names;
}

/** 開始タグから 1 属性の値を読む（引用符必須。無ければ null）。 */
function attrValue(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i");
  const m = re.exec(tag);
  return m ? m[1] : null;
}

export interface RecipeCheck {
  /** 本文に含まれる RecipeCard の数。 */
  count: number;
  /** 人が読めるエラー（空なら OK）。 */
  errors: string[];
  /** 検証を通った 1 枚ぶんの内容（count!==1 やエラー時は null）。 */
  recipe: ReturnType<typeof normalizeRecipe> | null;
}

/**
 * 本文 HTML の RecipeCard を検査する。
 *
 * **記事タイプは見ない**（仕様 §7, v1.8.78 で変更）。「レシピ記事かどうか」は
 * 専用の記事タイプではなく **カードの有無**で決まる。理由:
 *   - タイプ方式では `tid === "recipe"` が唯一の入口なのに、管理画面のタイプ
 *     作成は tid を送らず連番 ID を振るため、**UI からは有効化できなかった**。
 *   - JSON-LD の分岐は元から `!!article.recipe`（カードの有無）だった。
 *   - 「1 記事 = 1 レシピ」はカードの**枚数**の制約で、タイプとは無関係。
 *     枚数は KuroEditor 側が担保する（カードが 1 枚あると鍋ボタンをロックする
 *     `_syncRecipeBtn()`）。ここは REST / MCP / インポート用の最後の砦。
 *
 * @param bodyHtml 保存しようとしている本文
 */
export function checkRecipeCards(bodyHtml: string): RecipeCheck {
  const errors: string[] = [];
  const cards = parseBlocks(bodyHtml ?? "")
    .map((seg) => ({ seg, tag: openingTag(seg.html) }))
    .filter(({ tag }) => attrValue(tag, "data-kuro-block") === RECIPE_BLOCK);

  // 個数（仕様 §7）: 0 枚 = レシピ記事ではない（正常）。1 枚 = レシピ記事。
  // 2 枚以上だけ弾く — カードは料理名も画像も持たず記事共通のものを借りる設計
  // なので、2 枚目には固有の name/image が無く「同名 Recipe が並ぶ壊れた構造化
  // データ」になる。
  if (cards.length > 1) {
    errors.push(
      `レシピカードは 1 記事に 1 つだけです（${cards.length} 個あります）。`,
    );
  }

  let recipe: RecipeCheck["recipe"] = null;
  for (const { tag } of cards) {
    // 属性 allowlist
    const unknown = attrNames(tag).filter((n) => !ALLOWED_ATTRS.has(n));
    if (unknown.length) {
      errors.push(`レシピカードに未知の属性があります: ${unknown.join(", ")}`);
    }
    // 版
    const version = attrValue(tag, "data-recipe-version");
    if (version !== "1") {
      errors.push(`未知のレシピカード版です: ${version ?? "(なし)"}`);
    }
    // 内容（正本）
    const decoded = decodeRecipe(attrValue(tag, "data-recipe"));
    if (!decoded) {
      errors.push(
        "レシピカードの内容を読み取れません（data-recipe が壊れています）。",
      );
      continue;
    }
    const normalized = normalizeRecipe(decoded);
    const contentErrors = validateRecipe(normalized);
    errors.push(...contentErrors);
    if (!contentErrors.length && cards.length === 1) recipe = normalized;
  }

  return { count: cards.length, errors, recipe };
}
