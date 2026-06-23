import { adminHtml } from "./admin-shell";
import { serveAdminAsset } from "./asset-serve";
import { serveFont } from "./fonts";
import { handleApi } from "./api";
import { html, notFound } from "./http";
import {
  buildRobotsTxt,
  buildRssXml,
  buildSitemapXml,
  handlePublicRoute,
  isPublicPath,
  resolveFaviconPath,
  runScheduledAutoBuild,
} from "./public";
import type { Env } from "./types";

export default {
  // Cron trigger: drives "公開予定記事をその時間に自動ビルド" (auto build mode).
  // Builds only when a scheduled post has actually crossed its publish/unpublish
  // time since the last run; idle ticks are a single cheap query. No-op unless
  // the persisted build mode is "auto".
  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    if (!env.PUBLIC_PAGES || !env.DB) return;
    ctx.waitUntil(
      runScheduledAutoBuild(env).catch((err) => {
        console.error("scheduled auto-build failed:", err);
      }),
    );
  },

  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const requiredBindingError = validateRequiredBindings(env);
    if (requiredBindingError) return requiredBindingError;

    const url = new URL(request.url);
    const setupRequired = await needsSetup(env);
    const initializePreview = url.searchParams.get("preview") === "1";
    const adminEntryUrl = normalizePath(
      env.ACCESS_ADMIN_URL || "/kurocms/admin",
    );
    const isLegacyAdminPath = adminEntryUrl.endsWith("/admin");
    // basePath = everything up to but not including /admin (e.g. "/test/kurocms")
    const basePath = resolveBasePath(adminEntryUrl);
    // publicBase = everything before /kurocms (e.g. "/test") — the public site root
    const publicBase = resolvePublicBase(basePath);
    const pathname = stripBasePath(url.pathname, basePath);

    // Media files: serve from R2 — check both raw path and publicBase-stripped path
    const mediaRawPath = url.pathname;
    const mediaStrippedPath =
      publicBase && mediaRawPath.startsWith(publicBase + "/")
        ? mediaRawPath.slice(publicBase.length)
        : mediaRawPath;
    if (new RegExp("^/(images|videos|audios)/").test(mediaStrippedPath)) {
      if (env.MEDIA_BUCKET) {
        const r2Key = mediaStrippedPath.replace(/^\//, "").split("?")[0];
        const obj = await env.MEDIA_BUCKET.get(r2Key);
        if (obj) {
          const headers = new Headers();
          headers.set(
            "content-type",
            obj.httpMetadata?.contentType || "application/octet-stream",
          );
          headers.set("cache-control", "public, max-age=31536000, immutable");
          headers.set("etag", obj.etag);
          headers.set("access-control-allow-origin", "*");
          return new Response(obj.body, { headers });
        }
      }
      const assetRes = await env.ASSETS.fetch(
        rewriteRequestPath(request, mediaStrippedPath),
      );
      const h = new Headers(assetRes.headers);
      h.set("access-control-allow-origin", "*");
      return new Response(assetRes.body, {
        status: assetRes.status,
        headers: h,
      });
    }

    // /initialize — setup screen (always at root /initialize, no base prefix)
    if (url.pathname.startsWith("/initialize")) {
      if (!setupRequired && !initializePreview) {
        return Response.redirect(
          new URL(adminEntryUrl, request.url).toString(),
          302,
        );
      }
      return html(
        adminHtml({
          accessAdminUrl: env.ACCESS_ADMIN_URL || "/kurocms/admin",
          base: basePath,
        }),
      );
    }

    // Public routes: / /about /blog/* /news/* — relative to publicBase
    // e.g. for publicBase="/test": /test/, /test/about, /test/blog/*, /test/news/*
    const publicPath = stripPublicBase(url.pathname, publicBase);

    // SEO / distribution endpoints — handled BEFORE isPublicPath (which doesn't
    // match `.xml`/`.txt`). Edge-cached only; never written to KV.
    if (publicPath !== null && !setupRequired) {
      const xmlHeaders = {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "public, max-age=300, s-maxage=600",
      };
      if (publicPath === "/sitemap.xml") {
        return new Response(await buildSitemapXml(env), {
          headers: xmlHeaders,
        });
      }
      if (publicPath === "/robots.txt") {
        return new Response(await buildRobotsTxt(env), {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "public, max-age=300, s-maxage=600",
          },
        });
      }
      if (publicPath === "/rss.xml") {
        return new Response(await buildRssXml(env), { headers: xmlHeaders });
      }
      // Per-type feed: /{type}-rss.xml
      const rssM = publicPath.match(
        new RegExp("^/([a-zA-Z0-9_-]+)-rss\\.xml$"),
      );
      if (rssM) {
        return new Response(await buildRssXml(env, rssM[1]), {
          headers: xmlHeaders,
        });
      }
      // Bare favicon requests → redirect to the configured icon media (if any).
      if (publicPath === "/favicon.ico" || publicPath === "/favicon.svg") {
        const fav = await resolveFaviconPath(env);
        if (fav)
          return Response.redirect(new URL(fav, request.url).toString(), 302);
        return notFound();
      }
    }

    if (publicPath !== null && isPublicPath(publicPath)) {
      if (setupRequired) {
        return Response.redirect(
          new URL("/initialize/", request.url).toString(),
          302,
        );
      }
      const publicResp = await handlePublicRoute(publicPath, request, env);
      return publicResp ?? notFound();
    }

    // Paths outside the admin basePath → 404 (unless caught as public above)
    if (!pathname) {
      return notFound();
    }

    // Externalized admin assets: {base}/_admin/<file> → KV / ASSETS / release.
    if (pathname.startsWith("/_admin/")) {
      return serveAdminAsset(
        pathname.slice("/_admin/".length),
        request,
        env,
        ctx,
      );
    }

    // Self-hosted web fonts: {base}/_fonts/<key>.woff2 → KV read-through cache.
    if (pathname.startsWith("/_fonts/")) {
      return serveFont(pathname.slice("/_fonts/".length), env, ctx);
    }

    if (pathname.startsWith("/api/")) {
      return handleApi(rewriteRequestPath(request, pathname), env, ctx);
    }

    // basePath root (e.g. /kurocms/ or /test/kurocms/) → redirect to admin
    if (pathname === "/") {
      if (setupRequired) {
        return Response.redirect(
          new URL("/initialize/", request.url).toString(),
          302,
        );
      }
      if (isLegacyAdminPath) {
        return Response.redirect(
          new URL(adminEntryUrl, request.url).toString(),
          302,
        );
      }
      return html(
        adminHtml({
          accessAdminUrl: env.ACCESS_ADMIN_URL || "/kurocms/admin",
          base: basePath,
        }),
      );
    }

    if (!isLegacyAdminPath && pathname.startsWith("/api/admin/")) {
      return handleApi(rewriteRequestPath(request, pathname), env, ctx);
    }

    if (isLegacyAdminPath && pathname.startsWith("/admin/api/")) {
      const apiPath = pathname.slice("/admin".length) || "/api/health";
      return handleApi(rewriteRequestPath(request, apiPath), env, ctx);
    }

    if (isLegacyAdminPath && pathname.startsWith("/admin")) {
      return html(
        adminHtml({
          accessAdminUrl: env.ACCESS_ADMIN_URL || "/kurocms/admin",
          base: basePath,
        }),
      );
    }

    if (!isLegacyAdminPath) {
      return html(
        adminHtml({
          accessAdminUrl: env.ACCESS_ADMIN_URL || "/kurocms/admin",
          base: basePath,
        }),
      );
    }

    return notFound();
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validateRequiredBindings(env: Env): Response | null {
  // PUBLIC_PAGES is intentionally required. Do not silently tolerate missing KV;
  // generated public pages depend on this binding for persistence and caching.
  if (!env.PUBLIC_PAGES) {
    return new Response("PUBLIC_PAGES KV binding is required.", {
      status: 500,
    });
  }
  return null;
}

async function needsSetup(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM users",
  ).first<{
    count: number;
  }>();
  return (row?.count ?? 0) === 0;
}

function normalizePath(value: string): string {
  if (!value) return "/";
  const raw = value.trim();
  if (!raw) return "/";
  try {
    return new URL(raw).pathname || "/";
  } catch {
    return raw.startsWith("/") ? raw : `/${raw}`;
  }
}

/** Returns the path up to (not including) /admin.
 *  e.g. "/test/kurocms/admin" → "/test/kurocms"
 *       "/kurocms/admin"      → "/kurocms"
 *       "/admin"              → ""
 */
function resolveBasePath(adminPath: string): string {
  const n = normalizePath(adminPath).replace(/\/+$/, "") || "/";
  if (n === "/admin") return "";
  if (n.endsWith("/admin")) return n.slice(0, -"/admin".length) || "";
  return n;
}

/** Returns the public site root (part before /kurocms in basePath).
 *  e.g. "/test/kurocms" → "/test"
 *       "/kurocms"      → ""
 *       "/cms"          → "" (no /kurocms segment — treat root as public base)
 */
function resolvePublicBase(basePath: string): string {
  const idx = basePath.lastIndexOf("/kurocms");
  if (idx > 0) return basePath.slice(0, idx);
  return "";
}

/** Strip publicBase prefix and return the path segment for public routing.
 *  Returns null if the path doesn't start with publicBase.
 *  e.g. publicBase="/test", pathname="/test/blog/x" → "/blog/x"
 *       publicBase="",      pathname="/blog/x"       → "/blog/x"
 *       publicBase="/test", pathname="/other"         → null
 */
function stripPublicBase(pathname: string, publicBase: string): string | null {
  if (!publicBase) return pathname;
  if (pathname === publicBase || pathname === publicBase + "/") return "/";
  if (pathname.startsWith(publicBase + "/"))
    return pathname.slice(publicBase.length) || "/";
  return null;
}

function stripBasePath(pathname: string, basePath: string): string | null {
  if (!basePath) return pathname;
  if (pathname === basePath) return "/";
  if (pathname.startsWith(`${basePath}/`))
    return pathname.slice(basePath.length) || "/";
  return null;
}

function rewriteRequestPath(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  return new Request(url.toString(), request);
}
