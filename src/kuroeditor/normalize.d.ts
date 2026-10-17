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
 * 本文 HTML を KuroEditor の形にする（v2.44.0〜。{@link conformContentHtml} と同じ）。
 *
 * エディタの形以外は、すべてエディタの形へ写す（2026-10-17 の決定）。
 * - 文字は絶対に消さない（知らないタグは文字に戻す）
 * - 選べない値は近いものへ（文字サイズ 7 段・行間 6 段・字下げ 2em 刻み…）。無ければ書かない
 * - 機能の記法（data-*・id・kuro-/kurocms- のコメント・[[…]]）は残す。data-kuro-* の部品は中まで触らない
 * - 書き出しはブラウザの innerHTML と同じ綴り（開いて保存しても変わらない）
 * - R0（{@link sanitizeContentHtml}）を最後に掛ける。壊れた HTML も必ず形にする。冪等
 *
 * `opts` は以前の clipboardRepair。いまは意味を持たない（常に形へ揃える）。
 */
export function normalizeContentHtml(html: string, opts?: NormalizeOptions): string;

/** 本文 HTML を KuroEditor の形にする（{@link normalizeContentHtml} の本体）。 */
export function conformContentHtml(html: string): string;

/** 色として通る値なら小文字に揃えて返す（テーマの var(--…) は null）。 */
export function cssColor(value: string): string | null;

/** normalizeContentHtml が何を変えるかを、変更せずに数える。正は `changed`、内訳は文字列で数えた目安。 */
export function inspectContentHtml(html: string, opts?: NormalizeOptions): ContentHtmlStats;

export interface NormalizeOptions {
  /** 廃止（2026-10-17）。渡しても無視される —— 公開済みの本文も保存のたびに形へ揃う。 */
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
