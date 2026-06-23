// Self-hosted web-font runtime.
//
// Fonts chosen in the admin "Font Management" tab are delivered from Google
// Fonts but served from KuroCMS so the published site never depends on Google at
// view time. To stay within Worker subrequest limits (a single JP font is split
// into ~250 unicode-range woff2 subsets) we do NOT bulk-download on add:
//
//   1. ingestFont(): fetch only the small Google CSS, rewrite every
//      `src: url(...gstatic...woff2)` to a `{base}/_fonts/<key>.woff2` URL whose
//      <key> base64url-encodes the original gstatic path, and cache the rewritten
//      CSS in KV (`fontcss:<family>`). One subrequest, no binaries.
//   2. serveFont(): lazy read-through cache. The browser only requests the few
//      subsets the page text actually uses; each is fetched once from gstatic and
//      stored in KV (`fontbin:<key>`, immutable), then served from KV forever.
//
// Per-value KV size is tiny (one subset ≈ 50–80 KB), well under the 25 MiB limit.

import { familyStack, findSystemFont } from "./templates/font-catalog";
import type { Env } from "./types";

const GSTATIC_ORIGIN = "https://fonts.gstatic.com";
const FONT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
// Placeholder for the admin-asset base path; resolved at injection time so the
// same cached CSS works regardless of where the worker is mounted.
const BASE_TOKEN = "__FONT_BASE__";

export interface LoadedFont {
  family: string;
  weights: number[];
}

// ─── base64url helpers (gstatic paths are ASCII) ──────────────────────────────

function encodeKey(path: string): string {
  return btoa(path).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeKey(key: string): string | null {
  try {
    const b64 = key.replace(/-/g, "+").replace(/_/g, "/");
    return atob(b64);
  } catch {
    return null;
  }
}

// ─── Ingestion (admin save) ───────────────────────────────────────────────────

/**
 * Fetch the Google Fonts CSS for `family` at the given weights, rewrite the
 * woff2 src URLs to the self-hosted `/_fonts/` endpoint, and cache the CSS in KV.
 * Idempotent: re-running overwrites the cached CSS. Throws on a non-OK fetch so
 * the caller can surface the failure.
 */
export async function ingestFont(
  env: Env,
  family: string,
  weights: number[],
): Promise<void> {
  const wght = (weights.length ? weights : [400])
    .slice()
    .sort((a, b) => a - b)
    .join(";");
  const url =
    "https://fonts.googleapis.com/css2?family=" +
    encodeURIComponent(family).replace(/%20/g, "+") +
    ":wght@" +
    wght +
    "&display=swap";
  const res = await fetch(url, { headers: { "user-agent": FONT_UA } });
  if (!res.ok) {
    throw new Error(
      `Google Fonts CSS fetch failed for "${family}" (${res.status})`,
    );
  }
  const css = await res.text();
  const rewritten = rewriteFontCss(css);
  await env.PUBLIC_PAGES.put(fontCssKey(family), rewritten);
}

/** Replace gstatic woff2 URLs with self-hosted, base-relative URLs. */
function rewriteFontCss(css: string): string {
  const re = new RegExp(
    "https://fonts\\.gstatic\\.com(/[^)\\s\"']+\\.woff2)",
    "g",
  );
  return css.replace(
    re,
    (_m, path) => `${BASE_TOKEN}/_fonts/${encodeKey(path)}.woff2`,
  );
}

function fontCssKey(family: string): string {
  return "fontcss:" + family;
}

export async function removeFontCss(env: Env, family: string): Promise<void> {
  await env.PUBLIC_PAGES.delete(fontCssKey(family));
}

// ─── Serving (read-through cache) ─────────────────────────────────────────────

/**
 * Serve `/_fonts/<key>.woff2`. Returns the cached binary from KV, or fetches it
 * once from gstatic (limited to the font CDN — the key only encodes a path),
 * caches it via waitUntil, and returns it.
 */
export async function serveFont(
  file: string,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const key = file.replace(/\.woff2$/, "").split("?")[0];
  const path = decodeKey(key);
  // Only allow gstatic font subset paths — prevents the read-through fetch from
  // being abused as an open proxy.
  if (!path || !path.startsWith("/s/") || !path.endsWith(".woff2")) {
    return new Response("Not found", { status: 404 });
  }
  const cacheKey = "fontbin:" + key;
  const cached = await env.PUBLIC_PAGES.get(cacheKey, "arrayBuffer");
  if (cached) return woff2Response(cached);

  const upstream = await fetch(GSTATIC_ORIGIN + path, {
    headers: { "user-agent": FONT_UA },
  });
  if (!upstream.ok) return new Response("Not found", { status: 404 });
  const buf = await upstream.arrayBuffer();
  // Immutable subset — cache forever. expirationTtl omitted = no expiry.
  ctx.waitUntil(env.PUBLIC_PAGES.put(cacheKey, buf));
  return woff2Response(buf);
}

function woff2Response(body: ArrayBuffer): Response {
  return new Response(body, {
    headers: {
      "content-type": "font/woff2",
      "cache-control": "public, max-age=31536000, immutable",
      "access-control-allow-origin": "*",
    },
  });
}

// ─── Head injection (public render) ───────────────────────────────────────────

/**
 * Build the <head> markup injected into every published page:
 *   - a Google Fonts <link> loading every selected family + weights. For now we
 *     deliver fonts directly from the Google CDN (the KV self-host path above
 *     stays in place for a later switch).
 *   - a forceful `font-family` override that applies the chosen base font to ALL
 *     site text (article body, site-text content, headings, etc.). It uses
 *     `!important` and a broad selector so it wins over the template's and
 *     ke-content.css's own font rules — that is the whole point of a site-wide
 *     base font. Monospace and icon-font elements are excluded so code blocks and
 *     icon fonts keep their typeface.
 */
export function buildFontHead(fonts: LoadedFont[], baseFont: string): string {
  let out = "";

  if (fonts.length) {
    const fams = fonts
      .map((f) => {
        const w = (f.weights && f.weights.length ? f.weights : [400, 700])
          .slice()
          .sort((a, b) => a - b)
          .join(";");
        return (
          "family=" +
          encodeURIComponent(f.family).replace(/%20/g, "+") +
          ":wght@" +
          w
        );
      })
      .join("&");
    out +=
      '<link rel="preconnect" href="https://fonts.googleapis.com">' +
      '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?' +
      fams +
      '&display=swap">';
  }

  const stack = resolveBaseStack(baseFont);
  if (stack) out += baseFontStyle(stack);
  return out;
}

/**
 * Site-wide base font as a TEMPLATE-PRIORITY default.
 *
 * Wrapped in :where() so the rule carries ZERO specificity: any font-family the
 * active template declares (on a class, element, or utility selector) always wins
 * via the normal cascade, while every element the template leaves unstyled
 * inherits this font. Form controls don't inherit font-family from UA styles, so
 * they're named explicitly. No !important — we no longer override the template.
 */
function baseFontStyle(stack: string): string {
  return (
    '<style id="kuro-base-font">' +
    ":where(html body,button,input,select,textarea,optgroup){font-family:" +
    stack +
    "}" +
    "</style>"
  );
}

function resolveBaseStack(baseFont: string): string {
  if (!baseFont) return "";
  const sys = findSystemFont(baseFont);
  if (sys) return sys.stack;
  return familyStack(baseFont);
}
