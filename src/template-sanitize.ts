/**
 * Community のテンプレートから JS を外す(cms-cms-template 9.11・2026-10-25・利用者の決定)。
 *
 * Community の書き込みの口(宣伝ページの Worker・LP_Template/functions/entry.ts)が、保存の前に掛ける。
 * 公開ページで動く他人の JS は、そのサイトの読者を騙せ、管理者が自分の公開ページを開くと同じ origin の
 * 管理画面にも届くため(cms-cms-security)。外すもの:
 *   - `<script>` のすべて(閉じていないものの開きタグも)
 *   - `on…=` のイベント属性
 *   - `javascript:` / `vbscript:` / `data:text/html` の URL(href・src・action など)→ `#`
 *   - `srcdoc` 属性(中に頁を丸ごと書ける)
 * 当社の部品を指していた script は捨てずにサイト文字へ戻す(`_counts.js` → `[[counts]]`、
 * Tailwind の CDN → `[[tailwind:…]]`)。外したものは一覧で返し、公開した人に知らせる。
 *
 * 正規表現で書き換えるのは、保存の前の網(作者の手で書いた HTML)だから。公開ページの守り(サイトの CSP・
 * 部品の JS は当社のファイルだけ)は別にあり、ここはそれに他人の JS を乗せないための入口の掃除。
 */

export interface StripResult {
  html: string;
  /** 外したものの短い説明(公開の画面に出す)。 */
  removed: string[];
}

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const COUNTS_SRC = /^\[\[site\.basePath\]\]\/_counts\.js$/;
const TAILWIND_SRC =
  /^https:\/\/cdn\.tailwindcss\.com(?:\/[0-9.]+)?\/?(?:\?plugins=([a-z0-9,-]{1,80}))?$/i;

function attrValue(attrs: string, name: string): string | null {
  const m = attrs.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
  );
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
}

/** 文字参照と空白を外して、URL の頭を見る(`jav&#x61;script:` や改行を挟んだものも見抜く)。 */
function dangerousUrl(raw: string): boolean {
  const decoded = raw
    .replace(/&#x([0-9a-f]+);?/gi, (_m, h: string) =>
      String.fromCharCode(parseInt(h, 16)),
    )
    .replace(/&#(\d+);?/g, (_m, d: string) =>
      String.fromCharCode(parseInt(d, 10)),
    )
    .replace(/&(tab|newline);/gi, "")
    // 制御文字と空白(ブラウザは URL の頭のそれらを読み飛ばす)。
    .split("")
    .filter((c) => c.charCodeAt(0) > 0x20)
    .join("")
    .toLowerCase();
  return (
    /^(javascript|vbscript):/.test(decoded) || /^data:text\/html/.test(decoded)
  );
}

export function stripTemplateJs(html: string): StripResult {
  const removed: string[] = [];
  let out = html.replace(SCRIPT_RE, (_whole, attrs: string, body: string) => {
    const src = attrValue(attrs, "src");
    if (src !== null) {
      const s = src.trim();
      if (COUNTS_SRC.test(s)) return "[[counts]]";
      const tw = s.match(TAILWIND_SRC);
      if (tw)
        return tw[1] ? `[[tailwind:${tw[1].toLowerCase()}]]` : "[[tailwind]]";
      removed.push(`script: ${s.slice(0, 120)}`);
      return "";
    }
    if (body.trim())
      removed.push(`script: ${body.trim().replace(/\s+/g, " ").slice(0, 80)}`);
    return "";
  });
  // 閉じていない script・残った閉じタグ。
  out = out.replace(/<\/?script\b[^>]*>/gi, (tag) => {
    removed.push(`script: ${tag.slice(0, 80)}`);
    return "";
  });
  // 開きタグの中の、イベント属性・srcdoc・危ない URL。
  out = out.replace(
    /<([a-zA-Z][a-zA-Z0-9:-]*)(\s[^<>]*?)?(\/?)>/g,
    (whole, tag: string, attrs: string | undefined, slash: string) => {
      if (!attrs) return whole;
      let a = attrs.replace(
        /\s+(on[a-z]+|srcdoc)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
        (m, name: string) => {
          removed.push(`${name.toLowerCase()}= on <${tag.toLowerCase()}>`);
          return "";
        },
      );
      a = a.replace(
        /(\s(?:href|src|action|formaction|xlink:href|data|poster|background)\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
        (m, head: string, d?: string, s?: string, u?: string) => {
          const v = d ?? s ?? u ?? "";
          if (!dangerousUrl(v)) return m;
          removed.push(`URL: ${v.slice(0, 60)} on <${tag.toLowerCase()}>`);
          return `${head}"#"`;
        },
      );
      return `<${tag}${a}${slash}>`;
    },
  );
  return { html: out, removed };
}
