// 素材(画像・動画・音楽)の一覧。管理画面の素材管理はページで取る。
//
// ⚠ 以前は新しい順に固定の 200 件で切り、ページ送りも無かったので、201 件目より
// 古い素材は画面から見えなかった。?page= を付けた呼び出しは LIMIT/OFFSET で区切り、
// 全件数 total を返す(画面はそれでページ送りを出す)。
// ?page= の無い呼び出し(記事エディタ・サイト設定の選択欄)は従来どおり 200 件。
import type { Env, JsonValue } from "./types";

export const MEDIA_PER_PAGE_DEFAULT = 50;
export const MEDIA_PER_PAGE_MAX = 100;
const MEDIA_UNPAGED_LIMIT = 200;

const MEDIA_LIST_SQL =
  "SELECT mid AS id, kind, filename, mime, width, height, size_bytes AS sizeBytes, public_path AS publicPath, cache_version AS cacheVersion, created_at AS createdAt FROM media_assets WHERE kind = ?1 ORDER BY created_at DESC, mid DESC";

export async function listMediaPage(
  env: Env,
  kind: "image" | "video" | "audio",
  params: URLSearchParams,
): Promise<{ [key: string]: JsonValue }> {
  const total =
    (
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM media_assets WHERE kind = ?1",
      )
        .bind(kind)
        .first<{ n: number }>()
    )?.n ?? 0;
  if (!params.has("page")) {
    const rows = await env.DB.prepare(MEDIA_LIST_SQL + " LIMIT ?2")
      .bind(kind, MEDIA_UNPAGED_LIMIT)
      .all();
    return { items: rows.results as JsonValue, total };
  }
  // 数でない値・0 以下は既定へ(1 件ずつのページに化けさせない)。
  const posInt = (v: string | null, fallback: number) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 1 ? n : fallback;
  };
  const page = posInt(params.get("page"), 1);
  const perPage = Math.min(
    MEDIA_PER_PAGE_MAX,
    posInt(params.get("per_page"), MEDIA_PER_PAGE_DEFAULT),
  );
  const rows = await env.DB.prepare(MEDIA_LIST_SQL + " LIMIT ?2 OFFSET ?3")
    .bind(kind, perPage, (page - 1) * perPage)
    .all();
  return { items: rows.results as JsonValue, total, page, perPage };
}
