// Public page renderer. Template HTML comes only from D1.
import type {
  ArticleCardData,
  ArticleData,
  CategoryItem,
  Pagination,
  RenderContext,
  TypeItem,
} from "./templates/types";
import {
  isKuroCmsHtmlTemplate,
  isRtlLang,
  renderTemplate,
} from "./templates/html-template";
import { KE_VERSION } from "./admin-assets";
import { buildFontHead, type LoadedFont } from "./fonts";
import { stripInternalIds } from "./strip-internal-ids";
import type { Env } from "./types";

// Bump when the page-rendering OUTPUT changes in a way the per-page source_hash
// can't see (e.g. the <head> content-CSS <link>, template-model shape). The
// build salts every page hash with this, so cached builds are invalidated and
// all pages regenerate even when their underlying content is unchanged.
const RENDER_FORMAT_VERSION = "18";

/** Cheap, synchronous string hash (FNV-1a, base36) for cache keys. Not crypto. */
export function cheapHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

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
function publishedSql(alias: string, filter: PubFilter): string {
  if (filter === "live") return `${alias}live = 1`;
  const upper =
    filter === "future"
      ? ""
      : `AND datetime(${alias}publish_at) <= datetime('now') `;
  return `${alias}mode = 1 ${upper}AND (${alias}unpublish_at IS NULL OR datetime(${alias}unpublish_at) > datetime('now'))`;
}

/** SQL CASE computing a document's materialized `live` value from its flag
 *  state — the build-time counterpart of publishedSql, used wherever a build
 *  syncs documents.live. Must stay consistent with publishedSql and with the
 *  auto-build cron's pending-change predicate. */
function liveCaseSql(filter: "window" | "future"): string {
  const upper =
    filter === "future" ? "" : `AND datetime(publish_at) <= datetime('now') `;
  return `CASE WHEN mode = 1 ${upper}AND (unpublish_at IS NULL OR datetime(unpublish_at) > datetime('now')) THEN 1 ELSE 0 END`;
}

interface StoredTemplate {
  id: string;
  sourceHtml: string;
  /** JSON array of class tokens the static Tailwind CSS was compiled from. */
  compiledTokens?: string | null;
  /** cheapHash(compiled_css) — versions the /_tw/{id}.{hash}.css URL. */
  compiledHash?: string | null;
}

async function loadTemplate(
  env: Env,
  templateId?: string | null,
): Promise<StoredTemplate> {
  if (!templateId) throw new Error("No active template is configured.");
  const row = await env.DB.prepare(
    "SELECT id, source_html, compiled_tokens, compiled_hash FROM page_templates WHERE id = ?",
  )
    .bind(templateId)
    .first<{
      id: string;
      source_html: string | null;
      compiled_tokens: string | null;
      compiled_hash: string | null;
    }>();
  if (!row) throw new Error(`Template not found: ${templateId}`);
  if (!isKuroCmsHtmlTemplate(row.source_html)) {
    throw new Error(`Template is not a KuroCMS HTML template: ${templateId}`);
  }
  return {
    id: row.id,
    sourceHtml: row.source_html!,
    compiledTokens: row.compiled_tokens,
    compiledHash: row.compiled_hash,
  };
}

// ─── DB row types ─────────────────────────────────────────────────────────────

interface ArticleRow {
  did: string;
  slug: string;
  tid: string;
  publish_at: string;
  updated_at: string;
  title: string | null;
  summary: string | null;
  body_html: string | null;
  seo_json: string | null;
  categories_json: string | null;
  /** Author display name (users.display_name via documents.created_by).
   *  Only selected by fetchArticleDetail; list queries leave it undefined. */
  author_name?: string | null;
}

type TemplateContent = Record<string, string>;

/** Pre-fetched data shared across multiple generatePage calls in a single build. */
interface RenderPrefetch {
  types?: TypeItem[];
  categories?: CategoryItem[];
  templateContent?: Map<string, TemplateContent>; // keyed by lang
  externalConnections?: Array<{ id: string; service: string; handle: string }>;
  availableLangs?: Array<{ code: string; name: string }>;
  // Per-article translation languages, keyed by `${tid}/${slug}` (for the
  // language switcher gray-out). Build supplies it from already-loaded rows;
  // single-page serve falls back to a query.
  articleLangs?: Map<string, string[]>;
}

interface SettingsMap {
  site_name?: string;
  site_description?: string;
  /** Full configured public URL (scheme+host+optional base path), e.g.
   * "https://kuro.boo/" — used to build absolute canonical/OGP/sitemap URLs. */
  public_domain?: string;
  ga4_measurement_id?: string;
  bluesky_handle?: string;
  bluesky_sid?: string;
  template_id?: string;
  base_path?: string;
  default_lang?: string;
  fonts_json?: string;
  base_font?: string;
  font_configs_json?: string;
}

// ─── DB fetchers ──────────────────────────────────────────────────────────────

async function fetchSettings(env: Env): Promise<SettingsMap> {
  const row = await env.DB.prepare(
    `SELECT site_name, site_description, public_domain, ga4_measurement_id,
            bluesky_handle, bluesky_sid, template_id, default_lang,
            fonts_json, base_font, font_configs_json
     FROM site_settings WHERE id = 1`,
  ).first<{
    site_name: string;
    site_description: string;
    public_domain: string;
    ga4_measurement_id: string;
    bluesky_handle: string;
    bluesky_sid: string;
    template_id: string;
    default_lang: string;
    fonts_json: string;
    base_font: string;
    font_configs_json: string;
  }>();
  let basePath = "";
  try {
    const pd = row?.public_domain || "";
    if (pd) basePath = new URL(pd).pathname.replace(/\/$/, "");
  } catch {
    /* ignore */
  }
  return {
    site_name: row?.site_name || "",
    site_description: row?.site_description || "",
    public_domain: row?.public_domain || "",
    ga4_measurement_id: row?.ga4_measurement_id || "",
    bluesky_handle: row?.bluesky_handle || "",
    bluesky_sid: row?.bluesky_sid || "",
    template_id: row?.template_id || "",
    base_path: basePath,
    default_lang: row?.default_lang || "en",
    fonts_json: row?.fonts_json || "[]",
    base_font: row?.base_font || "",
    font_configs_json: row?.font_configs_json || "{}",
  };
}

async function countPublishedArticles(
  env: Env,
  filter: PubFilter = "live",
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM documents
     WHERE ${publishedSql("", filter)}`,
  ).first<{ cnt: number }>();
  return row?.cnt ?? 0;
}

async function countArticlesByTypeSlug(
  env: Env,
  typeSlug: string,
  filter: PubFilter = "live",
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM documents d
     JOIN taxonomy_items ti ON ti.id = d.tid AND ti.kind = 'type'
       AND (COALESCE(ti.slug, ti.id) = ? OR ti.id = ?)
     WHERE ${publishedSql("d.", filter)}`,
  )
    .bind(typeSlug, typeSlug)
    .first<{ cnt: number }>();
  return row?.cnt ?? 0;
}

function buildPagination(
  page: number,
  total: number,
  limit: number,
  baseUrl: string,
): Pagination | null {
  const totalPages = Math.ceil(total / limit);
  if (totalPages <= 1) return null;
  const prevUrl =
    page > 1 ? (page === 2 ? baseUrl : `${baseUrl}page/${page - 1}/`) : null;
  const nextUrl = page < totalPages ? `${baseUrl}page/${page + 1}/` : null;
  return { page, totalPages, prevUrl, nextUrl };
}

async function fetchPublishedArticles(
  env: Env,
  lang: string,
  defaultLang = "",
  page = 1,
  limit = 30,
  filter: PubFilter = "live",
): Promise<ArticleRow[]> {
  const offset = (page - 1) * limit;
  const rows = await env.DB.prepare(
    `SELECT d.did, d.slug, d.tid, d.publish_at, d.updated_at,
            COALESCE(NULLIF(NULLIF(dt_req.title, ''), d.slug), NULLIF(NULLIF(dt_en.title, ''), d.slug), NULLIF(NULLIF(dt_fb.title, ''), d.slug), NULLIF(NULLIF(dt_init.title, ''), d.slug), NULLIF(NULLIF(dt_site.title, ''), d.slug), NULLIF(NULLIF(dt_any.title, ''), d.slug)) AS title,
            COALESCE(NULLIF(dt_req.summary, ''), NULLIF(dt_en.summary, ''), NULLIF(dt_fb.summary, ''), NULLIF(dt_init.summary, ''), NULLIF(dt_site.summary, ''), NULLIF(dt_any.summary, '')) AS summary,
            COALESCE(NULLIF(dt_req.body_html, ''), NULLIF(dt_en.body_html, ''), NULLIF(dt_fb.body_html, ''), NULLIF(dt_init.body_html, ''), NULLIF(dt_site.body_html, ''), NULLIF(dt_any.body_html, '')) AS body_html,
            COALESCE(NULLIF(NULLIF(dt_req.seo_json, ''), '{}'), NULLIF(NULLIF(dt_en.seo_json, ''), '{}'), NULLIF(NULLIF(dt_fb.seo_json, ''), '{}'), NULLIF(NULLIF(dt_init.seo_json, ''), '{}'), NULLIF(NULLIF(dt_site.seo_json, ''), '{}'), NULLIF(NULLIF(dt_any.seo_json, ''), '{}')) AS seo_json,
            (SELECT json_group_array(json_object('id',ti.id,'name',ti.name,'slug',COALESCE(ti.slug,ti.id),'count',0))
             FROM document_categories dc JOIN categories ti ON ti.id=dc.cid
             WHERE dc.did=d.did ORDER BY ti.name) AS categories_json
     FROM documents d
     LEFT JOIN document_translations dt_req ON dt_req.did = d.did AND dt_req.lang = ?
     LEFT JOIN document_translations dt_fb ON dt_fb.did = d.did AND dt_fb.lang = d.fallback_lang
     LEFT JOIN document_translations dt_init ON dt_init.did = d.did AND dt_init.lang = d.initial_lang
     LEFT JOIN document_translations dt_site ON dt_site.did = d.did AND dt_site.lang = ?
     LEFT JOIN document_translations dt_en ON dt_en.did = d.did AND dt_en.lang = 'en'
     LEFT JOIN document_translations dt_any ON dt_any.did = d.did AND dt_any.lang = (
       SELECT dt2.lang FROM document_translations dt2
       WHERE dt2.did = d.did
       ORDER BY dt2.updated_at DESC
       LIMIT 1
     )
     WHERE ${publishedSql("d.", filter)}
     ORDER BY d.publish_at DESC, d.did DESC LIMIT ? OFFSET ?`,
  )
    .bind(lang, defaultLang || lang, limit, offset)
    .all<ArticleRow>();
  return rows.results ?? [];
}

async function fetchArticleDetail(
  env: Env,
  slug: string,
  tid: string,
  lang: string,
  defaultLang = "",
  filter: PubFilter = "live",
): Promise<ArticleRow | null> {
  return env.DB.prepare(
    `SELECT d.did, d.slug, d.tid, d.publish_at, d.updated_at,
            COALESCE(NULLIF(NULLIF(dt_req.title, ''), d.slug), NULLIF(NULLIF(dt_en.title, ''), d.slug), NULLIF(NULLIF(dt_fb.title, ''), d.slug), NULLIF(NULLIF(dt_init.title, ''), d.slug), NULLIF(NULLIF(dt_site.title, ''), d.slug), NULLIF(NULLIF(dt_any.title, ''), d.slug)) AS title,
            COALESCE(NULLIF(dt_req.summary, ''), NULLIF(dt_en.summary, ''), NULLIF(dt_fb.summary, ''), NULLIF(dt_init.summary, ''), NULLIF(dt_site.summary, ''), NULLIF(dt_any.summary, '')) AS summary,
            COALESCE(NULLIF(dt_req.body_html, ''), NULLIF(dt_en.body_html, ''), NULLIF(dt_fb.body_html, ''), NULLIF(dt_init.body_html, ''), NULLIF(dt_site.body_html, ''), NULLIF(dt_any.body_html, '')) AS body_html,
            COALESCE(NULLIF(NULLIF(dt_req.seo_json, ''), '{}'), NULLIF(NULLIF(dt_en.seo_json, ''), '{}'), NULLIF(NULLIF(dt_fb.seo_json, ''), '{}'), NULLIF(NULLIF(dt_init.seo_json, ''), '{}'), NULLIF(NULLIF(dt_site.seo_json, ''), '{}'), NULLIF(NULLIF(dt_any.seo_json, ''), '{}')) AS seo_json,
            (SELECT json_group_array(json_object('id',ti.id,'name',ti.name,'slug',COALESCE(ti.slug,ti.id),'count',0))
             FROM document_categories dc JOIN categories ti ON ti.id=dc.cid
             WHERE dc.did=d.did ORDER BY ti.name) AS categories_json,
            u.display_name AS author_name
     FROM documents d
     LEFT JOIN users u ON u.uid = d.created_by
     LEFT JOIN document_translations dt_req ON dt_req.did = d.did AND dt_req.lang = ?
     LEFT JOIN document_translations dt_fb ON dt_fb.did = d.did AND dt_fb.lang = d.fallback_lang
     LEFT JOIN document_translations dt_init ON dt_init.did = d.did AND dt_init.lang = d.initial_lang
     LEFT JOIN document_translations dt_site ON dt_site.did = d.did AND dt_site.lang = ?
     LEFT JOIN document_translations dt_en ON dt_en.did = d.did AND dt_en.lang = 'en'
     LEFT JOIN document_translations dt_any ON dt_any.did = d.did AND dt_any.lang = (
       SELECT dt2.lang FROM document_translations dt2
       WHERE dt2.did = d.did
       ORDER BY dt2.updated_at DESC
       LIMIT 1
     )
     WHERE d.slug = ? AND d.tid = ? AND ${publishedSql("d.", filter)}
     LIMIT 1`,
  )
    .bind(lang, defaultLang || lang, slug, tid)
    .first<ArticleRow>();
}

function buildBlueskyWidget(handle: string): string {
  const esc = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const uid = "bw_" + handle.replace(/[^a-z0-9]/gi, "_");
  // Rich, self-contained widget (avatar / text / images / embed / like+repost /
  // post links). Inline styles only — must render on non-Tailwind templates too.
  return `<div style="border:1px solid #d3e8ff;background:#f0f8ff;border-radius:16px;padding:14px;max-width:400px">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
    <div style="display:flex;align-items:center;gap:8px">
      <svg viewBox="0 0 360 320" style="width:22px;height:22px;fill:#0085ff"><path d="M180 142C164 110 119 51 78 30 38 10 0 31 0 73c0 9 2 19 5 29 14 37 57 47 95 41-34 7-66 21-69 54-2 35 31 43 52 35 47-19 82-61 97-88zm0 0c16-32 61-91 102-112 40-20 78 1 78 43 0 9-2 19-5 29-14 37-57 47-95 41 34 7 66 21 69 54 2 35-31 43-52 35C230 212 196 170 180 142z"/></svg>
      <strong style="color:#0085ff;font-size:14px">Bluesky</strong>
    </div>
    <a href="https://bsky.app/profile/${esc(handle)}" target="_blank" rel="noopener" style="font-size:11px;color:#0085ff;text-decoration:none">プロフィール →</a>
  </div>
  <div id="${uid}" style="display:flex;flex-direction:column;gap:8px">
    <p style="font-size:13px;color:#0085ff;opacity:.6;text-align:center;padding:10px 0;margin:0">読み込み中…</p>
  </div>
</div>
<script>
(function(){
  var H="${esc(handle)}",el=document.getElementById("${uid}");
  if(!el)return;
  var e=function(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");};
  var rt=function(iso){var d=Date.now()-new Date(iso).getTime(),m=Math.floor(d/60000);if(m<1)return"たった今";if(m<60)return m+"分前";var h=Math.floor(m/60);if(h<24)return h+"時間前";var dy=Math.floor(h/24);if(dy<7)return dy+"日前";return new Date(iso).toLocaleDateString("ja-JP",{month:"numeric",day:"numeric"});};
  fetch("https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor="+encodeURIComponent(H)+"&limit=10&filter=posts_no_replies",{headers:{accept:"application/json"}})
    .then(function(r){return r.json();})
    .then(function(data){
      if(!el)return;
      var items=(data.feed||[]).filter(function(f){return f.post&&f.post.record&&f.post.record.text;});
      if(!items.length){el.innerHTML="<p style='font-size:12px;color:#94a3b8;text-align:center;padding:10px 0;margin:0'>投稿がありません</p>";return;}
      el.innerHTML=items.map(function(f){
        var post=f.post,author=post.author||{},record=post.record||{};
        var rkey=(post.uri||"").split("/").pop();
        var postUrl="https://bsky.app/profile/"+encodeURIComponent(author.handle||"")+"/post/"+(rkey||"");
        var avatar=author.avatar
          ?"<img src='"+e(author.avatar)+"' style='width:40px;height:40px;border-radius:50%;object-fit:cover;flex-shrink:0' alt='' />"
          :"<div style='width:40px;height:40px;border-radius:50%;background:rgba(0,133,255,.2);flex-shrink:0'></div>";
        var images=((post.embed&&post.embed.images)||[]).slice(0,4);
        var imgHtml="";
        if(images.length){
          imgHtml="<div style='margin-top:8px;display:grid;grid-template-columns:"+(images.length>1?"1fr 1fr":"1fr")+";gap:4px;border-radius:8px;overflow:hidden'>"
            +images.map(function(img){var t=img.thumb||img.fullsize||"";return t?"<img src='"+e(t)+"' style='width:100%;object-fit:cover;max-height:150px;border-radius:6px' alt='"+e(img.alt||"")+"' />":"";}).join("")
            +"</div>";
        }else if(post.embed&&post.embed.external&&post.embed.external.thumb){
          imgHtml="<div style='margin-top:8px;border-radius:8px;overflow:hidden;border:1px solid #f1f5f9'><img src='"+e(post.embed.external.thumb)+"' style='width:100%;object-fit:cover;max-height:150px' alt='' />"
            +(post.embed.external.title?"<div style='padding:6px 8px;background:#f8fafc;font-size:11px;color:#475569;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'>"+e(post.embed.external.title)+"</div>":"")
            +"</div>";
        }
        return "<a href='"+postUrl+"' target='_blank' rel='noopener noreferrer' style='display:block;background:#fff;border-radius:12px;padding:12px;box-shadow:0 1px 2px rgba(0,0,0,.06);text-decoration:none'>"
          +"<div style='display:flex;align-items:center;gap:8px;margin-bottom:8px'>"+avatar
          +"<div style='min-width:0;flex:1;display:flex;flex-direction:column'>"
          +"<span style='font-weight:700;font-size:13px;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'>"+e(author.displayName||author.handle||"")+"</span>"
          +"<div style='display:flex;align-items:center;justify-content:space-between;margin-top:1px'>"
          +"<span style='font-size:11px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'>@"+e(author.handle||"")+"</span>"
          +"<span style='font-size:11px;color:#94a3b8;white-space:nowrap;margin-left:4px'>"+rt(record.createdAt||"")+"</span>"
          +"</div></div></div>"
          +"<p style='font-size:13px;color:#1f2937;line-height:1.6;white-space:pre-wrap;word-break:break-word;margin:0'>"+e(record.text||"")+"</p>"
          +imgHtml
          +"<div style='display:flex;align-items:center;gap:16px;margin-top:8px;font-size:11px;color:#64748b'>"
          +"<span style='display:inline-flex;align-items:center;gap:4px'><svg style='width:14px;height:14px;fill:#0085ff' viewBox='0 0 24 24'><path d='M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z'/></svg>"+(post.likeCount||0)+"</span>"
          +"<span style='display:inline-flex;align-items:center;gap:4px'><svg style='width:14px;height:14px;fill:#64748b' viewBox='0 0 24 24'><path d='M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z'/></svg>"+(post.repostCount||0)+"</span>"
          +"</div>"
          +"</a>";
      }).join("");
    }).catch(function(){if(el)el.innerHTML="<p style='font-size:12px;color:#94a3b8;text-align:center;padding:10px 0;margin:0'>読み込めませんでした</p>";});
})();
</script>`;
}

/**
 * Self-contained language switcher widget (expanded from the `[[lang]]` token).
 * Boxed 2-letter current code + dropdown of the site's registered languages.
 * Selecting a language reloads the same URL with `?lang=<code>` (the server then
 * renders both site text and articles in that language — see handlePublicRoute).
 * Client-side persistence: stores the choice in localStorage and rewrites
 * same-origin links to carry `?lang=` so the choice survives navigation.
 * Inline styles only (must render on non-Tailwind templates); contains no `[[`/`]]`.
 */
function buildLanguageWidget(
  currentLang: string,
  availableLangs: Array<{ code: string; name: string }>,
  enabled?: Set<string>,
): string {
  // Show even for a single language (user wants the active language always
  // visible). Only hide when no languages are registered at all.
  if (!Array.isArray(availableLangs) || availableLangs.length === 0) return "";
  const esc = (s: string) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const two = (c: string) => esc((c || "").slice(0, 2).toUpperCase());
  const uid = "kl_" + (currentLang || "x").replace(/[^a-z0-9]/gi, "_");
  const cur = two(currentLang) || two(availableLangs[0].code) || "?";
  const items = availableLangs
    .map((l) => {
      const on = l.code === currentLang;
      // Languages without a translation for THIS page are shown grayed-out and
      // are not selectable (no data-kl-code → the click handler ignores them).
      const usable = !enabled || enabled.has(l.code);
      if (!usable) {
        return `<div title="未翻訳 / not translated" style="display:flex;align-items:center;gap:8px;width:100%;text-align:left;font-size:12px;padding:6px 10px;border-radius:7px;line-height:1.2;opacity:.4;cursor:not-allowed"><span style="font-weight:700;min-width:20px">${two(l.code)}</span><span style="color:#94a3b8">${esc(l.name)}</span></div>`;
      }
      return `<button type="button" data-kl-code="${esc(l.code)}" style="display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:0;background:${on ? "#eef2ff" : "transparent"};color:#0f172a;font-size:12px;padding:6px 10px;border-radius:7px;cursor:pointer;line-height:1.2"><span style="font-weight:700;min-width:20px">${two(l.code)}</span><span style="color:#475569">${esc(l.name)}</span></button>`;
    })
    .join("");
  return `<div id="${uid}" style="position:relative;display:inline-block">
  <button type="button" data-kl-toggle aria-label="Language" style="display:inline-flex;align-items:center;gap:4px;border:1px solid #cbd5e1;border-radius:8px;padding:4px 8px;background:#fff;color:#0f172a;font-size:12px;font-weight:700;line-height:1;cursor:pointer">
    <span>${cur}</span>
    <svg viewBox="0 0 20 20" style="width:12px;height:12px;fill:#64748b"><path d="M5 7l5 5 5-5z"/></svg>
  </button>
  <div data-kl-menu style="display:none;position:absolute;right:0;top:calc(100% + 4px);min-width:150px;max-height:60vh;overflow:auto;background:#fff;border:1px solid #e2e8f0;border-radius:10px;box-shadow:0 10px 30px rgba(15,23,42,.15);padding:4px;z-index:1000">${items}</div>
</div>
<script>
(function(){
  var root=document.getElementById("${uid}");if(!root)return;
  var btn=root.querySelector("[data-kl-toggle]"),menu=root.querySelector("[data-kl-menu]"),KEY="kurocms_lang";
  function active(){try{var u=new URL(location.href);return u.searchParams.get("lang")||localStorage.getItem(KEY)||"";}catch(e){return"";}}
  function go(code){try{localStorage.setItem(KEY,code);}catch(e){}try{var u=new URL(location.href);u.searchParams.set("lang",code);location.href=u.toString();}catch(e){location.search="?lang="+encodeURIComponent(code);}}
  if(btn&&menu){
    btn.addEventListener("click",function(e){e.stopPropagation();menu.style.display=menu.style.display==="block"?"none":"block";});
    document.addEventListener("click",function(){menu.style.display="none";});
    menu.querySelectorAll("[data-kl-code]").forEach(function(b){b.addEventListener("click",function(e){e.preventDefault();go(b.getAttribute("data-kl-code"));});});
  }
  var lng=active();
  if(lng){
    var dec=function(a){try{var href=a.getAttribute&&a.getAttribute("href");if(!href||/^(#|mailto:|tel:|javascript:)/i.test(href))return;var u=new URL(href,location.href);if(u.origin!==location.origin)return;if(u.searchParams.get("lang"))return;u.searchParams.set("lang",lng);a.setAttribute("href",u.pathname+u.search+u.hash);}catch(e){}};
    var decAll=function(){document.querySelectorAll("a[href]").forEach(dec);};
    if(document.readyState!=="loading"){decAll();}else{document.addEventListener("DOMContentLoaded",decAll);}
    document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(a)dec(a);},true);
  }
})();
</script>`;
}

/** Active external SNS connections (Threads / X / Mastodon / Facebook 等). */
type ExternalConnection = { id: string; service: string; handle: string };

async function fetchExternalConnections(
  env: Env,
): Promise<ExternalConnection[]> {
  return env.DB.prepare(
    "SELECT id, service, handle FROM external_connections WHERE is_active = 1",
  )
    .all<ExternalConnection>()
    .then((r) => r.results ?? [])
    .catch(() => [] as ExternalConnection[]);
}

/**
 * Build the SNS-SID expansion context shared by site text (content) and the
 * template body (source_html). Spec §12: writing `[[sid]]` anywhere renders the
 * widget at that position. `snsSids` is the set of known SIDs (used to keep
 * media `[[mid]]` lookups separate); `resolveSns` turns a SID into widget HTML.
 */
function buildSnsContext(
  settings: SettingsMap | undefined,
  extConns: ExternalConnection[],
): { snsSids: Set<string>; resolveSns: (ref: string) => string } {
  const snsSids = new Set<string>();
  const blueskySid = settings?.bluesky_sid || "";
  if (blueskySid) snsSids.add(blueskySid);
  const extMap: Record<string, { service: string; handle: string }> = {};
  for (const c of extConns) {
    extMap[c.id] = { service: c.service, handle: c.handle || "" };
    snsSids.add(c.id);
  }
  const resolveSns = (ref: string): string => {
    if (blueskySid === ref && settings?.bluesky_handle) {
      return buildBlueskyWidget(settings.bluesky_handle);
    }
    const ext = extMap[ref];
    if (ext?.service === "bluesky" && ext.handle) {
      return buildBlueskyWidget(ext.handle);
    }
    return `<!-- sns widget: ${ref} (no handle configured) -->`;
  };
  return { snsSids, resolveSns };
}

/** Replace known SNS-SID tokens (`[[sns-001]]`) in-place, leaving all other
 *  `[[...]]` tokens (media / template bindings) untouched. */
function expandSnsRefs(
  html: string,
  snsSids: Set<string>,
  resolveSns: (ref: string) => string,
): string {
  if (!snsSids.size) return html;
  return html.replace(/\[\[([a-z0-9_-]+)\]\]/g, (m, ref: string) =>
    snsSids.has(ref) ? resolveSns(ref) : m,
  );
}

async function expandContentRefs(
  env: Env,
  content: TemplateContent,
  basePath: string,
  settings?: SettingsMap,
  lang = "en",
  prefetch?: RenderPrefetch,
  filter: PubFilter = "live",
): Promise<TemplateContent> {
  const allHtml = Object.values(content).join("\n");

  // ── Data refs: [[type:all]], [[category:all]], [[articles:latest:N]], etc. ──
  const dataRefPattern = /\[\[([a-z0-9_-]+(?::[a-z0-9_-]*)+)\]\]/g;
  const dataRefs = [
    ...new Set([...allHtml.matchAll(dataRefPattern)].map((m) => m[1])),
  ];
  const dataExpanded: Record<string, string> = {};
  if (dataRefs.length) {
    for (const ref of dataRefs) {
      const parts = ref.split(":");
      try {
        if (parts[0] === "type" && parts[1] === "all") {
          const rows =
            prefetch?.types ?? (await fetchTypesWithCounts(env, filter));
          dataExpanded[ref] = JSON.stringify(rows);
        } else if (parts[0] === "type" && parts[1] && parts[1] !== "all") {
          const n = parseInt(parts[2] || "10", 10);
          const rows = await fetchArticlesByType(
            env,
            parts[1],
            lang,
            settings?.default_lang ?? "",
            1,
            n,
            filter,
          );
          dataExpanded[ref] = JSON.stringify(
            rows.map((r) => toArticleCard(r, basePath)),
          );
        } else if (parts[0] === "category" && parts[1] === "all") {
          const rows =
            prefetch?.categories ??
            (await fetchCategoriesWithCounts(env, filter));
          dataExpanded[ref] = JSON.stringify(rows);
        } else if (parts[0] === "category" && parts[1] && parts[1] !== "all") {
          const n = parseInt(parts[2] || "10", 10);
          const rows = await fetchArticlesByCategory(
            env,
            parts[1],
            lang,
            settings?.default_lang ?? "",
            1,
            n,
            filter,
          );
          dataExpanded[ref] = JSON.stringify(
            rows.map((r) => toArticleCard(r, basePath)),
          );
        } else if (parts[0] === "articles" && parts[1] === "latest") {
          const n = parseInt(parts[2] || "10", 10);
          const rows = await fetchPublishedArticles(
            env,
            lang,
            settings?.default_lang ?? "",
            1,
            n,
            filter,
          );
          dataExpanded[ref] = JSON.stringify(
            rows.map((r) => toArticleCard(r, basePath)),
          );
        } else if (parts[0] === "article" && parts[1]) {
          const r = await env.DB.prepare(
            `SELECT d.slug, d.tid, d.publish_at, d.updated_at,
                    COALESCE(NULLIF(NULLIF(dt_req.title, ''), d.slug), NULLIF(NULLIF(dt_en.title, ''), d.slug), NULLIF(NULLIF(dt_fb.title, ''), d.slug), NULLIF(NULLIF(dt_init.title, ''), d.slug), NULLIF(NULLIF(dt_site.title, ''), d.slug), NULLIF(NULLIF(dt_any.title, ''), d.slug)) AS title,
                    COALESCE(NULLIF(dt_req.summary, ''), NULLIF(dt_en.summary, ''), NULLIF(dt_fb.summary, ''), NULLIF(dt_init.summary, ''), NULLIF(dt_site.summary, ''), NULLIF(dt_any.summary, '')) AS summary,
                    COALESCE(NULLIF(dt_req.body_html, ''), NULLIF(dt_en.body_html, ''), NULLIF(dt_fb.body_html, ''), NULLIF(dt_init.body_html, ''), NULLIF(dt_site.body_html, ''), NULLIF(dt_any.body_html, '')) AS body_html
             FROM documents d
             LEFT JOIN document_translations dt_req ON dt_req.did = d.did AND dt_req.lang = ?
             LEFT JOIN document_translations dt_fb ON dt_fb.did = d.did AND dt_fb.lang = d.fallback_lang
             LEFT JOIN document_translations dt_init ON dt_init.did = d.did AND dt_init.lang = d.initial_lang
             LEFT JOIN document_translations dt_site ON dt_site.did = d.did AND dt_site.lang = ?
             LEFT JOIN document_translations dt_en ON dt_en.did = d.did AND dt_en.lang = 'en'
             LEFT JOIN document_translations dt_any ON dt_any.did = d.did AND dt_any.lang = (
               SELECT dt2.lang FROM document_translations dt2
               WHERE dt2.did = d.did
               ORDER BY dt2.updated_at DESC
               LIMIT 1
             )
             WHERE d.slug = ? AND ${publishedSql("d.", filter)} LIMIT 1`,
          )
            .bind(lang, settings?.default_lang || lang, parts[1])
            .first<{
              slug: string;
              tid: string;
              publish_at: string;
              updated_at: string;
              title: string | null;
              summary: string | null;
              body_html: string | null;
            }>();
          if (r) {
            dataExpanded[ref] = JSON.stringify({
              slug: r.slug,
              type: r.tid,
              title: r.title || r.slug,
              summary: r.summary || "",
              // data-bid / data-cbid は編集用の内部キーなので公開 JSON にも出さない
              bodyHtml: stripInternalIds(r.body_html || ""),
              publishAt: r.publish_at,
              updatedAt: r.updated_at,
            } satisfies ArticleData);
          } else {
            dataExpanded[ref] = "null";
          }
        }
      } catch {
        dataExpanded[ref] = "null";
      }
    }
  }

  // ── Media refs: [[mid-xxx]] ───────────────────────────────────────────────
  const midPattern = /\[\[([a-z0-9_-]+)\]\]/g;
  const allRefs = [
    ...new Set([...allHtml.matchAll(midPattern)].map((m) => m[1])),
  ];

  // Separate SNS SIDs from media MIDs
  const extConns =
    prefetch?.externalConnections ?? (await fetchExternalConnections(env));
  const { snsSids, resolveSns } = buildSnsContext(settings, extConns);

  const mids = allRefs.filter((ref) => !snsSids.has(ref));

  const mediaMap: Record<
    string,
    { kind: string; public_path: string; cache_version: string }
  > = {};
  if (mids.length) {
    const BATCH = 50;
    for (let i = 0; i < mids.length; i += BATCH) {
      const chunk = mids.slice(i, i + BATCH);
      const ph = chunk.map(() => "?").join(",");
      const rows = await env.DB.prepare(
        `SELECT mid, kind, public_path, cache_version FROM media_assets WHERE mid IN (${ph})`,
      )
        .bind(...chunk)
        .all<{
          mid: string;
          kind: string;
          public_path: string;
          cache_version: string;
        }>();
      for (const r of rows.results ?? []) mediaMap[r.mid] = r;
    }
  }

  const expand = (html: string): string => {
    let out = html.replace(/\[\[([a-z0-9_-]+)\]\]/g, (_, ref: string) => {
      // SNS widget reference
      if (snsSids.has(ref)) {
        return resolveSns(ref);
      }
      // Media reference
      const m = mediaMap[ref];
      if (!m) return `<!-- media not found: ${ref} -->`;
      const src = `${basePath}${m.public_path}?v=${m.cache_version}`;
      if (m.kind === "image")
        return `<img src="${src}" loading="lazy" style="max-width:100%;height:auto;border-radius:8px">`;
      if (m.kind === "video")
        return `<video src="${src}" controls style="max-width:100%"></video>`;
      if (m.kind === "audio") return `<audio src="${src}" controls></audio>`;
      return `<a href="${src}">${ref}</a>`;
    });
    if (basePath) {
      out = out.replace(
        /src="(\/(images|videos|audios)\/)/g,
        `src="${basePath}$1`,
      );
    }
    return out;
  };

  // Apply data refs first, then bare media/sns refs, then the KuroEditor link
  // notation (card / wiki / hyper — expandSpecialLinks). 先行2パスが bare
  // トークン（[[mid]] / [[sns]] / [[a:b]]）を消費するため、最終パスには '|'
  // を含む wiki 形・[a-z0-9_-] に収まらない URL hyper 形・[[[card]]] だけが
  // 残り、パターンは重ならない。
  const resolveMid: MidResolver = (mid) => {
    const m = mediaMap[mid];
    return m ? `${basePath}${m.public_path}?v=${m.cache_version}` : null;
  };
  const afterData = Object.fromEntries(
    Object.entries(content).map(([k, v]) => [
      k,
      v.replace(
        /\[\[([a-z0-9_-]+(?::[a-z0-9_-]*)+)\]\]/g,
        (_, ref: string) =>
          dataExpanded[ref] ?? `<!-- data ref not found: ${ref} -->`,
      ),
    ]),
  );
  return Object.fromEntries(
    Object.entries(afterData).map(([k, v]) => [
      k,
      expandSpecialLinks(expand(v), basePath, resolveMid),
    ]),
  );
}

async function fetchTemplateContent(
  env: Env,
  lang: string,
  defaultLang = "",
): Promise<TemplateContent> {
  // Fetch: lang='' (legacy safety net) + defaultLang (fallback) + requested lang (override)
  const rows = await env.DB.prepare(
    `SELECT id, name, lang FROM taxonomy_items WHERE kind = 'template' AND (lang = '' OR lang = ? OR lang = ?)`,
  )
    .bind(defaultLang || lang, lang)
    .all<{ id: string; name: string; lang: string }>();
  const result: TemplateContent = {};
  // Priority: '' (legacy) → defaultLang → requested lang.
  // IMPORTANT: an EMPTY value never overrides a lower-priority non-empty one.
  // Enabling a language creates a blank row per site-text key; without this
  // guard those blanks would override the base-language value and the logo /
  // hero title / etc. would render as nothing on not-yet-translated languages.
  // Empty (untranslated) site text therefore falls back to the base language.
  for (const r of rows.results ?? []) {
    if (r.lang === "" && r.name && !(r.id in result)) result[r.id] = r.name;
  }
  if (defaultLang && defaultLang !== lang) {
    for (const r of rows.results ?? []) {
      if (r.lang === defaultLang && r.name) result[r.id] = r.name;
    }
  }
  for (const r of rows.results ?? []) {
    if (r.lang === lang && r.name) result[r.id] = r.name;
  }
  return result;
}

async function fetchTypesWithCounts(
  env: Env,
  filter: PubFilter = "live",
): Promise<TypeItem[]> {
  const rows = await env.DB.prepare(
    `SELECT ti.id, ti.name, COALESCE(ti.slug, ti.id) AS slug,
            COUNT(d.did) AS count
     FROM taxonomy_items ti
     LEFT JOIN documents d ON d.tid = ti.id AND ${publishedSql("d.", filter)}
     WHERE ti.kind = 'type' AND ti.lang = ''
     GROUP BY ti.id
     ORDER BY ti.name`,
  ).all<TypeItem>();
  return rows.results ?? [];
}

async function fetchCategoriesWithCounts(
  env: Env,
  filter: PubFilter = "live",
): Promise<CategoryItem[]> {
  const rows = await env.DB.prepare(
    `SELECT ti.id, ti.name, COALESCE(ti.slug, ti.id) AS slug,
            COUNT(DISTINCT dc.did) AS count
     FROM categories ti
     LEFT JOIN document_categories dc ON dc.cid = ti.id
     LEFT JOIN documents d ON d.did = dc.did AND ${publishedSql("d.", filter)}
     GROUP BY ti.id
     ORDER BY ti.name`,
  ).all<CategoryItem>();
  return rows.results ?? [];
}

async function countArticlesByCategory(
  env: Env,
  categorySlug: string,
  filter: PubFilter = "live",
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM documents d
     JOIN document_categories dc ON dc.did = d.did
     JOIN categories ti ON ti.id = dc.cid AND (ti.slug = ? OR ti.id = ?)
     WHERE ${publishedSql("d.", filter)}`,
  )
    .bind(categorySlug, categorySlug)
    .first<{ cnt: number }>();
  return row?.cnt ?? 0;
}

async function fetchArticlesByCategory(
  env: Env,
  categorySlug: string,
  lang: string,
  defaultLang = "",
  page = 1,
  limit = 30,
  filter: PubFilter = "live",
): Promise<ArticleRow[]> {
  const offset = (page - 1) * limit;
  const rows = await env.DB.prepare(
    `SELECT d.did, d.slug, d.tid, d.publish_at, d.updated_at,
            COALESCE(NULLIF(NULLIF(dt_req.title, ''), d.slug), NULLIF(NULLIF(dt_en.title, ''), d.slug), NULLIF(NULLIF(dt_fb.title, ''), d.slug), NULLIF(NULLIF(dt_init.title, ''), d.slug), NULLIF(NULLIF(dt_site.title, ''), d.slug), NULLIF(NULLIF(dt_any.title, ''), d.slug)) AS title,
            COALESCE(NULLIF(dt_req.summary, ''), NULLIF(dt_en.summary, ''), NULLIF(dt_fb.summary, ''), NULLIF(dt_init.summary, ''), NULLIF(dt_site.summary, ''), NULLIF(dt_any.summary, '')) AS summary,
            COALESCE(NULLIF(dt_req.body_html, ''), NULLIF(dt_en.body_html, ''), NULLIF(dt_fb.body_html, ''), NULLIF(dt_init.body_html, ''), NULLIF(dt_site.body_html, ''), NULLIF(dt_any.body_html, '')) AS body_html,
            COALESCE(NULLIF(NULLIF(dt_req.seo_json, ''), '{}'), NULLIF(NULLIF(dt_en.seo_json, ''), '{}'), NULLIF(NULLIF(dt_fb.seo_json, ''), '{}'), NULLIF(NULLIF(dt_init.seo_json, ''), '{}'), NULLIF(NULLIF(dt_site.seo_json, ''), '{}'), NULLIF(NULLIF(dt_any.seo_json, ''), '{}')) AS seo_json,
            (SELECT json_group_array(json_object('id',ti2.id,'name',ti2.name,'slug',COALESCE(ti2.slug,ti2.id),'count',0))
             FROM document_categories dc2 JOIN categories ti2 ON ti2.id=dc2.cid
             WHERE dc2.did=d.did ORDER BY ti2.name) AS categories_json
     FROM documents d
     JOIN document_categories dc ON dc.did = d.did
     JOIN categories ti ON ti.id = dc.cid AND (ti.slug = ? OR ti.id = ?)
     LEFT JOIN document_translations dt_req ON dt_req.did = d.did AND dt_req.lang = ?
     LEFT JOIN document_translations dt_fb ON dt_fb.did = d.did AND dt_fb.lang = d.fallback_lang
     LEFT JOIN document_translations dt_init ON dt_init.did = d.did AND dt_init.lang = d.initial_lang
     LEFT JOIN document_translations dt_site ON dt_site.did = d.did AND dt_site.lang = ?
     LEFT JOIN document_translations dt_en ON dt_en.did = d.did AND dt_en.lang = 'en'
     LEFT JOIN document_translations dt_any ON dt_any.did = d.did AND dt_any.lang = (
       SELECT dt2.lang FROM document_translations dt2
       WHERE dt2.did = d.did
       ORDER BY dt2.updated_at DESC
       LIMIT 1
     )
     WHERE ${publishedSql("d.", filter)}
     ORDER BY d.publish_at DESC, d.did DESC LIMIT ? OFFSET ?`,
  )
    .bind(categorySlug, categorySlug, lang, defaultLang || lang, limit, offset)
    .all<ArticleRow>();
  return rows.results ?? [];
}

async function fetchArticlesByType(
  env: Env,
  typeSlug: string,
  lang: string,
  defaultLang = "",
  page = 1,
  limit = 30,
  filter: PubFilter = "live",
): Promise<ArticleRow[]> {
  const offset = (page - 1) * limit;
  const rows = await env.DB.prepare(
    `SELECT d.did, d.slug, d.tid, d.publish_at, d.updated_at,
            COALESCE(NULLIF(NULLIF(dt_req.title, ''), d.slug), NULLIF(NULLIF(dt_en.title, ''), d.slug), NULLIF(NULLIF(dt_fb.title, ''), d.slug), NULLIF(NULLIF(dt_init.title, ''), d.slug), NULLIF(NULLIF(dt_site.title, ''), d.slug), NULLIF(NULLIF(dt_any.title, ''), d.slug)) AS title,
            COALESCE(NULLIF(dt_req.summary, ''), NULLIF(dt_en.summary, ''), NULLIF(dt_fb.summary, ''), NULLIF(dt_init.summary, ''), NULLIF(dt_site.summary, ''), NULLIF(dt_any.summary, '')) AS summary,
            COALESCE(NULLIF(dt_req.body_html, ''), NULLIF(dt_en.body_html, ''), NULLIF(dt_fb.body_html, ''), NULLIF(dt_init.body_html, ''), NULLIF(dt_site.body_html, ''), NULLIF(dt_any.body_html, '')) AS body_html,
            COALESCE(NULLIF(NULLIF(dt_req.seo_json, ''), '{}'), NULLIF(NULLIF(dt_en.seo_json, ''), '{}'), NULLIF(NULLIF(dt_fb.seo_json, ''), '{}'), NULLIF(NULLIF(dt_init.seo_json, ''), '{}'), NULLIF(NULLIF(dt_site.seo_json, ''), '{}'), NULLIF(NULLIF(dt_any.seo_json, ''), '{}')) AS seo_json,
            (SELECT json_group_array(json_object('id',ti2.id,'name',ti2.name,'slug',COALESCE(ti2.slug,ti2.id),'count',0))
             FROM document_categories dc JOIN categories ti2 ON ti2.id=dc.cid
             WHERE dc.did=d.did ORDER BY ti2.name) AS categories_json
     FROM documents d
     JOIN taxonomy_items ti ON ti.id = d.tid AND ti.kind = 'type' AND (COALESCE(ti.slug, ti.id) = ? OR ti.id = ?)
     LEFT JOIN document_translations dt_req ON dt_req.did = d.did AND dt_req.lang = ?
     LEFT JOIN document_translations dt_fb ON dt_fb.did = d.did AND dt_fb.lang = d.fallback_lang
     LEFT JOIN document_translations dt_init ON dt_init.did = d.did AND dt_init.lang = d.initial_lang
     LEFT JOIN document_translations dt_site ON dt_site.did = d.did AND dt_site.lang = ?
     LEFT JOIN document_translations dt_en ON dt_en.did = d.did AND dt_en.lang = 'en'
     LEFT JOIN document_translations dt_any ON dt_any.did = d.did AND dt_any.lang = (
       SELECT dt2.lang FROM document_translations dt2
       WHERE dt2.did = d.did
       ORDER BY dt2.updated_at DESC
       LIMIT 1
     )
     WHERE ${publishedSql("d.", filter)}
     ORDER BY d.publish_at DESC, d.did DESC LIMIT ? OFFSET ?`,
  )
    .bind(typeSlug, typeSlug, lang, defaultLang || lang, limit, offset)
    .all<ArticleRow>();
  return rows.results ?? [];
}

// ─── Scoped article fetch (latest / month archives) ──────────────────────────
// The home/type/category listing queries above share one large SELECT and the
// same translation-fallback joins; only the scope JOIN, the extra WHERE (live
// window / month), and the ORDER/LIMIT differ. The helpers below factor that
// out so the "latest view" and "/monthly/YYYY/MM/" archives reuse exactly the
// same column/fallback logic. Subquery aliases (dcx/tix) are chosen to never
// collide with any scope's outer aliases (d/ti/dc/dt_*).
const ARTICLE_COLS = `d.did, d.slug, d.tid, d.publish_at, d.updated_at,
  COALESCE(NULLIF(NULLIF(dt_req.title, ''), d.slug), NULLIF(NULLIF(dt_en.title, ''), d.slug), NULLIF(NULLIF(dt_fb.title, ''), d.slug), NULLIF(NULLIF(dt_init.title, ''), d.slug), NULLIF(NULLIF(dt_site.title, ''), d.slug), NULLIF(NULLIF(dt_any.title, ''), d.slug)) AS title,
  COALESCE(NULLIF(dt_req.summary, ''), NULLIF(dt_en.summary, ''), NULLIF(dt_fb.summary, ''), NULLIF(dt_init.summary, ''), NULLIF(dt_site.summary, ''), NULLIF(dt_any.summary, '')) AS summary,
  COALESCE(NULLIF(dt_req.body_html, ''), NULLIF(dt_en.body_html, ''), NULLIF(dt_fb.body_html, ''), NULLIF(dt_init.body_html, ''), NULLIF(dt_site.body_html, ''), NULLIF(dt_any.body_html, '')) AS body_html,
  COALESCE(NULLIF(NULLIF(dt_req.seo_json, ''), '{}'), NULLIF(NULLIF(dt_en.seo_json, ''), '{}'), NULLIF(NULLIF(dt_fb.seo_json, ''), '{}'), NULLIF(NULLIF(dt_init.seo_json, ''), '{}'), NULLIF(NULLIF(dt_site.seo_json, ''), '{}'), NULLIF(NULLIF(dt_any.seo_json, ''), '{}')) AS seo_json,
  (SELECT json_group_array(json_object('id',tix.id,'name',tix.name,'slug',COALESCE(tix.slug,tix.id),'count',0))
   FROM document_categories dcx JOIN categories tix ON tix.id=dcx.cid
   WHERE dcx.did=d.did ORDER BY tix.name) AS categories_json`;

// Two binds, in order: (1) requested lang, (2) site/default lang.
const ARTICLE_TR_JOINS = `LEFT JOIN document_translations dt_req ON dt_req.did = d.did AND dt_req.lang = ?
  LEFT JOIN document_translations dt_fb ON dt_fb.did = d.did AND dt_fb.lang = d.fallback_lang
  LEFT JOIN document_translations dt_init ON dt_init.did = d.did AND dt_init.lang = d.initial_lang
  LEFT JOIN document_translations dt_site ON dt_site.did = d.did AND dt_site.lang = ?
  LEFT JOIN document_translations dt_en ON dt_en.did = d.did AND dt_en.lang = 'en'
  LEFT JOIN document_translations dt_any ON dt_any.did = d.did AND dt_any.lang = (
    SELECT dt2.lang FROM document_translations dt2 WHERE dt2.did = d.did ORDER BY dt2.updated_at DESC LIMIT 1
  )`;

export type ArticleScope =
  | { kind: "home" }
  | { kind: "type"; slug: string }
  | { kind: "category"; slug: string };

const LATEST_WINDOW_DAYS = 30;
const LATEST_MIN = 30;

function scopeFromSql(scope: ArticleScope): { sql: string; binds: string[] } {
  if (scope.kind === "type")
    return {
      sql: `JOIN taxonomy_items ti ON ti.id = d.tid AND ti.kind = 'type' AND (COALESCE(ti.slug, ti.id) = ? OR ti.id = ?)`,
      binds: [scope.slug, scope.slug],
    };
  if (scope.kind === "category")
    return {
      sql: `JOIN document_categories dc ON dc.did = d.did JOIN categories ti ON ti.id = dc.cid AND (ti.slug = ? OR ti.id = ?)`,
      binds: [scope.slug, scope.slug],
    };
  return { sql: "", binds: [] };
}

async function fetchArticlesScoped(
  env: Env,
  scope: ArticleScope,
  lang: string,
  defaultLang: string,
  opts: {
    extraWhere?: string;
    extraBinds?: (string | number)[];
    limit?: number;
    offset?: number;
    filter?: PubFilter;
  } = {},
): Promise<ArticleRow[]> {
  const {
    extraWhere = "",
    extraBinds = [],
    limit,
    offset = 0,
    filter = "live",
  } = opts;
  const sc = scopeFromSql(scope);
  const limitSql = limit != null ? " LIMIT ? OFFSET ?" : "";
  const sql =
    `SELECT ${ARTICLE_COLS} FROM documents d ${sc.sql} ${ARTICLE_TR_JOINS} ` +
    `WHERE ${publishedSql("d.", filter)} ${extraWhere} ` +
    `ORDER BY d.publish_at DESC, d.did DESC${limitSql}`;
  const binds: (string | number)[] = [
    ...sc.binds,
    lang,
    defaultLang || lang,
    ...extraBinds,
  ];
  if (limit != null) binds.push(limit, offset);
  const rows = await env.DB.prepare(sql)
    .bind(...binds)
    .all<ArticleRow>();
  return rows.results ?? [];
}

/**
 * Latest view: articles published in the last 30 days (no upper cap). When that
 * window holds fewer than 30, fall back to the 30 most recent so the listing is
 * never sparse. See plan: time-drift is accepted (build-time refresh only).
 */
async function fetchArticlesLatest(
  env: Env,
  scope: ArticleScope,
  lang: string,
  defaultLang = "",
  filter: PubFilter = "live",
): Promise<ArticleRow[]> {
  const windowed = await fetchArticlesScoped(env, scope, lang, defaultLang, {
    extraWhere: `AND datetime(d.publish_at) >= datetime('now','-${LATEST_WINDOW_DAYS} days')`,
    filter,
  });
  if (windowed.length >= LATEST_MIN) return windowed;
  return fetchArticlesScoped(env, scope, lang, defaultLang, {
    limit: LATEST_MIN,
    filter,
  });
}

/** All articles published within a single calendar month (month = 'YYYY-MM'). */
async function fetchArticlesByMonth(
  env: Env,
  scope: ArticleScope,
  month: string,
  lang: string,
  defaultLang = "",
  filter: PubFilter = "live",
): Promise<ArticleRow[]> {
  return fetchArticlesScoped(env, scope, lang, defaultLang, {
    extraWhere: `AND strftime('%Y-%m', datetime(d.publish_at)) = ?`,
    extraBinds: [month],
    filter,
  });
}

/**
 * Completed months (descending) that have at least one published article in the
 * scope. The current month is excluded — its posts live in the latest view and
 * never get a (mutable) archive page.
 */
async function fetchDistinctMonths(
  env: Env,
  scope: ArticleScope,
  filter: PubFilter = "live",
): Promise<string[]> {
  const sc = scopeFromSql(scope);
  const rows = await env.DB.prepare(
    `SELECT DISTINCT strftime('%Y-%m', datetime(d.publish_at)) AS ym FROM documents d ${sc.sql} ` +
      `WHERE ${publishedSql("d.", filter)} ` +
      `AND strftime('%Y-%m', datetime(d.publish_at)) < strftime('%Y-%m', 'now') ` +
      `ORDER BY ym DESC`,
  )
    .bind(...sc.binds)
    .all<{ ym: string }>();
  return (rows.results ?? []).map((r) => r.ym).filter(Boolean);
}

/** Live article count per category slug — for the single shared counts KV value. */
async function fetchAllCategoryCounts(
  env: Env,
  filter: PubFilter = "live",
): Promise<Record<string, number>> {
  const rows = await env.DB.prepare(
    `SELECT COALESCE(ti.slug, ti.id) AS slug, COUNT(DISTINCT dc.did) AS count
     FROM categories ti
     LEFT JOIN document_categories dc ON dc.cid = ti.id
     LEFT JOIN documents d ON d.did = dc.did AND ${publishedSql("d.", filter)}
     GROUP BY ti.id`,
  ).all<{ slug: string; count: number }>();
  const out: Record<string, number> = {};
  for (const r of rows.results ?? []) out[r.slug] = r.count;
  return out;
}

// Single shared KV value holding live nav counts for ALL types AND categories.
// Read by the `/_counts.js` asset and filled into the nav client-side, so a
// count change rewrites ONE KV value instead of rebuilding every page that
// shows a count. Shape: { type: {slug:n}, category: {slug:n}, _v }.
const NAV_COUNTS_KEY = "_cfg/nav_counts";

/** Live nav counts for both kinds (for the single shared counts KV value). */
async function fetchNavCounts(
  env: Env,
  filter: PubFilter = "live",
): Promise<{ type: Record<string, number>; category: Record<string, number> }> {
  const [types, category] = await Promise.all([
    fetchTypesWithCounts(env, filter),
    fetchAllCategoryCounts(env, filter),
  ]);
  const type: Record<string, number> = {};
  for (const t of types) type[t.slug] = t.count ?? 0;
  return { type, category };
}

/** Recompute and persist the shared nav-counts KV value. */
async function writeNavCounts(
  env: Env,
  filter: PubFilter = "live",
): Promise<void> {
  if (!env.PUBLIC_PAGES) return;
  const counts = await fetchNavCounts(env, filter);
  await env.PUBLIC_PAGES.put(
    NAV_COUNTS_KEY,
    JSON.stringify({ ...counts, _v: Date.now() }),
  );
}

/**
 * `/_counts.js` body: exposes live nav counts as `window.__kuroCounts` AND fills
 * them in, so the nav never bakes fluctuating numbers into (cacheable) page HTML.
 * Templates only need a `data-kuro-count="type:{slug}"` / `"category:{slug}"`
 * element (text) or `data-kuro-count-bar="..."` (CSS width) plus one script tag.
 * Falls back to a live DB read when the KV value is missing (pre-first-build).
 */
export async function buildCountsJs(env: Env): Promise<string> {
  let json = "{}";
  try {
    const raw = env.PUBLIC_PAGES
      ? await env.PUBLIC_PAGES.get(NAV_COUNTS_KEY)
      : null;
    json = raw || JSON.stringify(await fetchNavCounts(env));
  } catch {
    /* keep empty object */
  }
  return (
    `window.__kuroCounts=${json};` +
    `(function(){var c=window.__kuroCounts||{};` +
    `function g(k){var i=k.indexOf(":");if(i<0)return;var m=c[k.slice(0,i)]||{};return m[k.slice(i+1)];}` +
    `function run(){` +
    `document.querySelectorAll("[data-kuro-count]").forEach(function(e){var n=g(e.getAttribute("data-kuro-count"));if(n!=null)e.textContent=n;});` +
    `document.querySelectorAll("[data-kuro-count-bar]").forEach(function(e){var n=g(e.getAttribute("data-kuro-count-bar"));if(n!=null)e.style.width=(Number(n)*10)+"%";});` +
    `}` +
    `if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",run);else run();})();`
  );
}

// ─── Archives dropdown widget (replaces the page/N pagination) ────────────────
function escHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── KuroEditor リンク記法の公開ビルド展開 ────────────────────────────────────
// KuroEditor は保存本文（body_html）にリンク・メディアを [[...]] トークンで
// 保持する（getContent → unrenderSpecialLinks）。公開ビルドは KuroEditor の
// renderSpecialLinks（KE 2.6.0）と同じ優先順位・同じクラスのマークアップへ
// 展開する（編集専用の data-kuro-* / contenteditable は付けない）:
//   [[[card]]]           → カードリンク <a class="kuro-card-link">
//   [[slug|]]            → URL カード <a class="kuro-url-card">（表題なしの明示）
//   [[slug|60%,right]]   → メディア figure（サイズ/寄せ/クリックリンク params）
//   [[YouTube等URL|…]]   → 16:9 iframe figure（YouTube / Vimeo）
//   [[slug|表示テキスト]] → 通常リンク <a>表示テキスト</a>
//   [[URL]]              → embed / メディア / 素リンク（hyper 形）
// スタイルは ke-content.css（KuroEditor content.css）が公開ページにも当たる。
// URL カードのタイトルはサーバー側で URL 自体から得られる情報のみ使う
// （http(s) はホスト名、内部 slug は slug 文字列）。KuroEditor の onFetchUrlMeta
// による「豪華表示」は編集時のクライアント側のみ。
//
// この展開は expand()（bare [[mid]] / [[sns]] トークン）と data ref（[[a:b]]）
// の【後】に走る: 先行パスが消費した bare トークンには触れず、'|' を含む wiki
// 形・[a-z0-9_-] に収まらない URL hyper 形・[[[card]]] だけが残っている。
const KE_URL_CARD_ICON =
  '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">' +
  '<circle cx="8" cy="8" r="6.5"/>' +
  '<ellipse cx="8" cy="8" rx="2.8" ry="6.5"/>' +
  '<line x1="1.5" y1="8" x2="14.5" y2="8"/>' +
  "</svg>";

// KuroEditor の MEDIA_EXT_RE / VIDEO_EXT_RE / AUDIO_EXT_RE と同一定義。
const KE_MEDIA_EXT_RE =
  /\.(jpe?g|png|gif|webp|svg|avif|mp4|webm|ogg|mov|mp3|wav|aac|flac|m4a)(\?.*)?$/i;
const KE_VIDEO_EXT_RE = /\.(mp4|webm|mov)(\?.*)?$/i;
const KE_AUDIO_EXT_RE = /\.(mp3|wav|aac|flac|m4a|oga)(\?.*)?$/i;

/** KuroEditor parseMediaParams と同一: "60%,right|https://…" を分解。 */
function keParseMediaParams(params: string): {
  size: string | null;
  align: string | null;
  link: string | null;
} {
  const result: {
    size: string | null;
    align: string | null;
    link: string | null;
  } = { size: null, align: null, link: null };
  if (!params) return result;
  let sizeAlignPart = params;
  const pipeIdx = params.indexOf("|");
  if (pipeIdx !== -1) {
    result.link = params.slice(pipeIdx + 1).trim() || null;
    sizeAlignPart = params.slice(0, pipeIdx);
  }
  for (const part of sizeAlignPart
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (/^\d+%$/.test(part)) result.size = part;
    else if (part === "left" || part === "right" || part === "center")
      result.align = part;
  }
  return result;
}

/** KuroEditor _looksLikeMediaParams と同一のヒューリスティック。 */
function keLooksLikeMediaParams(label: string): boolean {
  if (!label) return false;
  const paramsPart =
    label.indexOf("|") !== -1 ? label.slice(0, label.indexOf("|")) : label;
  const trimmed = paramsPart.trim();
  if (trimmed === "") return true; // "|https://…" = リンクのみ
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .every(
      (t) =>
        /^\d+%$/.test(t) || t === "left" || t === "right" || t === "center",
    );
}

/** KuroEditor resolveEmbedUrl と同一: YouTube / Vimeo の埋め込み URL 解決。 */
function keResolveEmbedUrl(url: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtube.com") {
      const v = u.searchParams.get("v");
      if (v) return `https://www.youtube.com/embed/${v}`;
      const shorts = u.pathname.match(/^\/shorts\/([^/]+)/);
      if (shorts) return `https://www.youtube.com/embed/${shorts[1]}`;
    }
    if (host === "youtu.be") {
      const id = u.pathname.slice(1);
      if (id) return `https://www.youtube.com/embed/${id}`;
    }
    if (host === "vimeo.com") {
      const id = u.pathname.replace(/\D/g, "");
      if (id) return `https://player.vimeo.com/video/${id}`;
    }
  } catch {
    /* not a URL */
  }
  return null;
}

/** 16:9 iframe figure（KuroEditor _buildIframeFigure の公開版）。 */
function keIframeFigure(
  embedUrl: string,
  size: string | null,
  align: string | null,
): string {
  const sizeStyle = size && size !== "100%" ? ` style="width:${size}"` : "";
  const alignClass = align ? ` kuro-media-wrap--${align}` : "";
  return (
    `<figure class="kuro-media-wrap kuro-media-wrap--iframe${alignClass}"${sizeStyle}>` +
    `<div class="kuro-iframe-wrap">` +
    `<iframe src="${escHtml(embedUrl)}" class="kuro-media kuro-media--iframe" allowfullscreen frameborder="0" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" title="埋め込み動画"></iframe>` +
    `</div></figure>`
  );
}

/** メディア figure（KuroEditor wiki/hyper メディア分岐の公開版）。 */
function keMediaFigure(
  src: string,
  size: string | null,
  align: string | null,
  link: string | null,
): string {
  const sizeStyle = size && size !== "100%" ? ` style="width:${size}"` : "";
  const alignClass = align ? ` kuro-media-wrap--${align}` : "";
  const linkBtn = link
    ? `<a class="kuro-media-open-link" href="${escHtml(link)}" target="_blank" rel="noopener">↗ URLを新規タブで開く</a>`
    : "";
  const esc = escHtml(src);
  if (KE_VIDEO_EXT_RE.test(src)) {
    return `<figure class="kuro-media-wrap kuro-media-wrap--video${alignClass}"${sizeStyle}><video src="${esc}" controls class="kuro-media kuro-media--video"></video>${linkBtn}</figure>`;
  }
  if (KE_AUDIO_EXT_RE.test(src)) {
    return `<figure class="kuro-media-wrap kuro-media-wrap--audio${alignClass}"${sizeStyle}><audio src="${esc}" controls class="kuro-media kuro-media--audio"></audio>${linkBtn}</figure>`;
  }
  return `<figure class="kuro-media-wrap${alignClass}"${sizeStyle}><img src="${esc}" alt="" loading="lazy" class="kuro-media">${linkBtn}</figure>`;
}

/** URL カード（[[slug|]]）のアンカー。 */
function keUrlCard(slug: string, href: string): string {
  const isHttp = /^https?:\/\//i.test(slug);
  let title = slug;
  if (isHttp) {
    try {
      title = new URL(slug).hostname;
    } catch {
      /* keep raw slug as title */
    }
  }
  const sub = isHttp ? slug : href;
  const ext = isHttp ? ' target="_blank" rel="noopener"' : "";
  return (
    `<a href="${escHtml(href)}"${ext} class="kuro-url-card">` +
    `<span class="kuro-url-card__icon">${KE_URL_CARD_ICON}</span>` +
    `<span class="kuro-url-card__body">` +
    `<span class="kuro-url-card__title">${escHtml(title)}</span>` +
    `<span class="kuro-url-card__url">${escHtml(sub)}</span>` +
    `</span>` +
    `<span class="kuro-url-card__arrow">↗</span>` +
    `</a>`
  );
}

/** mid / URL / 内部 slug を href に解決する（mid は resolveMid に委譲）。 */
type MidResolver = (mid: string) => string | null;

function expandSpecialLinks(
  html: string,
  basePath: string,
  resolveMid: MidResolver = () => null,
): string {
  const resolve = (slug: string): string | null => {
    if (/^https?:\/\//i.test(slug)) return slug;
    if (/^(img|vid|aud|mid)-/.test(slug)) return resolveMid(slug);
    return `${basePath}/${slug.replace(/^\/+/, "")}`;
  };
  // KuroEditor renderSpecialLinks と同じ単一パス・同じ優先順位
  // （card > wiki > hyper）。
  const RE =
    /\[\[\[([^\]]+)\]\]\]|\[\[([^\]|]+)\|([^\]]*)\]\]|\[\[([^\]]+)\]\]/g;
  return html.replace(
    RE,
    (
      match,
      card?: string,
      wikiSlug?: string,
      wikiLabel?: string,
      hyper?: string,
    ) => {
      if (card !== undefined) {
        const url = resolve(card);
        if (!url) return `<!-- media not found: ${escHtml(card)} -->`;
        return `<a href="${escHtml(url)}" target="_blank" rel="noopener" class="kuro-card-link">${escHtml(card)}</a>`;
      }

      if (wikiSlug !== undefined && wikiLabel !== undefined) {
        const url = resolve(wikiSlug);
        if (!url) return `<!-- media not found: ${escHtml(wikiSlug)} -->`;
        // ⓪ 空ラベル = 表題なしの明示 → URL カード
        if (wikiLabel === "") return keUrlCard(wikiSlug, url);
        // ① iframe embed（メディア拡張子より先に判定 — KE と同順）
        const embedUrl = keResolveEmbedUrl(url);
        if (embedUrl) {
          const { size, align } = keParseMediaParams(wikiLabel);
          return keIframeFigure(embedUrl, size, align);
        }
        // ② メディア（mid 系 / 拡張子 / params らしきラベルの http URL）
        const isMedia =
          /^(img|vid|aud|mid)-/.test(wikiSlug) ||
          KE_MEDIA_EXT_RE.test(url) ||
          (/^https?:\/\//i.test(wikiSlug) && keLooksLikeMediaParams(wikiLabel));
        if (isMedia) {
          const { size, align, link } = keParseMediaParams(wikiLabel);
          return keMediaFigure(url, size, align, link);
        }
        // ③ 通常の wiki リンク [[slug|表示テキスト]]
        const ext = /^https?:\/\//i.test(wikiSlug)
          ? ' target="_blank" rel="noopener"'
          : "";
        return `<a href="${escHtml(url)}"${ext}>${escHtml(wikiLabel)}</a>`;
      }

      if (hyper !== undefined) {
        const url = resolve(hyper);
        if (!url) return `<!-- media not found: ${escHtml(hyper)} -->`;
        // ① iframe embed
        const embedUrl = keResolveEmbedUrl(url);
        if (embedUrl) return keIframeFigure(embedUrl, null, null);
        // ② メディアファイル
        if (/^(img|vid|aud|mid)-/.test(hyper) || KE_MEDIA_EXT_RE.test(url)) {
          return keMediaFigure(url, null, null, null);
        }
        // ③ 素リンク
        const ext = /^https?:\/\//i.test(hyper)
          ? ' target="_blank" rel="noopener"'
          : "";
        return `<a href="${escHtml(url)}"${ext}>${escHtml(hyper)}</a>`;
      }

      return match;
    },
  );
}

// "Latest" label for the first dropdown option. Site/UI chrome (not authored
// content), so a compact built-in map keeps it localized without new site-text
// keys; unknown langs fall back to English.
const ARCHIVE_LATEST_LABEL: Record<string, string> = {
  en: "Latest",
  ja: "最新",
  de: "Aktuell",
  fr: "Récents",
  it: "Recenti",
  es: "Recientes",
  zh: "最新",
  ko: "최신",
  uk: "Останні",
  ar: "الأحدث",
  pt: "Mais recentes",
};
function archiveLatestLabel(lang: string): string {
  return (
    ARCHIVE_LATEST_LABEL[lang] ||
    ARCHIVE_LATEST_LABEL[lang.split("-")[0]] ||
    ARCHIVE_LATEST_LABEL.en
  );
}

/** Localized "YYYY年MM月" / "Month YYYY" label for a 'YYYY-MM' archive entry. */
function monthLabel(ym: string, lang: string): string {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  try {
    return new Intl.DateTimeFormat(lang, {
      year: "numeric",
      month: "long",
    }).format(new Date(Date.UTC(y, m - 1, 1)));
  } catch {
    return `${y}-${String(m).padStart(2, "0")}`;
  }
}

/**
 * Build the `<select>` archive switcher string injected via `[[html:archives]]`.
 * First option = the latest view (scope root); the rest = completed months,
 * descending. Returns "" when there is nothing to switch between.
 */
function buildArchivesWidget(opts: {
  scope: ArticleScope;
  months: string[];
  currentMonth: string | null;
  basePath: string;
  lang: string;
}): string {
  const { scope, months, currentMonth, basePath, lang } = opts;
  let rootUrl: string;
  let monthBase: string;
  if (scope.kind === "type") {
    rootUrl = `${basePath}/${scope.slug}/`;
    monthBase = `${basePath}/${scope.slug}/monthly/`;
  } else if (scope.kind === "category") {
    rootUrl = `${basePath}/category/${scope.slug}/`;
    monthBase = `${basePath}/category/${scope.slug}/monthly/`;
  } else {
    rootUrl = `${basePath}/`;
    monthBase = `${basePath}/monthly/`;
  }
  if (months.length === 0) return ""; // only the latest view exists → no switcher

  const opt = (value: string, label: string, selected: boolean): string =>
    `<option value="${escHtml(value)}"${selected ? " selected" : ""}>${escHtml(label)}</option>`;
  const options = [
    opt(rootUrl, archiveLatestLabel(lang), currentMonth == null),
  ];
  for (const ym of months) {
    const [y, m] = ym.split("-");
    options.push(
      opt(`${monthBase}${y}/${m}/`, monthLabel(ym, lang), currentMonth === ym),
    );
  }
  return (
    `<select class="kuro-archives" aria-label="${escHtml(archiveLatestLabel(lang))}" ` +
    `onchange="if(this.value)window.location.href=this.value">${options.join("")}</select>`
  );
}

// ─── Data assembly ────────────────────────────────────────────────────────────

function toArticleCard(r: ArticleRow, basePath: string): ArticleCardData {
  let coverUrl: string | null = null;
  if (r.seo_json) {
    try {
      const seo = JSON.parse(r.seo_json) as { coverPath?: string };
      if (seo.coverPath) coverUrl = `${basePath}${seo.coverPath}`;
    } catch {
      /* ignore */
    }
  }
  let categories: CategoryItem[] = [];
  if (r.categories_json) {
    try {
      categories = JSON.parse(r.categories_json) as CategoryItem[];
    } catch {
      /* ignore */
    }
  }
  const d = formatCardDate(r.publish_at);
  return {
    slug: r.slug,
    tid: r.tid,
    title: r.title || r.slug,
    summary: r.summary || "",
    publishAt: r.publish_at,
    date: d.date,
    dateDay: d.day,
    dateYm: d.ym,
    dateWeekday: d.weekday,
    coverUrl,
    categories,
  };
}

const JP_WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** Build-time fallback only. Visible public dates are hydrated in the browser
 *  from `publishAt`, so they follow the visitor's local timezone. */
function formatCardDate(iso: string | null | undefined): {
  date: string;
  day: string;
  ym: string;
  weekday: string;
} {
  if (!iso) return { date: "", day: "", ym: "", weekday: "" };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()))
    return { date: "", day: "", ym: "", weekday: "" };
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const mm = String(m).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return {
    date: `${y}年${mm}月${dd}日`,
    day: String(day),
    ym: `${y}年${m}月`,
    weekday: JP_WEEKDAYS[d.getDay()],
  };
}

async function buildRenderContext(
  env: Env,
  path: string,
  params: Record<string, string>,
  lang: string,
  settings: SettingsMap,
  prefetch?: RenderPrefetch,
  filter: PubFilter = "live",
): Promise<RenderContext | null> {
  const basePath = settings.base_path || "";
  const LIMIT = 30;

  const [rawContent, types, categories] = await Promise.all([
    prefetch?.templateContent?.get(lang) ??
      fetchTemplateContent(env, lang, settings.default_lang ?? ""),
    prefetch?.types ?? fetchTypesWithCounts(env, filter),
    prefetch?.categories ?? fetchCategoriesWithCounts(env, filter),
  ]);
  const content = await expandContentRefs(
    env,
    rawContent,
    basePath,
    settings,
    lang,
    prefetch,
    filter,
  );

  // The About page body is authored rich content too — wrap it like the article
  // body so callouts/roundboxes render on the public page.
  if (content["about-body"]) {
    content["about-body"] = wrapKuroContent(content["about-body"]);
  }
  // Same for the legal pages' site texts (privacy policy / terms of service).
  if (content["privacy"])
    content["privacy"] = wrapKuroContent(content["privacy"]);
  if (content["terms"]) content["terms"] = wrapKuroContent(content["terms"]);

  // /privacy/ and /terms/ exist only while their site text has content (after
  // the language fallback above): an empty key means 404 — and the matching
  // [[privacy]]/[[terms]] template tokens expand to nothing (no dead links).
  if ((path === "/privacy/" || path === "/privacy") && !content["privacy"])
    return null;
  if ((path === "/terms/" || path === "/terms") && !content["terms"])
    return null;

  content["_site-name"] = settings.site_name || "";
  // Nav lists carry NO counts: counts fluctuate on every publish, so baking them
  // into page HTML would either go stale or force rebuilds. The nav shows names
  // only; live counts are filled client-side from the shared `__kuroCounts`.
  content["_nav-types"] = JSON.stringify(types.map(({ count: _c, ...t }) => t));
  content["_nav-categories"] = JSON.stringify(
    categories.map(({ count: _c, ...c }) => c),
  );
  content["_bluesky-handle"] = settings.bluesky_handle || "";

  // Site-owner display name, for the About page's ProfilePage JSON-LD
  // (earliest-created admin = the installer-created owner account).
  if (path === "/about/" || path === "/about") {
    const owner = await env.DB.prepare(
      `SELECT display_name FROM users
       WHERE is_admin = 1 AND TRIM(COALESCE(display_name, '')) != ''
       ORDER BY created_at ASC LIMIT 1`,
    )
      .first<{ display_name: string }>()
      .catch(() => null);
    content["_author-name"] = (owner?.display_name || "").trim();
  }

  const availableLangs =
    prefetch?.availableLangs ??
    (await env.DB.prepare(
      `SELECT id, COALESCE(name, id) AS name FROM taxonomy_items WHERE kind = 'language' ORDER BY id`,
    )
      .all<{ id: string; name: string }>()
      .then((r) =>
        (r.results ?? []).map((row) => ({ code: row.id, name: row.name })),
      )
      .catch(() => [] as { code: string; name: string }[]));
  content["_available-langs"] = JSON.stringify(availableLangs);

  let article: ArticleData | undefined;
  const defaultLang = settings.default_lang ?? "";

  if (params.article && params.type) {
    const r = await fetchArticleDetail(
      env,
      params.article,
      params.type,
      lang,
      defaultLang,
      filter,
    );
    if (!r) return null;
    const expandedBody = await expandContentRefs(
      env,
      { body: r.body_html || "" },
      basePath,
      settings,
      lang,
      undefined,
      filter,
    );
    let articleCategories: CategoryItem[] = [];
    if (r.categories_json) {
      try {
        articleCategories = JSON.parse(r.categories_json) as CategoryItem[];
      } catch {
        /* ignore */
      }
    }
    content["_article-categories"] = JSON.stringify(articleCategories);
    let articleCover: string | null = null;
    if (r.seo_json) {
      try {
        const seo = JSON.parse(r.seo_json) as { coverPath?: string };
        if (seo.coverPath) articleCover = `${basePath}${seo.coverPath}`;
      } catch {
        /* ignore */
      }
    }
    // CMS-appended byline (visible authorship for E-E-A-T; matches the
    // Person author emitted in the article JSON-LD). Skipped when the
    // creating user has no display name.
    const authorName = (r.author_name || "").trim();
    const bodyWithByline =
      (expandedBody.body || "") +
      (authorName
        ? buildBylineHtml(authorName, basePath, lang, defaultLang)
        : "");
    article = {
      slug: r.slug,
      type: r.tid,
      title: r.title || r.slug,
      summary: r.summary || "",
      bodyHtml: wrapKuroContent(bodyWithByline),
      publishAt: r.publish_at,
      updatedAt: r.updated_at,
      coverUrl: articleCover,
      date: formatCardDate(r.publish_at).date,
      authorName: authorName || null,
    };
  }

  // Listing scopes (home / type / category) share the same shape: a "latest"
  // view (`/`, `/{type}/`, `/category/{slug}/`) or a `/monthly/YYYY/MM/` archive,
  // plus the archives `<select>`. Legacy `/page/N/` requests (un-migrated
  // templates) keep the old paginated behaviour — served on-demand only.
  const fillListScope = async (scope: ArticleScope): Promise<void> => {
    if (params.page != null) {
      const page = parseInt(params.page || "1", 10);
      const baseUrl =
        scope.kind === "category"
          ? `${basePath}/category/${scope.slug}/`
          : scope.kind === "type"
            ? `${basePath}/${scope.slug}/`
            : `${basePath}/`;
      const [rows, total] = await Promise.all([
        scope.kind === "category"
          ? fetchArticlesByCategory(
              env,
              scope.slug,
              lang,
              defaultLang,
              page,
              LIMIT,
              filter,
            )
          : scope.kind === "type"
            ? fetchArticlesByType(
                env,
                scope.slug,
                lang,
                defaultLang,
                page,
                LIMIT,
                filter,
              )
            : fetchPublishedArticles(
                env,
                lang,
                defaultLang,
                page,
                LIMIT,
                filter,
              ),
        scope.kind === "category"
          ? countArticlesByCategory(env, scope.slug, filter)
          : scope.kind === "type"
            ? countArticlesByTypeSlug(env, scope.slug, filter)
            : countPublishedArticles(env, filter),
      ]);
      content["_articles"] = JSON.stringify(
        rows.map((r) => toArticleCard(r, basePath)),
      );
      content["_pagination"] = JSON.stringify(
        buildPagination(page, total, LIMIT, baseUrl),
      );
      return;
    }
    const month = params.month || null;
    const [rows, months] = await Promise.all([
      month
        ? fetchArticlesByMonth(env, scope, month, lang, defaultLang, filter)
        : fetchArticlesLatest(env, scope, lang, defaultLang, filter),
      fetchDistinctMonths(env, scope, filter),
    ]);
    content["_articles"] = JSON.stringify(
      rows.map((r) => toArticleCard(r, basePath)),
    );
    content["_archives-html"] = buildArchivesWidget({
      scope,
      months,
      currentMonth: month,
      basePath,
      lang,
    });
  };

  if (article) {
    // article detail already filled above — no listing
  } else if (params.category) {
    const catItem = categories.find(
      (c) => c.slug === params.category || c.id === params.category,
    );
    content["_category-name"] = catItem?.name || params.category;
    await fillListScope({ kind: "category", slug: params.category });
  } else if (params.type) {
    const typeItem = types.find(
      (t) => t.slug === params.type || t.id === params.type,
    );
    if (!typeItem) return null;
    content["_type-name"] = typeItem.name;
    await fillListScope({ kind: "type", slug: params.type });
  } else if (
    path === "/" ||
    path === "" ||
    params.page != null ||
    params.month != null
  ) {
    await fillListScope({ kind: "home" });
  }
  // else: static template page (e.g. /about/) — no article injection needed

  return { path, params, content, article, lang, basePath };
}

/** Languages for which an article has a translation (for the switcher gray-out). */
async function fetchArticleLangs(
  env: Env,
  tid: string,
  slug: string,
): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT dt.lang FROM documents d
     JOIN document_translations dt ON dt.did = d.did
     WHERE d.tid = ? AND d.slug = ?
       AND (
         NULLIF(dt.body_html, '') IS NOT NULL
         OR NULLIF(dt.summary, '') IS NOT NULL
         OR (NULLIF(dt.title, '') IS NOT NULL AND dt.title <> d.slug)
       )`,
  )
    .bind(tid, slug)
    .all<{ lang: string }>()
    .catch(() => ({ results: [] as { lang: string }[] }));
  return (rows.results ?? []).map((r) => r.lang).filter(Boolean);
}

export async function generatePage(
  env: Env,
  path: string,
  params: Record<string, string>,
  lang: string,
  template: StoredTemplate,
  settings?: SettingsMap,
  prefetch?: RenderPrefetch,
  filter: PubFilter = "live",
): Promise<string | null> {
  const s = settings ?? (await fetchSettings(env));
  const ctx = await buildRenderContext(
    env,
    path,
    params,
    lang,
    s,
    prefetch,
    filter,
  );
  if (!ctx) return null;
  // Spec §12: `[[sid]]` in the template body renders the SNS widget in place.
  // Expand before the template parser consumes the token (it would otherwise
  // resolve `[[sns-001]]` as an unknown value path and drop it).
  const extConns =
    prefetch?.externalConnections ?? (await fetchExternalConnections(env));
  const { snsSids, resolveSns } = buildSnsContext(s, extConns);
  let sourceHtml = expandSnsRefs(template.sourceHtml, snsSids, resolveSns);

  // Languages registered site-wide (for the switcher list / hreflang fallback).
  let availableLangs: Array<{ code: string; name: string }> = [];
  try {
    availableLangs = JSON.parse(ctx.content["_available-langs"] || "[]");
  } catch {
    /* ignore */
  }
  // Languages available for THIS page (others are grayed-out in the switcher and
  // are NOT emitted as hreflang alternates): articles → their translation langs;
  // other pages → all registered langs. Computed once and reused for SEO.
  let pageLangs: string[];
  if (params.article && params.type) {
    const key = `${params.type}/${params.article}`;
    pageLangs =
      prefetch?.articleLangs?.get(key) ??
      (await fetchArticleLangs(env, params.type, params.article));
  } else {
    pageLangs = availableLangs.map((l) => l.code);
  }

  // `[[lang]]` → language switcher widget. Expand before the parser drops it.
  if (sourceHtml.includes("[[lang]]")) {
    sourceHtml = sourceHtml
      .split("[[lang]]")
      .join(buildLanguageWidget(lang, availableLangs, new Set(pageLangs)));
  }
  // `[[privacy]]` / `[[terms]]` → links to the dedicated legal pages (same
  // source-token family as [[lang]]/[[sid]]). Expanded to a plain inheriting
  // <a> so the template's own footer/nav styling applies. While the backing
  // site text is empty the token expands to nothing, so templates can embed
  // these unconditionally without producing dead links.
  for (const legal of ["privacy", "terms"] as const) {
    const token = `[[${legal}]]`;
    if (!sourceHtml.includes(token)) continue;
    const link = ctx.content[legal]
      ? `<a href="${seoAttr(`${ctx.basePath}/${legal}/`)}" class="kuro-legal-link kuro-legal-link--${legal}">${seoText(legalPageLabel(legal, lang))}</a>`
      : "";
    sourceHtml = sourceHtml.split(token).join(link);
  }
  // Reserved "related-<N>" site-text slugs. On an article page, expand any
  // [[html:content.related-<N>]] the template placed into a same-category
  // neighbour strip: N cards total, split around the current article (older on
  // the left, newer on the right, with a ←・→ marker for "this article").
  // Rendered here rather than stored — it depends on the article being built.
  if (ctx.article) {
    const wantN = new Set<number>();
    for (const m of sourceHtml.matchAll(/content\.related-(\d+)/g)) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= 20) wantN.add(n);
    }
    if (wantN.size) {
      let cats: Array<{ slug?: string; id?: string }> = [];
      try {
        cats = JSON.parse(ctx.content["_article-categories"] || "[]");
      } catch {
        /* ignore */
      }
      const catSlug = cats[0]?.slug || cats[0]?.id || "";
      if (catSlug) {
        const defLang = s.default_lang || lang;
        const pool = await fetchCategoryPool(
          env,
          catSlug,
          lang,
          defLang,
          filter,
        );
        for (const n of wantN) {
          const { left, right } = pickCategoryNeighbours(
            pool,
            ctx.article.slug,
            n,
          );
          ctx.content[`related-${n}`] = buildRelatedHtml(
            left,
            right,
            ctx.basePath,
            lang,
            defLang,
          );
        }
      }
    }
  }
  const adminBase = adminAssetBase(env);
  let html = injectContentStyles(renderTemplate(sourceHtml, ctx), adminBase);
  html = applyRtlDir(html, lang);
  html = applyCompiledTailwind(html, template, s.base_path || "");
  html = injectFontHead(s, html, lang);
  html = injectSeoHead(html, s, ctx, pageLangs);
  html = injectGa4Head(html, s);
  return html;
}

/**
 * Inject the web-font <link> and the base-font override into the page <head>
 * (before </head>, after injectContentStyles so it overrides ke-content.css).
 * Fonts are configured in the admin "Font Management" tab; see src/fonts.ts.
 * No-op when no fonts are loaded and no base font is set.
 */
function injectFontHead(
  settings: SettingsMap,
  html: string,
  lang: string,
): string {
  const cfg = resolveFontConfig(settings, lang);
  const loaded = cfg.loaded;
  const baseFont = cfg.base;
  if (!loaded.length && !baseFont) return html;
  const head = buildFontHead(loaded, baseFont);
  if (!head) return html;
  return html.includes("</head>")
    ? html.replace("</head>", head + "</head>")
    : head + html;
}

function resolveFontConfig(
  settings: SettingsMap,
  lang: string,
): { loaded: LoadedFont[]; base: string } {
  let loaded: LoadedFont[] = [];
  try {
    const parsed = JSON.parse(settings.fonts_json || "[]");
    if (Array.isArray(parsed)) loaded = parsed as LoadedFont[];
  } catch {
    /* ignore malformed config */
  }
  let base = settings.base_font || "";
  try {
    const configs = JSON.parse(settings.font_configs_json || "{}");
    const selected =
      configs && typeof configs === "object" ? configs[lang] : null;
    if (selected && typeof selected === "object") {
      if (Array.isArray(selected.fonts))
        loaded = selected.fonts as LoadedFont[];
      if (typeof selected.base === "string") base = selected.base;
    }
  } catch {
    /* ignore malformed config */
  }
  return { loaded, base };
}

// ─── SEO / distribution <head> ────────────────────────────────────────────────

/** Escape a string for use inside a double-quoted HTML attribute. */
function seoAttr(s: string): string {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Escape text content (e.g. inside <title>). */
function seoText(s: string): string {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Strip HTML tags and collapse whitespace, then clamp to `max` chars. For
 *  meta description / OGP description (which must be plain text). */
function seoDescription(html: string, max = 160): string {
  const text = String(html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return (
    text
      .slice(0, max - 1)
      .replace(/\s+\S*$/, "")
      .trimEnd() + "…"
  );
}

/** Pull the first image src out of an expanded site-text value (which is an
 *  `<img src="…">` after [[mid]] expansion) or a bare path. "" if none. */
function extractImgSrc(value: string): string {
  if (!value) return "";
  const m = value.match(/<img[^>]+src="([^"]+)"/i);
  if (m) return m[1];
  const t = value.trim();
  return /^(https?:\/\/|\/)/.test(t) ? t : "";
}

/**
 * Inject per-page SEO meta into the rendered <head>: a page-specific <title>,
 * meta description, canonical, OGP, Twitter Card, robots/generator, favicon and
 * multilingual hreflang alternates. Code-generated so it applies uniformly to
 * every template (templates need not author any of it). See docs 引き継ぎ-001.
 *
 * `pageLangs` are the languages this page actually exists in (article →
 * translation langs; other pages → all registered langs); they drive hreflang.
 */
function injectSeoHead(
  html: string,
  settings: SettingsMap,
  ctx: RenderContext,
  pageLangs: string[],
): string {
  const siteName = ctx.content["_site-name"] || settings.site_name || "";
  const lang = ctx.lang;
  const defaultLang = settings.default_lang || "";
  const path = ctx.path || "/";
  const basePath = ctx.basePath || "";

  // Origin (scheme://host) for absolute URLs; "" if public_domain unconfigured.
  let origin = "";
  try {
    if (settings.public_domain) origin = new URL(settings.public_domain).origin;
  } catch {
    /* ignore malformed public_domain */
  }
  const abs = (rel: string): string => {
    if (!rel) return "";
    if (/^https?:\/\//i.test(rel)) return rel;
    return origin ? origin + rel : "";
  };

  const isArticle = !!(ctx.params.article && ctx.params.type);
  const article = ctx.article;

  // ── Title ──
  let title: string;
  if (isArticle && article) {
    title = siteName ? `${article.title}｜${siteName}` : article.title;
  } else if (ctx.params.type) {
    const tn = ctx.content["_type-name"] || ctx.params.type;
    title = siteName ? `${tn}｜${siteName}` : tn;
  } else if (ctx.params.category) {
    const cn = ctx.content["_category-name"] || ctx.params.category;
    title = siteName ? `${cn}｜${siteName}` : cn;
  } else if (ctx.path === "/privacy/" || ctx.path === "/privacy") {
    const pn = legalPageLabel("privacy", lang);
    title = siteName ? `${pn}｜${siteName}` : pn;
  } else if (ctx.path === "/terms/" || ctx.path === "/terms") {
    const tn = legalPageLabel("terms", lang);
    title = siteName ? `${tn}｜${siteName}` : tn;
  } else {
    title = siteName;
  }

  // ── Description ──
  let description: string;
  if (isArticle && article) {
    description = seoDescription(article.summary || "");
  } else {
    description =
      seoDescription(settings.site_description || "") ||
      seoDescription(ctx.content["top-hero-sub"] || "");
  }

  // ── og:image (absolute) ──
  const imageUrl =
    isArticle && article && article.coverUrl
      ? abs(article.coverUrl)
      : abs(extractImgSrc(ctx.content["top-hero-cover"] || ""));

  // ── robots: pagination beyond page 1 → noindex,follow (thin duplicates) ──
  const pageNo = parseInt(ctx.params.page || "1", 10);
  const robots =
    pageNo > 1
      ? "noindex,follow"
      : "index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1";

  // ── Multilingual URLs ──
  // Clean URL serves the default language (Accept-Language fallback); per-lang
  // variants are addressed with ?lang=. canonical = this page's own variant.
  const cleanUrl = origin ? `${origin}${basePath}${path}` : "";
  const langUrl = (l: string): string =>
    !cleanUrl
      ? ""
      : l === defaultLang
        ? cleanUrl
        : `${cleanUrl}?lang=${encodeURIComponent(l)}`;
  const canonical = langUrl(lang);
  // Other registered/translated languages, for og:locale:alternate + hreflang.
  const altLangs = pageLangs.filter((l) => l && l !== lang);

  const tags: string[] = [];
  if (description)
    tags.push(`<meta name="description" content="${seoAttr(description)}">`);
  if (canonical)
    tags.push(`<link rel="canonical" href="${seoAttr(canonical)}">`);
  tags.push(`<meta name="robots" content="${robots}">`);
  tags.push(`<meta name="generator" content="KuroCMS">`);

  // Open Graph
  tags.push(
    `<meta property="og:type" content="${isArticle ? "article" : "website"}">`,
  );
  if (title)
    tags.push(`<meta property="og:title" content="${seoAttr(title)}">`);
  if (description)
    tags.push(
      `<meta property="og:description" content="${seoAttr(description)}">`,
    );
  if (canonical)
    tags.push(`<meta property="og:url" content="${seoAttr(canonical)}">`);
  if (siteName)
    tags.push(`<meta property="og:site_name" content="${seoAttr(siteName)}">`);
  if (lang) tags.push(`<meta property="og:locale" content="${seoAttr(lang)}">`);
  for (const l of altLangs)
    tags.push(`<meta property="og:locale:alternate" content="${seoAttr(l)}">`);
  if (imageUrl)
    tags.push(`<meta property="og:image" content="${seoAttr(imageUrl)}">`);
  if (isArticle && article) {
    if (article.publishAt)
      tags.push(
        `<meta property="article:published_time" content="${seoAttr(article.publishAt)}">`,
      );
    if (article.updatedAt)
      tags.push(
        `<meta property="article:modified_time" content="${seoAttr(article.updatedAt)}">`,
      );
  }

  // Twitter Card (twitter:site intentionally omitted — no dedicated X handle).
  tags.push(
    `<meta name="twitter:card" content="${imageUrl ? "summary_large_image" : "summary"}">`,
  );
  if (title)
    tags.push(`<meta name="twitter:title" content="${seoAttr(title)}">`);
  if (description)
    tags.push(
      `<meta name="twitter:description" content="${seoAttr(description)}">`,
    );
  if (imageUrl)
    tags.push(`<meta name="twitter:image" content="${seoAttr(imageUrl)}">`);

  // Favicon (from site-text icon/favicon images, if set).
  const faviconSrc = extractImgSrc(
    ctx.content["favicon"] || ctx.content["icon"] || "",
  );
  if (faviconSrc) {
    const ext = /\.svg(\?|$)/i.test(faviconSrc) ? 'type="image/svg+xml" ' : "";
    tags.push(`<link rel="icon" ${ext}href="${seoAttr(faviconSrc)}">`);
  }

  // Discovery: sitemap + RSS feeds (site-wide and per-type).
  const siteBase = origin ? `${origin}${basePath}` : basePath;
  tags.push(
    `<link rel="sitemap" type="application/xml" href="${seoAttr(siteBase)}/sitemap.xml">`,
  );
  tags.push(
    `<link rel="alternate" type="application/rss+xml"${siteName ? ` title="${seoAttr(siteName)}"` : ""} href="${seoAttr(siteBase)}/rss.xml">`,
  );
  try {
    const navTypes = JSON.parse(ctx.content["_nav-types"] || "[]") as Array<{
      slug?: string;
      name?: string;
    }>;
    for (const t of navTypes) {
      if (!t.slug) continue;
      tags.push(
        `<link rel="alternate" type="application/rss+xml"${t.name ? ` title="${seoAttr(t.name)}"` : ""} href="${seoAttr(siteBase)}/${seoAttr(t.slug)}-rss.xml">`,
      );
    }
  } catch {
    /* ignore malformed _nav-types */
  }

  // hreflang alternates (only worth emitting when the page has >1 language).
  if (cleanUrl && pageLangs.length > 1) {
    for (const l of pageLangs) {
      tags.push(
        `<link rel="alternate" hreflang="${seoAttr(l)}" href="${seoAttr(langUrl(l))}">`,
      );
    }
    tags.push(
      `<link rel="alternate" hreflang="x-default" href="${seoAttr(cleanUrl)}">`,
    );
  }

  // ── JSON-LD structured data (article → Article + BreadcrumbList; home →
  // WebSite). Only emitted when we have an absolute origin to form @id/url. ──
  const jsonLd: Record<string, unknown>[] = [];
  if (origin) {
    if (isArticle && article) {
      const articleLd: Record<string, unknown> = {
        "@context": "https://schema.org",
        "@type": "Article",
        headline: article.title,
        ...(imageUrl ? { image: [imageUrl] } : {}),
        ...(article.publishAt ? { datePublished: article.publishAt } : {}),
        ...(article.updatedAt ? { dateModified: article.updatedAt } : {}),
        ...(description ? { description } : {}),
        // Author: a named Person linking to the About page (E-E-A-T; pairs
        // with the visible byline the CMS appends to the body). Falls back to
        // the site Organization when the creating user has no display name.
        ...(article.authorName
          ? {
              author: {
                "@type": "Person",
                name: article.authorName,
                url: `${siteBase}/about/`,
              },
            }
          : siteName
            ? { author: { "@type": "Organization", name: siteName } }
            : {}),
        ...(siteName
          ? { publisher: { "@type": "Organization", name: siteName } }
          : {}),
        ...(canonical
          ? { mainEntityOfPage: { "@type": "WebPage", "@id": canonical } }
          : {}),
      };
      jsonLd.push(articleLd);

      // Breadcrumb: Home → Type index → Article.
      const items: Array<{ name: string; item: string }> = [
        { name: siteName || "Home", item: `${siteBase}/` },
      ];
      let typeName = "";
      let typeSlug = ctx.params.type;
      try {
        const navTypes = JSON.parse(
          ctx.content["_nav-types"] || "[]",
        ) as Array<{ id?: string; slug?: string; name?: string }>;
        const tt = navTypes.find(
          (t) => t.slug === ctx.params.type || t.id === ctx.params.type,
        );
        if (tt) {
          typeName = tt.name || "";
          if (tt.slug) typeSlug = tt.slug;
        }
      } catch {
        /* ignore */
      }
      if (typeName)
        items.push({ name: typeName, item: `${siteBase}/${typeSlug}/` });
      items.push({ name: article.title, item: canonical || `${siteBase}/` });
      jsonLd.push({
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: items.map((it, i) => ({
          "@type": "ListItem",
          position: i + 1,
          name: it.name,
          item: it.item,
        })),
      });
    } else if (path === "/about/" || path === "/about") {
      // About = the author profile page: ProfilePage with a Person entity.
      // This is the page article JSON-LD author.url points at, closing the
      // author-identity loop. sameAs strengthens the entity with the site's
      // configured social profiles.
      const ownerName = (ctx.content["_author-name"] || "").trim();
      if (ownerName) {
        const sameAs: string[] = [];
        if (settings.bluesky_handle)
          sameAs.push(
            `https://bsky.app/profile/${encodeURIComponent(settings.bluesky_handle)}`,
          );
        jsonLd.push({
          "@context": "https://schema.org",
          "@type": "ProfilePage",
          mainEntity: {
            "@type": "Person",
            name: ownerName,
            url: `${siteBase}/about/`,
            ...(sameAs.length ? { sameAs } : {}),
          },
        });
      }
    } else if (path === "/" || path === "") {
      jsonLd.push({
        "@context": "https://schema.org",
        "@type": "WebSite",
        ...(siteName ? { name: siteName } : {}),
        url: `${siteBase}/`,
        ...(description ? { description } : {}),
      });
    }
  }
  for (const ld of jsonLd) {
    // Escape "</" so the JSON can't break out of the <script> element.
    const json = JSON.stringify(ld).replace(/<\//g, "<\\/");
    tags.push(`<script type="application/ld+json">${json}</script>`);
  }

  // Replace the template's <title> (which renders [[site.name]] site-wide) with
  // the page-specific one; inject one if the template has none.
  let out = html;
  const titleTag = `<title>${seoText(title)}</title>`;
  if (/<title>[\s\S]*?<\/title>/i.test(out)) {
    out = out.replace(/<title>[\s\S]*?<\/title>/i, titleTag);
  } else {
    tags.unshift(titleTag);
  }
  // Drop any description the template may already carry to avoid duplicates.
  out = out.replace(/<meta\s+name="description"[^>]*>/gi, "");

  const block = "\n" + tags.join("\n") + "\n";
  return out.includes("</head>")
    ? out.replace("</head>", block + "</head>")
    : block + out;
}

/**
 * Inject the GA4 gtag.js snippet near the top of <head> when a measurement ID is
 * configured (admin "Analytics" tab). ID-only (no arbitrary script paste) for
 * safety; emitted only when the ID matches the expected G-XXXX shape.
 */
function injectGa4Head(html: string, settings: SettingsMap): string {
  const id = (settings.ga4_measurement_id || "").trim();
  if (!id || !/^G-[A-Z0-9]+$/.test(id)) return html;
  const e = seoAttr(id);
  const snippet =
    `<script async src="https://www.googletagmanager.com/gtag/js?id=${e}"></script>\n` +
    `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${e}');</script>\n`;
  // Place right after <head ...> so it loads early.
  const m = html.match(/<head[^>]*>/i);
  if (m) {
    const at = (m.index ?? 0) + m[0].length;
    return html.slice(0, at) + "\n" + snippet + html.slice(at);
  }
  return html.includes("</head>")
    ? html.replace("</head>", snippet + "</head>")
    : snippet + html;
}

/**
 * Base path under which the externalized admin assets (`/_admin/*`) are served —
 * i.e. the admin base (the part of ACCESS_ADMIN_URL before "/admin", e.g.
 * "/kurocms/admin" → "/kurocms"). This is NOT the public site base
 * (`ctx.basePath`): the public pages and the admin assets live under different
 * roots, so the content-CSS <link> must point at the admin base. Mirrors
 * normalizePath()+resolveBasePath() in index.ts (kept local to avoid a circular
 * import between public.ts and index.ts).
 */
function adminAssetBase(env: Env): string {
  const raw = (env.ACCESS_ADMIN_URL || "/kurocms/admin").trim();
  let p: string;
  try {
    p = new URL(raw).pathname || "/";
  } catch {
    p = raw.startsWith("/") ? raw : "/" + raw;
  }
  p = p.replace(/\/+$/, "") || "/";
  if (p === "/admin") return "";
  if (p.endsWith("/admin")) return p.slice(0, -"/admin".length) || "";
  return p;
}

/**
 * KuroEditor authors class-based content blocks (rounded box, custom list
 * markers, tables) whose styling lives in the editor stylesheet — which the
 * public site does NOT load. Link the dedicated, theme-neutral content
 * stylesheet (built from KuroEditor's src/content.css, served by
 * serveAdminAsset from KV/edge/release) so authored content renders on any
 * template. The file is immutable (version-pinned) and cached aggressively.
 */
/**
 * Wrap authored rich-body HTML in `.kuro-content` so KuroEditor's published
 * content styles (callouts, roundboxes, tables, list markers…) apply on the
 * public site. ke-content.css scopes those rules under `.kuro-content` (and is
 * unlayered so it beats the template's `.prose`); without this wrapper a callout
 * renders as plain text. Mirrors how the in-editor preview wraps content.
 * data-bid / data-cbid はここで必ず剥がす (認可済み経路 = 記事本文 / about /
 * privacy / terms がすべてこの関数を通るため、公開面の単一チョークポイント)。
 * 除去ロジックは strip-internal-ids.ts (構造走査・F0-2 の '>' 属性値バグを修正済み)。
 */
function wrapKuroContent(html: string): string {
  const h = stripInternalIds((html || "").trim());
  return h ? `<div class="kuro-content">${h}</div>` : "";
}

/** "Written by" label per site language (falls back to English). */
const BYLINE_LABELS: Record<string, string> = {
  ja: "筆者",
  en: "Written by",
  ko: "글쓴이",
  zh: "作者",
  de: "Autor",
  fr: "Auteur",
  it: "Autore",
  es: "Autor",
  uk: "Автор",
  ar: "بقلم",
  pt: "Escrito por",
};

// Localized names of the dedicated legal pages. Used as the [[privacy]]/
// [[terms]] link text and as the page <title> (same 9-language set as the
// byline; unknown languages fall back to English).
const LEGAL_PAGE_LABELS: Record<"privacy" | "terms", Record<string, string>> = {
  privacy: {
    ja: "プライバシーポリシー",
    en: "Privacy Policy",
    ko: "개인정보 처리방침",
    zh: "隐私政策",
    de: "Datenschutzerklärung",
    fr: "Politique de confidentialité",
    it: "Informativa sulla privacy",
    es: "Política de privacidad",
    uk: "Політика конфіденційності",
    ar: "سياسة الخصوصية",
    pt: "Política de Privacidade",
  },
  terms: {
    ja: "利用規約",
    en: "Terms of Service",
    ko: "이용약관",
    zh: "服务条款",
    de: "Nutzungsbedingungen",
    fr: "Conditions d'utilisation",
    it: "Termini di servizio",
    es: "Términos de servicio",
    uk: "Умови використання",
    ar: "شروط الخدمة",
    pt: "Termos de Serviço",
  },
};

function legalPageLabel(page: "privacy" | "terms", lang: string): string {
  const labels = LEGAL_PAGE_LABELS[page];
  return labels[lang] || labels.en;
}

/**
 * Stamp dir="rtl" on the root <html> tag for right-to-left languages (Arabic
 * etc.). Direction is a PAGE attribute, so the core sets it template-agnostically
 * — templates keep <html lang="[[site.lang]]"> as-is and translations stay
 * plain HTML (Unicode bidi resolves mixed-direction runs within the text).
 * A template that already writes its own dir attribute wins (not overridden).
 */
function applyRtlDir(html: string, lang: string): string {
  if (!isRtlLang(lang)) return html;
  return html.replace(/<html\b([^>]*)>/i, (tag, attrs: string) =>
    /\bdir\s*=/i.test(attrs) ? tag : `<html${attrs} dir="rtl">`,
  );
}

/**
 * Author byline appended to the article body by the CMS (templates need not
 * author it — same policy as injectSeoHead). Links to /about/ in the page's
 * language so the visible byline matches the Person author in JSON-LD, which
 * is what E-E-A-T evaluation cross-checks. Inline styles only — must render
 * on non-Tailwind templates too.
 */
function buildBylineHtml(
  authorName: string,
  basePath: string,
  lang: string,
  defaultLang: string,
): string {
  const label = BYLINE_LABELS[lang] || BYLINE_LABELS.en;
  const href =
    `${basePath}/about/` +
    (lang && lang !== defaultLang ? `?lang=${encodeURIComponent(lang)}` : "");
  return (
    `<div class="kuro-byline" style="margin-top:2.5rem;padding-top:.9rem;border-top:1px solid rgba(128,128,128,.3);font-size:.85rem;opacity:.85">` +
    `${seoText(label)}: <a href="${seoAttr(href)}" rel="author">${seoText(authorName)}</a></div>`
  );
}

// ─── Related-articles strip ([[html:content.related-<N>]]) ──────────────────

const RELATED_LABELS: Record<string, string> = {
  ja: "関連記事",
  en: "Related articles",
  ko: "관련 기사",
  zh: "相关文章",
  de: "Ähnliche Artikel",
  fr: "Articles liés",
  it: "Articoli correlati",
  es: "Artículos relacionados",
  pt: "Artigos relacionados",
  ar: "مقالات ذات صلة",
  uk: "Схожі статті",
};

interface RelatedPoolItem {
  did: string;
  slug: string;
  tid: string;
  title: string;
  cover: string | null;
}

// All published articles in one category, newest first (publish_at DESC). Light
// projection — title + cover only, no bodies. Capped defensively; a strip only
// ever needs the current article's immediate neighbours plus wrap-around fill.
async function fetchCategoryPool(
  env: Env,
  categorySlug: string,
  lang: string,
  defaultLang: string,
  filter: PubFilter,
): Promise<RelatedPoolItem[]> {
  const rows = await env.DB.prepare(
    `SELECT d.did, d.slug, d.tid,
       COALESCE(NULLIF(NULLIF(dt_req.title, ''), d.slug), NULLIF(NULLIF(dt_en.title, ''), d.slug), NULLIF(NULLIF(dt_fb.title, ''), d.slug), NULLIF(NULLIF(dt_init.title, ''), d.slug), NULLIF(NULLIF(dt_site.title, ''), d.slug), NULLIF(NULLIF(dt_any.title, ''), d.slug)) AS title,
       COALESCE(NULLIF(NULLIF(dt_req.seo_json, ''), '{}'), NULLIF(NULLIF(dt_en.seo_json, ''), '{}'), NULLIF(NULLIF(dt_fb.seo_json, ''), '{}'), NULLIF(NULLIF(dt_init.seo_json, ''), '{}'), NULLIF(NULLIF(dt_site.seo_json, ''), '{}'), NULLIF(NULLIF(dt_any.seo_json, ''), '{}')) AS seo_json
     FROM documents d
     JOIN document_categories dc ON dc.did = d.did
     JOIN categories ti ON ti.id = dc.cid AND (ti.slug = ? OR ti.id = ?)
     ${ARTICLE_TR_JOINS}
     WHERE ${publishedSql("d.", filter)}
     ORDER BY d.publish_at DESC, d.did DESC
     LIMIT 500`,
  )
    .bind(categorySlug, categorySlug, lang, defaultLang || lang)
    .all<{
      did: string;
      slug: string;
      tid: string;
      title: string;
      seo_json: string;
    }>();
  return (rows.results ?? []).map((r) => {
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

// Split N cards around the current article: older on the left, newer on the
// right. When a side runs out (the article is the newest/oldest in its
// category), fill from the far end — no newer → oldest; no older → newest — so
// the strip keeps N cards. Never repeats the current article. `pool` is DESC
// (index 0 = newest). Returned `left` reads farthest→closest-older toward the
// centre; `right` reads closest→farthest-newer.
function pickCategoryNeighbours(
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

function relatedCardHtml(
  a: RelatedPoolItem,
  basePath: string,
  lang: string,
  defaultLang: string,
): string {
  const href =
    `${basePath}/${a.tid}/${a.slug}/` +
    (lang && lang !== defaultLang ? `?lang=${encodeURIComponent(lang)}` : "");
  const cover = a.cover ? `${basePath}${a.cover}` : "";
  const img = cover
    ? `<img src="${seoAttr(cover)}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block" />`
    : "";
  return (
    `<a class="kuro-related__item" href="${seoAttr(href)}" style="flex:1 1 0;min-width:0;text-decoration:none;color:inherit;display:flex;flex-direction:column;gap:.4rem">` +
    `<span style="display:block;width:100%;aspect-ratio:16/10;border-radius:.5rem;overflow:hidden;background:rgba(128,128,128,.12)">${img}</span>` +
    `<span style="font-size:.72rem;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${seoText(a.title)}</span>` +
    `</a>`
  );
}

function buildRelatedHtml(
  left: RelatedPoolItem[],
  right: RelatedPoolItem[],
  basePath: string,
  lang: string,
  defaultLang: string,
): string {
  if (!left.length && !right.length) return "";
  const label = RELATED_LABELS[lang] || RELATED_LABELS.en;
  const cards = (arr: RelatedPoolItem[]) =>
    arr.map((a) => relatedCardHtml(a, basePath, lang, defaultLang)).join("");
  const marker = `<span aria-hidden="true" style="flex:0 0 auto;align-self:center;color:rgba(128,128,128,.55);font-size:.8rem;white-space:nowrap;padding:0 .1rem">←・→</span>`;
  return (
    `<nav class="kuro-related" aria-label="${seoAttr(label)}" style="margin-top:1.75rem;padding-top:1rem;border-top:1px solid rgba(128,128,128,.2);display:flex;align-items:flex-start;gap:.5rem">` +
    cards(left) +
    marker +
    cards(right) +
    `</nav>`
  );
}

function injectContentStyles(html: string, basePath: string): string {
  const link =
    '<link rel="stylesheet" href="' +
    basePath +
    "/_admin/ke-content." +
    KE_VERSION +
    '.css" />';
  return html.includes("</head>")
    ? html.replace("</head>", link + "</head>")
    : link + html;
}

// ─── Static Tailwind CSS (replaces cdn.tailwindcss.com on public pages) ──────

/**
 * Class tokens injected by CMS widget HTML. Today this is empty on purpose:
 * every CMS-generated snippet (pagination data, archives select, byline,
 * Bluesky widget, language switcher) uses kuro-* classes or inline styles,
 * never Tailwind utilities. RULE: if a future widget emits a Tailwind class,
 * add it here so existing templates keep full coverage without a recompile.
 */
export const TW_WIDGET_SAFELIST: string[] = [];

/**
 * Extract the class-candidate tokens the template's static Tailwind CSS is
 * compiled from: every class="..." attribute value, plus quoted string
 * literals inside inline <script> blocks (classList toggles). Junk tokens are
 * harmless — the JIT compiler ignores anything that isn't a real utility.
 * Used identically at compile time (via the tw-tokens API) and at build time
 * (coverage check), so the two can never disagree.
 */
export function extractTwTokens(sourceHtml: string): string[] {
  const src = String(sourceHtml || "");
  const tokens = new Set<string>(TW_WIDGET_SAFELIST);
  const addAll = (s: string) => {
    for (const t of s.split(/\s+/)) if (t) tokens.add(t);
  };
  for (const m of src.matchAll(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/gi))
    addAll(m[1] ?? m[2] ?? "");
  for (const s of src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const q of (s[1] || "").matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*?)\1/g))
      addAll(q[2] || "");
  }
  return [...tokens].sort();
}

const TW_CDN_SCRIPT_RE =
  /<script[^>]*\bsrc\s*=\s*["'](https:\/\/cdn\.tailwindcss\.com[^"']*)["'][^>]*>\s*<\/script>/i;

/** The Tailwind Play-CDN URL a template loads ("" when it doesn't use it). */
export function findTwCdnUrl(sourceHtml: string): string {
  const m = String(sourceHtml || "").match(TW_CDN_SCRIPT_RE);
  return m ? m[1] : "";
}

// Coverage result cached per loaded-template object (one build / one serve).
const twCoverage = new WeakMap<StoredTemplate, boolean>();

function compiledTwCovers(template: StoredTemplate): boolean {
  if (!template.compiledHash || !template.compiledTokens) return false;
  let ok = twCoverage.get(template);
  if (ok === undefined) {
    try {
      const have = new Set(JSON.parse(template.compiledTokens) as string[]);
      ok = extractTwTokens(template.sourceHtml).every((t) => have.has(t));
    } catch {
      ok = false;
    }
    twCoverage.set(template, ok);
  }
  return ok;
}

/**
 * Swap the render-blocking cdn.tailwindcss.com runtime compiler for the
 * pre-compiled static stylesheet (immutable, hash-versioned). Falls back to
 * the CDN script whenever the compiled token set doesn't cover the current
 * source (e.g. a REST-side template edit added new classes and the admin
 * hasn't recompiled yet) — slower but always renders correctly; the admin
 * screen self-heals it on the next visit.
 *
 * The link points at the PUBLIC base (`{publicBase}/_tw/…`), not the admin
 * base: it's a public-page asset, and admin paths can be shadowed by other
 * workers on the public domain (kuro.boo/kurocms/* → promotion worker).
 */
function applyCompiledTailwind(
  html: string,
  template: StoredTemplate,
  publicBase: string,
): string {
  if (!compiledTwCovers(template)) return html;
  return html.replace(
    TW_CDN_SCRIPT_RE,
    `<link rel="stylesheet" href="${publicBase}/_tw/${template.id}.${template.compiledHash}.css">`,
  );
}

/** GET {base}/_tw/{id}.{hash}.css — the compiled per-template Tailwind CSS. */
export async function serveTemplateCss(
  env: Env,
  id: string,
  hash: string,
): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT compiled_css, compiled_hash FROM page_templates WHERE id = ?",
  )
    .bind(id)
    .first<{ compiled_css: string | null; compiled_hash: string | null }>()
    .catch(() => null);
  if (!row?.compiled_css) {
    return new Response("Not found", { status: 404 });
  }
  // Hash mismatch = the CSS was recompiled after this page was built. Serve
  // the CURRENT css under the stale URL (short cache) instead of 404ing —
  // pages keep their styling until the next build refreshes the href (the
  // build salt includes compiledHash, so it will).
  const current = row.compiled_hash === hash;
  return new Response(row.compiled_css, {
    headers: {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": current
        ? "public, max-age=31536000, immutable" // hash-versioned: cache forever
        : "public, max-age=300",
    },
  });
}

// ─── KV storage ───────────────────────────────────────────────────────────────

function normPath(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** Legacy / size-guard per-language key. */
function kvKey(path: string, lang: string): string {
  return `page:${lang}:${normPath(path)}`;
}

/** One key per page holding ALL language variants (see kvPutBundle). */
function kvKeyBundle(path: string): string {
  return `pageb:${normPath(path)}`;
}

interface PageBundle {
  v: number;
  langs: Record<string, string>;
}

// KV value hard limit is 25 MiB; stay under with margin before falling back.
const KV_BUNDLE_MAX_BYTES = 24 * 1024 * 1024;

function requirePublicPages(env: Env): KVNamespace {
  // PUBLIC_PAGES is intentionally fail-fast. Do not change this back to a no-op
  // fallback; KV is a core persistence/cache layer for generated public pages.
  if (!env.PUBLIC_PAGES) {
    throw new Error("PUBLIC_PAGES KV binding is required.");
  }
  return env.PUBLIC_PAGES;
}

/** Write all language variants of a page in ONE KV value (1 write/page). If the
 *  bundle would exceed the KV value limit, fall back to per-language keys so a
 *  pathological page (huge × many langs) still works. */
async function kvPutBundle(
  env: Env,
  path: string,
  bundle: Record<string, string>,
): Promise<void> {
  const kv = requirePublicPages(env);
  const payload: PageBundle = { v: 1, langs: bundle };
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json).length;
  if (bytes <= KV_BUNDLE_MAX_BYTES) {
    await kv.put(kvKeyBundle(path), json);
    return;
  }
  for (const [lang, html] of Object.entries(bundle)) {
    await kv.put(kvKey(path, lang), html);
  }
}

/** Read a page's HTML for `lang`, plus the langs actually present in KV. Tries
 *  the bundle key first, then the per-language fallback key (size-guard / legacy). */
async function kvGetPage(
  env: Env,
  path: string,
  lang: string,
): Promise<{ html: string | null; kvLangs: string[] }> {
  const kv = requirePublicPages(env);
  const raw = await kv.get(kvKeyBundle(path));
  if (raw) {
    try {
      const b = JSON.parse(raw) as PageBundle;
      if (b && b.langs) {
        return { html: b.langs[lang] ?? null, kvLangs: Object.keys(b.langs) };
      }
    } catch {
      /* corrupt bundle — fall through to per-language */
    }
  }
  const perLang = await kv.get(kvKey(path, lang));
  return { html: perLang, kvLangs: perLang ? [lang] : [] };
}

// ─── Build progress events ────────────────────────────────────────────────────

export type BuildEvent =
  | { type: "start"; total: number; langs: number; articles: number }
  | {
      type: "page";
      index: number;
      total: number;
      path: string;
      lang: string;
      status: "built" | "skipped" | "error";
      reason?: string;
    }
  | {
      type: "done";
      built: number;
      skipped: number;
      errors: number;
      more?: boolean;
      /** Orphan page keys removed by the post-build sweep (final pass only). */
      swept?: number;
    };

// Thrown by the build loop when the per-invocation build budget is reached, so
// the build can stop early and the client can resume in another Worker
// invocation (each invocation has a ~1000 subrequest ceiling).
const BUILD_BUDGET_REACHED = { budgetReached: true } as const;

// A Worker invocation allows ~1000 subrequests. Budget the build to ~80% of
// that and let the number of pages built per invocation float with the actual
// data: a page's cost scales with how many language variants it contains (one
// generate() per language ≈ a few D1 reads; media refs are batched into single
// IN-queries, so cost tracks language count, not media count), plus two writes
// when it actually builds. Budgeting by *subrequests* — not a fixed page count —
// is what keeps multi-language sites (e.g. 9 langs/page) under the ceiling: a
// 9-language site builds ~9× the subrequests per page, so it builds proportionally
// fewer pages per invocation and the client resumes the rest.
const WORKER_SUBREQUEST_LIMIT = 1000;
const BUILD_SUBREQUEST_BUDGET = Math.floor(WORKER_SUBREQUEST_LIMIT * 0.8); // 800
const SUBREQ_PER_LANG = 4;
const SUBREQ_PER_BUILT_PAGE = 2;

// ─── Build cache helpers ──────────────────────────────────────────────────────

async function loadBuildCache(env: Env): Promise<Map<string, string>> {
  const rows = await env.DB.prepare(
    `SELECT path, lang, source_hash FROM page_build_cache`,
  ).all<{
    path: string;
    lang: string;
    source_hash: string;
  }>();
  const map = new Map<string, string>();
  for (const r of rows.results ?? [])
    map.set(`${r.path}:${r.lang}`, r.source_hash);
  return map;
}

async function saveBuildCache(
  env: Env,
  path: string,
  lang: string,
  hash: string,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO page_build_cache (path, lang, source_hash, built_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(path, lang) DO UPDATE SET source_hash=excluded.source_hash, built_at=excluded.built_at`,
  )
    .bind(path, lang, hash, now)
    .run();
}

// ─── Build helpers ────────────────────────────────────────────────────────────

/** Shared setup for the incremental (re)builds triggered by one document's
 *  lifecycle (publish / unpublish / type change / delete): prefetch the render
 *  data once and return a writeBundle() that renders one path in the given
 *  langs and stores it as ONE KV bundle (1 write/page). `articleLangs` seeds
 *  the per-article language map (empty for pure index rebuilds); `extraLangs`
 *  folds a document's translation langs into allLangs. */
async function createPageWriter(
  env: Env,
  settings: SettingsMap,
  articleLangs: Map<string, string[]>,
  extraLangs: string[] = [],
  // "live" (the default) refreshes already-materialized pages only. The per-doc
  // rebuilds (content edits, single-doc build) must never render pending
  // flag-state into the shared index pages — only the full build does that.
  filter: PubFilter = "live",
): Promise<{
  writeBundle: (
    path: string,
    langs: string[],
    params: Record<string, string>,
  ) => Promise<void>;
  allLangs: string[];
}> {
  const template = await loadTemplate(env, settings.template_id);

  // Pre-fetch shared data once for all pages in this build
  const [docTypes, docCategories] = await Promise.all([
    fetchTypesWithCounts(env, filter),
    fetchCategoriesWithCounts(env, filter),
  ]);
  const docDefLang = settings.default_lang ?? "";
  const docAvailLangs = await env.DB.prepare(
    `SELECT id, COALESCE(name, id) AS name FROM taxonomy_items WHERE kind = 'language' ORDER BY id`,
  )
    .all<{ id: string; name: string }>()
    .then((r) =>
      (r.results ?? []).map((row) => ({ code: row.id, name: row.name })),
    )
    .catch(() => [] as { code: string; name: string }[]);
  // Index pages (home/type) must contain EVERY registered language, else a
  // per-doc rebuild's bundle would clobber the other langs. Articles only need
  // their own translation langs.
  const allLangs = Array.from(
    new Set(
      [docDefLang, ...docAvailLangs.map((l) => l.code), ...extraLangs].filter(
        Boolean,
      ),
    ),
  );
  const docTemplateContent = new Map<string, TemplateContent>();
  for (const lang of allLangs) {
    docTemplateContent.set(
      lang,
      await fetchTemplateContent(env, lang, docDefLang),
    );
  }
  const docExtConns = await env.DB.prepare(
    "SELECT id, service, handle FROM external_connections WHERE is_active = 1",
  )
    .all<{ id: string; service: string; handle: string }>()
    .then((r) => r.results ?? [])
    .catch(() => [] as { id: string; service: string; handle: string }[]);
  const docPrefetch: RenderPrefetch = {
    types: docTypes,
    categories: docCategories,
    templateContent: docTemplateContent,
    externalConnections: docExtConns,
    availableLangs: docAvailLangs,
    articleLangs,
  };

  // Render a page for the given langs and store as ONE bundle (1 write/page).
  const writeBundle = async (
    path: string,
    langs: string[],
    params: Record<string, string>,
  ): Promise<void> => {
    const bundle: Record<string, string> = {};
    for (const lang of langs) {
      const html = await generatePage(
        env,
        path,
        params,
        lang,
        template,
        settings,
        docPrefetch,
        filter,
      );
      if (html) bundle[lang] = html;
    }
    if (Object.keys(bundle).length) await kvPutBundle(env, path, bundle);
  };
  return { writeBundle, allLangs };
}

/** Refresh the stored pages of a single document plus the listings that show it.
 *  `extraTids` = additional type indexes to refresh — on a type change, pass the
 *  PREVIOUS tid so the article disappears from its old type's listings.
 *
 *  Two flavors, both rendering under the "live" filter (never pending flag
 *  state — only a build materializes the publish flag):
 *  - default (content refresh, fired by the editor's save): acts only when the
 *    document is ALREADY live; a flagged-but-unbuilt article is a no-op, so a
 *    content save can never side-channel-publish it.
 *  - `promote` (the explicit POST /api/documents/:did/build): a true
 *    single-document build — first syncs THIS document's `live` from its
 *    flag-state (mode within the publish window, build-mode aware), deleting
 *    the detail page when the document just left publication. */
export async function buildDocumentPages(
  env: Env,
  did: string,
  extraTids: string[] = [],
  opts: { promote?: boolean } = {},
): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT d.slug, d.tid, d.live, d.publish_at,
            GROUP_CONCAT(DISTINCT CASE
              WHEN NULLIF(dt.body_html, '') IS NOT NULL
                OR NULLIF(dt.summary, '') IS NOT NULL
                OR (NULLIF(dt.title, '') IS NOT NULL AND dt.title <> d.slug)
              THEN dt.lang
            END) AS langs
     FROM documents d
     LEFT JOIN document_translations dt ON dt.did = d.did
     WHERE d.did = ?
     GROUP BY d.did`,
  )
    .bind(did)
    .first<{
      slug: string;
      tid: string;
      live: number;
      publish_at: string | null;
      langs: string | null;
    }>();

  if (!row) return;

  let live = row.live === 1;
  if (opts.promote) {
    const buildFilter =
      (await getBuildMode(env)) === "always" ? "future" : "window";
    const updated = await env.DB.prepare(
      `UPDATE documents SET live = ${liveCaseSql(buildFilter)}
       WHERE did = ? RETURNING live`,
    )
      .bind(did)
      .first<{ live: number }>();
    live = updated?.live === 1;
    if (!live) {
      // The document just left publication: remove its detail page, then let
      // the index rebuilds below drop it from the listings.
      await deleteArticlePages(env, row.tid, row.slug);
    }
  } else if (!live) {
    return; // content refresh of a not-yet-built document: nothing to update
  }

  const settings = await fetchSettings(env);
  const docLangs = (row.langs || settings.default_lang || "en")
    .split(",")
    .filter(Boolean);
  const otherTids = Array.from(
    new Set(extraTids.filter((t) => t && t !== row.tid)),
  );

  const { writeBundle, allLangs } = await createPageWriter(
    env,
    settings,
    new Map([[`${row.tid}/${row.slug}`, docLangs]]),
    docLangs,
  );

  if (live) {
    await writeBundle(`/${row.tid}/${row.slug}/`, docLangs, {
      type: row.tid,
      article: row.slug,
    });
  }

  // Latest views are always refreshed (the new/removed post may enter or leave
  // the rolling 30-day window). `/page/N/` is no longer pre-built — it is served
  // on-demand for un-migrated templates.
  await writeBundle("/", allLangs, {});
  for (const t of [row.tid, ...otherTids]) {
    await writeBundle(`/${t}/`, allLangs, { type: t });
  }

  // Completed-month archives are immutable, so they only need rebuilding when the
  // affected post belongs to a PAST month (a back-dated publish or an unpublish).
  // Current-month posts live only in the latest view above.
  const artMonth = (row.publish_at || "").slice(0, 7); // 'YYYY-MM'
  const curMonth = new Date().toISOString().slice(0, 7);
  if (artMonth && artMonth < curMonth) {
    const [y, m] = artMonth.split("-");
    await writeBundle(`/monthly/${y}/${m}/`, allLangs, { month: artMonth });
    for (const t of [row.tid, ...otherTids]) {
      await writeBundle(`/${t}/monthly/${y}/${m}/`, allLangs, {
        type: t,
        month: artMonth,
      });
    }
  }

  // One shared KV value for all type+category nav counts (filled client-side).
  await writeNavCounts(env);
}

/** Refresh the index pages after a document is REMOVED entirely (deleted): the
 *  home page, the given type indexes, and — when the article lived in a
 *  completed month — the month archives. buildDocumentPages can't be used here
 *  because the document row is already gone. */
export async function rebuildIndexPages(
  env: Env,
  tids: string[],
  publishAt?: string | null,
): Promise<void> {
  const settings = await fetchSettings(env);
  const { writeBundle, allLangs } = await createPageWriter(
    env,
    settings,
    new Map(),
  );
  const uniqueTids = Array.from(new Set(tids.filter(Boolean)));
  await writeBundle("/", allLangs, {});
  for (const t of uniqueTids) {
    await writeBundle(`/${t}/`, allLangs, { type: t });
  }
  const artMonth = (publishAt || "").slice(0, 7); // 'YYYY-MM'
  const curMonth = new Date().toISOString().slice(0, 7);
  if (artMonth && artMonth < curMonth) {
    const [y, m] = artMonth.split("-");
    await writeBundle(`/monthly/${y}/${m}/`, allLangs, { month: artMonth });
    for (const t of uniqueTids) {
      await writeBundle(`/${t}/monthly/${y}/${m}/`, allLangs, {
        type: t,
        month: artMonth,
      });
    }
  }
  await writeNavCounts(env);
}

/** Remove a (formerly) published article's detail page from KV so the old URL
 *  stops being served. Serving prefers the KV bundle over D1, so unpublish /
 *  delete / type change MUST delete the stale page — nothing overwrites it
 *  otherwise. Clears the bundle key, the legacy per-language fallback keys,
 *  and the page's page_build_cache rows. */
export async function deleteArticlePages(
  env: Env,
  tid: string,
  slug: string,
): Promise<void> {
  const kv = requirePublicPages(env);
  const path = `/${tid}/${slug}/`;
  await kv.delete(kvKeyBundle(path));
  const langRows = await env.DB.prepare(
    `SELECT id FROM taxonomy_items WHERE kind = 'language'`,
  )
    .all<{ id: string }>()
    .catch(() => ({ results: [] as { id: string }[] }));
  for (const r of langRows.results ?? []) {
    await kv.delete(kvKey(path, r.id)).catch(() => {});
  }
  await env.DB.prepare("DELETE FROM page_build_cache WHERE path = ?")
    .bind(path)
    .run()
    .catch(() => {});
}

/** Cap on KV deletes per sweep pass: the sweep runs inside the final build
 *  pass's leftover subrequest budget, so a pathological backlog is spread
 *  across successive full builds instead of risking the invocation ceiling. */
const SWEEP_DELETE_MAX = 100;

/** Mark-and-sweep for leftover page keys, run after a COMPLETED full build.
 *  Deletes `pageb:` / legacy `page:` KV keys whose path is not in
 *  `expectedPaths`, then prunes page_build_cache rows for no-longer-expected
 *  paths (a stale row would otherwise let a later build skip a page that no
 *  longer exists in KV). Strictly prefix-scoped: the namespace also holds
 *  non-page keys (admin-asset cache, `_cfg/*`, fonts, version cache) that
 *  must never be touched. Returns the number of KV keys deleted. */
async function sweepOrphanPages(
  env: Env,
  expectedPaths: Set<string>,
): Promise<number> {
  const kv = requirePublicPages(env);
  // Compare in normalized key form (kvKey/kvKeyBundle strip the trailing "/").
  const expected = new Set<string>();
  for (const p of expectedPaths) expected.add(normPath(p));
  let deleted = 0;
  outer: for (const prefix of ["pageb:", "page:"]) {
    let cursor: string | undefined;
    do {
      const listed = await kv.list({ prefix, cursor });
      for (const k of listed.keys) {
        // pageb:<path> / legacy page:<lang>:<path>
        const rest = k.name.slice(prefix.length);
        const path =
          prefix === "pageb:" ? rest : rest.slice(rest.indexOf(":") + 1);
        if (expected.has(path)) continue;
        if (deleted >= SWEEP_DELETE_MAX) break outer;
        await kv.delete(k.name);
        deleted++;
      }
      cursor = listed.list_complete
        ? undefined
        : ((listed as { cursor?: string }).cursor ?? undefined);
    } while (cursor);
  }
  const cacheRows = await env.DB.prepare(
    "SELECT DISTINCT path FROM page_build_cache",
  )
    .all<{ path: string }>()
    .catch(() => ({ results: [] as { path: string }[] }));
  const stale = (cacheRows.results ?? [])
    .map((r) => r.path)
    .filter((p) => !expected.has(normPath(p)));
  for (let i = 0; i < stale.length; i += 50) {
    const chunk = stale.slice(i, i + 50);
    await env.DB.prepare(
      `DELETE FROM page_build_cache WHERE path IN (${chunk.map(() => "?").join(",")})`,
    )
      .bind(...chunk)
      .run()
      .catch(() => {});
  }
  return deleted;
}

/** Rebuild all public pages for all registered languages, with caching and progress events. */
export async function buildAllPublicPages(
  env: Env,
  requestedLang = "en",
  onEvent?: (event: BuildEvent) => void,
  maxBuilt = Number.POSITIVE_INFINITY,
  force = false,
): Promise<{
  built: number;
  skipped: number;
  errors: number;
  langs: number;
  articles: number;
  more: boolean;
  /** Orphan page keys removed by the post-build sweep (final pass only). */
  swept: number;
}> {
  const settings = await fetchSettings(env);
  const template = await loadTemplate(env, settings.template_id);
  // The full build is the sole materializer of the publish flag: it renders
  // from mode within the publish window ("always" mode ignores the future
  // publish_at bound so scheduled posts are built and listed immediately) and
  // syncs documents.live at the end, so serving ("live" filter) follows.
  const filter: PubFilter =
    (await getBuildMode(env)) === "always" ? "future" : "window";
  // Fold a hash of the template SOURCE into the cache key so editing the
  // template (same id) invalidates every page's build hash and forces a rebuild
  // (the per-page hashes are `${ts}:${tplId}`, otherwise blind to template edits).
  // Also fold the filter in so toggling the mode rebuilds listings/details.
  const fontHash = cheapHash(
    `${settings.fonts_json || ""}:${settings.base_font || ""}:${settings.font_configs_json || ""}`,
  );
  // compiledHash participates so a Tailwind-CSS recompile regenerates pages
  // (their <link> href embeds the hash) on the next build.
  const tplId = `${template.id}:${cheapHash(template.sourceHtml)}:${template.compiledHash || ""}:${fontHash}:${filter === "future" ? "F" : ""}`;

  // ── Resolve languages ─────────────────────────────────────────────────────
  const langRows = await env.DB.prepare(
    `SELECT id FROM taxonomy_items WHERE kind = 'language' ORDER BY id`,
  ).all<{ id: string }>();
  const registeredLangs = (langRows.results ?? [])
    .map((r) => r.id)
    .filter(Boolean);
  const siteLang = settings.default_lang || requestedLang;
  const allLangs = Array.from(
    new Set([siteLang, requestedLang, ...registeredLangs]),
  ).filter(Boolean);

  const types = await fetchTypesWithCounts(env, filter);

  // ── Preload source hashes ─────────────────────────────────────────────────
  // 1. Per-type max updated_at (published articles only, for type-index pages)
  const typeMaxRows = await env.DB.prepare(
    `SELECT tid, MAX(updated_at) AS ts FROM documents WHERE mode = 1 GROUP BY tid`,
  ).all<{ tid: string; ts: string }>();
  const typeMaxTs = new Map(
    typeMaxRows.results.map((r) => [r.tid, r.ts || ""]),
  );

  // 1b. Time-aware "live set" signature per type: count + newest publish_at among
  // articles that are live RIGHT NOW (publish window open). MAX(updated_at) above
  // can't see a scheduled post crossing its publish_at (no row is written when the
  // clock passes), so the index/home/type/category hashes would otherwise stay put
  // and those pages would skip — leaving a just-published article off every listing.
  // Folding this signature in makes the listing hashes change the moment a post
  // enters (cnt+1 / newer maxPub) or leaves (cnt-1) the live window.
  const liveSigRows = await env.DB.prepare(
    `SELECT tid, COUNT(*) AS cnt, COALESCE(MAX(publish_at), '') AS mpub
     FROM documents
     WHERE ${publishedSql("", filter)}
     GROUP BY tid`,
  ).all<{ tid: string; cnt: number; mpub: string }>();
  const typeLiveSig = new Map(
    liveSigRows.results.map((r) => [r.tid, `${r.cnt}:${r.mpub}`]),
  );
  const siteLiveSig =
    liveSigRows.results.reduce((s, r) => s + r.cnt, 0) +
    ":" +
    liveSigRows.results.reduce((m, r) => (r.mpub > m ? r.mpub : m), "");

  // Content max updated_at — site text, categories, and settings.
  const contentMaxRow = await env.DB.prepare(
    `SELECT MAX(ts) AS ts FROM (
       SELECT MAX(updated_at) AS ts FROM taxonomy_items
       UNION ALL
       SELECT MAX(updated_at) AS ts FROM categories
       UNION ALL
       SELECT MAX(updated_at) AS ts FROM site_settings
     )`,
  ).first<{ ts: string }>();
  const contentTs = contentMaxRow?.ts || "";
  const contentHash = `${contentTs}:${tplId}`;

  // Site-wide max of published articles (for home page) — also incorporates content changes
  const siteMaxTs = Array.from(typeMaxTs.values()).reduce(
    (a, b) => (a > b ? a : b),
    "",
  );
  const siteHash = `${siteMaxTs}:${contentTs}:${tplId}:${siteLiveSig}`;

  // 2. Per-article-translation updated_at (for article pages). The DOCUMENT's
  // updated_at participates too: document-level changes that render on the
  // article page — category assignment (chips), publish date, type — bump
  // documents.updated_at without touching any translation row, and would
  // otherwise never make the page a build target.
  const artRows = await env.DB.prepare(
    `SELECT d.slug, d.tid, d.updated_at AS dts, dt.lang, dt.updated_at AS ts
     FROM documents d
     JOIN document_translations dt ON dt.did = d.did
     WHERE ${publishedSql("d.", filter)}
       AND (
         NULLIF(dt.body_html, '') IS NOT NULL
         OR NULLIF(dt.summary, '') IS NOT NULL
         OR (NULLIF(dt.title, '') IS NOT NULL AND dt.title <> d.slug)
       )`,
  ).all<{
    slug: string;
    tid: string;
    dts: string;
    lang: string;
    ts: string;
  }>();
  const artHash = new Map(
    artRows.results.map((r) => [
      `${r.slug}:${r.tid}:${r.lang}`,
      `${r.ts || ""}:${r.dts || ""}:${contentTs}:${tplId}`,
    ]),
  );

  // Count published articles
  const articleCount = new Set(artRows.results.map((r) => `${r.slug}:${r.tid}`))
    .size;

  // Per-article translation langs (for the switcher gray-out; avoids per-render queries)
  const articleLangsMap = new Map<string, string[]>();
  for (const r of artRows.results) {
    const k = `${r.tid}/${r.slug}`;
    const arr = articleLangsMap.get(k);
    if (arr) arr.push(r.lang);
    else articleLangsMap.set(k, [r.lang]);
  }

  // 3. Load existing page_build_cache. A forced full rebuild (`force`, sent only
  // on the FIRST pass by the client) wipes it so every page's hash misses and
  // rebuilds. Resume passes send force=false, so they skip already-rebuilt pages
  // via the cache entries this pass writes — chunked resume stays intact.
  if (force) {
    await env.DB.prepare("DELETE FROM page_build_cache").run();
  }
  const cache = force ? new Map<string, string>() : await loadBuildCache(env);

  // Categories are no longer pre-built as pages, but the nav still lists their
  // names (counts are filled client-side), so the prefetch needs them.
  const categories = await fetchCategoriesWithCounts(env, filter);

  // 4. Completed-month archive signatures (home aggregate + per type). Each month
  // is an immutable `/monthly/YYYY/MM/` page; its hash depends only on that month's
  // articles, so a new (current-month) post never rebuilds past months. The current
  // month is excluded — its posts live in the latest view ("/", "/{type}/").
  const monthRows = await env.DB.prepare(
    `SELECT d.tid AS tid, strftime('%Y-%m', datetime(d.publish_at)) AS ym,
            COUNT(*) AS cnt, COALESCE(MAX(d.updated_at), '') AS ts
     FROM documents d
     WHERE ${publishedSql("d.", filter)}
       AND strftime('%Y-%m', datetime(d.publish_at)) < strftime('%Y-%m', 'now')
     GROUP BY d.tid, ym`,
  ).all<{ tid: string; ym: string; cnt: number; ts: string }>();
  // Per-type: tid → (ym → signature). Home: ym → aggregated signature.
  const typeMonthSig = new Map<string, Map<string, string>>();
  const homeMonthAgg = new Map<string, { cnt: number; ts: string }>();
  for (const r of monthRows.results ?? []) {
    if (!r.ym) continue;
    let tm = typeMonthSig.get(r.tid);
    if (!tm) {
      tm = new Map();
      typeMonthSig.set(r.tid, tm);
    }
    tm.set(r.ym, `${r.cnt}:${r.ts}`);
    const h = homeMonthAgg.get(r.ym);
    if (h) {
      h.cnt += r.cnt;
      if (r.ts > h.ts) h.ts = r.ts;
    } else {
      homeMonthAgg.set(r.ym, { cnt: r.cnt, ts: r.ts });
    }
  }
  const homeMonths = Array.from(homeMonthAgg.keys()).sort().reverse();
  const typeMonthTotal = Array.from(typeMonthSig.values()).reduce(
    (s, m) => s + m.size,
    0,
  );

  // Legal pages exist only while their site text has content in ANY language
  // (per-language emptiness falls back / 404s inside generatePage).
  const legalRows = await env.DB.prepare(
    `SELECT DISTINCT id FROM taxonomy_items
     WHERE kind = 'template' AND id IN ('privacy','terms')
       AND TRIM(COALESCE(name, '')) != ''`,
  ).all<{ id: string }>();
  const hasLegalPage: Record<"privacy" | "terms", boolean> = {
    privacy: false,
    terms: false,
  };
  for (const r of legalRows.results ?? []) {
    if (r.id === "privacy" || r.id === "terms") hasLegalPage[r.id] = true;
  }

  // ── Expected page-path set (for the orphan sweep after a completed pass) ──
  // Mirrors every path this build — or the per-document incremental builds —
  // legitimately writes. Type paths are included under BOTH the taxonomy slug
  // (full build) and the raw tid (buildDocumentPages); they usually coincide.
  const expectedPaths = new Set<string>(["/", "/about/"]);
  if (hasLegalPage.privacy) expectedPaths.add("/privacy/");
  if (hasLegalPage.terms) expectedPaths.add("/terms/");
  for (const ym of homeMonths) {
    const [y, m] = ym.split("-");
    expectedPaths.add(`/monthly/${y}/${m}/`);
  }
  for (const t of types) {
    const tm = typeMonthSig.get(t.id);
    for (const key of new Set([t.slug, t.id])) {
      if (!key) continue;
      expectedPaths.add(`/${key}/`);
      if (tm) {
        for (const ym of tm.keys()) {
          const [y, m] = ym.split("-");
          expectedPaths.add(`/${key}/monthly/${y}/${m}/`);
        }
      }
    }
  }
  for (const r of artRows.results) {
    expectedPaths.add(`/${r.tid}/${r.slug}/`);
  }

  // ── Compute total page count ──────────────────────────────────────────────
  // One bundle per page (all langs in one KV value) → count pages, NOT pages×langs.
  // home + about + type-indexes + month archives (home + per type) + articles.
  // Categories are NOT pre-built (served on-demand), so they are excluded here.
  const total =
    2 + types.length + homeMonths.length + typeMonthTotal + articleCount;
  onEvent?.({
    type: "start",
    total,
    langs: allLangs.length,
    articles: articleCount,
  });

  // Pre-fetch shared data once to avoid repeated DB queries per page
  const buildDefLang = settings.default_lang ?? "";
  const templateContentCache = new Map<string, TemplateContent>();
  for (const lang of allLangs) {
    templateContentCache.set(
      lang,
      await fetchTemplateContent(env, lang, buildDefLang),
    );
  }
  const extConns = await env.DB.prepare(
    "SELECT id, service, handle FROM external_connections WHERE is_active = 1",
  )
    .all<{ id: string; service: string; handle: string }>()
    .then((r) => r.results ?? [])
    .catch(() => [] as { id: string; service: string; handle: string }[]);
  const buildAvailLangs = await env.DB.prepare(
    `SELECT id, COALESCE(name, id) AS name FROM taxonomy_items WHERE kind = 'language' ORDER BY id`,
  )
    .all<{ id: string; name: string }>()
    .then((r) =>
      (r.results ?? []).map((row) => ({ code: row.id, name: row.name })),
    )
    .catch(() => [] as { code: string; name: string }[]);
  const buildPrefetch: RenderPrefetch = {
    types,
    categories,
    templateContent: templateContentCache,
    externalConnections: extConns,
    availableLangs: buildAvailLangs,
    articleLangs: articleLangsMap,
  };

  // Estimated subrequests already spent this invocation, seeded with the
  // preamble queries above plus one template-content fetch per language.
  let subreqEstimate = 20 + allLangs.length;
  let built = 0,
    skipped = 0,
    errors = 0,
    index = 0,
    more = false;

  // Build ONE page as a single KV bundle holding every language variant.
  // `langs` = the languages this page should contain (index pages = all
  // registered langs; articles = only langs with a translation). The cache key
  // is per-PATH (lang "*"); the combined hash covers every lang so any change
  // (incl. a lang added/removed) triggers a rebuild.
  async function processPageBundle(
    path: string,
    langs: string[],
    hashFor: (lang: string) => string,
    generate: (lang: string) => Promise<string | null>,
  ): Promise<void> {
    index++;
    const cacheKey = `${path}:*`;
    const combined =
      langs
        .slice()
        .sort()
        .map((l) => `${l}=${hashFor(l)}`)
        .join("|") +
      "|" +
      RENDER_FORMAT_VERSION;
    if (cache.get(cacheKey) === combined) {
      skipped++;
      onEvent?.({
        type: "page",
        index,
        total,
        path,
        lang: "*",
        status: "skipped",
      });
      return;
    }
    // Account for this page's subrequests up front: one generate() per language
    // runs whether the page builds, errors, or yields no content.
    subreqEstimate += langs.length * SUBREQ_PER_LANG;
    try {
      const bundle: Record<string, string> = {};
      for (const lang of langs) {
        const html = await generate(lang);
        if (html) bundle[lang] = html;
      }
      const keys = Object.keys(bundle);
      if (keys.length) {
        await kvPutBundle(env, path, bundle); // 1 write per page
        await saveBuildCache(env, path, "*", combined);
        cache.set(cacheKey, combined);
        subreqEstimate += SUBREQ_PER_BUILT_PAGE;
        built++;
        onEvent?.({
          type: "page",
          index,
          total,
          path,
          lang: keys.join(","),
          status: "built",
        });
      } else {
        skipped++;
        onEvent?.({
          type: "page",
          index,
          total,
          path,
          lang: "*",
          status: "skipped",
          reason: "no content",
        });
      }
    } catch (err) {
      errors++;
      onEvent?.({
        type: "page",
        index,
        total,
        path,
        lang: "*",
        status: "error",
        reason: String(err),
      });
    }
    // Stop this invocation once the subrequest budget (or the hard page cap) is
    // spent. Cache-skipped pages cost ~0 subrequests and return early above, so
    // only generated pages count. The client resumes the remaining work in a
    // fresh Worker invocation (already-built pages then skip via build cache).
    if (built >= maxBuilt || subreqEstimate >= BUILD_SUBREQUEST_BUDGET)
      throw BUILD_BUDGET_REACHED;
  }

  // All processPageBundle calls run inside one try: when the per-invocation
  // build budget (maxBuilt) is reached, processPageBundle throws the sentinel,
  // we stop early and report `more: true` so the client resumes in a fresh
  // Worker invocation (already-built pages then skip via page_build_cache).
  try {
    // ── Index pages: one bundle per page, containing all registered langs ──
    await processPageBundle(
      "/",
      allLangs,
      () => siteHash,
      (lang) =>
        generatePage(
          env,
          "/",
          {},
          lang,
          template,
          settings,
          buildPrefetch,
          filter,
        ),
    );
    // Home completed-month archives: /monthly/YYYY/MM/ (immutable; per-month hash).
    for (const ym of homeMonths) {
      const [y, m] = ym.split("-");
      const sig = homeMonthAgg.get(ym);
      const monthHash = `${sig?.cnt ?? 0}:${sig?.ts ?? ""}:${tplId}`;
      await processPageBundle(
        `/monthly/${y}/${m}/`,
        allLangs,
        () => monthHash,
        (lang) =>
          generatePage(
            env,
            `/monthly/${y}/${m}/`,
            { month: ym },
            lang,
            template,
            settings,
            buildPrefetch,
            filter,
          ),
      );
    }
    await processPageBundle(
      "/about/",
      allLangs,
      () => contentHash,
      (lang) =>
        generatePage(
          env,
          "/about/",
          {},
          lang,
          template,
          settings,
          buildPrefetch,
          filter,
        ),
    );
    // Legal pages (/privacy/, /terms/) — built only while their site text has
    // content (hasLegalPage; generatePage also yields null per empty language).
    // When the text is emptied the path drops out of expectedPaths and the
    // orphan sweep removes the stale bundle + build-cache row.
    for (const legal of ["privacy", "terms"] as const) {
      if (!hasLegalPage[legal]) continue;
      await processPageBundle(
        `/${legal}/`,
        allLangs,
        () => contentHash,
        (lang) =>
          generatePage(
            env,
            `/${legal}/`,
            {},
            lang,
            template,
            settings,
            buildPrefetch,
            filter,
          ),
      );
    }
    for (let ti = 0; ti < types.length; ti++) {
      const t = types[ti];
      const typeHash = `${typeMaxTs.get(t.id) || ""}:${contentTs}:${tplId}:${typeLiveSig.get(t.id) || "0:"}`;
      await processPageBundle(
        `/${t.slug}/`,
        allLangs,
        () => typeHash,
        (lang) =>
          generatePage(
            env,
            `/${t.slug}/`,
            { type: t.slug },
            lang,
            template,
            settings,
            buildPrefetch,
            filter,
          ),
      );
      // Per-type completed-month archives: /{type}/monthly/YYYY/MM/ (immutable).
      const tMonths = typeMonthSig.get(t.id);
      if (tMonths) {
        for (const ym of Array.from(tMonths.keys()).sort().reverse()) {
          const [y, m] = ym.split("-");
          const monthHash = `${tMonths.get(ym) || "0:"}:${tplId}`;
          await processPageBundle(
            `/${t.slug}/monthly/${y}/${m}/`,
            allLangs,
            () => monthHash,
            (lang) =>
              generatePage(
                env,
                `/${t.slug}/monthly/${y}/${m}/`,
                { type: t.slug, month: ym },
                lang,
                template,
                settings,
                buildPrefetch,
                filter,
              ),
          );
        }
      }
    }
    // Category pages are NOT pre-built — served on-demand by handlePublicRoute
    // (KV miss → generate + edge-cache), so a category-count change never fans
    // out into a build. The shared counts KV is refreshed at the end.

    // ── Article pages: one bundle per article, only langs that have a translation ──
    const artGroups = new Map<
      string,
      { tid: string; slug: string; langs: string[] }
    >();
    for (const r of artRows.results) {
      const key = `${r.tid}/${r.slug}`;
      let g = artGroups.get(key);
      if (!g) {
        g = { tid: r.tid, slug: r.slug, langs: [] };
        artGroups.set(key, g);
      }
      g.langs.push(r.lang);
    }
    for (const g of artGroups.values()) {
      const path = `/${g.tid}/${g.slug}/`;
      await processPageBundle(
        path,
        g.langs,
        (lang) => artHash.get(`${g.slug}:${g.tid}:${lang}`) ?? "",
        (lang) =>
          generatePage(
            env,
            path,
            { type: g.tid, article: g.slug },
            lang,
            template,
            settings,
            buildPrefetch,
            filter,
          ),
      );
    }
  } catch (e) {
    if (e !== BUILD_BUDGET_REACHED) throw e;
    more = true; // budget spent — more pages remain; client resumes
  }

  // ── Orphan sweep (mark-and-sweep) ── only after a COMPLETED pass
  // (more:false): expectedPaths is then authoritative, and any page key
  // outside it is a leftover (a delete/unpublish/type change the incremental
  // cleanup missed, or a page written by an older version, e.g. /category/,
  // /page/N/). Serving prefers KV, so leftovers would otherwise be served
  // forever. Non-fatal and capped per pass; the final pass of a chunked build
  // has spent almost no budget (it mostly cache-skips), so the sweep fits.
  let swept = 0;
  if (!more) {
    try {
      swept = await sweepOrphanPages(env, expectedPaths);
    } catch {
      /* non-fatal: retried on the next full build */
    }
  }

  // ── Materialize the publish flag ── only after a COMPLETED pass: sync
  // documents.live to what this build just published. This is THE moment the
  // publish flag takes effect — everything served on-demand (categories,
  // KV-miss fallback, sitemap/RSS/llms.txt, nav counts) reads live, so until a
  // build fully drains, flag changes stay invisible to visitors. A chunked
  // pass (more:true) keeps the old snapshot; the mode/live disagreement also
  // lets the auto-build cron detect that a build is still pending.
  if (!more) {
    const liveCase = liveCaseSql(filter);
    await env.DB.prepare(
      `UPDATE documents SET live = ${liveCase} WHERE live <> ${liveCase}`,
    ).run();
  }

  // Refresh the shared nav-counts KV value (one write, filled into the nav
  // client-side). Cheap and independent of the per-page build budget. Runs
  // after the live sync so the counts match the pages just published.
  await writeNavCounts(env);

  onEvent?.({ type: "done", built, skipped, errors, more, swept });
  return {
    built,
    skipped,
    errors,
    more,
    swept,
    langs: allLangs.length,
    articles: articleCount,
  };
}

// ─── Build scheduling mode (manual / auto / always) ───────────────────────────
// One mutually-exclusive mode, KV-backed so no schema migration is needed and the
// cron gate reads it cheaply. The publish flag (mode) is pure state in every
// mode — the build is what materializes it into documents.live:
//   "manual"  — flag changes + publish_at wait for a manual build (default)
//   "auto"    — cron builds whenever some document's pending flag-state differs
//               from its live state (covers flag flips and window crossings)
//   "always"  — like manual, but builds ignore the future publish_at bound so
//               future-dated posts are built/listed as soon as a build runs
export type BuildMode = "manual" | "auto" | "always";
export const BUILD_MODE_KEY = "_cfg/build_schedule_mode";
// Same per-invocation page budget as the manual build; if a transition affects
// more pages than this, the next cron tick detects the still-pending mode/live
// disagreement (live only syncs on a fully drained build) and continues.
const AUTO_BUILD_MAX_PER_INVOCATION = 50;

/** Read the persisted build mode (defaults to "manual"). */
export async function getBuildMode(env: Env): Promise<BuildMode> {
  if (!env.PUBLIC_PAGES) return "manual";
  const v = await env.PUBLIC_PAGES.get(BUILD_MODE_KEY);
  return v === "auto" || v === "always" ? v : "manual";
}

/** Persist the build mode. */
export async function setBuildMode(env: Env, mode: BuildMode): Promise<void> {
  if (!env.PUBLIC_PAGES) return;
  await env.PUBLIC_PAGES.put(BUILD_MODE_KEY, mode);
}

/**
 * Cron entry point. Only acts in "auto" mode, and only when some document's
 * flag-state (mode within the publish window) disagrees with its materialized
 * `live` state. One predicate covers every pending transition — a manual
 * publish/unpublish flag flip AND a publish_at / unpublish_at boundary
 * crossing — because the full build syncs `live` on completion: agreement
 * means nothing is pending, and a budget-limited pass (`more`) leaves the
 * disagreement in place so the next tick continues (already-built pages skip
 * via the build cache). Idle ticks cost a single COUNT query.
 */
export async function runScheduledAutoBuild(env: Env): Promise<void> {
  if (!env.PUBLIC_PAGES) return;
  if ((await getBuildMode(env)) !== "auto") return;

  // Must mirror the "window" filter (auto mode never builds future posts) and
  // the build's live-sync CASE exactly, or the cron would loop or stall.
  const pending = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM documents
     WHERE live <> (CASE WHEN mode = 1
       AND datetime(publish_at) <= datetime('now')
       AND (unpublish_at IS NULL OR datetime(unpublish_at) > datetime('now'))
       THEN 1 ELSE 0 END)`,
  ).first<{ cnt: number }>();
  if ((pending?.cnt ?? 0) === 0) return;

  await buildAllPublicPages(
    env,
    env.SITE_DEFAULT_LANG || "en",
    undefined,
    AUTO_BUILD_MAX_PER_INVOCATION,
  );
}

// ─── sitemap.xml / RSS / robots.txt ───────────────────────────────────────────

/** Escape text for inclusion in XML element/attribute content. */
function xmlEscape(s: string): string {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Resolve the absolute public origin (scheme://host) from public_domain. */
function publicOrigin(settings: SettingsMap): string {
  try {
    if (settings.public_domain) return new URL(settings.public_domain).origin;
  } catch {
    /* ignore */
  }
  return "";
}

/** Registered site languages (default first), for hreflang enumeration. */
async function fetchRegisteredLangs(env: Env): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT id FROM taxonomy_items WHERE kind = 'language' ORDER BY id`,
  )
    .all<{ id: string }>()
    .catch(() => ({ results: [] as { id: string }[] }));
  return (rows.results ?? []).map((r) => r.id).filter(Boolean);
}

interface SitemapEntry {
  path: string; // relative to base, e.g. "/", "/about/", "/blog/slug/"
  langs: string[]; // languages this URL exists in (for hreflang); [] = single
  lastmod?: string; // ISO date
}

/**
 * Build the sitemap.xml for every public URL (home, about, type indexes,
 * category indexes, published articles). Multilingual URLs carry xhtml:link
 * hreflang alternates. URLs match the build/canonical convention exactly
 * (article = /{type-id}/{slug}/). Edge-cached only; never written to KV.
 */
export async function buildSitemapXml(env: Env): Promise<string> {
  const settings = await fetchSettings(env);
  const origin = publicOrigin(settings);
  const base = origin + (settings.base_path || "");
  const defaultLang = settings.default_lang || "";
  // The sitemap enumerates what is actually served: the last completed build's
  // materialized state (documents.live). In "always" mode the build itself
  // publishes future-dated posts, so they show up here via live too.
  const filter: PubFilter = "live";

  const registered = await fetchRegisteredLangs(env);
  if (defaultLang && !registered.includes(defaultLang))
    registered.unshift(defaultLang);

  const [types, categories] = await Promise.all([
    fetchTypesWithCounts(env, filter),
    fetchCategoriesWithCounts(env, filter),
  ]);

  // Published article translations → group langs + lastmod per article.
  const artRows = await env.DB.prepare(
    `SELECT d.slug, d.tid, dt.lang, dt.updated_at AS ts
     FROM documents d
     JOIN document_translations dt ON dt.did = d.did
     WHERE ${publishedSql("d.", filter)}
       AND (
         NULLIF(dt.body_html, '') IS NOT NULL
         OR NULLIF(dt.summary, '') IS NOT NULL
         OR (NULLIF(dt.title, '') IS NOT NULL AND dt.title <> d.slug)
       )`,
  )
    .all<{ slug: string; tid: string; lang: string; ts: string }>()
    .catch(() => ({
      results: [] as Array<{
        slug: string;
        tid: string;
        lang: string;
        ts: string;
      }>,
    }));
  const artGroups = new Map<
    string,
    { tid: string; slug: string; langs: string[]; lastmod: string }
  >();
  let siteLastmod = "";
  for (const r of artRows.results ?? []) {
    const key = `${r.tid}/${r.slug}`;
    let g = artGroups.get(key);
    if (!g) {
      g = { tid: r.tid, slug: r.slug, langs: [], lastmod: "" };
      artGroups.set(key, g);
    }
    if (!g.langs.includes(r.lang)) g.langs.push(r.lang);
    if (r.ts > g.lastmod) g.lastmod = r.ts;
    if (r.ts > siteLastmod) siteLastmod = r.ts;
  }

  const entries: SitemapEntry[] = [];
  entries.push({ path: "/", langs: registered, lastmod: siteLastmod });
  entries.push({ path: "/about/", langs: registered });
  // Legal pages, only while their backing site text has content (404 otherwise).
  const legalRows = await env.DB.prepare(
    `SELECT DISTINCT id FROM taxonomy_items
     WHERE kind = 'template' AND id IN ('privacy','terms')
       AND TRIM(COALESCE(name, '')) != ''`,
  )
    .all<{ id: string }>()
    .catch(() => ({ results: [] as { id: string }[] }));
  for (const r of legalRows.results ?? []) {
    entries.push({ path: `/${r.id}/`, langs: registered });
  }
  for (const t of types)
    entries.push({ path: `/${t.slug}/`, langs: registered });
  for (const c of categories)
    entries.push({ path: `/category/${c.slug}/`, langs: registered });
  // Completed-month archives (home + per type). Category month pages are served
  // on-demand and omitted to avoid enumerating non-pre-built URLs.
  const homeMonths = await fetchDistinctMonths(env, { kind: "home" }, filter);
  for (const ym of homeMonths) {
    const [y, m] = ym.split("-");
    entries.push({ path: `/monthly/${y}/${m}/`, langs: registered });
  }
  for (const t of types) {
    const tMonths = await fetchDistinctMonths(
      env,
      { kind: "type", slug: t.slug },
      filter,
    );
    for (const ym of tMonths) {
      const [y, m] = ym.split("-");
      entries.push({
        path: `/${t.slug}/monthly/${y}/${m}/`,
        langs: registered,
      });
    }
  }
  for (const g of artGroups.values())
    entries.push({
      path: `/${g.tid}/${g.slug}/`,
      langs: g.langs,
      lastmod: g.lastmod,
    });

  const langHref = (path: string, l: string): string =>
    l === defaultLang
      ? `${base}${path}`
      : `${base}${path}?lang=${encodeURIComponent(l)}`;

  const urls = entries
    .map((e) => {
      const loc = `${base}${e.path}`;
      const parts = [`    <loc>${xmlEscape(loc)}</loc>`];
      if (e.lastmod)
        parts.push(`    <lastmod>${xmlEscape(e.lastmod)}</lastmod>`);
      if (origin && e.langs.length > 1) {
        for (const l of e.langs)
          parts.push(
            `    <xhtml:link rel="alternate" hreflang="${xmlEscape(l)}" href="${xmlEscape(langHref(e.path, l))}"/>`,
          );
        parts.push(
          `    <xhtml:link rel="alternate" hreflang="x-default" href="${xmlEscape(loc)}"/>`,
        );
      }
      return `  <url>\n${parts.join("\n")}\n  </url>`;
    })
    .join("\n");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
    urls +
    `\n</urlset>\n`
  );
}

/** Format an ISO/SQLite timestamp as an RFC 822 date for RSS pubDate. */
function rfc822(ts: string): string {
  const d = new Date(
    (ts || "").replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? "" : "Z"),
  );
  return isNaN(d.getTime()) ? "" : d.toUTCString();
}

/**
 * Build an RSS 2.0 feed of the latest published articles. `typeSlug` limits the
 * feed to one type (e.g. /blog-rss.xml); omit for the site-wide feed. Uses the
 * default language. Edge-cached only.
 */
export async function buildRssXml(
  env: Env,
  typeSlug?: string,
): Promise<string> {
  const settings = await fetchSettings(env);
  const origin = publicOrigin(settings);
  const base = origin + (settings.base_path || "");
  const lang = settings.default_lang || "en";
  const siteName = settings.site_name || "KuroCMS";
  const siteDesc = settings.site_description || "";

  const rows = typeSlug
    ? await fetchArticlesByType(env, typeSlug, lang, lang, 1, 20, "live")
    : await fetchPublishedArticles(env, lang, lang, 1, 20, "live");

  const channelLink = `${base}/`;
  const items = rows
    .map((r) => {
      const link = `${base}/${r.tid}/${r.slug}/`;
      const title = r.title || r.slug;
      const desc = seoDescription(r.summary || "", 300);
      const pub = rfc822(r.publish_at);
      return (
        `    <item>\n` +
        `      <title>${xmlEscape(title)}</title>\n` +
        `      <link>${xmlEscape(link)}</link>\n` +
        `      <guid isPermaLink="true">${xmlEscape(link)}</guid>\n` +
        (desc ? `      <description>${xmlEscape(desc)}</description>\n` : "") +
        (pub ? `      <pubDate>${pub}</pubDate>\n` : "") +
        `    </item>`
      );
    })
    .join("\n");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0">\n` +
    `  <channel>\n` +
    `    <title>${xmlEscape(siteName)}</title>\n` +
    `    <link>${xmlEscape(channelLink)}</link>\n` +
    `    <description>${xmlEscape(siteDesc)}</description>\n` +
    (lang ? `    <language>${xmlEscape(lang)}</language>\n` : "") +
    items +
    (items ? "\n" : "") +
    `  </channel>\n` +
    `</rss>\n`
  );
}

/**
 * robots.txt (引き継ぎ-001 decision = option2): keep Cloudflare's AI
 * content-signal preamble verbatim, then append the standard allow-all rule and
 * the Sitemap reference. Returned for /robots.txt; edge-cached only.
 */
export async function buildRobotsTxt(env: Env): Promise<string> {
  const settings = await fetchSettings(env);
  const origin = publicOrigin(settings);
  const base = origin + (settings.base_path || "");
  const sitemap = origin ? `${base}/sitemap.xml` : "/sitemap.xml";
  // Cloudflare's default content-signal preamble (kept as a code constant so the
  // signal survives even though KuroCMS now owns /robots.txt).
  const contentSignal =
    "# Cloudflare Content Signals Policy\n" +
    "#\n" +
    "# To learn more about the Content Signals Policy visit https://www.cloudflare.com/content-signals-policy/\n" +
    "#\n" +
    "# The content-signal directive below indicates a preference, not a permission.\n" +
    "#\n" +
    "# Content-Signal: search=yes, ai-input=yes, ai-train=no\n" +
    "Content-Signal: search=yes, ai-input=yes, ai-train=no\n";
  return (
    contentSignal +
    "\n" +
    "User-agent: *\n" +
    "Allow: /\n" +
    "\n" +
    `Sitemap: ${sitemap}\n`
  );
}

/**
 * llms.txt (https://llmstxt.org): a curated markdown site index for LLMs / AI
 * crawlers — site name + description, then every published article per type
 * with its summary, then utility pages. Complements robots.txt's
 * ai-input=yes Content-Signal: the signal welcomes AI reading, llms.txt tells
 * the AI what is worth reading. Article descriptions come from the existing
 * per-language summary, so no extra authoring is needed. Served at /llms.txt;
 * edge-cached only, never written to KV.
 */
export async function buildLlmsTxt(env: Env): Promise<string> {
  const settings = await fetchSettings(env);
  const origin = publicOrigin(settings);
  const base = origin + (settings.base_path || "");
  const lang = settings.default_lang || "en";
  const siteName = settings.site_name || "KuroCMS";
  const siteDesc = seoDescription(settings.site_description || "", 500);

  const registered = await fetchRegisteredLangs(env);
  const types = await fetchTypesWithCounts(env, "live");

  // Markdown-safe single line: collapse whitespace, escape link brackets.
  const md = (s: string) =>
    String(s || "")
      .replace(/\s+/g, " ")
      .replace(/([[\]])/g, "\\$1")
      .trim();

  const lines: string[] = [];
  lines.push(`# ${md(siteName)}`);
  lines.push("");
  if (siteDesc) {
    lines.push(`> ${md(siteDesc)}`);
    lines.push("");
  }
  if (registered.length > 1) {
    const others = registered.filter((l) => l && l !== lang);
    lines.push(
      `- Default language: ${lang}. Also available: ${others.join(", ")} (append ?lang=CODE to any URL).`,
    );
    lines.push("");
  }

  for (const t of types) {
    const rows = await fetchArticlesByType(
      env,
      t.slug,
      lang,
      lang,
      1,
      100,
      "live",
    );
    if (!rows.length) continue;
    lines.push(`## ${md(t.name || t.slug)}`);
    lines.push("");
    for (const r of rows) {
      const link = `${base}/${r.tid}/${r.slug}/`;
      const desc = seoDescription(r.summary || "", 200);
      lines.push(
        `- [${md(r.title || r.slug)}](${link})${desc ? `: ${md(desc)}` : ""}`,
      );
    }
    lines.push("");
  }

  lines.push("## Pages");
  lines.push("");
  lines.push(`- [About](${base}/about/)`);
  lines.push(`- [Sitemap](${base}/sitemap.xml)`);
  lines.push(`- [RSS](${base}/rss.xml)`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Resolve the site favicon to a servable media URL (basePath-prefixed,
 * cache-versioned), from the 'favicon' (preferred) or 'icon' site-text image.
 * Returns null when neither is set. Used by the /favicon.* redirect routes.
 */
export async function resolveFaviconPath(env: Env): Promise<string | null> {
  const settings = await fetchSettings(env);
  const basePath = settings.base_path || "";
  const defaultLang = settings.default_lang || "";
  const rows = await env.DB.prepare(
    `SELECT id, name, lang FROM taxonomy_items WHERE kind = 'template' AND id IN ('favicon','icon')`,
  )
    .all<{ id: string; name: string; lang: string }>()
    .catch(() => ({
      results: [] as { id: string; name: string; lang: string }[],
    }));
  // Same fallback semantics as fetchTemplateContent: an EMPTY per-language row
  // must never shadow a non-empty one. The editor writes per-language rows and
  // language registration seeds blank rows, so an unordered "first row wins"
  // here picked a blank and 404'd even though the favicon was configured.
  // Priority among non-empty rows: default_lang → '' (canonical) → the rest.
  const pick = (id: string): string => {
    const mine = (rows.results ?? []).filter(
      (r) => r.id === id && (r.name || "").trim(),
    );
    const rank = (lang: string) =>
      lang === defaultLang ? 0 : lang === "" ? 1 : 2;
    mine.sort(
      (a, b) => rank(a.lang) - rank(b.lang) || a.lang.localeCompare(b.lang),
    );
    return mine.length ? mine[0].name : "";
  };
  const value = pick("favicon") || pick("icon");
  const m = value.match(/\[\[([a-z0-9_-]+)\]\]/);
  if (!m) return null;
  const asset = await env.DB.prepare(
    `SELECT public_path, cache_version FROM media_assets WHERE mid = ?`,
  )
    .bind(m[1])
    .first<{ public_path: string; cache_version: string }>();
  if (!asset?.public_path) return null;
  return `${basePath}${asset.public_path}?v=${asset.cache_version}`;
}

// ─── Language detection ───────────────────────────────────────────────────────

/**
 * Parse the Accept-Language header and return the best-matching language
 * from the given list. Falls back to defaultLang.
 * Strips region suffixes: "en-US" → "en", "zh-TW" → "zh".
 */
function detectAcceptLang(
  request: Request,
  available: string[],
  defaultLang: string,
): string {
  const header = request.headers.get("accept-language") || "";
  if (!header) return defaultLang;
  const parsed = header
    .split(",")
    .map((part) => {
      const [tag, qStr] = part.trim().split(";q=");
      const q = qStr ? parseFloat(qStr) : 1;
      const lang = (tag.trim().split("-")[0] || "").toLowerCase();
      return { lang, q: isNaN(q) ? 0 : q };
    })
    .filter((x) => x.lang.length >= 2)
    .sort((a, b) => b.q - a.q);
  for (const { lang } of parsed) {
    if (available.includes(lang)) return lang;
  }
  return defaultLang;
}

/** The visitor's primary (highest-priority) Accept-Language base tag, e.g. "ja". */
function browserPrimaryLang(request: Request): string {
  const header = request.headers.get("accept-language") || "";
  return (header.split(",")[0] || "")
    .trim()
    .split(";")[0]
    .trim()
    .split("-")[0]
    .toLowerCase();
}

/** Choose a fallback language for a page that lacks the requested translation.
 *  Prefer a language the visitor can read: English when their browser's primary
 *  language is non-Japanese and English exists; otherwise the site base language
 *  (else any available). Only returns a language present in `available`. */
function pickFallbackLang(
  request: Request,
  available: string[],
  siteLang: string,
): string {
  const primary = browserPrimaryLang(request);
  if (primary && primary !== "ja" && available.includes("en")) return "en";
  if (available.includes(siteLang)) return siteLang;
  return available[0] ?? siteLang;
}

// ─── Route handling ───────────────────────────────────────────────────────────

const PUBLIC_RESERVED = new Set([
  "kurocms",
  "api",
  "vendor",
  "initialize",
  "assets",
  "images",
  "videos",
  "audios",
]);

/** Returns true for paths that should be served as public pages. */
export function isPublicPath(pathname: string): boolean {
  if (pathname === "/") return true;
  if (new RegExp("^/category/[^/]").test(pathname)) return true;
  // Month archives: /monthly/YYYY/MM/ and /:type/monthly/YYYY/MM/
  if (new RegExp("^/monthly/[0-9]{4}/[0-9]{2}/?$").test(pathname)) return true;
  if (
    new RegExp("^/[a-zA-Z0-9_-]+/monthly/[0-9]{4}/[0-9]{2}/?$").test(pathname)
  )
    return true;
  // Legacy paginated home/type (served on-demand for un-migrated templates):
  // /page/N/ and /:type/page/N/
  if (new RegExp("^/page/[0-9]+/?$").test(pathname)) return true;
  if (new RegExp("^/[a-zA-Z0-9_-]+/page/[0-9]+/?$").test(pathname)) return true;
  // /{type-slug} or /{type-slug}/{article-slug} — any slug not in reserved set
  const m = pathname.match(new RegExp("^/([a-zA-Z0-9_-]+)(/[^/]*)?/?$"));
  if (!m) return false;
  return !PUBLIC_RESERVED.has(m[1]);
}

/**
 * Serve a public path.
 * KV hit → return cached HTML.
 * KV miss → generate on-the-fly, cache, return.
 */
export async function handlePublicRoute(
  pathname: string,
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);

  // Read settings and registered languages for language detection
  const settings = await fetchSettings(env);
  const siteLang = settings.default_lang || "en";

  const langRows = await env.DB.prepare(
    `SELECT id FROM taxonomy_items WHERE kind = 'language' ORDER BY id`,
  ).all<{ id: string }>();
  const registeredLangs = (langRows.results ?? [])
    .map((r) => r.id)
    .filter(Boolean);
  if (!registeredLangs.includes(siteLang)) registeredLangs.unshift(siteLang);

  // ?lang= overrides; otherwise use Accept-Language header matching
  const lang =
    url.searchParams.get("lang") ||
    detectAcceptLang(request, registeredLangs, siteLang);

  // Edge cache check — avoids KV read on repeat requests at same datacenter
  const edgeCache = caches.default;
  const edgeCacheKey = (() => {
    const u = new URL(request.url);
    u.searchParams.set("_ck_lang", lang);
    return new Request(u.toString());
  })();
  const edgeCached = await edgeCache.match(edgeCacheKey);
  if (edgeCached) return edgeCached;

  // Category and legacy /page/N/ paths are NOT pre-built into KV (categories are
  // on-demand by design; /page/N/ is the un-migrated-template fallback). Old
  // installs may still hold stale KV bundles for them from a previous version, so
  // skip the KV read entirely and always regenerate (edge-cached) to stay fresh.
  const onDemandOnly =
    new RegExp("^/category/").test(pathname) ||
    new RegExp("^/page/[0-9]+/?$").test(pathname) ||
    new RegExp("^/[^/]+/page/[0-9]+/?$").test(pathname);

  if (!onDemandOnly) {
    // KV lookup — one bundle per page holds every language variant.
    const { html: cached, kvLangs } = await kvGetPage(env, pathname, lang);
    if (cached) {
      const res = new Response(cached, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          // stale-while-revalidate: once the 5-min edge TTL lapses, serve the
          // cached page INSTANTLY while refreshing in the background, so a
          // template/CSS change is never more than one visit stale instead of
          // making visitors wait for a full regen (or holding an old page for
          // the whole max-age). 24h SWR window.
          "Cache-Control":
            "public, max-age=60, s-maxage=300, stale-while-revalidate=86400",
          "X-KuroCMS-Source": "kv-static",
        },
      });
      await edgeCache.put(edgeCacheKey, res.clone());
      return res;
    }

    // The page is built but this language has no translation → "jump" (302) to a
    // language the visitor can read: English first when the browser's primary
    // language is non-Japanese and English exists, otherwise the base language.
    if (kvLangs.length > 0 && !kvLangs.includes(lang)) {
      const fallback = pickFallbackLang(request, kvLangs, siteLang);
      if (fallback && fallback !== lang) {
        const to = new URL(request.url);
        to.searchParams.set("lang", fallback);
        return Response.redirect(to.toString(), 302);
      }
    }
  }

  // KV miss (page not built yet): generate on-the-fly as a fallback.
  // NOTE: serving NEVER writes to KV — the build is the sole KV writer. This
  // removes user-traffic-driven writes (and the write-limit 500 risk).
  const template = await loadTemplate(env, settings.template_id);
  let html: string | null = null;

  if (pathname === "/" || pathname === "") {
    html = await generatePage(env, "/", {}, lang, template, settings);
  } else if (
    pathname === "/about" ||
    pathname === "/about/" ||
    pathname === "/privacy" ||
    pathname === "/privacy/" ||
    pathname === "/terms" ||
    pathname === "/terms/"
  ) {
    // Standalone pages. /privacy/ and /terms/ 404 (null) while their site
    // text is empty — buildRenderContext enforces it.
    html = await generatePage(env, pathname, {}, lang, template, settings);
  } else {
    // Ordered matches: month archives (3+ segments) and category before the
    // generic /:type/:article/ pattern. Categories are always served here (never
    // pre-built); /page/N/ is the legacy paginated path kept for un-migrated
    // templates.
    let m: RegExpMatchArray | null;
    if (
      (m = pathname.match(new RegExp("^/monthly/([0-9]{4})/([0-9]{2})/?$")))
    ) {
      html = await generatePage(
        env,
        pathname,
        { month: `${m[1]}-${m[2]}` },
        lang,
        template,
        settings,
      );
    } else if (
      (m = pathname.match(
        new RegExp("^/category/([^/]+)/monthly/([0-9]{4})/([0-9]{2})/?$"),
      ))
    ) {
      html = await generatePage(
        env,
        pathname,
        { category: m[1], month: `${m[2]}-${m[3]}` },
        lang,
        template,
        settings,
      );
    } else if ((m = pathname.match(new RegExp("^/category/([^/]+)/?$")))) {
      html = await generatePage(
        env,
        pathname,
        { category: m[1] },
        lang,
        template,
        settings,
      );
    } else if (
      (m = pathname.match(
        new RegExp("^/([^/]+)/monthly/([0-9]{4})/([0-9]{2})/?$"),
      ))
    ) {
      html = await generatePage(
        env,
        pathname,
        { type: m[1], month: `${m[2]}-${m[3]}` },
        lang,
        template,
        settings,
      );
    } else if ((m = pathname.match(new RegExp("^/page/([0-9]+)/?$")))) {
      const page = parseInt(m[1], 10);
      if (page >= 2)
        html = await generatePage(
          env,
          pathname,
          { page: String(page) },
          lang,
          template,
          settings,
        );
    } else if ((m = pathname.match(new RegExp("^/([^/]+)/page/([0-9]+)/?$")))) {
      const page = parseInt(m[2], 10);
      if (page >= 2)
        html = await generatePage(
          env,
          pathname,
          { type: m[1], page: String(page) },
          lang,
          template,
          settings,
        );
    } else if ((m = pathname.match(new RegExp("^/([^/]+)/([^/]+)/?$")))) {
      html = await generatePage(
        env,
        pathname,
        { type: m[1], article: m[2] },
        lang,
        template,
        settings,
      );
    } else if ((m = pathname.match(new RegExp("^/([^/]+)/?$")))) {
      html = await generatePage(
        env,
        pathname,
        { type: m[1] },
        lang,
        template,
        settings,
      );
    }
  }

  if (!html) return null;

  // Do NOT write to KV here (build is the sole writer). Edge-cache only.
  const res = new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // On-demand pages (categories, un-built fallbacks): short fresh window +
      // a SWR grace so a stale hit serves instantly and refreshes in the
      // background instead of blocking on regeneration.
      "Cache-Control": "public, max-age=30, stale-while-revalidate=86400",
      "X-KuroCMS-Source": "generated",
    },
  });
  await edgeCache.put(edgeCacheKey, res.clone());
  return res;
}
