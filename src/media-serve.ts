/**
 * R2 のメディアを返す(公開の `/images/…`・大きいファイルの `/_media/…`・管理画面の `/api/media/file/…` で共通)。
 * 無ければ null(呼ぶ側が 404 やプレースホルダを決める)。
 */
import type { Env } from "./types";

export async function serveMediaObject(
  env: Env,
  key: string,
  opts: { private: boolean },
): Promise<Response | null> {
  if (!env.MEDIA_BUCKET) return null;
  // The binding stays present even after the R2 subscription is cancelled
  // or the bucket is deleted; in that state .get() throws.
  try {
    const obj = await env.MEDIA_BUCKET.get(key);
    if (!obj) return null;
    const headers = new Headers();
    // メディアとして配る種類だけをそのまま名乗る。ほか(取り込み元や復元の行が名乗った HTML など)は
    // 中身として動かさない。種類の推し量りも止める。
    const stored = obj.httpMetadata?.contentType || "";
    headers.set(
      "content-type",
      new RegExp("^(image|video|audio)/(?!svg)", "i").test(stored)
        ? stored
        : "application/octet-stream",
    );
    headers.set("x-content-type-options", "nosniff");
    headers.set(
      "cache-control",
      opts.private
        ? "private, no-store"
        : "public, max-age=31536000, immutable",
    );
    headers.set("etag", obj.etag);
    if (!opts.private) headers.set("access-control-allow-origin", "*");
    return new Response(obj.body, { headers });
  } catch {
    return null;
  }
}
