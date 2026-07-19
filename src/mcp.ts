// KuroCMS MCP server — a minimal, stateless Streamable-HTTP transport at
// POST /api/mcp. JSON-RPC 2.0 in, JSON-RPC 2.0 out (no SSE/sessions — there are
// no server-initiated messages). Each tool is a THIN wrapper: it builds an
// internal Request to the existing REST routes and dispatches it through
// handleApi(), so routing, auth, validation, and every handler are reused with
// zero duplication. Auth = the existing PAT (Authorization: Bearer kuro_<token>).
import { requireAuth } from "./auth";
import { handleApi, KUROCMS_VERSION } from "./api";
import type { Env } from "./types";

const PROTOCOL_VERSION = "2025-06-18";

const mcpHeaders = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST,OPTIONS",
  "access-control-allow-headers":
    "content-type,authorization,mcp-protocol-version",
};

type RestSpec = { method: string; path: string; body?: unknown };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  // Map validated tool arguments to an internal REST request.
  build: (args: Record<string, unknown>) => RestSpec;
}

const str = (a: Record<string, unknown>, k: string): string =>
  typeof a[k] === "string" ? (a[k] as string) : "";
const seg = (a: Record<string, unknown>, k: string): string =>
  encodeURIComponent(str(a, k));
// Forward only the provided keys so REST upserts keep omitted fields intact.
const pick = (
  a: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (a[k] !== undefined) out[k] = a[k];
  return out;
};

// Reusable schema fragments.
const ID = {
  type: "string",
  description:
    "Article identifier — the did (doc_<hex>) OR the globally-unique slug. Pass a slug from list_articles straight through; no lookup step is needed.",
};
const LANG = { type: "string", description: "Language code, e.g. ja, en." };

const TOOLS: ToolDef[] = [
  {
    name: "list_articles",
    description:
      "Enumerate articles (newest first, up to 1000). Each entry carries the article's slug (the id you pass to every other tool), tid, title, initial_lang, languages (CSV of the langs that have a translation) and timestamps — no bodies. " +
      "Optional q (slug/title substring). Optional lang picks the display-title language.",
    inputSchema: {
      type: "object",
      properties: {
        q: {
          type: "string",
          description: "Search slug/title (partial match).",
        },
        lang: {
          type: "string",
          description: "Display-title language.",
        },
      },
    },
    build: (a) => {
      const qs = new URLSearchParams();
      if (str(a, "q")) qs.set("q", str(a, "q"));
      if (str(a, "lang")) qs.set("lang", str(a, "lang"));
      const q = qs.toString();
      return {
        method: "GET",
        path: "/api/documents" + (q ? `?${q}` : ""),
      };
    },
  },
  {
    name: "get_article",
    description:
      "Get one article (document fields + the list of its translations). " +
      "Translation bodyHtml may carry data-bid attributes on top-level elements: " +
      "they are stable block ids used for 3-way merging. Treat them as opaque and " +
      "preserve them verbatim when sending an edited body back via update_article_body.",
    inputSchema: { type: "object", properties: { id: ID }, required: ["id"] },
    build: (a) => ({ method: "GET", path: `/api/documents/${seg(a, "id")}` }),
  },
  {
    name: "create_article",
    description:
      "Create a NEW article shell (draft). slug is globally unique — an existing slug returns 409; add the body afterwards with update_article_body.",
    inputSchema: {
      type: "object",
      properties: {
        tid: {
          type: "string",
          description: "Registered type id (e.g. blog, news).",
        },
        slug: {
          type: "string",
          description:
            "lowercase a-z0-9-, globally unique, not starting with doc_.",
        },
        initialLang: {
          type: "string",
          description: "Base language code (2-20 chars).",
        },
        fallbackLang: { type: "string" },
        publishAt: { type: "string", description: "ISO 8601." },
        unpublishAt: { type: "string", description: "ISO 8601." },
      },
      required: ["tid", "slug", "initialLang"],
    },
    build: (a) => ({
      method: "POST",
      path: "/api/documents",
      body: pick(a, [
        "tid",
        "slug",
        "initialLang",
        "fallbackLang",
        "publishAt",
        "unpublishAt",
      ]),
    }),
  },
  {
    name: "update_article_body",
    description:
      "Upsert the body of an article in a specific language (title + bodyHtml required). :lang is mandatory — content is never written to the base language by default. " +
      "This is also how you ADD a translation: call it with a new lang and that language auto-registers (no separate step). Editing the base-language text means passing the article's initialLang as lang. " +
      "When editing an existing body, keep the data-bid attribute of every top-level element you did not add (unchanged AND edited blocks alike — data-bid is a stable block id used for 3-way merging, not a content hash). " +
      "Never invent or renumber data-bid values; leave them off blocks you newly insert.",
    inputSchema: {
      type: "object",
      properties: {
        id: ID,
        lang: LANG,
        title: { type: "string", description: "1-240 chars." },
        bodyHtml: {
          type: "string",
          description:
            "Article body HTML (>=1 char). Preserve existing data-bid attributes " +
            "on top-level elements; omit them on newly added blocks.",
        },
        summary: { type: "string", description: "<=200 chars." },
        seo: {
          type: "object",
          description: "SEO object (e.g. { coverPath }).",
        },
        hashtags: { type: "array", items: { type: "string" } },
      },
      required: ["id", "lang", "title", "bodyHtml"],
    },
    build: (a) => ({
      method: "PUT",
      path: `/api/documents/${seg(a, "id")}/translations/${seg(a, "lang")}`,
      body: pick(a, ["title", "bodyHtml", "summary", "seo", "hashtags"]),
    }),
  },
  {
    name: "set_article_status",
    description:
      "Set publish state. mode: 0=draft, 1=published, 2=hidden. Publishing/unpublishing triggers a background build. Omitted publishAt/unpublishAt/tid keep their stored values. tid moves the article to another registered type (its public URL changes; old pages are cleaned up automatically).",
    inputSchema: {
      type: "object",
      properties: {
        id: ID,
        mode: { type: "integer", enum: [0, 1, 2] },
        publishAt: { type: "string", description: "ISO 8601." },
        unpublishAt: { type: "string", description: "ISO 8601." },
        tid: {
          type: "string",
          description: "Registered type id to move the article to.",
        },
      },
      required: ["id", "mode"],
    },
    build: (a) => ({
      method: "PUT",
      path: `/api/documents/${seg(a, "id")}`,
      body: pick(a, ["mode", "publishAt", "unpublishAt", "tid"]),
    }),
  },
  {
    name: "set_article_categories",
    description:
      "Replace the article's categories with the given list of category ids.",
    inputSchema: {
      type: "object",
      properties: {
        id: ID,
        categories: { type: "array", items: { type: "string" } },
      },
      required: ["id", "categories"],
    },
    build: (a) => ({
      method: "PUT",
      path: `/api/documents/${seg(a, "id")}/categories`,
      body: pick(a, ["categories"]),
    }),
  },
  {
    name: "delete_translation",
    description:
      "Delete one language's translation of an article. The base language cannot be deleted alone.",
    inputSchema: {
      type: "object",
      properties: { id: ID, lang: LANG },
      required: ["id", "lang"],
    },
    build: (a) => ({
      method: "DELETE",
      path: `/api/documents/${seg(a, "id")}/translations/${seg(a, "lang")}`,
    }),
  },
  {
    name: "delete_article",
    description:
      "Delete a whole article (all translations). Requires an Admin token.",
    inputSchema: { type: "object", properties: { id: ID }, required: ["id"] },
    build: (a) => ({
      method: "DELETE",
      path: `/api/documents/${seg(a, "id")}`,
    }),
  },
  {
    name: "list_types",
    description: "List article types.",
    inputSchema: { type: "object", properties: {} },
    build: () => ({ method: "GET", path: "/api/types" }),
  },
  {
    name: "list_categories",
    description: "List categories.",
    inputSchema: { type: "object", properties: {} },
    build: () => ({ method: "GET", path: "/api/categories" }),
  },
  {
    name: "list_site_text",
    description:
      "List the site's FIXED content blocks (footer, hero, about, logo, favicon, etc.) — the admin 'サイト文字編集' site text, SEPARATE from articles. Returns each block's key (id, e.g. footer-text, top-hero-title) and its value for the given language, plus is_inherited (1 = no own value in this language, falls back to the default language). Values are KuroEditor HTML and may contain [[mid]] media refs. Edit a value with update_site_text.",
    inputSchema: {
      type: "object",
      properties: {
        lang: { type: "string", description: "Language code, e.g. ja, en." },
      },
      required: ["lang"],
    },
    build: (a) => ({
      method: "GET",
      path: `/api/v1/content?lang=${encodeURIComponent(str(a, "lang"))}`,
    }),
  },
  {
    name: "update_site_text",
    description:
      "Set one site-text block's value for one language (Admin token). id is a key from list_site_text (e.g. footer-text). value is KuroEditor HTML — it may be empty to blank the block; preserve any [[mid]] media refs. Repeat per language for multilingual text. Site-text edits do NOT auto-publish — call build_site afterwards to reflect them.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Site-text key, e.g. footer-text." },
        lang: LANG,
        value: {
          type: "string",
          description:
            "KuroEditor HTML value; may be empty to blank the block.",
        },
      },
      required: ["id", "lang", "value"],
    },
    build: (a) => ({
      method: "PUT",
      path: `/api/v1/content/${seg(a, "id")}/translations/${seg(a, "lang")}`,
      body: { name: str(a, "value") },
    }),
  },
  {
    name: "build_site",
    description:
      "Rebuild the public site (incremental — unchanged pages skip). One pass per call.",
    inputSchema: {
      type: "object",
      properties: {
        lang: {
          type: "string",
          description: "Build language (defaults to base).",
        },
      },
    },
    build: (a) => ({
      method: "POST",
      path: "/api/build",
      body: pick(a, ["lang"]),
    }),
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

type Json = Record<string, unknown>;

function rpcResult(id: unknown, result: unknown): Json {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function rpcError(id: unknown, code: number, message: string): Json {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/** Run a tool by dispatching an internal REST request through handleApi. */
async function callTool(
  name: string,
  args: Record<string, unknown>,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Json> {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool)
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  const spec = tool.build(args || {});
  const internalUrl = new URL(spec.path, request.url).toString();
  const headers = new Headers({ "content-type": "application/json" });
  const auth = request.headers.get("authorization");
  if (auth) headers.set("authorization", auth);
  const internalReq = new Request(internalUrl, {
    method: spec.method,
    headers,
    body: spec.body !== undefined ? JSON.stringify(spec.body) : undefined,
  });
  const res = await handleApi(internalReq, env, ctx);
  const text = await res.text();
  return { content: [{ type: "text", text }], isError: !res.ok };
}

async function dispatchRpc(
  msg: Json,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Json | null> {
  const { id, method, params } = msg as {
    id?: unknown;
    method?: string;
    params?: Json;
  };
  // Notifications (no id) get no response body.
  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion:
          (params?.protocolVersion as string) || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "KuroCMS", version: KUROCMS_VERSION },
      });
    case "notifications/initialized":
      return null; // notification — no reply
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    case "tools/call": {
      const name = (params?.name as string) || "";
      const args = (params?.arguments as Record<string, unknown>) || {};
      return rpcResult(id, await callTool(name, args, request, env, ctx));
    }
    default:
      if (id === undefined) return null; // unknown notification
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** Streamable-HTTP MCP endpoint. */
export async function handleMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: mcpHeaders });
  }
  if (request.method !== "POST") {
    // No server→client stream in this stateless server.
    return new Response("Method Not Allowed", {
      status: 405,
      headers: mcpHeaders,
    });
  }

  // Transport-level auth: the same PAT as the REST API. Reject up front so MCP
  // clients are prompted to provide a token.
  try {
    await requireAuth(env, request);
  } catch {
    return new Response(
      JSON.stringify(rpcError(null, -32001, "Authentication required.")),
      {
        status: 401,
        headers: {
          ...mcpHeaders,
          "www-authenticate": 'Bearer realm="KuroCMS"',
        },
      },
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return new Response(JSON.stringify(rpcError(null, -32700, "Parse error")), {
      headers: mcpHeaders,
    });
  }

  // Support a single request or a batch array.
  if (Array.isArray(payload)) {
    const out: Json[] = [];
    for (const m of payload) {
      const r = await dispatchRpc(m as Json, request, env, ctx);
      if (r) out.push(r);
    }
    return new Response(out.length ? JSON.stringify(out) : null, {
      status: out.length ? 200 : 202,
      headers: mcpHeaders,
    });
  }

  const result = await dispatchRpc(payload as Json, request, env, ctx);
  if (!result) {
    return new Response(null, { status: 202, headers: mcpHeaders });
  }
  return new Response(JSON.stringify(result), { headers: mcpHeaders });
}
