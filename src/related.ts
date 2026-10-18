// 関連記事の帯(content.related-N)の候補と、今の記事の前後への振り分け。
// (node の試験から読めるよう、public.ts から分けた・2026-10-18)
import {
  ARTICLE_TR_JOINS,
  publishedSql,
  type PubFilter,
} from "./published-sql.ts";
import type { Env } from "./types";

export interface RelatedPoolItem {
  did: string;
  slug: string;
  tid: string;
  title: string;
  cover: string | null;
}

// Max cards one strip asks for (content.related-N, N ≤ 20 — see the caller).
export const RELATED_MAX = 20;

// The slice of one category's published articles a related strip can use, as
// one newest-first list: the RELATED_MAX articles on each side of the current
// one, plus the RELATED_MAX newest and oldest (the wrap-around fill). Light
// projection — title + cover only, no bodies.
//
// ⚠ This used to read the newest 500 of the category. An article older than
// that was not in its own pool, so pickCategoryNeighbours found nothing and the
// strip vanished (and the "oldest" fill was really the 500th). Reading the
// windows around the current article keeps the work per page small however big
// the category grows, and is right for every article (2026-10-18).
export async function fetchCategoryPool(
  env: Env,
  categorySlug: string,
  currentSlug: string,
  lang: string,
  defaultLang: string,
  filter: PubFilter,
): Promise<RelatedPoolItem[]> {
  const cur = await env.DB.prepare(
    "SELECT did, COALESCE(publish_at, '') AS pa FROM documents WHERE slug = ?",
  )
    .bind(currentSlug)
    .first<{ did: string; pa: string }>();
  if (!cur) return [];
  // Same order everywhere: newest first, did as the tie-break. COALESCE keeps a
  // missing publish_at comparable (it sorts as the oldest, as NULL did).
  const key = "COALESCE(d.publish_at, '')";
  const newer = `(${key} > ? OR (${key} = ? AND d.did > ?))`;
  const older = `(${key} < ? OR (${key} = ? AND d.did < ?))`;
  const at = [cur.pa, cur.pa, cur.did];
  const select = `SELECT d.did, d.slug, d.tid, COALESCE(d.publish_at, '') AS pa,
       COALESCE(NULLIF(NULLIF(dt_req.title, ''), d.slug), NULLIF(NULLIF(dt_en.title, ''), d.slug), NULLIF(NULLIF(dt_fb.title, ''), d.slug), NULLIF(NULLIF(dt_init.title, ''), d.slug), NULLIF(NULLIF(dt_site.title, ''), d.slug), NULLIF(NULLIF(dt_any.title, ''), d.slug)) AS title,
       COALESCE(NULLIF(NULLIF(dt_req.seo_json, ''), '{}'), NULLIF(NULLIF(dt_en.seo_json, ''), '{}'), NULLIF(NULLIF(dt_fb.seo_json, ''), '{}'), NULLIF(NULLIF(dt_init.seo_json, ''), '{}'), NULLIF(NULLIF(dt_site.seo_json, ''), '{}'), NULLIF(NULLIF(dt_any.seo_json, ''), '{}')) AS seo_json
     FROM documents d
     JOIN document_categories dc ON dc.did = d.did
     JOIN categories ti ON ti.id = dc.cid AND (ti.slug = ? OR ti.id = ?)
     ${ARTICLE_TR_JOINS}
     WHERE ${publishedSql("d.", filter)}`;
  const slice = (cond: string, binds: string[], dir: "ASC" | "DESC") =>
    env.DB.prepare(
      `${select}
       ${cond ? `AND ${cond}` : ""}
       ORDER BY ${key} ${dir}, d.did ${dir}
       LIMIT ?`,
    )
      .bind(
        categorySlug,
        categorySlug,
        lang,
        defaultLang || lang,
        ...binds,
        RELATED_MAX,
      )
      .all<CategoryPoolRow>();
  const parts = await Promise.all([
    slice("", [], "DESC"), // newest
    slice(newer, at, "ASC"), // closest newer
    slice(`d.did = ?`, [cur.did], "DESC"), // the article itself
    slice(older, at, "DESC"), // closest older
    slice("", [], "ASC"), // oldest
  ]);
  const byDid = new Map<string, CategoryPoolRow>();
  for (const p of parts) for (const r of p.results ?? []) byDid.set(r.did, r);
  const rows = [...byDid.values()].sort((x, y) =>
    x.pa === y.pa ? (x.did < y.did ? 1 : -1) : x.pa < y.pa ? 1 : -1,
  );
  return rows.map((r) => {
    let cover: string | null = null;
    if (r.seo_json) {
      try {
        const seo = JSON.parse(r.seo_json) as { coverPath?: string };
        if (seo.coverPath) cover = seo.coverPath;
      } catch {
        /* ignore */
      }
    }
    return {
      did: r.did,
      slug: r.slug,
      tid: r.tid,
      title: r.title || r.slug,
      cover,
    };
  });
}

interface CategoryPoolRow {
  did: string;
  slug: string;
  tid: string;
  title: string;
  seo_json: string;
  pa: string;
}

// Split N cards around the current article: older on the left, newer on the
// right. When a side runs out (the article is the newest/oldest in its
// category), fill from the far end — no newer → oldest; no older → newest — so
// the strip keeps N cards. Never repeats the current article. `pool` is DESC
// (index 0 = newest). Returned `left` reads farthest→closest-older toward the
// centre; `right` reads closest→farthest-newer.
export function pickCategoryNeighbours(
  pool: RelatedPoolItem[],
  currentSlug: string,
  n: number,
): { left: RelatedPoolItem[]; right: RelatedPoolItem[] } {
  const idx = pool.findIndex((a) => a.slug === currentSlug);
  if (idx < 0) return { left: [], right: [] };
  const olderCount = Math.floor(n / 2);
  const newerCount = n - olderCount;
  const used = new Set<string>([pool[idx].did]);
  const take = (src: RelatedPoolItem[], count: number): RelatedPoolItem[] => {
    const out: RelatedPoolItem[] = [];
    for (const a of src) {
      if (out.length >= count) break;
      if (used.has(a.did)) continue;
      used.add(a.did);
      out.push(a);
    }
    return out;
  };
  const newerClosestFirst: RelatedPoolItem[] = [];
  for (let i = idx - 1; i >= 0; i--) newerClosestFirst.push(pool[i]);
  const oldestFirst: RelatedPoolItem[] = [];
  for (let i = pool.length - 1; i > idx; i--) oldestFirst.push(pool[i]);
  let right = take(newerClosestFirst, newerCount);
  if (right.length < newerCount)
    right = right.concat(take(oldestFirst, newerCount - right.length));
  const olderClosestFirst: RelatedPoolItem[] = [];
  for (let i = idx + 1; i < pool.length; i++) olderClosestFirst.push(pool[i]);
  const newestFirst: RelatedPoolItem[] = [];
  for (let i = 0; i < idx; i++) newestFirst.push(pool[i]);
  let left = take(olderClosestFirst, olderCount);
  if (left.length < olderCount)
    left = left.concat(take(newestFirst, olderCount - left.length));
  left.reverse(); // closest-older ends adjacent to the centre marker
  return { left, right };
}
