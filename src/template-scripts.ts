/**
 * テンプレートの作者が書いたスクリプトを、サイトのファイルへ移す(cms-cms-security「CSP」・
 * 運用者の決定 2026-10-24)。
 *
 * 公開サイトの CSP は `'self'` だけを許す(site-csp.ts)。ページに直接書いたスクリプトは
 * 自分のサイトのページにあっても `'self'` では動かない —— 差し込まれたスクリプトを止めるのが
 * CSP の役目だから。テンプレートの HTML は作者の持ち物で script を含んでよいので、
 * 作者はこれまでどおり貼り付けて書き、CMS が公開ページでは自分のファイルとして読ませる。
 *
 *   インラインの script          → `<script src="{publicBase}/_tjs/{テンプレート ID}.{ハッシュ}.js">`
 *                                    (元の位置。type などの属性は引き継ぐ → 動く順番は変わらない)
 *   外部の JS(`src="https://…"`) → 読み込まない(外す)。管理画面で警告する
 *   中に `[[…]]` を含む script    → ページごとに中身が変わるので移せない。インラインのまま(警告する)
 *
 * テンプレートの CSS を `/_tw/` のファイルにしているのと同じ道。中身はテンプレートの
 * source_html から毎回取り出すので、別の保存場所を持たない(ハッシュで引き当てる)。
 *
 * ⚠ ここは cloudflare:workers を読まない(node で直接試験する)。
 */

/** 動くスクリプトの type(これ以外 —— JSON-LD・テンプレート片など —— は触らない)。 */
const EXECUTABLE_TYPES = new Set([
  "",
  "text/javascript",
  "application/javascript",
  "module",
]);

/**
 * CMS が自分で扱う外部の JS(テンプレートに書かれていても外さない)。
 * Tailwind の Play CDN は、CMS が静的 CSS に置き換える(applyCompiledTailwind)。置き換えが
 * 済んでいない間だけ残り、報告に出る。
 */
const MANAGED_EXTERNAL = /^https:\/\/cdn\.tailwindcss\.com(?:[/?#]|$)/i;

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(
    new RegExp(
      `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
      "i",
    ),
  );
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? "";
}

/** async / defer はインラインでは効かない。ファイルにすると効いてしまうので外す(順番を保つ)。 */
function keptAttrs(attrs: string): string {
  return attrs
    .replace(
      /(?:^|\s)(?:async|defer)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi,
      "",
    )
    .replace(/\s+$/, "");
}

/** 中身のハッシュ(SHA-256 の先頭 16 桁の 16 進)。 */
export async function scriptHash(body: string): Promise<string> {
  const d = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body),
  );
  return [...new Uint8Array(d)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

export type TemplateScript =
  | { kind: "inline"; attrs: string; body: string; hash: string }
  | { kind: "external"; src: string }
  | { kind: "token"; attrs: string; body: string };

/** テンプレートの HTML にあるスクリプトの一覧(動くものだけ)。 */
export async function templateScripts(
  sourceHtml: string,
): Promise<TemplateScript[]> {
  const out: TemplateScript[] = [];
  for (const m of sourceHtml.matchAll(SCRIPT_RE)) {
    const attrs = m[1] ?? "";
    const body = m[2] ?? "";
    const type = (attr(attrs, "type") ?? "").trim().toLowerCase();
    if (!EXECUTABLE_TYPES.has(type)) continue;
    const src = attr(attrs, "src");
    if (src !== null) {
      if (isExternal(src) && !MANAGED_EXTERNAL.test(src.trim()))
        out.push({ kind: "external", src: src.trim() });
      continue;
    }
    if (!body.trim()) continue;
    if (body.includes("[[")) {
      out.push({ kind: "token", attrs, body });
      continue;
    }
    out.push({ kind: "inline", attrs, body, hash: await scriptHash(body) });
  }
  return out;
}

/** 別の出どころを指す src か(`https://`・`http://`・`//`)。 */
function isExternal(src: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(src.trim());
}

/** 移したスクリプトのファイルの道筋。 */
export function templateScriptPath(
  publicBase: string,
  templateId: string,
  hash: string,
): string {
  return `${(publicBase || "").replace(/\/+$/, "")}/_tjs/${templateId}.${hash}.js`;
}

/**
 * 公開ページ用に書き換える: インラインはファイルへ、外部の JS は外す。
 * `[[…]]` を含むものと、動かない type のものはそのまま。
 */
export async function externalizeTemplateScripts(
  sourceHtml: string,
  templateId: string,
  publicBase: string,
): Promise<string> {
  if (!/<script\b/i.test(sourceHtml)) return sourceHtml;
  const hashes = new Map<string, string>();
  for (const s of await templateScripts(sourceHtml))
    if (s.kind === "inline") hashes.set(s.body, s.hash);
  return sourceHtml.replace(SCRIPT_RE, (whole, attrs: string, body: string) => {
    const type = (attr(attrs, "type") ?? "").trim().toLowerCase();
    if (!EXECUTABLE_TYPES.has(type)) return whole;
    const src = attr(attrs, "src");
    if (src !== null) {
      return isExternal(src) && !MANAGED_EXTERNAL.test(src.trim()) ? "" : whole;
    }
    const hash = hashes.get(body);
    if (!hash) return whole;
    const kept = keptAttrs(attrs);
    return `<script${kept} src="${templateScriptPath(publicBase, templateId, hash)}"></script>`;
  });
}

/** `/_tjs/{id}.{hash}.js` の中身(テンプレートの HTML から引き当てる)。無ければ null。 */
export async function templateScriptBody(
  sourceHtml: string,
  hash: string,
): Promise<string | null> {
  for (const s of await templateScripts(sourceHtml))
    if (s.kind === "inline" && s.hash === hash) return s.body;
  return null;
}

/** 管理画面に出す警告(外部の JS・`[[…]]` を含むスクリプト)。 */
export interface TemplateScriptWarning {
  kind: "external" | "token";
  /** external: 読み込まない JS の URL。token: スクリプトの頭(80 字)。 */
  detail: string;
}

export async function templateScriptWarnings(
  sourceHtml: string,
): Promise<TemplateScriptWarning[]> {
  const out: TemplateScriptWarning[] = [];
  for (const s of await templateScripts(sourceHtml)) {
    if (s.kind === "external") out.push({ kind: "external", detail: s.src });
    else if (s.kind === "token")
      out.push({
        kind: "token",
        detail: s.body.trim().replace(/\s+/g, " ").slice(0, 80),
      });
  }
  return out;
}
