// 公開の判定と、記事の題を選ぶ翻訳の結合。public.ts と related.ts が使う SQL の部品。
// (node の試験から読めるよう、public.ts から分けた・2026-10-18)

/**
 * Which notion of "published" a query runs under. The publish flag (documents.
 * mode) is pure STATE — it only takes effect when a build materializes it into
 * documents.live. Serving must never read mode directly, or a flagged-but-not-
 * yet-built article would leak out through the on-demand pages (categories,
 * KV-miss fallback, sitemap/RSS) before any build ran.
 *   "live"   — serve-time: what the last completed build published (live = 1)
 *   "window" — build-time: mode = 1 within the publish window
 *   "future" — build-time in "always" mode: the upper publish_at bound is
 *              dropped so future-dated posts are built/listed immediately; the
 *              unpublish_at (expiry) bound is always enforced
 */
export type PubFilter = "live" | "window" | "future";

/** SQL predicate selecting published documents under `filter`.
 *  `alias` is the column prefix ("d." or ""). */
export function publishedSql(alias: string, filter: PubFilter): string {
  if (filter === "live") return `${alias}live = 1`;
  const upper =
    filter === "future"
      ? ""
      : `AND datetime(${alias}publish_at) <= datetime('now') `;
  return `${alias}mode = 1 ${upper}AND (${alias}unpublish_at IS NULL OR datetime(${alias}unpublish_at) > datetime('now'))`;
}

// Two binds, in order: (1) requested lang, (2) site/default lang.
export const ARTICLE_TR_JOINS = `LEFT JOIN document_translations dt_req ON dt_req.did = d.did AND dt_req.lang = ?
  LEFT JOIN document_translations dt_fb ON dt_fb.did = d.did AND dt_fb.lang = d.fallback_lang
  LEFT JOIN document_translations dt_init ON dt_init.did = d.did AND dt_init.lang = d.initial_lang
  LEFT JOIN document_translations dt_site ON dt_site.did = d.did AND dt_site.lang = ?
  LEFT JOIN document_translations dt_en ON dt_en.did = d.did AND dt_en.lang = 'en'
  LEFT JOIN document_translations dt_any ON dt_any.did = d.did AND dt_any.lang = (
    SELECT dt2.lang FROM document_translations dt2 WHERE dt2.did = d.did ORDER BY dt2.updated_at DESC LIMIT 1
  )`;
