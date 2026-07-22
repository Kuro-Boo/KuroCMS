// 型定義: src/normalize.js（DOM 非依存の本文 HTML 正規化）。
// KuroEditor が単一の正として保守し、dist/kuro-normalize.d.ts として emit する。
// ホスト（KuroCMS 等）はこれを vendored して、API 取込み・メンテナンス掃除で
// エディタのペーストと「完全に同じ正規化」を適用する。

/** inspectContentHtml が返す、正規化で変わる箇所の内訳。 */
export interface ContentHtmlStats {
  /** <b> の数（→ <strong>）。 */
  bTags: number;
  /** font-weight だけを持つ <span> の数（→ <strong>）。 */
  boldSpans: number;
  /** 段落として使われている <div> の数（→ <p> か unwrap）。 */
  divBlocks: number;
  /** 空ブロック（<div><br></div> 等）の数。 */
  emptyBlocks: number;
  /** 正規化で実際に HTML が変化するか。 */
  changed: boolean;
}

/**
 * 本文 HTML を KuroEditor の正規形に揃える。
 *
 * - `<b>` / font-weight だけの `<span>` → `<strong>`
 * - 段落の `<div>` → `<p>`（属性は保持）
 * - 素の `<div>` ブロックラッパー → unwrap（スタイル付きは保持）
 * - 空ブロック → トップレベルは `<p><br></p>`、入れ子は `<br>`
 *
 * `<pre>` / `<code>` 配下は一切触らない。壊れた HTML は入力をそのまま返す。
 * 冪等（2 回適用しても同じ）。
 */
export function normalizeContentHtml(html: string): string;

/** normalizeContentHtml が何を変えるかを、変更せずに数える。 */
export function inspectContentHtml(html: string): ContentHtmlStats;
