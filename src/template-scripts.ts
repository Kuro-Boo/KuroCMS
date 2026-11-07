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
 *   属性のハンドラー(`onclick="…"` など) → 要素には `data-kt-on` の印だけを残し、中身を 1 つのファイルへ
 *                                    まとめる。ファイルは </body> の直前で読み、印の要素に addEventListener で
 *                                    付け直す(`this` は要素・`event` が使える・`return false` で既定の動きを止める
 *                                    —— 属性に書いたときと同じ)。`[[…]]` を含むものは移せない(警告する)。
 *                                    2026-11-06・課題 dffbd3ff: entamy.com の携帯のメニューが onclick で開いていた
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

// ── 属性のハンドラー ─────────────────────────────────────────────────────

/** 開きタグ(属性の値の中の `>` で切れないように、引用符の中を読み飛ばす)。 */
const OPEN_TAG_RE =
  /<([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)(\s*\/?)>/g;
/** 属性の 1 つ。 */
const ATTR_RE = /(\s+)([^\s"'>/=]+)(?:(\s*=\s*)("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
/** 中を読まない区間(スクリプト・スタイル・注記・textarea)。 */
const SKIP_RE =
  /<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>|<!--[\s\S]*?-->|<textarea\b[\s\S]*?<\/textarea\s*>/gi;
/** 移した印を付ける属性。 */
export const HANDLER_MARK = "data-kt-on";

function unquote(v: string): string {
  return v.startsWith('"') || v.startsWith("'") ? v.slice(1, -1) : v;
}

/** 属性の値の文字参照を戻す(JS の中身にする)。 */
function decodeAttr(v: string): string {
  return v.replace(
    /&(#x[0-9a-f]+|#\d+|quot|apos|amp|lt|gt);/gi,
    (m, e: string) => {
      const k = e.toLowerCase();
      if (k === "quot") return '"';
      if (k === "apos") return "'";
      if (k === "amp") return "&";
      if (k === "lt") return "<";
      if (k === "gt") return ">";
      const n = k.startsWith("#x")
        ? parseInt(k.slice(2), 16)
        : parseInt(k.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    },
  );
}

interface HandlerScan {
  /** 印を付けた HTML。 */
  html: string;
  /** 移したハンドラー(印の番号 → [出来事, 中身])。 */
  handlers: Array<Array<[string, string]>>;
  /** 移せなかったもの(`[[…]]` を含む)。 */
  tokens: string[];
}

/** 属性のハンドラーを探して印に替える。中を読まない区間には触らない。 */
function scanHandlers(sourceHtml: string): HandlerScan {
  const handlers: Array<Array<[string, string]>> = [];
  const tokens: string[] = [];
  const rewriteTags = (chunk: string) =>
    chunk.replace(
      OPEN_TAG_RE,
      (whole, tag: string, attrs: string, close: string) => {
        if (!/\son[a-z]+\s*=/i.test(attrs)) return whole;
        const moved: Array<[string, string]> = [];
        const kept = attrs.replace(
          ATTR_RE,
          (a, sp: string, name: string, _eq?: string, value?: string) => {
            if (!/^on[a-z]+$/i.test(name) || value === undefined) return a;
            const code = decodeAttr(unquote(value));
            if (code.includes("[[")) {
              tokens.push(code.trim().replace(/\s+/g, " ").slice(0, 80));
              return a;
            }
            moved.push([name.slice(2).toLowerCase(), code]);
            return "";
          },
        );
        if (!moved.length) return whole;
        handlers.push(moved);
        return `<${tag}${kept} ${HANDLER_MARK}="${handlers.length - 1}"${close}>`;
      },
    );
  let html = "";
  let at = 0;
  for (const m of sourceHtml.matchAll(SKIP_RE)) {
    html += rewriteTags(sourceHtml.slice(at, m.index)) + m[0];
    at = m.index! + m[0].length;
  }
  html += rewriteTags(sourceHtml.slice(at));
  return { html, handlers, tokens };
}

/** 移したハンドラーを付け直すファイルの中身。無ければ null。 */
function handlerScript(
  handlers: Array<Array<[string, string]>>,
): string | null {
  if (!handlers.length) return null;
  const table = handlers
    .map(
      (list, i) =>
        `${JSON.stringify(String(i))}:[` +
        list
          .map(
            ([ev, code]) =>
              `[${JSON.stringify(ev)},function(event){\n${code}\n}]`,
          )
          .join(",") +
        "]",
    )
    .join(",\n");
  return (
    "// テンプレートの属性のハンドラー(KuroCMS が公開ページ用に移した・template-scripts.ts)\n" +
    "(function(){var H={" +
    table +
    '};\nfunction bind(){document.querySelectorAll("[' +
    HANDLER_MARK +
    ']").forEach(function(el){(H[el.getAttribute("' +
    HANDLER_MARK +
    '")]||[]).forEach(function(h){el.addEventListener(h[0],function(e){if(h[1].call(this,e)===false)e.preventDefault();});});});}\n' +
    'if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",bind);else bind();})();\n'
  );
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
  const scan = scanHandlers(sourceHtml);
  const moved = handlerScript(scan.handlers);
  let html = await externalizeScriptTags(scan.html, templateId, publicBase);
  if (moved) {
    const tag = `<script src="${templateScriptPath(publicBase, templateId, await scriptHash(moved))}"></script>`;
    const end = html.search(/<\/body\s*>/i);
    html = end < 0 ? html + tag : html.slice(0, end) + tag + html.slice(end);
  }
  return html;
}

async function externalizeScriptTags(
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

/** 属性のハンドラーをまとめたファイル(静的資産に置く・public.ts)。ハンドラーが無ければ null。 */
export async function templateHandlerScript(
  sourceHtml: string,
): Promise<{ hash: string; body: string } | null> {
  const body = handlerScript(scanHandlers(sourceHtml).handlers);
  return body ? { hash: await scriptHash(body), body } : null;
}

/** `/_tjs/{id}.{hash}.js` の中身(テンプレートの HTML から引き当てる)。無ければ null。 */
export async function templateScriptBody(
  sourceHtml: string,
  hash: string,
): Promise<string | null> {
  for (const s of await templateScripts(sourceHtml))
    if (s.kind === "inline" && s.hash === hash) return s.body;
  const moved = handlerScript(scanHandlers(sourceHtml).handlers);
  if (moved && (await scriptHash(moved)) === hash) return moved;
  return null;
}

/** 管理画面に出す警告(外部の JS・`[[…]]` を含むスクリプト)。 */
export interface TemplateScriptWarning {
  kind: "external" | "token" | "handler_token";
  /** external: 読み込まない JS の URL。token / handler_token: スクリプト・属性のハンドラーの頭(80 字)。 */
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
  for (const detail of scanHandlers(sourceHtml).tokens)
    out.push({ kind: "handler_token", detail });
  return out;
}
