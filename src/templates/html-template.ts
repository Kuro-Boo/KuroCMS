import type { RenderContext } from "./types";

const HTML_TEMPLATE_MARKER = "<!-- kurocms-template-api:1 -->";

// ISO 639-1 languages written right-to-left. Drives the page-level direction:
// generatePage stamps dir="rtl" on <html> for these (writing direction is a
// PAGE attribute — templates and translations stay direction-agnostic, and
// Unicode bidi handles mixed-direction runs inside the text).
const RTL_LANGS = new Set([
  "ar", // Arabic
  "dv", // Divehi
  "fa", // Persian
  "he", // Hebrew
  "ps", // Pashto
  "sd", // Sindhi
  "ug", // Uyghur
  "ur", // Urdu
  "yi", // Yiddish
]);

export function isRtlLang(lang: string): boolean {
  return RTL_LANGS.has((lang || "").toLowerCase());
}

type TemplateValue =
  | string
  | number
  | boolean
  | null
  | TemplateObject
  | TemplateValue[];
type TemplateObject = { [key: string]: TemplateValue };

type TemplateNode =
  | { type: "text"; value: string }
  | { type: "value"; path: string; raw: boolean }
  | {
      type: "section";
      mode: "if" | "unless" | "each";
      path: string;
      children: TemplateNode[];
    };

function parseJson<T>(source: string | undefined, fallback: T): T {
  if (!source) return fallback;
  try {
    return JSON.parse(source) as T;
  } catch {
    return fallback;
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value: unknown): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

function objectValue(
  value: TemplateValue | undefined,
  key: string,
): TemplateValue | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value[key];
}

function parseNodes(
  source: string,
  startIndex = 0,
  closingMode?: string,
): { nodes: TemplateNode[]; index: number } {
  const nodes: TemplateNode[] = [];
  const tokenPattern = /\[\[([^\]]+)\]\]/g;
  tokenPattern.lastIndex = startIndex;
  let cursor = startIndex;

  while (true) {
    const match = tokenPattern.exec(source);
    if (!match) {
      if (closingMode)
        throw new Error(`Unclosed template section: ${closingMode}`);
      nodes.push({ type: "text", value: source.slice(cursor) });
      return { nodes, index: source.length };
    }
    if (match.index > cursor) {
      nodes.push({ type: "text", value: source.slice(cursor, match.index) });
    }

    const expression = match[1].trim();
    if (expression.startsWith("/")) {
      const mode = expression.slice(1).trim();
      if (!closingMode || mode !== closingMode) {
        throw new Error(`Unexpected template section close: ${expression}`);
      }
      return { nodes, index: tokenPattern.lastIndex };
    }

    const sectionMatch = expression.match(/^#(if|unless|each)\s+(.+)$/);
    if (sectionMatch) {
      const mode = sectionMatch[1] as "if" | "unless" | "each";
      const parsed = parseNodes(source, tokenPattern.lastIndex, mode);
      nodes.push({
        type: "section",
        mode,
        path: sectionMatch[2].trim(),
        children: parsed.nodes,
      });
      tokenPattern.lastIndex = parsed.index;
      cursor = parsed.index;
      continue;
    }

    const raw = expression.startsWith("html:");
    const path = raw
      ? expression.slice("html:".length).trim()
      : expression.startsWith("value:")
        ? expression.slice("value:".length).trim()
        : expression;
    nodes.push({ type: "value", path, raw });
    cursor = tokenPattern.lastIndex;
  }
}

function resolvePath(
  scopes: TemplateValue[],
  path: string,
): TemplateValue | undefined {
  if (path === "." || path === "this") return scopes[scopes.length - 1];
  const parts = path.split(".").filter(Boolean);
  for (let i = scopes.length - 1; i >= 0; i--) {
    let value: TemplateValue | undefined = scopes[i];
    let found = true;
    for (const part of parts) {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        !(part in value)
      ) {
        found = false;
        break;
      }
      value = value[part];
    }
    if (found) return value;
  }
  return undefined;
}

function scopedPublishAt(scopes: TemplateValue[], path: string): string | null {
  const datePath = path.split(".").pop() || "";
  if (!["date", "dateDay", "dateYm", "dateWeekday"].includes(datePath))
    return null;

  if (path.startsWith("article.")) {
    const root = scopes[0];
    const article = objectValue(root, "article");
    const publishAt = objectValue(article, "publishAt");
    return typeof publishAt === "string" && publishAt ? publishAt : null;
  }

  for (let i = scopes.length - 1; i >= 0; i--) {
    const publishAt = objectValue(scopes[i], "publishAt");
    if (typeof publishAt === "string" && publishAt) return publishAt;
  }
  return null;
}

function localDateTimeHtml(
  path: string,
  publishAt: string,
  fallback: TemplateValue | undefined,
): string {
  const format = path.split(".").pop() || "date";
  return (
    `<time data-kuro-local-date="${escapeAttr(publishAt)}" ` +
    `data-kuro-date-format="${escapeAttr(format)}" ` +
    `datetime="${escapeAttr(publishAt)}">${escapeHtml(fallback ?? "")}</time>`
  );
}

function localDateHydrationScript(): string {
  return `<script>(function(){function z(n){return String(n).padStart(2,"0")}function fmt(iso,kind){var d=new Date(iso);if(!isFinite(d.getTime()))return"";var loc=(navigator.languages&&navigator.languages[0])||navigator.language||document.documentElement.lang||undefined;if(kind==="dateDay")return String(d.getDate());if(kind==="dateYm")return new Intl.DateTimeFormat(loc,{year:"numeric",month:"long"}).format(d);if(kind==="dateWeekday")return new Intl.DateTimeFormat(loc,{weekday:"short"}).format(d);try{return new Intl.DateTimeFormat(loc,{year:"numeric",month:"2-digit",day:"2-digit"}).format(d)}catch(e){return d.getFullYear()+"-"+z(d.getMonth()+1)+"-"+z(d.getDate())}}function run(){document.querySelectorAll("time[data-kuro-local-date]").forEach(function(el){var v=fmt(el.getAttribute("data-kuro-local-date")||"",el.getAttribute("data-kuro-date-format")||"date");if(v)el.textContent=v})}if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",run);else run()})();</script>`;
}

function injectLocalDateHydration(html: string): string {
  if (!html.includes("data-kuro-local-date")) return html;
  const script = localDateHydrationScript();
  return html.includes("</body>")
    ? html.replace("</body>", script + "</body>")
    : html + script;
}

function isTruthy(value: TemplateValue | undefined): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

function renderNodes(nodes: TemplateNode[], scopes: TemplateValue[]): string {
  return nodes
    .map((node) => {
      if (node.type === "text") return node.value;
      if (node.type === "value") {
        const value = resolvePath(scopes, node.path);
        if (value === undefined || value === null) return "";
        if (typeof value === "object") return "";
        const publishAt = scopedPublishAt(scopes, node.path);
        if (!node.raw && publishAt)
          return localDateTimeHtml(node.path, publishAt, value);
        return node.raw ? String(value) : escapeHtml(value);
      }

      const value = resolvePath(scopes, node.path);
      if (node.mode === "each") {
        if (!Array.isArray(value)) return "";
        return value
          .map((item) => renderNodes(node.children, [...scopes, item]))
          .join("");
      }
      const shouldRender =
        node.mode === "if" ? isTruthy(value) : !isTruthy(value);
      return shouldRender ? renderNodes(node.children, scopes) : "";
    })
    .join("");
}

function buildTemplateModel(ctx: RenderContext): TemplateObject {
  const articles = parseJson<TemplateValue[]>(ctx.content["_articles"], []);
  const types = parseJson<TemplateValue[]>(ctx.content["_nav-types"], []);
  const categories = parseJson<TemplateValue[]>(
    ctx.content["_nav-categories"],
    [],
  );
  const articleCategories = parseJson<TemplateValue[]>(
    ctx.content["_article-categories"],
    [],
  );
  const pagination = parseJson<TemplateObject | null>(
    ctx.content["_pagination"],
    null,
  );
  // Pre-rendered <select> archive switcher (latest + completed months). Output
  // raw via [[html:archives]]; empty string when there is nothing to switch.
  const archives = ctx.content["_archives-html"] || "";
  const content = Object.fromEntries(
    Object.entries(ctx.content)
      .filter(([key]) => !key.startsWith("_"))
      .map(([key, value]) => [key, value]),
  );

  const isAbout = ctx.path === "/about" || ctx.path === "/about/";
  // Dedicated legal pages (privacy policy / terms of service), rendered from
  // the `privacy` / `terms` site texts — same standalone-page shape as About.
  const isPrivacy = ctx.path === "/privacy" || ctx.path === "/privacy/";
  const isTerms = ctx.path === "/terms" || ctx.path === "/terms/";
  return {
    page: {
      path: ctx.path,
      // isHome must exclude the standalone pages (About/Privacy/Terms): they
      // have no article/type/category params, so without this guard the home
      // block would also render on them.
      isHome:
        !isAbout &&
        !isPrivacy &&
        !isTerms &&
        !ctx.article &&
        !ctx.params.type &&
        !ctx.params.category,
      isAbout,
      isPrivacy,
      isTerms,
      isArticle: Boolean(ctx.article),
      isType: Boolean(ctx.params.type && !ctx.article),
      isCategory: Boolean(ctx.params.category),
    },
    site: {
      name: ctx.content["_site-name"] || "",
      lang: ctx.lang,
      // "rtl" / "ltr" — for templates that want direction-aware markup. The
      // page-level <html dir> is injected by the core regardless (generatePage).
      dir: isRtlLang(ctx.lang) ? "rtl" : "ltr",
      basePath: ctx.basePath,
    },
    content,
    navigation: { types, categories },
    articles,
    article: ctx.article
      ? {
          ...ctx.article,
          categories: articleCategories,
        }
      : null,
    pagination,
    archives,
    type: {
      id: ctx.params.type || "",
      name: ctx.content["_type-name"] || ctx.params.type || "",
    },
    category: {
      id: ctx.params.category || "",
      name: ctx.content["_category-name"] || ctx.params.category || "",
    },
    integrations: {
      blueskyHandle: ctx.content["_bluesky-handle"] || "",
      // showBlueskyFeed was retired with the settings feed toggle: feed
      // placement is template-driven via the [[sid]] tokens (spec §12).
      // Templates still referencing it resolve to empty/false harmlessly.
    },
  };
}

export function isKuroCmsHtmlTemplate(
  source: string | null | undefined,
): boolean {
  return Boolean(source?.trimStart().startsWith(HTML_TEMPLATE_MARKER));
}

export function renderTemplate(source: string, ctx: RenderContext): string {
  if (!isKuroCmsHtmlTemplate(source)) {
    throw new Error("HTML template marker is missing");
  }
  const parsed = parseNodes(source);
  return injectLocalDateHydration(
    renderNodes(parsed.nodes, [buildTemplateModel(ctx)]),
  );
}
