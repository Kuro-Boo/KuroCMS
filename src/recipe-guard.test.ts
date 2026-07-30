// 契約テスト (node で直接実行: `npm run test:recipe`)。
// 保存 API の最後の砦（checkRecipeCards）の振る舞いを固定する。
// 実装を import するのでテストと本体が乖離しない。
import { checkRecipeCards } from "./recipe-guard.ts";
import { buildRecipeCardHtml, normalizeRecipe } from "./kuro-recipe.js";

const RECIPE = normalizeRecipe({
  yield: "2人分",
  prepTimeMinutes: 10,
  cookTimeMinutes: 15,
  ingredients: [{ name: "生しいたけ", amount: "6枚" }],
  instructions: [{ text: "フライパンで両面を焼く。" }],
});
const card = (r = RECIPE) => buildRecipeCardHtml(r);

type Case = [name: string, run: () => boolean];

const cases: Case[] = [
  [
    "recipe タイプ + カード 1 枚 → OK・内容を返す",
    () => {
      const c = checkRecipeCards(`<p>まえがき</p>${card()}`, true);
      return (
        c.errors.length === 0 &&
        c.count === 1 &&
        c.recipe?.yield === "2人分" &&
        c.recipe?.ingredients[0]?.name === "生しいたけ"
      );
    },
  ],
  [
    "recipe タイプ + カード 0 枚 → エラー",
    () => {
      const c = checkRecipeCards("<p>本文だけ</p>", true);
      return c.count === 0 && c.errors.join().includes("1 つ必要");
    },
  ],
  [
    "recipe タイプ + カード 2 枚 → エラー（1 記事 1 レシピ）",
    () => {
      const c = checkRecipeCards(`${card()}${card()}`, true);
      return c.count === 2 && c.errors.join().includes("1 つだけ");
    },
  ],
  [
    "他タイプにカードがある → エラー",
    () => {
      const c = checkRecipeCards(card(), false);
      return c.errors.join().includes("レシピタイプの記事にだけ");
    },
  ],
  [
    "他タイプ + カード無し → OK",
    () => checkRecipeCards("<p>普通の記事</p>", false).errors.length === 0,
  ],
  [
    "data-recipe が壊れている → エラー",
    () => {
      const broken = card().replace(/data-recipe="[^"]*"/, 'data-recipe="%%%"');
      return checkRecipeCards(broken, true)
        .errors.join()
        .includes("読み取れません");
    },
  ],
  [
    "内容が要件を満たさない（材料ゼロ）→ エラー",
    () => {
      const empty = buildRecipeCardHtml(
        normalizeRecipe({ ...RECIPE, ingredients: [] }),
      );
      return checkRecipeCards(empty, true).errors.join().includes("材料");
    },
  ],
  [
    "未知の属性は弾く（本文経由で任意属性を持ち込ませない）",
    () => {
      const evil = card().replace("<div ", '<div onclick="alert(1)" ');
      const c = checkRecipeCards(evil, true);
      return (
        c.errors.join().includes("未知の属性") &&
        c.errors.join().includes("onclick")
      );
    },
  ],
  [
    "未知の版は弾く",
    () => {
      const v9 = card().replace(
        'data-recipe-version="1"',
        'data-recipe-version="9"',
      );
      return checkRecipeCards(v9, true)
        .errors.join()
        .includes("未知のレシピカード版");
    },
  ],
  [
    "属性値の中の > でタグ境界を誤らない（tokenizer 経由）",
    () => {
      const tricky = `<p title="1 > 0">まえがき</p>${card()}`;
      const c = checkRecipeCards(tricky, true);
      return c.count === 1 && c.errors.length === 0;
    },
  ],
  [
    "data-bid 付き（ブロック契約の内部 id）は許可する",
    () => {
      const withBid = card().replace("<div ", '<div data-bid="blk-1" ');
      return checkRecipeCards(withBid, true).errors.length === 0;
    },
  ],
  [
    "レイアウト属性（data-width / data-align / style）は許可する",
    () => {
      const laid = buildRecipeCardHtml(RECIPE, { width: "50%", align: "left" });
      return checkRecipeCards(laid, true).errors.length === 0;
    },
  ],
];

let failed = 0;
for (const [name, run] of cases) {
  let ok = false;
  try {
    ok = run();
  } catch (e) {
    console.log("      threw:", e);
  }
  if (ok) console.log("OK   " + name);
  else {
    failed++;
    console.log("FAIL " + name);
  }
}
if (failed) {
  console.error(`\n${failed} case(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} cases passed`);
