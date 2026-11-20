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
  type UpdateManifest,
} from "./release-source";
import { reportRelease } from "./release-report";

import {
  ASSET_RE,
  KV_PREFIX,
  ensureAssets,
  ensureOnce,
  type EnsureResult,
} from "./asset-prefill.ts";
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

  // 4) まだ KV に無い。配布基盤(update)からの取りそろえを裏で始め、この要求は待たせずに「準備中」と答える。
  //    前はここで配布基盤の返事を待っていた。返事が遅い・返らないあいだ、ブラウザは管理画面の JS を待ち続け、
  //    「Now Loading」のまま 10 分ほど固まった(2026-11-21・新しい導入)。画面の読み込み係(admin-shell.ts)は
  //    「準備中」を受けたら案内を出して頼み直す。頼み直しのたびに、取りそろえが止まっていれば始め直す。
  ctx.waitUntil(ensureOwnAdminAssets(env).catch(() => undefined));
  return new Response("Admin asset is being prepared", {
    status: 503,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "retry-after": "2",
      "x-kurocms-asset": "preparing",
    },
  });
}

/**
 * 自分の版の部品を、そろうまで取り寄せる(asset-prefill.ts の ensureAssets)。印があれば KV を 1 回読むだけ。
 * 毎分の刻み(index.ts の runMinute)・番人の migrate・部品の取りこぼしから呼ぶ。同じ isolate では 1 本にまとめる。
 */
export function ensureOwnAdminAssets(env: Env): Promise<EnsureResult> {
  const version = KUROCMS_VERSION.replace(/^v/, "");
  const token = releaseToken(env);
  return ensureOnce(version, async () => {
    let manifest: UpdateManifest | null = null;
    try {
      return await ensureAssets(
        env.PUBLIC_PAGES,
        version,
        async () =>
          (manifest = await fetchUpdateManifest(version, undefined, token)),
        {
          fetchArtifact: (name) => fetchUpdateArtifact(manifest!, name, token),
          report: (code, detail) => reportRelease(env, code, detail),
        },
      );
    } catch (err) {
      await reportRelease(env, "release_update_failed", {
        what: "asset_prefill",
        version,
        reason: reasonOf(err),
      });
      return { ready: false, filled: 0, kept: 0, failed: 1 };
    }
  });
}
