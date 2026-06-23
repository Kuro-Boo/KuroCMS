// Serves the externalized admin assets (admin-app.<hash>.js, ke.<ver>.{js,css}) that
// are NOT bundled into worker.js. Source of truth at runtime:
//   1) Cache API (edge)  2) KV PUBLIC_PAGES  3) ASSETS (local dev)  4) GitHub release.
// Hashed filenames are immutable, so everything is cached aggressively.
// NOTE: lives at src/ root (a Worker module). src/admin/** is browser-only (tsconfig.admin.json).
import { KUROCMS_VERSION } from "./api";
import type { Env } from "./types";

// Version-pinned release base. NOT `latest/download` — that path is CDN-stale.
const RELEASE_BASE = `https://github.com/Kuro-Boo/KuroCMS-releases/releases/download/v${KUROCMS_VERSION}`;
const ASSET_RE = /^(admin-app|ke|ke-content)\.[a-z0-9.]+\.(js|css)$/;
const KV_PREFIX = "admin:asset:";
const IMMUTABLE = "public, max-age=31536000, immutable";

function contentType(filename: string): string {
  return filename.endsWith(".css")
    ? "text/css; charset=utf-8"
    : "text/javascript; charset=utf-8";
}

function assetResponse(body: BodyInit, filename: string): Response {
  return new Response(body, {
    headers: {
      "content-type": contentType(filename),
      "cache-control": IMMUTABLE,
    },
  });
}

// Fetch with retry on transient errors (connection/timeout/5xx/429). Respects Retry-After.
async function fetchWithRetry(url: string, max = 3): Promise<Response | null> {
  for (let attempt = 0; attempt <= max; attempt++) {
    if (attempt > 0) {
      const backoff =
        Math.min(4000, 500 * 2 ** (attempt - 1)) + Math.random() * 250;
      await new Promise((r) => setTimeout(r, backoff));
    }
    try {
      const res = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) return res;
      // permanent client errors (except 429) → give up
      if (res.status >= 400 && res.status < 500 && res.status !== 429)
        return null;
      // transient (429 / 5xx): honor Retry-After before next attempt
      const ra = Number(res.headers.get("retry-after"));
      if (Number.isFinite(ra) && ra > 0) {
        await new Promise((r) => setTimeout(r, Math.min(8000, ra * 1000)));
      }
    } catch {
      /* network / timeout → retry */
    }
  }
  return null;
}

export async function serveAdminAsset(
  filename: string,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!ASSET_RE.test(filename)) {
    return new Response("Not found", { status: 404 });
  }

  // 1) Edge cache (Cache API). Hashed filename = immutable, safe to cache.
  //    No-op on workers.dev; KV (below) is the effective cache there.
  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;

  const finalize = (res: Response): Response => {
    ctx.waitUntil(cache.put(request, res.clone()));
    return res;
  };

  // 2) KV (prod source of truth after first lazy-fetch).
  const kvKey = KV_PREFIX + filename;
  const fromKv = await env.PUBLIC_PAGES.get(kvKey, "arrayBuffer");
  if (fromKv) return finalize(assetResponse(fromKv, filename));

  // 3) ASSETS (local dev: public/_admin/). Installed prod workers have no ASSETS binding.
  if (env.ASSETS) {
    try {
      const assetUrl = new URL(request.url);
      assetUrl.pathname = "/_admin/" + filename;
      const res = await env.ASSETS.fetch(
        new Request(assetUrl.toString(), { method: "GET" }),
      );
      if (res.ok) {
        const buf = await res.arrayBuffer();
        ctx.waitUntil(env.PUBLIC_PAGES.put(kvKey, buf));
        return finalize(assetResponse(buf, filename));
      }
    } catch {
      /* ASSETS unavailable — fall through to release */
    }
  }

  // 4) GitHub release (version-pinned), with retry. Cache into KV on success.
  const rel = await fetchWithRetry(`${RELEASE_BASE}/${filename}`);
  if (rel) {
    const buf = await rel.arrayBuffer();
    ctx.waitUntil(env.PUBLIC_PAGES.put(kvKey, buf));
    return finalize(assetResponse(buf, filename));
  }

  return new Response("Admin asset unavailable", { status: 503 });
}
