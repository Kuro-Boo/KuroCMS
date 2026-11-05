// Serves the externalized admin assets (admin-app.<hash>.js, ke.<ver>.{js,css}) that
// are NOT bundled into worker.js. Source of truth at runtime:
//   1) Cache API (edge)  2) KV PUBLIC_PAGES  3) ASSETS (local dev)  4) 配布基盤(update).
// Hashed filenames are immutable, so everything is cached aggressively.
// NOTE: lives at src/ root (a Worker module). src/admin/** is browser-only (tsconfig.admin.json).
import { KUROCMS_VERSION } from "./api";
import { releaseToken } from "./release-token";
import type { Env } from "./types";
import {
  fetchUpdateArtifact,
  fetchUpdateManifest,
  reasonOf,
} from "./release-source";
import { reportRelease } from "./release-report";

const ASSET_RE =
  /^(admin-app|ke|ke-content|kuro-links|kuro-code-copy|kuro-head|kuro-site|html2canvas)\.[a-z0-9.]+\.(js|css)$/;
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
      /* ASSETS unavailable — fall through to the distribution */
    }
  }

  // 4) 配布基盤(update)の、自分の版の成果物から取る(署名と sha256 を確かめる)。
  //    結果は Defects へ送る(release-report)。確かめの通らない管理画面の JS は配らない。
  const version = KUROCMS_VERSION.replace(/^v/, "");
  const token = releaseToken(env);
  try {
    const manifest = await fetchUpdateManifest(version, undefined, token);
    const buf = await fetchUpdateArtifact(manifest, filename, token);
    ctx.waitUntil(env.PUBLIC_PAGES.put(kvKey, buf));
    ctx.waitUntil(
      reportRelease(env, "release_update_ok", {
        what: "asset",
        version,
        asset: filename,
      }),
    );
    return finalize(assetResponse(buf, filename));
  } catch (err) {
    ctx.waitUntil(
      reportRelease(env, "release_update_failed", {
        what: "asset",
        version,
        asset: filename,
        reason: reasonOf(err),
      }),
    );
  }

  return new Response("Admin asset unavailable", { status: 503 });
}
