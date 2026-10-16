// 型定義: src/normalize.js（DOM 非依存の本文 HTML 正規化）。
// KuroEditor が単一の正として保守し、dist/kuro-normalize.d.ts として emit する。
// Entamy のモノレポの製品（KuroCMS・Admin・KuroNote）は src を直接 import する（写しは置かない）。
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
  /** R0 で落とす要素・属性の数（script / style / on* / javascript: / 外部の iframe など）。 */
  unsafe: number;
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
 * - R0: 動くもの・ページ全体に効くものを落とす（{@link sanitizeContentHtml}。最後に掛ける）
 *
 * `<pre>` / `<code>` 配下は形を触らない。壊れた HTML は形を推測して直さないが、
 * R0 だけは掛ける。冪等（2 回適用しても同じ）。
 */
export function normalizeContentHtml(html: string, opts?: NormalizeOptions): string;

/** normalizeContentHtml が何を変えるかを、変更せずに数える。 */
export function inspectContentHtml(html: string, opts?: NormalizeOptions): ContentHtmlStats;

export interface NormalizeOptions {
  /**
   * Chrome のクリップボード由来の壊れ方を直すか（R6/R7/R8）。既定 `true` ——
   * **書き込む経路はすべて既定のまま**にする。
   *
   * `false` にするのは、**既に公開されている本文を一括で掃除する場合**。
   * R1〜R5 と違い R6〜R8 は**見た目が変わる**ので、混入したまま公開された
   * 記事の表示が突然変わる。「書式の正規化」の副作用として起こしてよい
   * 変更ではない。
   *
   * ⚠ **「やってはいけない」ではなく「黙ってやらない」。** 意図して直すのは
   * 正当なので、呼び出し側が何が変わるか分かった上で明示的に選べばよい。
   * KuroCMS の保守画面は、既定オフのチェックと件数の予告でそれを提供する。
   * （2026-08-16 の決定。貼り付け破壊の修正仕様。admin.entamy.com の KuroEditor）
   */
  clipboardRepair?: boolean;
}

/**
 * R0 — 本文から「動くもの」と「ページ全体に効くもの」を落とす。
 *
 * - 中身ごと: script / style / noscript / template / title / object / applet / frameset / svg / math など
 * - タグだけ: link / meta / base / embed / form（中身は残す）など
 * - iframe: KuroEditor の埋め込みと同じ行き先（YouTube / Vimeo / Google マップ）だけ残す
 * - 属性: on* / srcdoc / formaction、危ない枠組みの href・src など（javascript: 等）、
 *   expression() 等を含む style
 *
 * 木を作らずブラウザと同じ区切りでタグを読むので、**壊れた HTML でも効く**。
 * 危ないものが無ければ入力をそのまま返す。冪等。
 * 書き込む経路（normalizeContentHtml の最後）と、出す経路（公開ページ・エディタへの
 * 読み込み）の両方で使う。
 */
export function sanitizeContentHtml(html: string): string;
