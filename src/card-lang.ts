// 本文のカード(求人・レシピ・問い合わせ)の見出しを、公開の頁の言語で作り直す(仕様 editor-editor-spec-ui
// #spec-i18n・2026-11-24)。
//
// エディタは保存のときに本文の言語でカードの中身(プレビュー)を書くが、言語の設定より前に保存した本文や、
// 別の言語の頁へ写した本文では、見出しが頁の言語と食い違う。正本は data 属性なので、公開の頁を作るたびに
// 正本から頁の言語で作り直す(求人は頁を作る日で「募集していません」も決まる)。
// ⚠ 中身を作り直すだけで、開始タグの属性は aria-label 以外触らない(公開物は R0 を通した後の本文)。

import {
  CONTACT_BLOCK,
  contactText,
  decodeContactForm,
  normalizeContactForm,
  renderContactPreview,
  validateContactForm,
} from "../../KuroEditor/src/contact.js";
import {
  JOB_BLOCK,
  decodeJob,
  jobCardLabel,
  normalizeJob,
  renderJobPreview,
  validateJob,
} from "../../KuroEditor/src/job.js";
import {
  RECIPE_BLOCK,
  decodeRecipe,
  normalizeRecipe,
  recipeCardLabel,
  renderRecipePreview,
  validateRecipe,
} from "../../KuroEditor/src/recipe.js";

/** 開始タグの終わり(引用符の中の > を読み飛ばす)。 */
export function tagEnd(html: string, from: number): number {
  let q = "";
  for (let i = from; i < html.length; i++) {
    const c = html[i];
    if (q) {
      if (c === q) q = "";
    } else if (c === '"' || c === "'") q = c;
    else if (c === ">") return i;
  }
  return -1;
}

/** html[start] の <div …> に対応する </div> の後ろの位置(見つからなければ -1)。 */
export function divEnd(html: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) return -1;
    if (/^<div[\s>]/i.test(html.slice(lt, lt + 5))) {
      const e = tagEnd(html, lt);
      if (e < 0) return -1;
      depth++;
      i = e + 1;
    } else if (/^<\/div\s*>/i.test(html.slice(lt, lt + 7))) {
      const e = html.indexOf(">", lt);
      depth--;
      i = e + 1;
      if (depth === 0) return i;
    } else {
      const e = tagEnd(html, lt + 1);
      i = e < 0 ? lt + 1 : e + 1;
    }
  }
  return -1;
}

const CARD_OPEN = new RegExp(
  `<div\\b[^>]*\\bdata-kuro-block="(${JOB_BLOCK}|${RECIPE_BLOCK}|${CONTACT_BLOCK})"`,
  "gi",
);

function attr(tag: string, name: string): string {
  return new RegExp(`\\b${name}="([^"]*)"`, "i").exec(tag)?.[1] ?? "";
}

function escAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function withLabel(tag: string, label: string): string {
  return /\baria-label="[^"]*"/i.test(tag)
    ? tag.replace(/\baria-label="[^"]*"/i, `aria-label="${escAttr(label)}"`)
    : tag.replace(/>$/, ` aria-label="${escAttr(label)}">`);
}

/**
 * 本文のカードの中身を、正本から頁の言語で作り直す。読めない・正しくないカードは触らない。
 * @param today 頁を作る日(サイトの時計・YYYY-MM-DD)。期限を過ぎた求人を「募集していません」と出す
 */
export function relabelCards(
  html: string,
  lang: string,
  today: string,
): string {
  if (!html || !html.includes("data-kuro-block=")) return html;
  let out = "";
  let pos = 0;
  CARD_OPEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CARD_OPEN.exec(html))) {
    const start = m.index;
    if (start < pos) continue;
    const tEnd = tagEnd(html, start);
    const end = divEnd(html, start);
    if (tEnd < 0 || end < 0) break;
    const tag = html.slice(start, tEnd + 1);
    let inner: string | null = null;
    let label = "";
    if (m[1] === JOB_BLOCK) {
      const d = decodeJob(attr(tag, "data-job"));
      const j = d ? normalizeJob(d) : null;
      if (j && !validateJob(j).length) {
        inner = renderJobPreview(j, { lang, today });
        label = jobCardLabel(lang);
      }
    } else if (m[1] === RECIPE_BLOCK) {
      const d = decodeRecipe(attr(tag, "data-recipe"));
      const r = d ? normalizeRecipe(d) : null;
      if (r && !validateRecipe(r).length) {
        inner = renderRecipePreview(r, { lang });
        label = recipeCardLabel(lang);
      }
    } else {
      const d = decodeContactForm(attr(tag, "data-contact"));
      const c = d ? normalizeContactForm(d) : null;
      if (c && !validateContactForm(c).length) {
        inner = renderContactPreview(c, { lang });
        label = contactText(lang).card;
      }
    }
    if (inner === null) continue;
    out += html.slice(pos, start) + withLabel(tag, label) + inner + "</div>";
    pos = end;
    CARD_OPEN.lastIndex = end;
  }
  return out + html.slice(pos);
}
