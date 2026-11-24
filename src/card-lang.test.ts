// 契約テスト (node で直接実行)。本文のカードの見出しを頁の言語で作り直す(card-lang.ts・#spec-i18n)と、
// 問い合わせフォームの公開ページ・送った方への誤りの文が頁の言語で出ること。
import assert from "node:assert/strict";
import { relabelCards } from "./card-lang.ts";
import { buildJobCardHtml, normalizeJob } from "../../KuroEditor/src/job.js";
import {
  buildRecipeCardHtml,
  normalizeRecipe,
} from "../../KuroEditor/src/recipe.js";
import {
  buildContactCardHtml,
  emptyContactForm,
  normalizeContactForm,
  renderContactFormHtml,
  validateSubmission,
} from "../../KuroEditor/src/contact.js";

const JOB = normalizeJob({
  open: true,
  openedAt: "2026-11-01",
  employmentType: ["PART_TIME"],
  location: { country: "JP", region: "Chiba", locality: "Kashiwa" },
  validThrough: "2026-11-10",
});
const RECIPE = normalizeRecipe({
  yield: "2",
  prepTimeMinutes: 10,
  ingredients: [{ name: "egg", amount: "1" }],
  instructions: [{ text: "boil" }],
});

// 日本語で保存した求人カードを、英語の頁では英語で出す(期限は頁を作る日で決める)
{
  const html = `<p>a</p>${buildJobCardHtml(JOB)}<p>b</p>`;
  const out = relabelCards(html, "en", "2026-11-24");
  assert.ok(out.includes("Employment type"));
  assert.ok(out.includes("Not currently hiring"));
  assert.ok(out.includes('aria-label="Job card"'));
  assert.ok(!out.includes("雇用形態"));
  assert.ok(out.startsWith("<p>a</p>"));
  assert.ok(out.endsWith("<p>b</p>"));
}

// レシピ・問い合わせのカードも頁の言語で
{
  const html =
    buildRecipeCardHtml(RECIPE) +
    buildContactCardHtml(normalizeContactForm(emptyContactForm()));
  const out = relabelCards(html, "de", "2026-11-24");
  assert.ok(out.includes("Zutaten"));
  assert.ok(out.includes("Vorbereitung 10 Min."));
  assert.ok(out.includes('aria-label="Kontaktformular"'));
  assert.ok(!out.includes("材料"));
}

// 壊れたカード・カードの無い本文は触らない
{
  const broken = '<div data-kuro-block="job-card" data-job="%%%">x</div>';
  assert.equal(relabelCards(broken, "en", "2026-11-24"), broken);
  assert.equal(
    relabelCards("<p>plain</p>", "en", "2026-11-24"),
    "<p>plain</p>",
  );
}

// 公開ページのフォームは頁の言語で、ブラウザの案内を data-messages に載せる
const form = normalizeContactForm({
  ...emptyContactForm("en"),
  to: ["mail-001"],
});
{
  const html = renderContactFormHtml(form, {
    form: "x",
    sig: "y",
    endpoint: "/_contact",
    lang: "fr",
  });
  assert.ok(html.includes('data-lang="fr"'));
  assert.ok(html.includes("Envoi en cours"));
  assert.ok(html.includes("Laissez ce champ vide"));
  assert.ok(!/[ぁ-んァ-ン]/.test(html));
}

// 送った方への誤りの文も頁の言語
{
  const r = validateSubmission(form, { f1: "not-an-email" }, "es");
  assert.equal(r.errors.f1, "El correo electrónico no es válido.");
  assert.ok(/^Introduce/.test(r.errors.f0));
}

console.log("card-lang: OK");
