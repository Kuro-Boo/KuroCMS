// 公開 HTML の見出しに「安定した id」と「# アンカー」を与え、目次データを取り出す。
//
// 経緯: 以前は KuroEditor の目次パネルが編集中に本文 DOM へ書き込む
// `id="kuro-h-<連番>"` がそのまま D1 に保存され、公開ページにも出ていた。連番なので
// 見出しを 1 つ挿入するだけで以降が全部ずれる（＝共有できるアンカーにならないし、
// data-bid を持たないブロックでは 3-way マージの鍵にまで揺れが混ざる）。しかも
// 公開側にはアンカーも目次も無く、実質どこからも参照されていなかった。
//
// そこで publish 時に、見出しテキスト由来の安定 id へ置き換える。D1 の本文は
// 触らない（編集側の都合とは切り離す）。旧 `kuro-h-<連番>` は再生成対象、著者が
// 自分で付けた id はそのまま尊重する。
//
// DOM は使わない（Workers で動く）。タグ境界は引用符を見ながら走査するので、
// 属性値の中の '>'（例 title="1 > 0"）で切り間違えない。

export interface HeadingItem {
  /** 見出しに実際に付与した id（＝ アンカーのフラグメント）。 */
  id: string;
  /** h1..h5 の数値。 */
  level: number;
  /** タグを除いた見出しテキスト。目次のラベルに使う。 */
  text: string;
}

export interface AnnotateResult {
  html: string;
  headings: HeadingItem[];
}

/** 旧 KuroEditor 目次パネルが振る位置依存 id。見つけたら安定 id で置き換える。 */
const LEGACY_HEADING_ID_RE = /^kuro-h-\d+$/;

/** id / スラッグの最大長。長い見出しでも URL が壊れない程度に丸める。 */
const MAX_SLUG_LENGTH = 60;

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeHtml(value: string): string {
  return escapeAttr(value).replace(/'/g, "&#39;");
}

/**
 * `lt`（'<' の位置）から始まるタグの終端（'>' の次の位置）を返す。
 * 引用符で囲まれた属性値の中の '>' は終端とみなさない。
 */
function findTagEnd(html: string, lt: number): number {
  const n = html.length;
  let j = lt + 1;
  let quote = "";
  while (j < n) {
    const ch = html[j];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      break;
    }
    j++;
  }
  return j < n ? j + 1 : n;
}

/**
 * タグと HTML コメントを落として素のテキストにする（引用符対応の走査版）。
 *
 * ⚠ 見出し以外にも要る。サイトテキストは KuroEditor で編集する＝中身は HTML なので、
 *   固定ページのタイトルのように【平文でなければならない場所】（<title>・og:title・
 *   ナビのリンク文字・llms.txt）へそのまま流すと、`&lt;h1&gt;…` と実体参照で見えてしまう。
 */
export function htmlToPlainText(html: string): string {
  return plainText(html);
}

function plainText(html: string): string {
  let out = "";
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    i = findTagEnd(html, lt);
  }
  return out
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 見出しテキストから URL フラグメント用のスラッグを作る。
 *
 * 日本語をローマ字化したりはしない（辞書が要るうえ再現性が落ちる）。Unicode の
 * 文字・数字はそのまま残す — フラグメント識別子は UTF-8 で問題なく、ブラウザが
 * 必要に応じて percent-encode する。記号と空白だけを '-' に畳む。
 */
export function slugifyHeading(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "-")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, "");
}

/** 同じ見出しテキストが複数あるとき用。既出なら -2, -3 … を足す。 */
function uniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

/** 開始タグから id 属性の値を取り出す（無ければ ""）。 */
function readIdAttr(tag: string): string {
  const m = /\sid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
  if (!m) return "";
  return (m[1] ?? m[2] ?? m[3] ?? "").trim();
}

/** 開始タグから id 属性を取り除く。 */
function removeIdAttr(tag: string): string {
  return tag.replace(/\sid\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, "");
}

export interface AnnotateOptions {
  /** アンカー <a> の aria-label（サイト言語に合わせて呼び手が渡す）。 */
  anchorLabel?: string;
}

/**
 * h1〜h5 に安定 id を付け、末尾に `#` アンカーを差し込む。
 * 併せて目次用の見出し一覧を返す。
 *
 * - 著者が自分で付けた id（`kuro-h-<連番>` 以外）は変更しない
 * - 既にアンカーが入っている見出しは二重に足さない（再実行しても同じ結果）
 * - 閉じタグが見つからない壊れた見出しは素通しする
 */
export function annotateHeadings(
  html: string,
  options: AnnotateOptions = {},
): AnnotateResult {
  const src = typeof html === "string" ? html : "";
  if (!/<h[1-5][\s/>]/i.test(src)) return { html: src, headings: [] };

  const anchorLabel = options.anchorLabel || "Link to this section";
  const used = new Set<string>();
  const headings: HeadingItem[] = [];
  let out = "";
  let i = 0;
  const n = src.length;

  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt === -1) {
      out += src.slice(i);
      break;
    }
    out += src.slice(i, lt);

    // コメントは '>' を含みうるので丸ごと写す
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      const stop = end === -1 ? n : end + 3;
      out += src.slice(lt, stop);
      i = stop;
      continue;
    }

    const tagEnd = findTagEnd(src, lt);
    const tag = src.slice(lt, tagEnd);
    const opening = /^<h([1-5])(?=[\s/>])/i.exec(tag);
    if (!opening) {
      out += tag;
      i = tagEnd;
      continue;
    }

    const level = Number(opening[1]);
    const close = new RegExp(`</h${level}\\s*>`, "i").exec(src.slice(tagEnd));
    if (!close) {
      // 閉じタグが無い＝壊れている。触らずそのまま流す
      out += tag;
      i = tagEnd;
      continue;
    }
    const inner = src.slice(tagEnd, tagEnd + close.index);
    const closeTag = close[0];

    const text = plainText(inner);
    const existingId = readIdAttr(tag);
    const keepExisting =
      Boolean(existingId) && !LEGACY_HEADING_ID_RE.test(existingId);
    const id = keepExisting
      ? uniqueId(existingId, used)
      : uniqueId(
          slugifyHeading(text) || `section-${headings.length + 1}`,
          used,
        );

    const openTag = removeIdAttr(tag).replace(
      /^<h([1-5])/i,
      `<h$1 id="${escapeAttr(id)}"`,
    );
    // 冪等性: 既にアンカーがあるなら足さない（再ビルドで '#' が増えていかない）
    const anchor = inner.includes("kuro-anchor")
      ? ""
      : `<a class="kuro-anchor" href="#${escapeAttr(id)}" aria-label="${escapeAttr(
          anchorLabel,
        )}">#</a>`;

    out += openTag + inner + anchor + closeTag;
    headings.push({ id, level, text });
    i = tagEnd + close.index + closeTag.length;
  }

  return { html: out, headings };
}

export interface TocOptions {
  /** 見出しの上に出す表題（"目次" / "Contents" …）。 */
  label: string;
  /** これ未満の本数なら目次を作らない（既定 2）。 */
  minItems?: number;
}

/**
 * 目次 HTML。テンプレートは `[[html:article.toc]]` でそのまま置ける。
 * スタイルは公開ページ側の scoped CSS（public.ts の injectContentStyles）が持つ。
 * テンプレートの配色に依存しないよう、色は currentColor と半透明グレーだけ。
 */
export function renderTocHtml(
  headings: HeadingItem[],
  options: TocOptions,
): string {
  const minItems = options.minItems ?? 2;
  if (headings.length < minItems) return "";
  const minLevel = headings.reduce((m, h) => Math.min(m, h.level), 9);
  const items = headings
    .map((h) => {
      const depth = Math.max(0, Math.min(3, h.level - minLevel));
      return (
        `<li class="kuro-toc__item" data-depth="${depth}">` +
        `<a href="#${escapeAttr(h.id)}">${escapeHtml(h.text)}</a>` +
        `</li>`
      );
    })
    .join("");
  return (
    `<nav class="kuro-toc" aria-label="${escapeAttr(options.label)}">` +
    `<p class="kuro-toc__title">${escapeHtml(options.label)}</p>` +
    `<ol class="kuro-toc__list">${items}</ol>` +
    `</nav>`
  );
}
