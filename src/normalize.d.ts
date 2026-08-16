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
  /** ブロックに付いた font-size / font-weight の数（Chrome のコピーが焼き込む）。 */
  blockDecor: number;
  /** ブロックを内包している見出し・段落の数（Chrome のコピーの文脈要素）。 */
  nestedBlocks: number;
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
 * - ブロックに付いた `font-size` / `font-weight` → 除去（`<span>` のものは保持）
 * - ブロックを内包した見出し・段落 → 解いて兄弟に並べる（文字は落とさない、
 *   `data-bid` は 1 ブロックに 1 つだけ残す）
 *
 * `<pre>` / `<code>` 配下は一切触らない。壊れた HTML は入力をそのまま返す。
 * 冪等（2 回適用しても同じ）。
 */
export function normalizeContentHtml(html: string, opts?: NormalizeOptions): string;

/** normalizeContentHtml が何を変えるかを、変更せずに数える。 */
export function inspectContentHtml(html: string, opts?: NormalizeOptions): ContentHtmlStats;

export interface NormalizeOptions {
  /**
   * Chrome のクリップボード由来の壊れ方を直すか（R6/R7/R8）。既定 `true` ——
   * **書き込む経路はすべて既定のまま**にする。
   *
   * `false` にするのは、**既に公開されている本文を一括で掃除する場合だけ**。
   * 混入したまま公開された記事を今から直すと公開ページの見た目が変わり、
   * 読者にとってはそちらの方が実害が大きい。R6〜R8 が効くのは
   * これ以降の書き込みだけで、既存記事は編集して保存した時に自然に直る。
   * （2026-08-16 の決定。KuroEditor/docs/貼り付け破壊の修正仕様.md）
   */
  clipboardRepair?: boolean;
}
