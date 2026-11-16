/**
 * 公開中の頁が使うメディアを CDN(Workers Static Assets)に置く(旗 static-404・cms-cms-media「公開のメディアは CDN」・
 * 2026-11-16 利用者「すくなからず、画像だけでも、cdn に入れるべき」「25以下ならすべて cdn に設置した方がよい」)。
 *
 * - 置けるもの: 公開中の頁が使い(page_media)、台帳(media_assets)にあり、{@link MEDIA_ASSET_MAX} 以下で、SVG でないもの。
 *   SVG は資産として名乗りどおりに返ると、直に開いたときにスクリプトが動く(Worker は octet-stream で返している)。
 * - 置けないものは、公開の頁の中だけ `/_media/…` を指す(Worker が先に受け、R2 から返す・run_worker_first)。
 * - 公開の頁の画像には `?v=` でビルドの版を付ける(利用者「?v= でビルドバージョンをすべての画像につける」)。
 *   版が変われば URL が変わり、ブラウザが覚えた古い応答(壊れていた間の 404 など)を使わない。台帳の版
 *   (cache_version)が付いていれば、その後ろに足す。
 *
 * 1 ファイルの上限が 25 MiB(Cloudflare)ではなく 20 MiB なのは、番人へ中身を Worker どうしの呼び出し(RPC)で
 * base64 にして渡すため(1 回 32 MiB まで・base64 で 4/3 倍)。
 */
import type { Env } from "./types";

export const MEDIA_ASSET_MAX = 20 * 1024 * 1024;

const MEDIA_REF = new RegExp(
  "(^|[^A-Za-z0-9_.\\-])((?:https?:)?//[^/\"'\\s)<>]+)?((?:/[A-Za-z0-9._\\-]+)*)/(images|videos|audios)/([A-Za-z0-9._\\-]{1,200})(\\?v=([A-Za-z0-9._\\-]*))?",
  "g",
);

/**
 * 頁の HTML のメディアの URL を書き換える。`cdn` は CDN に置けるメディアのキー(`images/img-1.png`)。
 * `publicBase` の下(または根)の `/images/…` だけを扱い、ほかの基点のものには触れない。
 */
export function rewriteMediaRefs(
  html: string,
  opts: { version: string; cdn: Set<string>; publicBase: string },
): string {
  const ver = opts.version.replace(/[^A-Za-z0-9._-]/g, "");
  return html.replace(
    MEDIA_REF,
    (
      all,
      lead: string,
      host: string | undefined,
      prefix: string,
      kind: string,
      file: string,
      _q,
      v: string | undefined,
    ) => {
      if (prefix && prefix !== opts.publicBase) return all;
      const key = `${kind}/${file}`;
      const base = `${host ?? ""}${prefix}`;
      const stamp = !v
        ? ver
        : v === ver || v.endsWith(`-${ver}`)
          ? v
          : `${v}-${ver}`;
      if (opts.cdn.has(key)) return `${lead}${base}/${key}?v=${stamp}`;
      return `${lead}${base}/_media/${key}?v=${stamp}`;
    },
  );
}

let held: { at: number; keys: Set<string>; base: string } | null = null;

/**
 * 書き換えに要るもの: CDN に置けるメディアのキーと、公開の基点(公開のドメインのパス)。この isolate で 1 分控える
 * —— 頁を書くたびに台帳を読まない。
 */
export async function mediaRewriteContext(
  env: Env,
  now = Date.now(),
): Promise<{ keys: Set<string>; base: string }> {
  if (held && now - held.at < 60_000) return held;
  const [rows, site] = await Promise.all([
    env.DB.prepare(
      `SELECT public_path FROM media_assets
        WHERE size_bytes <= ? AND COALESCE(mime, '') NOT LIKE 'image/svg%'`,
    )
      .bind(MEDIA_ASSET_MAX)
      .all<{ public_path: string }>(),
    env.DB.prepare(
      "SELECT public_domain FROM site_settings WHERE id = 1",
    ).first<{
      public_domain: string | null;
    }>(),
  ]);
  let base = "";
  try {
    if (site?.public_domain)
      base = new URL(site.public_domain).pathname.replace(/\/$/, "");
  } catch {
    /* 形の悪い設定は根とみなす */
  }
  const keys = new Set(
    (rows.results ?? []).map((r) => r.public_path.replace(/^\//, "")),
  );
  held = { at: now, keys, base };
  return held;
}

/** 頁の全言語の HTML を書き換える(KV に書く直前・public.ts の kvPutBundle)。 */
export async function rewriteBundleMedia(
  env: Env,
  bundle: Record<string, string>,
  version: string,
): Promise<Record<string, string>> {
  const ctx = await mediaRewriteContext(env);
  const out: Record<string, string> = {};
  for (const [lang, html] of Object.entries(bundle))
    out[lang] = rewriteMediaRefs(html, {
      version,
      cdn: ctx.keys,
      publicBase: ctx.base,
    });
  return out;
}

/** 試験専用。 */
export function __resetMediaCdnForTest(): void {
  held = null;
}

export interface MediaAsset {
  /** 資産のパス(公開の基点つき)。 */
  path: string;
  /** R2 のキー(`images/img-1.png`)。 */
  key: string;
  hash: string;
  size: number;
  type: string;
}

/**
 * 登録の一覧に載せるメディア: 公開中の頁が使い、CDN に置けるもの。ハッシュは中身ではなく「キー・台帳の版・大きさ」から
 * 作る(番号は再発行しない・差し替えれば版が変わる —— 中身を読まずに一意になる)。
 */
export async function publicMediaAssets(
  env: Env,
  publicBase: string,
  hash: (s: string) => Promise<string>,
): Promise<MediaAsset[]> {
  const rows = await env.DB.prepare(
    `SELECT DISTINCT m.public_path AS p, m.size_bytes AS size, m.mime AS mime, m.cache_version AS v
       FROM page_media pm JOIN media_assets m ON m.public_path = '/' || pm.media_key
      WHERE m.size_bytes <= ? AND COALESCE(m.mime, '') NOT LIKE 'image/svg%'`,
  )
    .bind(MEDIA_ASSET_MAX)
    .all<{ p: string; size: number; mime: string | null; v: string | null }>();
  const out: MediaAsset[] = [];
  for (const r of rows.results ?? []) {
    const key = r.p.replace(/^\//, "");
    if (!/^(images|videos|audios)\//.test(key)) continue;
    const type = /^(image|video|audio)\//i.test(r.mime ?? "")
      ? r.mime!
      : "application/octet-stream";
    out.push({
      path: `${publicBase}/${key}`,
      key,
      hash: await hash(`media:${key}:${r.v ?? ""}:${r.size}`),
      size: Number(r.size),
      type,
    });
  }
  return out;
}
