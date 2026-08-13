import {
  SESSION_COOKIE,
  bootstrapAdmin,
  clearSessionCookieHeader,
  createSession,
  createPersonalAccessToken,
  requireAdmin,
  requireAuth,
  requireAuthor,
  requireInteractiveUser,
  sessionCookieHeader,
  tryAuth,
} from "./auth";
import {
  buildDocumentPages,
  buildAllPublicPages,
  cheapHash,
  deleteArticlePages,
  extractTwTokens,
  findTwCdnUrl,
  generatePage,
  getBuildMode,
  rebuildIndexPages,
  setBuildMode,
  type BuildMode,
} from "./public";
import { cacheVersion, makeId, nowIso, randomToken, sha256Hex } from "./crypto";
import {
  mergeBlocks,
  normalizeBlockIds,
  type MergeConflict,
} from "./kuro-blocks.js";
// 本文 HTML の正規化（KuroEditor の paste と完全に同一実装の vendored コピー）。
import { normalizeContentHtml, inspectContentHtml } from "./normalize.js";
import { checkRecipeCards } from "./recipe-guard.js";
import { KUROMAILER_SHARED_SECRET } from "./kuromailer-secret";
import { COMMUNITY_SHARED_PAT } from "./community-secret";
import { verifyRegistration, verifyAuthentication } from "./webauthn";
// migrations/ を順番どおりに適用した最終形（スキーマの正本）。ビルド時生成。
import { SCHEMA_MANIFEST } from "./schema-manifest";
// GitHub の非 API 経路（レート制限に当たらない）からタグを読む純関数。
import {
  parseStableTagFromLocation,
  parseLatestTagFromAtom,
  releaseAssetUrl as buildReleaseAssetUrl,
} from "./github-release";
import {
  HttpError,
  json,
  jsonError,
  readJson,
  requireSlug,
  requireString,
  optionalString,
} from "./http";
import { isKuroCmsHtmlTemplate } from "./templates/html-template";
import {
  chooseTemplateSourceOrigin,
  isAcceptableTemplateSource,
  isSameZoneAsCommunity,
} from "./templates/community-source";
import {
  FONT_CATALOG,
  SYSTEM_FONTS,
  findCatalogEntry,
  findSystemFont,
  familyStack,
} from "./templates/font-catalog";
import type { AuthUser, Env, JsonValue } from "./types";
import { handleMcp } from "./mcp";
import { unfurlVerify, unfurlUrlAllowed, fetchUnfurl } from "./unfurl";

interface DocumentRow {
  did: string;
  slug: string;
  tid: string;
  mode: number;
  initial_lang: string;
  fallback_lang: string;
  publish_at: string;
  unpublish_at: string | null;
  created_at: string;
  updated_at: string;
  title: string | null;
  languages: string | null;
  category_ids: string | null;
  category_names: string | null;
  sns_bsky_posted_at: string | null;
  sns_threads_posted_at: string | null;
  sns_x_posted_at: string | null;
}

interface SingleDocumentRow {
  did: string;
  slug: string;
  tid: string;
  mode: number;
  initial_lang: string;
  fallback_lang: string;
  publish_at: string;
  created_at: string;
  updated_at: string;
  title: string | null;
  summary: string | null;
  body_html: string | null;
  metadata_json: string | null;
}

interface UserProfileRow {
  uid: string;
  email: string;
  display_name: string | null;
  author_id: string | null;
  is_admin: number;
  is_author: number;
  created_at: string;
  updated_at: string;
}

interface TokenListRow {
  token_id: string;
  name: string;
  scopes_json: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

interface CategoryRow {
  cid: string;
  name: string;
  slug: string;
  created_at: string;
  updated_at: string;
  article_count: number;
}

interface ManagedLanguageRow {
  lang: string;
  display_name: string | null;
  created_at: string;
  updated_at: string;
  document_count: number;
  search_count: number;
}

export const KUROCMS_VERSION = "1.9.35";
const KUROCMS_GITHUB_REPO = "Kuro-Boo/KuroCMS";
const KUROCMS_COMMUNITY_BASE_URL = "https://kuro.boo/kurocms";

// Throttle for the unauthenticated POST /api/migrate (see handler). KV-backed so
// it is shared across the isolate fleet; TTL just above the window bounds growth.
const MIGRATE_THROTTLE_KEY = "system:migrate_last_run";
const MIGRATE_THROTTLE_MS = 30_000;

const jsonHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,authorization",
  // Stamp every admin API response with the serving Worker's version. The admin
  // client compares this against the version that served its page and reloads
  // when they diverge (i.e. a system update swapped the Worker under an open
  // tab) — purely reactively, off the client's own requests, with no polling.
  // x-kurocms-docrev (added per-request by handleApi) is the article dataset's
  // revision; the admin list re-fetches when it changes, so out-of-band edits
  // (AI via REST/MCP) surface without a manual reload.
  "access-control-expose-headers": "x-kurocms-version, x-kurocms-docrev",
  "x-kurocms-version": KUROCMS_VERSION,
};

// Current revision of the article dataset, maintained by DB triggers (migration
// 0061). A single indexed-row read; any failure (e.g. pre-migration DB) yields
// null so the header is simply omitted. Stamped onto responses by handleApi.
async function readDocRev(env: Env): Promise<string | null> {
  try {
    const row = await env.DB.prepare(
      "SELECT rev FROM data_revision WHERE name = 'documents'",
    ).first<{ rev: number }>();
    return row ? String(row.rev) : null;
  } catch {
    return null;
  }
}

export async function handleApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const response = await handleApiDispatch(request, env, ctx);
  // Stamp the dataset revision so the admin list can auto-refresh on out-of-band
  // edits. Skip preflight and the public health check (kept read-free and hot).
  if (request.method === "OPTIONS") return response;
  if (new URL(request.url).pathname.endsWith("/api/health")) return response;
  const rev = await readDocRev(env);
  if (rev === null) return response;
  const headers = new Headers(response.headers);
  headers.set("x-kurocms-docrev", rev);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function handleApiDispatch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: jsonHeaders });
  }

  const startedAt = Date.now();
  const requestId = request.headers.get("cf-ray") || makeId("req");
  const url = new URL(request.url);
  const path = normalizeAdminApiPath(url.pathname);
  let actor: AuthUser | null = null;

  try {
    if (request.method === "GET" && path === "/api/health") {
      return json(
        {
          ok: true,
          service: "KuroCMS",
          version: KUROCMS_VERSION,
          time: nowIso(),
        },
        { headers: jsonHeaders },
      );
    }

    // WorkerOps Contract: apply pending migrations after a guardian-driven deploy.
    // Public + idempotent (run-once tracking). WorkerOps calls this via the service
    // binding with no auth header; safe to call repeatedly (applied migrations skip).
    // Because it is unauthenticated and each call triggers a GitHub manifest fetch,
    // a short KV throttle bounds resource abuse from anonymous callers. WorkerOps
    // issues a single post-deploy call, and the admin update path applies
    // migrations directly (systemUpdate → applyPendingMigrations), so the throttle
    // never blocks a legitimate migration.
    if (request.method === "POST" && path === "/api/migrate") {
      const last = await env.PUBLIC_PAGES.get(MIGRATE_THROTTLE_KEY);
      if (last && Date.now() - Number(last) < MIGRATE_THROTTLE_MS) {
        return json(
          { ok: true, applied: 0, throttled: true },
          { headers: jsonHeaders },
        );
      }
      await env.PUBLIC_PAGES.put(MIGRATE_THROTTLE_KEY, String(Date.now()), {
        expirationTtl: 60,
      });
      const applied = await applyPendingMigrations(env);
      // ⚠ WorkerOps 経由のデプロイ（インストーラーが作った guardian が叩く経路）
      //   でも必ずスキーマを収束させる。これで「どの経路で入った DB でも、
      //   デプロイのたびに正本へ揃う」が成立する。
      const schema = await reconcileSchema(env, true);
      return json(
        { ok: true, applied, schema: schema as unknown as JsonValue },
        { headers: jsonHeaders },
      );
    }

    if (request.method === "GET" && path === "/api/help") {
      return json(
        {
          ok: true,
          message: "KuroCMS REST API",
          base: "/kurocms/api/",
          // ⚠ "v1" は新しい世代ではなく **古い一族**。名前から中身を推測しない。
          //   記事もサイト管理も無印 /api/* にある。
          families: {
            "/api/*":
              "中核 API（57 本）。記事 documents/types/categories/languages、メディア、設定、利用者、認証、build、system/*。ふだん使うのはこちら。",
            "/api/v1/*":
              "古い一族（15 本）。テンプレート templates/*、サイト文字 content/*、そして公開フラグ published / unpublish のみ。バージョン番号ではなく歴史的な区分で、v1 が新しいわけではない。",
          },
          auth: {
            human: "Passkey (WebAuthn) — sets session cookie",
            machine: "Authorization: Bearer kuro_<PAT>",
            issueToken: "POST /api/me/tokens (requires session)",
          },
          endpoints: {
            public: ["GET /api/health", "GET /api/help"],
            setup: ["GET /api/setup/status", "POST /api/setup"],
            auth: [
              "GET /api/auth/session",
              "GET /api/auth/invite/:token",
              "POST /api/auth/passkey/register/begin",
              "POST /api/auth/passkey/register/complete",
              "POST /api/auth/passkey/login/begin",
              "POST /api/auth/passkey/login/complete",
              "POST /api/auth/logout",
            ],
            me: [
              "GET|PUT /api/me",
              "GET|POST /api/me/tokens",
              "POST /api/me/tokens/:tokenId/revoke",
            ],
            content: [
              "GET|POST /api/documents (GET=list: slug/tid/title/languages, no bodies, newest-updated first; filters ?slug= ?tid= ?mode= ?live= ?updatedSince= ?updatedUntil= ?q= ?lang= ?limit= ?offset= ?fields=; POST=create, 409 if slug exists)",
              "GET|PUT|DELETE /api/documents/:id (:id = did or globally-unique slug)",
              "GET /api/documents/:id/revisions (revision history, metadata only; ?lang= ?since= ?until= ?limit= ?offset=)",
              "POST /api/documents/revisions/dedupe (Admin; maintenance — reclaim duplicated revision bodies, chunked, `more` until done)",
              "GET /api/documents/:id/revisions/:revisionNo (one revision WITH bodyHtml; ?lang=, default = the article's base language)",
              "GET|PUT|DELETE /api/documents/:id/translations/:lang (PUT upserts)",
              "GET|PUT /api/documents/:id/categories",
              "PUT /api/documents/:id/timestamps",
              "PUT /api/documents/:id/translations/:lang/timestamps",
              "POST /api/documents/:id/build",
              "POST /api/mcp (MCP server, Streamable HTTP / JSON-RPC; PAT auth)",
              "GET|POST /api/types",
              "PUT|DELETE /api/types/:tid",
              "GET|POST /api/categories",
              "PUT|DELETE /api/categories/:cid",
              "GET|POST /api/languages",
              "DELETE /api/languages/:lang",
            ],
            // "Site text" = the template's fixed content blocks (footer, hero,
            // about, logo…), edited on the admin "サイト文字編集" tab. These live
            // on the older /api/v1/* family (shared with template/community
            // management) — see guides.siteText.
            siteText: [
              "GET /api/v1/content?lang=<code> (list site-text keys + this language's values)",
              "GET /api/v1/content/:id/translations[/:lang] (one key's languages, or one value)",
              "POST /api/v1/content (Admin; create a key across all languages)",
              "PUT /api/v1/content/:id/translations/:lang (Admin; body { name } = KuroEditor HTML)",
              "DELETE /api/v1/content/:id/translations/:lang (Admin; clear one language)",
              "DELETE /api/v1/content/:id (Admin; remove a key in every language)",
            ],
            media: [
              "POST /api/media/images",
              "POST /api/media/videos",
              "POST /api/media/audios",
            ],
            users: [
              "GET /api/users",
              "PUT /api/users/:uid",
              "DELETE /api/users/:uid",
              "POST /api/invitations",
            ],
            settings: [
              "GET|PUT /api/settings",
              "PUT /api/v1/published { published: boolean } — サイト全体の公開/非公開（配信のキルスイッチ）。GET /api/settings が返す siteIsPublished はこの値。PUT /api/settings に siteIsPublished を含めても同じ結果になる（内部で委譲）",
              "POST /api/v1/unpublish — 非公開に倒し、公開ページの実体も落とす",
            ],
            operations: ["POST /api/build", "GET|POST /api/backups"],
          },
          // Step-by-step procedures the flat endpoint index above can't convey.
          // Kept here so a client can drive content/translations correctly from
          // /api/help ALONE, without the separate spec document.
          guides: {
            translations: {
              model:
                "Article text is stored PER LANGUAGE in translations. The base language is simply the translation whose lang == the article's initialLang, so editing base-language text is the same call as adding another language. NOTE: 'site text' is a DIFFERENT concept (the template's fixed content blocks — footer, hero, about, etc.), stored separately — see guides.siteText; do not confuse the two.",
              ids: ":id in every /api/documents/:id[/...] route is the did (doc_<hex>) OR the globally-unique slug, interchangeably — take a slug straight from the GET /api/documents list and pass it in as :id; no did lookup step is needed.",
              update:
                "GET /api/documents -> pick a slug -> update it directly: PUT /api/documents/:slug/translations/:lang edits the body text (see upsertFields), PUT /api/documents/:slug edits publish state / type. There is no separate by-slug update route — the slug IS the :id.",
              list: "To enumerate editable content, GET /api/documents — each item carries slug, tid, title, initial_lang, languages (CSV of the langs that have a translation), mode/live and timestamps, but NO bodies. Rows are ordered by updated_at DESC. FILTER SERVER-SIDE instead of pulling the whole catalogue: ?slug=<exact slug, comma-separated for several> | ?q=<slug/title substring> | ?tid=<type> | ?mode=0|1 (publish flag) | ?live=0|1 (what the last build published) | ?updatedSince=/?updatedUntil=<ISO 8601 or YYYY-MM-DD, on updated_at> | ?limit=<1..1000, default 1000> | ?offset= | ?fields=<comma-separated keys to keep, e.g. slug,updated_at> | ?lastEditSource=<api|mcp|admin|autosave|maintenance|unknown, comma-separated> keeps articles whose CURRENT text in any language was last written by one of these (every row carries last_edit_sources = 'lang=source' pairs) | ?lang=<code> picks the display-title language. One known article needs no list call at all — GET /api/documents/<slug> directly.",
              history:
                "GET /api/documents/:id/revisions lists the article's revision history (?lang= ?since= ?until= ?limit=<1..200, default 50> ?offset=) -> { revisions:[{ revisionId, lang, revisionNo, title, snapshotAt, snapshotBy, bodyHash, bytes }], total, limit, offset }. Snapshots are FULL TEXT, not diffs — a revision always reads back as a complete bodyHtml, so nothing has to be replayed or merged; that is also why the list omits bodies. Storage-wise an unchanged body is STORED ONCE and later revisions share it (bodyShared:true says so) — this is invisible to readers, both the body and `bytes` are always the real ones. PROVENANCE — two DIFFERENT fields, do not mix them up: `source` = who WROTE that version's text; `replacedBy` = who OVERWROTE it. Values: api (REST with a PAT) | mcp (an MCP tool call) | admin (a human clicked save) | autosave (the admin editor's timer) | maintenance (a server-side sweep) | import (a bulk importer overwrote it) | null (before this was recorded). The machine-vs-human split comes from the auth mechanism, so it cannot be faked by a client. Filter with ?source= and ?replacedBy= (comma-separated; 'unknown' matches null). TO RECOVER TEXT AN AI DESTROYED: ?source=admin,autosave lists the versions a HUMAN wrote (newest first = what to restore), and ?source=admin,autosave&replacedBy=mcp,api narrows it to the ones a machine overwrote. Restore by PUTting that bodyHtml back. To find affected articles across the whole site in one call: GET /api/documents?lastEditSource=mcp,api (each row also carries last_edit_sources, e.g. 'ja=mcp,en=admin'). Fetch one with GET /api/documents/:id/revisions/:revisionNo (?lang= — revisionNo is sequential PER LANGUAGE and defaults to the article's base language) -> { revision:{ ..., bodyHtml, seo, hashtags } }. A revision is written BEFORE each overwrite/delete of a translation, so revision N is the text as it was before the N-th change; the current text is GET /api/documents/:id/translations/:lang. History is read-only (there is no rollback endpoint: PUT the old bodyHtml back to restore it).",
              read: "GET /api/documents/:id/translations lists an article's languages (lang, title, summary, updated_at). GET /api/documents/:id/translations/:lang returns that language's full title/summary/bodyHtml/seo/hashtags.",
              create: [
                "1. POST /api/documents { tid (an ALREADY-registered type), slug (globally unique, must not start with doc_), initialLang } -> 201 with the new did. This creates only the shell (no text); 409 if the slug exists.",
                "2. PUT /api/documents/:id/translations/:initialLang { title, bodyHtml } -> writes the base-language text.",
              ],
              addLanguage:
                "PUT /api/documents/:id/translations/:lang { title, bodyHtml } for any other language. An unregistered language is auto-registered on write, so no separate 'create language' step is required.",
              upsertFields:
                'PUT body: title (required, 1-240) | bodyHtml | summary (<=200) | seo (object) | hashtags (string[]) | baseBodyHash (optional) | createdAt/updatedAt (optional ISO 8601, for imports). OMITTING A FIELD KEEPS ITS STORED VALUE — this holds for bodyHtml, summary, seo AND hashtags alike, so a body-only update can no longer wipe the summary / hashtags / SEO (incl. the cover path). To CLEAR one, send it explicitly as "" / {} / []. bodyHtml is the one exception at CREATE time: a new translation must include it.',
              optimisticLock:
                "To avoid clobbering a concurrent edit, send baseBodyHash = SHA-256 hex of the bodyHtml you loaded. On mismatch the PUT returns 409 body_conflict (the current stored version is snapshotted to revision history first). Omit baseBodyHash to force-overwrite.",
              rules:
                ":lang is MANDATORY on PUT/DELETE (400 lang_required — the base language is never written/deleted implicitly). DELETE /api/documents/:id/translations/:lang cannot remove the base language or the last remaining translation; delete the whole article via DELETE /api/documents/:id instead.",
              publish:
                "A LIVE article rebuilds its public pages automatically after a translation save. A draft (or a full-site refresh) is materialized via POST /api/build.",
            },
            siteText: {
              model:
                "'Site text' is the template's FIXED content blocks (footer, hero, about, logo, favicon, etc.) — the admin 'サイト文字編集' tab — and is SEPARATE from articles/translations. Each block is a key (id, e.g. about-body, footer-text, top-hero-title) holding a per-language value. Values are KuroEditor HTML and may contain [[mid]] media refs. NOTE: these endpoints are on the older /api/v1/* family (shared with template/community management), not the unversioned core API.",
              list: "GET /api/v1/content?lang=<code> -> { items:[{ id, name (the value), is_system, is_inherited, updated_at }], lang, defaultLang }. is_inherited=1 means this language has no own value yet and falls back to defaultLang. This is the key list to enumerate site text.",
              update:
                "PUT /api/v1/content/:id/translations/:lang { name } upserts ONE key's value for ONE language (Admin) — the language is a PATH segment, mirroring article translations (/api/documents/:id/translations/:lang). name is the KuroEditor HTML value; it may be empty to blank a block, and has no length cap. Repeat per language for multilingual text. Read back with GET /api/v1/content/:id/translations/:lang (or omit :lang for all languages of the key).",
              keys: "POST /api/v1/content { id } creates a new key across every registered language with empty values (Admin). DELETE /api/v1/content/:id/translations/:lang clears ONE language's value; DELETE /api/v1/content/:id removes the key in ALL languages (Admin).",
              publish:
                "Site-text edits do NOT auto-rebuild (unlike article saves). Call POST /api/build (admin '今すぐビルド') to reflect them on the public site.",
            },
          },
        },
        { headers: jsonHeaders },
      );
    }

    if (request.method === "GET" && path === "/api/setup/status") {
      return withJsonHeaders(await setupStatus(env));
    }

    if (request.method === "POST" && path === "/api/setup") {
      return withJsonHeaders(await setup(request, env));
    }

    if (request.method === "GET" && path === "/api/auth/session") {
      return withJsonHeaders(await authSession(request, env));
    }

    const inviteTokenMatch = path.match(/^\/api\/auth\/invite\/([^/]+)$/);
    if (request.method === "GET" && inviteTokenMatch) {
      return withJsonHeaders(await getInviteInfo(env, inviteTokenMatch[1]));
    }

    // Passkey recovery by email (locked-out users). Both endpoints are public.
    if (request.method === "POST" && path === "/api/auth/recover/request") {
      return withJsonHeaders(await recoverRequest(request, env));
    }
    const recoverTokenMatch = path.match(/^\/api\/auth\/recover\/([^/]+)$/);
    if (request.method === "GET" && recoverTokenMatch) {
      return withJsonHeaders(await getRecoverInfo(env, recoverTokenMatch[1]));
    }

    if (
      request.method === "POST" &&
      path === "/api/auth/passkey/register/begin"
    ) {
      return withJsonHeaders(await passkeyRegisterBegin(request, env));
    }

    if (
      request.method === "POST" &&
      path === "/api/auth/passkey/register/complete"
    ) {
      return withJsonHeaders(await passkeyRegisterComplete(request, env));
    }

    if (request.method === "POST" && path === "/api/auth/passkey/login/begin") {
      return withJsonHeaders(await passkeyLoginBegin(request, env));
    }

    if (
      request.method === "POST" &&
      path === "/api/auth/passkey/login/complete"
    ) {
      return withJsonHeaders(await passkeyLoginComplete(request, env));
    }

    const singleMatch = path.match(/^\/api\/single\/([^/]+)$/);
    if (request.method === "GET" && singleMatch) {
      return withJsonHeaders(await getSingle(request, env, singleMatch[1]));
    }

    // Thumbnail images are public (no auth required) so community library can display them.
    const thumbPublicMatch = path.match(
      new RegExp("^/api/v1/templates/([^/]+)/thumbnail$"),
    );
    if (request.method === "GET" && thumbPublicMatch) {
      return siteTemplateServeThumbnail(env, thumbPublicMatch[1]);
    }

    // MCP server (Streamable HTTP, JSON-RPC). Authenticates internally with the
    // same PAT, then dispatches each tool call back through handleApi.
    if (path === "/api/mcp") {
      return handleMcp(request, env, ctx);
    }

    // URL カードのリッチ表示メタ取得（unfurl）。公開ページのクライアントが叩くため
    // 認証不要だが、開放プロキシ化を防ぐため「認証済み(Author)」か「ビルドが発行した
    // HMAC 署名」のどちらかを要求する。詳細は unfurlEndpoint。
    if (request.method === "OPTIONS" && path === "/api/unfurl") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          "Access-Control-Allow-Headers": "authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
    if (request.method === "GET" && path === "/api/unfurl") {
      return unfurlEndpoint(request, env);
    }

    const user = await requireAuth(env, request);
    actor = user;

    if (request.method === "GET" && path === "/api/system/storage") {
      requireAdmin(user);
      return withJsonHeaders(await systemStorage(env));
    }

    if (request.method === "POST" && path === "/api/system/r2/enable") {
      requireAdmin(user);
      return withJsonHeaders(await enableR2Storage(env));
    }

    if (request.method === "GET" && path === "/api/system/version") {
      requireAdmin(user);
      const refresh = new URL(request.url).searchParams.get("refresh") === "1";
      return withJsonHeaders(await systemVersion(env, refresh));
    }

    if (request.method === "POST" && path === "/api/system/update") {
      requireAdmin(user);
      return withJsonHeaders(await systemUpdate(request, env, user));
    }

    if (request.method === "PUT" && path === "/api/system/update-channel") {
      requireAdmin(user);
      return withJsonHeaders(await setUpdateChannel(request, env));
    }

    if (request.method === "GET" && path === "/api/system/custom-domains") {
      requireAdmin(user);
      return withJsonHeaders(await listCustomDomains(env));
    }

    if (request.method === "POST" && path === "/api/system/custom-domains") {
      requireAdmin(user);
      return withJsonHeaders(await addCustomDomain(request, env));
    }

    // ── Backup / Restore (client-orchestrated streaming ZIP) ──────────────
    if (request.method === "GET" && path === "/api/system/backup/manifest") {
      requireAdmin(user);
      return withJsonHeaders(await backupManifest(env));
    }
    const backupTableMatch = path.match(
      /^\/api\/system\/backup\/table\/([a-z_]+)$/,
    );
    if (request.method === "GET" && backupTableMatch) {
      requireAdmin(user);
      return withJsonHeaders(await backupTable(env, backupTableMatch[1], url));
    }
    const backupMediaMatch = path.match(
      /^\/api\/system\/backup\/media\/([^/]+)$/,
    );
    if (request.method === "GET" && backupMediaMatch) {
      requireAdmin(user);
      return await backupMedia(env, backupMediaMatch[1]);
    }
    if (request.method === "POST" && path === "/api/system/restore/wipe-db") {
      requireAdmin(user);
      return withJsonHeaders(await restoreWipeDb(env));
    }
    if (
      request.method === "POST" &&
      path === "/api/system/restore/wipe-media"
    ) {
      requireAdmin(user);
      return withJsonHeaders(await restoreWipeMedia(env, url));
    }
    if (
      request.method === "POST" &&
      path === "/api/system/restore/wipe-pages"
    ) {
      requireAdmin(user);
      return withJsonHeaders(await restoreWipePages(env, url));
    }
    const restoreTableMatch = path.match(
      /^\/api\/system\/restore\/table\/([a-z_]+)$/,
    );
    if (request.method === "POST" && restoreTableMatch) {
      requireAdmin(user);
      return withJsonHeaders(
        await restoreTable(request, env, restoreTableMatch[1]),
      );
    }
    const restoreMediaMatch = path.match(
      /^\/api\/system\/restore\/media\/([^/]+)$/,
    );
    if (request.method === "POST" && restoreMediaMatch) {
      requireAdmin(user);
      return withJsonHeaders(
        await restoreMedia(request, env, restoreMediaMatch[1]),
      );
    }
    // 重複メディアの統合（保守）。既定は dry run、?apply=1 で実行。
    // content_hash 未設定の行があるうちは phase:"hashing" を返すので、
    // 呼び手は done になるまで繰り返す（ワイプ系と同じ作法）。
    // スキーマの点検（GET＝報告のみ）／修復（POST）。更新時にも自動で走るが、
    // 移行の前後に単体で確かめられるようにしておく。
    if (path === "/api/system/schema") {
      requireAdmin(user);
      return withJsonHeaders(
        json(
          (await reconcileSchema(
            env,
            request.method === "POST",
          )) as unknown as JsonValue,
        ),
      );
    }
    if (request.method === "POST" && path === "/api/system/media/dedupe") {
      requireAdmin(user);
      return withJsonHeaders(await mediaDedupe(env, url));
    }
    if (request.method === "POST" && path === "/api/system/restore/finish") {
      requireAdmin(user);
      return withJsonHeaders(await restoreFinish(env));
    }

    if (request.method === "POST" && path === "/api/auth/logout") {
      return withJsonHeaders(await authLogout(request, env, user));
    }

    if (request.method === "POST" && path === "/api/invitations") {
      return withJsonHeaders(await createInvitation(request, env, user));
    }

    if (request.method === "GET" && path === "/api/users") {
      return withJsonHeaders(await listUsers(env, user));
    }
    const userUidMatch = path.match(/^\/api\/users\/([^/]+)$/);
    if (userUidMatch) {
      if (request.method === "PUT")
        return withJsonHeaders(
          await updateUser(request, env, user, userUidMatch[1]),
        );
      if (request.method === "DELETE")
        return withJsonHeaders(await deleteUser(env, user, userUidMatch[1]));
    }

    if (path === "/api/me") {
      return withJsonHeaders(await me(request, env, user));
    }

    if (path === "/api/me/tokens") {
      return withJsonHeaders(await meTokens(request, env, user));
    }

    const meTokenRevokeMatch = path.match(
      /^\/api\/me\/tokens\/([^/]+)\/revoke$/,
    );
    if (request.method === "POST" && meTokenRevokeMatch) {
      return withJsonHeaders(
        await revokeMeToken(env, user, meTokenRevokeMatch[1]),
      );
    }
    const meTokenDeleteMatch = path.match(
      /^\/api\/me\/tokens\/([^/]+)\/delete$/,
    );
    if (request.method === "DELETE" && meTokenDeleteMatch) {
      return withJsonHeaders(
        await deleteMeToken(env, user, meTokenDeleteMatch[1]),
      );
    }

    // Passkey (device) management for the signed-in user.
    if (request.method === "GET" && path === "/api/me/passkeys") {
      return withJsonHeaders(await listMyPasskeys(env, user));
    }
    const mePasskeyMatch = path.match(/^\/api\/me\/passkeys\/([^/]+)$/);
    if (mePasskeyMatch) {
      const credentialId = decodeURIComponent(mePasskeyMatch[1]);
      if (request.method === "PATCH")
        return withJsonHeaders(
          await renameMyPasskey(request, env, user, credentialId),
        );
      if (request.method === "DELETE")
        return withJsonHeaders(await deleteMyPasskey(env, user, credentialId));
    }

    if (path === "/api/settings") {
      return withJsonHeaders(await settings(request, env, user));
    }

    if (path === "/api/settings/worker-secrets") {
      return withJsonHeaders(await workerSecretsSettings(request, env, user));
    }

    if (path === "/api/fonts") {
      return withJsonHeaders(await fonts(request, env, user));
    }

    if (path === "/api/types") {
      return withJsonHeaders(await types(request, env, user));
    }

    const typeMatch = path.match(/^\/api\/types\/([^/]+)$/);
    if (typeMatch) {
      return withJsonHeaders(
        await typeDetail(request, env, user, typeMatch[1]),
      );
    }

    if (path === "/api/categories") {
      return withJsonHeaders(await categories(request, env, user));
    }

    const categoryMatch = path.match(/^\/api\/categories\/([^/]+)$/);
    if (categoryMatch) {
      return withJsonHeaders(
        await categoryDetail(request, env, user, categoryMatch[1]),
      );
    }

    if (path === "/api/languages") {
      return withJsonHeaders(await languages(request, env, user));
    }

    const languageMatch = path.match(/^\/api\/languages\/([^/]+)$/);
    if (request.method === "DELETE" && languageMatch) {
      return withJsonHeaders(
        await deleteLanguage(env, user, languageMatch[1], url),
      );
    }

    if (path === "/api/documents") {
      return withJsonHeaders(await documents(request, env, user, url));
    }

    // Every `/api/documents/:id/...` route below accepts EITHER a did
    // (`doc_<hex>`) or the globally-unique slug as `:id` — resolveDid() maps a
    // slug to its did (404 if none), so clients can read/update an article by
    // slug without first knowing its did.
    const documentTranslationTimestampsMatch = path.match(
      /^\/api\/documents\/([^/]+)\/translations\/([^/]+)\/timestamps$/,
    );
    if (documentTranslationTimestampsMatch) {
      return withJsonHeaders(
        await updateContentTimestamps(
          request,
          env,
          user,
          await resolveDid(env, documentTranslationTimestampsMatch[1]),
          documentTranslationTimestampsMatch[2],
        ),
      );
    }

    // Revision history (read-only). Metadata list, or one revision's full body
    // by revision_no — see documentRevisions for why the body is never in the
    // list. Routed before the generic /api/documents/:id matcher for the same
    // reason the translation routes are.
    const documentRevisionsMatch = path.match(
      /^\/api\/documents\/([^/]+)\/revisions(?:\/(\d+))?$/,
    );
    if (request.method === "GET" && documentRevisionsMatch) {
      return withJsonHeaders(
        await documentRevisions(
          env,
          await resolveDid(env, documentRevisionsMatch[1]),
          url,
          documentRevisionsMatch[2],
        ),
      );
    }

    const documentTranslationMatch = path.match(
      /^\/api\/documents\/([^/]+)\/translations(?:\/([^/]+))?$/,
    );
    if (documentTranslationMatch) {
      return withJsonHeaders(
        await documentTranslations(
          request,
          env,
          user,
          await resolveDid(env, documentTranslationMatch[1]),
          documentTranslationMatch[2],
          ctx,
        ),
      );
    }

    const documentCategoriesMatch = path.match(
      /^\/api\/documents\/([^/]+)\/categories$/,
    );
    if (documentCategoriesMatch) {
      return withJsonHeaders(
        await documentCategories(
          request,
          env,
          user,
          await resolveDid(env, documentCategoriesMatch[1]),
          ctx,
        ),
      );
    }

    const documentTimestampsMatch = path.match(
      /^\/api\/documents\/([^/]+)\/timestamps$/,
    );
    if (documentTimestampsMatch) {
      return withJsonHeaders(
        await updateContentTimestamps(
          request,
          env,
          user,
          await resolveDid(env, documentTimestampsMatch[1]),
        ),
      );
    }

    // Maintenance: strip Chrome-copy style noise (`revert-layer` dumps) and
    // normalize plain links in every stored translation body. MUST be routed
    // before the generic /api/documents/:id matcher below, which would
    // otherwise swallow "cleanup-styles" as a slug.
    if (request.method === "POST" && path === "/api/documents/cleanup-styles") {
      return withJsonHeaders(await cleanupCopyNoise(env, user));
    }

    // Maintenance: reclaim duplicated revision bodies written before body
    // sharing existed. Routed with the other maintenance sweeps, ahead of the
    // generic /api/documents/:id matcher.
    if (
      request.method === "POST" &&
      path === "/api/documents/revisions/dedupe"
    ) {
      return withJsonHeaders(await dedupeRevisionBodies(env, user));
    }

    // Maintenance: canonicalize body formatting (<b>/bold spans → <strong>,
    // <div> paragraphs → <p>, empty blocks). Same must-be-before-:id rule as
    // cleanup-styles above.
    if (
      request.method === "GET" &&
      path === "/api/documents/normalize-format"
    ) {
      return withJsonHeaders(await normalizeBodyFormatPreview(env, user));
    }
    if (
      request.method === "POST" &&
      path === "/api/documents/normalize-format"
    ) {
      return withJsonHeaders(await normalizeBodyFormat(env, user));
    }

    // 表紙の欠落補完（保守）。基準言語の表紙を、表紙を持たない翻訳へ配る。
    // GET = dry run（対象の一覧）、POST = 実行。
    if (path === "/api/documents/cover-fallback") {
      requireAdmin(user);
      return withJsonHeaders(
        await coverFallbackSweep(env, request.method === "POST"),
      );
    }

    const documentMatch = path.match(/^\/api\/documents\/([^/]+)$/);
    if (documentMatch) {
      return withJsonHeaders(
        await documentDetail(
          request,
          env,
          user,
          await resolveDid(env, documentMatch[1]),
          ctx,
        ),
      );
    }

    // Bulk posted-flag operation: mark/clear ALL documents for one service
    // (used when enabling a new SNS so existing articles don't get re-posted).
    if (request.method === "POST" && path === "/api/documents/sns/bulk-flag") {
      return withJsonHeaders(await documentSnsBulkFlag(request, env, user));
    }
    // Per-article SNS posted flag (Bluesky). GET reads it; PUT { bsky: bool }
    // sets (true) or clears (false) it — manual override of the posted state.
    const documentSnsMatch = path.match(/^\/api\/documents\/([^/]+)\/sns$/);
    if (documentSnsMatch) {
      return withJsonHeaders(
        await documentSnsFlag(request, env, user, documentSnsMatch[1]),
      );
    }
    // On-demand post to Bluesky (the green "投稿" button on unposted articles).
    const documentSnsPostMatch = path.match(
      /^\/api\/documents\/([^/]+)\/sns\/bsky\/post$/,
    );
    if (request.method === "POST" && documentSnsPostMatch) {
      return withJsonHeaders(
        await postDocumentToBluesky(env, user, documentSnsPostMatch[1]),
      );
    }
    // On-demand post to X (parent tweet + link-reply; see postToX).
    const documentSnsXPostMatch = path.match(
      /^\/api\/documents\/([^/]+)\/sns\/x\/post$/,
    );
    if (request.method === "POST" && documentSnsXPostMatch) {
      return withJsonHeaders(
        await postDocumentToX(env, user, documentSnsXPostMatch[1]),
      );
    }
    // On-demand post to Threads (single post: image URL + text + link).
    const documentSnsThreadsPostMatch = path.match(
      /^\/api\/documents\/([^/]+)\/sns\/threads\/post$/,
    );
    if (request.method === "POST" && documentSnsThreadsPostMatch) {
      return withJsonHeaders(
        await postDocumentToThreads(
          env,
          ctx,
          user,
          documentSnsThreadsPostMatch[1],
        ),
      );
    }

    if (request.method === "POST" && path === "/api/media/upload") {
      return withJsonHeaders(await uploadMediaFile(request, env, user));
    }
    const mediaAssetMatch = path.match(/^\/api\/media\/asset\/([^/]+)$/);
    if (request.method === "GET" && mediaAssetMatch) {
      return withJsonHeaders(
        await getMediaAssetByMid(env, decodeURIComponent(mediaAssetMatch[1])),
      );
    }
    if (request.method === "GET" && path === "/api/media/images") {
      return withJsonHeaders(await listMediaAssets(env, user, "image"));
    }
    if (request.method === "POST" && path === "/api/media/images/upload") {
      return withJsonHeaders(
        await uploadMediaFile(request, env, user, "image"),
      );
    }
    if (request.method === "POST" && path === "/api/media/images") {
      return withJsonHeaders(
        await createMediaAsset(request, env, user, "image"),
      );
    }
    if (request.method === "GET" && path === "/api/media/videos") {
      return withJsonHeaders(await listMediaAssets(env, user, "video"));
    }
    if (request.method === "POST" && path === "/api/media/videos/upload") {
      return withJsonHeaders(
        await uploadMediaFile(request, env, user, "video"),
      );
    }
    if (request.method === "POST" && path === "/api/media/videos") {
      return withJsonHeaders(
        await createMediaAsset(request, env, user, "video"),
      );
    }
    if (request.method === "GET" && path === "/api/media/audios") {
      return withJsonHeaders(await listMediaAssets(env, user, "audio"));
    }
    if (request.method === "POST" && path === "/api/media/audios/upload") {
      return withJsonHeaders(
        await uploadMediaFile(request, env, user, "audio"),
      );
    }
    if (request.method === "POST" && path === "/api/media/audios") {
      return withJsonHeaders(
        await createMediaAsset(request, env, user, "audio"),
      );
    }
    const mediaDeleteMatch = path.match(
      /^\/api\/media\/(images|videos|audios)\/([^/]+)\/delete$/,
    );
    if (request.method === "DELETE" && mediaDeleteMatch) {
      return withJsonHeaders(
        await deleteMediaAsset(env, user, mediaDeleteMatch[2]),
      );
    }

    // ── Site management: templates ──────────────────────────────────────────
    if (request.method === "GET" && path === "/api/v1/templates") {
      return withJsonHeaders(await siteTemplatesList(env, user));
    }
    if (request.method === "POST" && path === "/api/v1/templates") {
      return withJsonHeaders(await siteTemplateRegister(request, env, user));
    }
    const tmplActivateMatch = path.match(
      new RegExp("^/api/v1/templates/([^/]+)/activate$"),
    );
    if (request.method === "PUT" && tmplActivateMatch) {
      return withJsonHeaders(
        await siteTemplateActivate(env, user, tmplActivateMatch[1]),
      );
    }
    const tmplPreviewMatch = path.match(
      new RegExp("^/api/v1/templates/([^/]+)/preview$"),
    );
    if (request.method === "GET" && tmplPreviewMatch) {
      return siteTemplatePreview(request, env, user, tmplPreviewMatch[1]);
    }
    const tmplSourceMatch = path.match(
      new RegExp("^/api/v1/templates/([^/]+)/source-html$"),
    );
    if (request.method === "GET" && tmplSourceMatch) {
      return withJsonHeaders(
        await siteTemplateGetSource(env, user, tmplSourceMatch[1]),
      );
    }
    if (request.method === "PUT" && tmplSourceMatch) {
      return withJsonHeaders(
        await siteTemplateSaveSource(request, env, user, tmplSourceMatch[1]),
      );
    }
    // Static Tailwind CSS: token list for the admin-browser compile, and the
    // upload/clear of the compiled stylesheet (served at {base}/_tw/…).
    const tmplTwTokensMatch = path.match(
      new RegExp("^/api/v1/templates/([^/]+)/tw-tokens$"),
    );
    if (request.method === "GET" && tmplTwTokensMatch) {
      return withJsonHeaders(
        await siteTemplateTwTokens(env, user, tmplTwTokensMatch[1]),
      );
    }
    const tmplTwCssMatch = path.match(
      new RegExp("^/api/v1/templates/([^/]+)/compiled-css$"),
    );
    if (request.method === "PUT" && tmplTwCssMatch) {
      return withJsonHeaders(
        await siteTemplateSaveCompiledCss(
          request,
          env,
          user,
          tmplTwCssMatch[1],
        ),
      );
    }
    if (request.method === "DELETE" && tmplTwCssMatch) {
      return withJsonHeaders(
        await siteTemplateClearCompiledCss(env, user, tmplTwCssMatch[1]),
      );
    }
    const tmplThumbMatch = path.match(
      new RegExp("^/api/v1/templates/([^/]+)/thumbnail$"),
    );
    if (request.method === "GET" && tmplThumbMatch) {
      return siteTemplateServeThumbnail(env, tmplThumbMatch[1]);
    }
    // ローカルテンプレを Community へ upsert（初回公開 or 更新）— 正規ルート
    const tmplPublishMatch = path.match(
      new RegExp("^/api/v1/templates/([^/]+)/publish$"),
    );
    if (request.method === "POST" && tmplPublishMatch) {
      return withJsonHeaders(
        await siteTemplatePublish(env, user, tmplPublishMatch[1]),
      );
    }
    const tmplCommunityMatch = path.match(
      new RegExp("^/api/v1/templates/([^/]+)/community$"),
    );
    if (request.method === "PUT" && tmplCommunityMatch) {
      return withJsonHeaders(
        await siteTemplateSetCommunity(
          request,
          env,
          user,
          tmplCommunityMatch[1],
        ),
      );
    }
    if (request.method === "DELETE" && tmplCommunityMatch) {
      return withJsonHeaders(
        await siteTemplateDeleteCommunity(env, user, tmplCommunityMatch[1]),
      );
    }
    const tmplThumbnailMatch = path.match(
      new RegExp("^/api/v1/templates/([^/]+)/thumbnail$"),
    );
    if (request.method === "POST" && tmplThumbnailMatch) {
      requireAdmin(user);
      return withJsonHeaders(
        await siteTemplateLocalThumbnail(request, env, tmplThumbnailMatch[1]),
      );
    }
    const tmplDetailMatch = path.match(
      new RegExp("^/api/v1/templates/([^/]+)$"),
    );
    if (request.method === "GET" && tmplDetailMatch) {
      return withJsonHeaders(
        await siteTemplateDetail(env, user, tmplDetailMatch[1]),
      );
    }
    if (request.method === "PUT" && tmplDetailMatch) {
      return withJsonHeaders(
        await siteTemplateUpdateMeta(request, env, user, tmplDetailMatch[1]),
      );
    }
    if (request.method === "DELETE" && tmplDetailMatch) {
      return withJsonHeaders(
        await siteTemplateDelete(env, user, tmplDetailMatch[1]),
      );
    }
    // ── Site management: site text (template fixed-content blocks) ──────────
    // Per-language values mirror the article translations shape — the language
    // lives in the PATH: GET/PUT/DELETE /api/v1/content/:id/translations/:lang.
    // The cross-key list stays a query (all keys for one language), which is the
    // language-axis counterpart of GET /api/documents?lang=.
    if (request.method === "GET" && path === "/api/v1/content") {
      return withJsonHeaders(await siteContentList(request, env, user));
    }
    if (request.method === "POST" && path === "/api/v1/content") {
      return withJsonHeaders(await siteContentCreate(request, env, user));
    }
    const siteContentTranslationMatch = path.match(
      new RegExp("^/api/v1/content/([^/]+)/translations(?:/([^/]+))?$"),
    );
    if (siteContentTranslationMatch) {
      return withJsonHeaders(
        await siteContentTranslations(
          request,
          env,
          user,
          siteContentTranslationMatch[1],
          siteContentTranslationMatch[2],
        ),
      );
    }
    const siteContentMatch = path.match(
      new RegExp("^/api/v1/content/([^/]+)$"),
    );
    if (request.method === "DELETE" && siteContentMatch) {
      return withJsonHeaders(
        await siteContentDelete(request, env, user, siteContentMatch[1]),
      );
    }

    // Build scheduling mode: "manual" | "auto" | "always" (KV-backed).
    if (path === "/api/build/mode") {
      if (request.method === "GET") {
        requireAuthor(user);
        return json(
          { mode: await getBuildMode(env) },
          { headers: jsonHeaders },
        );
      }
      if (request.method === "PUT") {
        requireAdmin(user);
        const body2 = await readJson(request).catch(
          () => ({}) as Record<string, unknown>,
        );
        const raw = typeof body2.mode === "string" ? body2.mode : "";
        if (raw !== "manual" && raw !== "auto" && raw !== "always") {
          throw new HttpError(400, "bad_request", "invalid mode");
        }
        await setBuildMode(env, raw as BuildMode);
        return json({ ok: true, mode: raw }, { headers: jsonHeaders });
      }
    }

    if (request.method === "POST" && path === "/api/build") {
      requireAuthor(user);
      const body2 = await readJson(request).catch(
        () => ({}) as Record<string, unknown>,
      );
      const lang = (typeof body2.lang === "string" ? body2.lang : null) ?? "en";
      // Force a full rebuild (ignore the page_build_cache skip). The client sends
      // this ONLY on the first pass; resume passes omit it so chunked resume still
      // skips already-rebuilt pages.
      const force = body2.force === true;
      const enc = new TextEncoder();
      const { readable, writable } = new TransformStream<
        Uint8Array,
        Uint8Array
      >();
      const writer = writable.getWriter();
      // Run build asynchronously; stream NDJSON progress events to the client
      (async () => {
        try {
          await buildAllPublicPages(
            env,
            lang,
            (event) => {
              const line = JSON.stringify(event) + "\n";
              return writer.write(enc.encode(line));
            },
            BUILD_MAX_PER_INVOCATION,
            force,
          );
        } catch (err) {
          const errLine =
            JSON.stringify({ type: "error", message: String(err) }) + "\n";
          await writer.write(enc.encode(errLine)).catch(() => {});
        } finally {
          await writer.close().catch(() => {});
        }
      })();
      return new Response(readable, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    // Single-document build: the one per-document action that MATERIALIZES the
    // publish flag (promote syncs documents.live from mode before rendering,
    // and deletes the detail page when the document left publication).
    const buildDocMatch = path.match(/^\/api\/documents\/([^/]+)\/build$/);
    if (request.method === "POST" && buildDocMatch) {
      requireAuthor(user);
      // ⚠ resolveDid を必ず通すこと。ここだけ素の :id を渡していたため、slug で
      //   叩くと buildDocumentPages の WHERE d.did = ? が一件も引かず、何もせずに
      //   ok:true を返していた（他の /api/documents/:id/... は全て did/slug 両対応
      //   で、/api/help にもそう書いてある）。存在しない id は 404 で弾く。
      const buildDid = await resolveDid(env, buildDocMatch[1]);
      await buildDocumentPages(env, buildDid, [], { promote: true });
      return json({ ok: true, did: buildDid }, { headers: jsonHeaders });
    }

    if (request.method === "POST" && path === "/api/backups") {
      requireAdmin(user);
      return withJsonHeaders(await createBackup(env));
    }

    if (request.method === "POST" && path === "/api/debug/client-error") {
      return withJsonHeaders(await debugClientError(request, env, user));
    }

    if (request.method === "PUT" && path === "/api/v1/published") {
      return withJsonHeaders(await setSitePublished(request, env, user));
    }
    if (request.method === "POST" && path === "/api/v1/unpublish") {
      return withJsonHeaders(await siteUnpublish(env, user));
    }

    if (path === "/api/import/strapi/settings") {
      return withJsonHeaders(await strapiImportSettings(request, env, user));
    }
    if (request.method === "GET" && path === "/api/import/strapi/preview") {
      return withJsonHeaders(
        await strapiImportPreview(request, env, user, url),
      );
    }
    if (request.method === "POST" && path === "/api/import/strapi/execute") {
      return withJsonHeaders(await strapiImportExecute(request, env, user));
    }
    if (path === "/api/import/kurocms/settings") {
      return withJsonHeaders(await kurocmsImportSettings(request, env, user));
    }
    if (request.method === "GET" && path === "/api/import/kurocms/preview") {
      return withJsonHeaders(
        await kurocmsImportPreview(request, env, user, url),
      );
    }
    if (request.method === "POST" && path === "/api/import/kurocms/execute") {
      return withJsonHeaders(await kurocmsImportExecute(request, env, user));
    }

    throw new HttpError(404, "not_found", "API route was not found.");
  } catch (error) {
    await logDebugEvent(env, {
      requestId,
      level: error instanceof HttpError ? "warn" : "error",
      eventType: "api_error",
      phase: "handleApi",
      action: `${request.method} ${path}`,
      route: path,
      method: request.method,
      statusCode: error instanceof HttpError ? error.status : 500,
      latencyMs: Date.now() - startedAt,
      actorUid: actor?.uid ?? null,
      actorEmail: actor?.email ?? null,
      cfRay: request.headers.get("cf-ray"),
      userAgent: request.headers.get("user-agent"),
      errorCode: error instanceof HttpError ? error.code : "internal_error",
      errorMessage:
        error instanceof Error ? error.message : "Unexpected error.",
      errorStack: error instanceof Error ? error.stack || null : null,
      metadata: {
        authSource: actor?.authSource ?? null,
      },
    });
    if (error instanceof HttpError) {
      return json(
        { error: { code: error.code, message: error.message } },
        { status: error.status, headers: jsonHeaders },
      );
    }
    // Unexpected (non-HttpError) failures: the full message + stack are already
    // recorded via logDebugEvent above. Return a generic message so internal
    // implementation details never leak to the client; the requestId lets the
    // operator correlate the response with the logged detail.
    return json(
      {
        error: {
          code: "internal_error",
          message: "An unexpected error occurred.",
          requestId,
        },
      },
      { status: 500, headers: jsonHeaders },
    );
  }
}

// ---------------------------------------------------------------------------
// Single type endpoints (public, read-only)
// ---------------------------------------------------------------------------

async function getSingle(
  request: Request,
  env: Env,
  tidParam: string,
): Promise<Response> {
  const url = new URL(request.url);
  const requestedLang = (
    url.searchParams.get("lang") ??
    env.SITE_DEFAULT_LANG ??
    "en"
  )
    .trim()
    .toLowerCase();

  const query = `
    SELECT d.did, d.slug, d.tid, d.mode, d.initial_lang, d.fallback_lang,
           d.publish_at, d.created_at, d.updated_at,
           dt.title, dt.summary, dt.body_html, dt.metadata_json
    FROM documents d
    LEFT JOIN document_translations dt ON dt.did = d.did AND dt.lang = ?
    WHERE d.tid = ? AND d.mode = 1 AND d.live = 1
    LIMIT 1`;

  let row = await env.DB.prepare(query)
    .bind(requestedLang, tidParam)
    .first<SingleDocumentRow>();

  if (!row) {
    throw new HttpError(
      404,
      "single_not_found",
      "Single type document was not found.",
    );
  }

  // If the requested lang has no translation, try fallback_lang
  if (
    row.title === null &&
    row.fallback_lang &&
    row.fallback_lang !== requestedLang
  ) {
    const fallbackRow = await env.DB.prepare(query)
      .bind(row.fallback_lang, tidParam)
      .first<SingleDocumentRow>();
    if (fallbackRow) {
      row = fallbackRow;
    }
  }

  const lang =
    row.title !== null ? requestedLang : (row.fallback_lang ?? requestedLang);

  let metadata: JsonValue = null;
  if (row.metadata_json) {
    try {
      metadata = JSON.parse(row.metadata_json) as JsonValue;
    } catch {
      metadata = null;
    }
  }

  return json({
    tid: row.tid,
    slug: row.slug,
    did: row.did,
    lang,
    title: row.title ?? "",
    summary: row.summary ?? "",
    bodyHtml: row.body_html ?? "",
    metadata,
  });
}

// ---------------------------------------------------------------------------
// Auth endpoints
// ---------------------------------------------------------------------------

async function authSession(request: Request, env: Env): Promise<Response> {
  // Read session id from cookie or sess_ Bearer token (read-only, no session extension)
  let sessionId: string | null = null;

  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookieMatch = cookieHeader.match(
    new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`),
  );
  if (cookieMatch) {
    sessionId = cookieMatch[1];
  }

  if (!sessionId) {
    const authorization = request.headers.get("authorization") ?? "";
    const bearerMatch = authorization.match(/^Bearer\s+(sess_\S+)$/i);
    if (bearerMatch) {
      sessionId = bearerMatch[1];
    }
  }

  if (!sessionId) {
    return json({ authenticated: false });
  }

  const row = await env.DB.prepare(
    `SELECT
      sessions.session_id,
      sessions.uid,
      sessions.expires_at,
      users.email,
      users.display_name,
      users.is_admin,
      users.is_author,
      users.disabled_at
    FROM sessions
    INNER JOIN users ON users.uid = sessions.uid
    WHERE sessions.session_id = ?`,
  )
    .bind(sessionId)
    .first<{
      session_id: string;
      uid: string;
      expires_at: string;
      email: string;
      display_name: string | null;
      is_admin: number;
      is_author: number;
      disabled_at: string | null;
    }>();

  if (!row) {
    return json({ authenticated: false });
  }

  if (Date.parse(row.expires_at) <= Date.now()) {
    return json({ authenticated: false });
  }

  if (row.disabled_at) {
    return json({ authenticated: false });
  }

  return json({
    authenticated: true,
    uid: row.uid,
    email: row.email,
    // 管理 UI のタブタイトル（"KuroCMS <ユーザー名>"）に使う。複数インスタンスを
    // 同時に開いたときにどのサイトのタブか見分けられるようにするため。
    displayName: row.display_name ?? "",
    isAdmin: row.is_admin === 1,
    isAuthor: row.is_author === 1,
  });
}

interface InvitationRow {
  token: string;
  email: string;
  is_admin: number;
  is_author: number;
  expires_at: string;
}

/**
 * Resolve an unused invitation by its plaintext token. Invitations are stored
 * as a SHA-256 hash (like recovery tokens / PATs). Returns the stored PK value
 * (`token`) so callers consume the exact row. Does NOT check expiry — each
 * caller decides how to report it.
 */
async function lookupInvitationToken(
  env: Env,
  token: string,
): Promise<InvitationRow | null> {
  const tokenHash = await sha256Hex(token);
  return await env.DB.prepare(
    `SELECT token, email, is_admin, is_author, expires_at
     FROM invitation_tokens WHERE token = ? AND used_at IS NULL`,
  )
    .bind(tokenHash)
    .first<InvitationRow>();
}

async function getInviteInfo(env: Env, token: string): Promise<Response> {
  const row = await lookupInvitationToken(env, token);

  if (!row) {
    throw new HttpError(
      404,
      "invite_not_found",
      "Invitation was not found or already used.",
    );
  }

  if (Date.parse(row.expires_at) <= Date.now()) {
    throw new HttpError(404, "invite_expired", "Invitation has expired.");
  }

  return json({
    email: row.email,
    isAdmin: row.is_admin === 1,
    isAuthor: row.is_author === 1,
    expiresAt: row.expires_at,
  });
}

// ─── Email sending (via KuroMailer) ────────────────────────────────────────────

/** Minimal HTML-escape for interpolating text into email HTML bodies. */
function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Send one email through KuroMailer's KuroCMS endpoint. Server-side only — the
 * shared secret (KUROCMS_AND_KUROMAILER_PAT) is never exposed to the browser.
 * Spec: ../KuroMailer/docs/kurocms_rest_api.md.
 */
async function sendMail(
  env: Env,
  msg: {
    to: string;
    subject: string;
    html?: string;
    text?: string;
    fromName?: string;
    replyTo?: string;
    idempotencyKey?: string;
  },
): Promise<void> {
  // The shared key is embedded as a common constant; an optional Worker Secret
  // (env) may override it, but by default no per-install setup is required.
  const secret =
    (env.KUROCMS_AND_KUROMAILER_PAT ?? "").trim() || KUROMAILER_SHARED_SECRET;
  if (!secret) {
    throw new HttpError(
      503,
      "mailer_not_configured",
      "Email sending is not configured (missing KuroMailer shared secret).",
    );
  }
  const base = (env.KUROMAILER_URL ?? "https://mail.kuro.boo").replace(
    /\/+$/,
    "",
  );
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secret}`,
    "Content-Type": "application/json",
  };
  if (msg.idempotencyKey) headers["Idempotency-Key"] = msg.idempotencyKey;
  const resp = await fetch(`${base}/api/kurocms/send`, {
    method: "POST",
    headers,
    body: JSON.stringify(msg),
  });
  if (!resp.ok) {
    let detail = resp.statusText;
    try {
      const d = (await resp.json()) as { error?: string };
      if (d?.error) detail = d.error;
    } catch {
      /* non-JSON error body */
    }
    throw new HttpError(
      502,
      "mail_send_failed",
      `KuroMailer ${resp.status}: ${detail}`,
    );
  }
}

// ─── Passkey recovery (emailed magic link) ─────────────────────────────────────

const RECOVERY_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes
const RECOVERY_THROTTLE_MS = 60 * 1000; // min gap between requests per user

/** Derive the admin base path (e.g. "/kurocms/admin") from ACCESS_ADMIN_URL. */
function adminBasePath(env: Env): string {
  const raw = String(env.ACCESS_ADMIN_URL || "/kurocms/admin").trim();
  try {
    return new URL(raw).pathname.replace(/\/+$/, "") || "/kurocms/admin";
  } catch {
    return (
      (raw.startsWith("/") ? raw : `/${raw}`).replace(/\/+$/, "") ||
      "/kurocms/admin"
    );
  }
}

/**
 * Request a recovery link by email. Always returns 200 (no account enumeration);
 * only sends mail when a matching, enabled user exists and isn't throttled.
 */
async function recoverRequest(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const email = (optionalString(body, "email") ?? "").trim().toLowerCase();
  const ok = json({ ok: true });
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return ok;

  const user = await env.DB.prepare(
    "SELECT uid, email FROM users WHERE email = ? AND disabled_at IS NULL",
  )
    .bind(email)
    .first<{ uid: string; email: string }>();
  if (!user) return ok; // unknown email — say nothing

  // Throttle: skip if a token was issued for this user very recently.
  const recent = await env.DB.prepare(
    "SELECT created_at FROM recovery_tokens WHERE uid = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(user.uid)
    .first<{ created_at: string }>();
  if (
    recent &&
    Date.now() - Date.parse(recent.created_at) < RECOVERY_THROTTLE_MS
  ) {
    return ok;
  }

  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const now = nowIso();
  const expiresAt = new Date(Date.now() + RECOVERY_TOKEN_TTL_MS).toISOString();
  await env.DB.prepare(
    `INSERT INTO recovery_tokens (token_hash, uid, email, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(tokenHash, user.uid, user.email, expiresAt, now)
    .run();

  const origin = new URL(request.url).origin;
  const link = `${origin}${adminBasePath(env)}/?recover=${encodeURIComponent(token)}`;
  const settings = await env.DB.prepare(
    "SELECT site_name FROM site_settings WHERE id = 1",
  ).first<{ site_name: string | null }>();
  const siteName = (settings?.site_name ?? "KuroCMS").trim() || "KuroCMS";

  try {
    await sendMail(env, {
      to: user.email,
      fromName: siteName,
      subject: `[${siteName}] パスキー再設定のご案内 / Passkey recovery`,
      text:
        `${siteName} の管理画面にサインインするための新しいパスキーを登録できます。\n` +
        `次のリンクを開いてください（30分間有効・1回のみ）:\n${link}\n\n` +
        `心当たりがない場合はこのメールを無視してください。\n\n` +
        `Register a new passkey to sign in to ${siteName}.\n` +
        `Open this link (valid for 30 minutes, single use):\n${link}\n`,
      html:
        `<p>${htmlEscape(siteName)} の管理画面にサインインするための新しいパスキーを登録できます。</p>` +
        `<p><a href="${link}">パスキーを再設定する / Register a new passkey</a></p>` +
        `<p style="color:#666;font-size:13px">このリンクは30分間有効で、1回のみ使用できます。心当たりがない場合は無視してください。</p>`,
      idempotencyKey: `recover-${tokenHash}`,
    });
  } catch (err) {
    // Never leak configuration/send errors to an anonymous caller; log only.
    console.warn(
      JSON.stringify({
        event: "recovery_mail_failed",
        uid: user.uid,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  return ok;
}

/** Look up a recovery token's account (for the recovery screen). Public. */
async function getRecoverInfo(env: Env, token: string): Promise<Response> {
  const row = await lookupRecoveryToken(env, token);
  if (!row) {
    throw new HttpError(
      404,
      "recover_invalid",
      "This recovery link is invalid or has already been used.",
    );
  }
  if (Date.parse(row.expires_at) <= Date.now()) {
    throw new HttpError(
      404,
      "recover_expired",
      "This recovery link has expired.",
    );
  }
  return json({ email: row.email, expiresAt: row.expires_at });
}

/** Resolve an unused recovery token by its plaintext value. */
async function lookupRecoveryToken(
  env: Env,
  token: string,
): Promise<{ uid: string; email: string; expires_at: string } | null> {
  const tokenHash = await sha256Hex(token);
  return await env.DB.prepare(
    "SELECT uid, email, expires_at FROM recovery_tokens WHERE token_hash = ? AND used_at IS NULL",
  )
    .bind(tokenHash)
    .first<{ uid: string; email: string; expires_at: string }>();
}

async function passkeyRegisterBegin(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await readJson(request);
  const uid = optionalString(body, "uid") ?? null;
  const invitationToken = optionalString(body, "invitationToken") ?? null;
  const recoveryToken = optionalString(body, "recoveryToken") ?? null;

  let userEmail: string;
  let resolvedUid: string | null;

  // Authorization for who a new passkey may be registered to, in priority order:
  //   1. Authenticated session → add a device to MY account (body uid ignored).
  //   2. Valid invitation token → new user (uid created at complete time).
  //   3. Valid recovery token → add a passkey to the existing locked-out account.
  //   4. Bootstrap: a uid may be used ONLY when no passkeys exist anywhere yet
  //      (the very first passkey, i.e. initial setup). Once any passkey exists,
  //      adding to an account requires a session — closing the previous hole
  //      where an arbitrary uid could be passed unauthenticated.
  const sessionUser = await tryAuth(env, request);
  if (sessionUser) {
    resolvedUid = sessionUser.uid;
    userEmail = sessionUser.email;
  } else if (recoveryToken) {
    const rec = await lookupRecoveryToken(env, recoveryToken);
    if (!rec || Date.parse(rec.expires_at) <= Date.now()) {
      throw new HttpError(
        404,
        "recover_invalid",
        "This recovery link is invalid, expired, or already used.",
      );
    }
    resolvedUid = rec.uid;
    userEmail = rec.email;
  } else if (invitationToken) {
    const invRow = await lookupInvitationToken(env, invitationToken);
    if (!invRow) {
      throw new HttpError(
        404,
        "invite_not_found",
        "Invitation was not found or already used.",
      );
    }
    if (Date.parse(invRow.expires_at) <= Date.now()) {
      throw new HttpError(400, "invite_expired", "Invitation has expired.");
    }
    userEmail = invRow.email;
    resolvedUid = null; // will be created at complete time
  } else if (uid) {
    const credCount = await env.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM passkey_credentials",
    ).first<{ cnt: number }>();
    if ((credCount?.cnt ?? 0) > 0) {
      throw new HttpError(
        403,
        "registration_not_authorized",
        "Sign in or use a valid invitation to register a passkey.",
      );
    }
    const userRow = await env.DB.prepare(
      "SELECT uid, email FROM users WHERE uid = ?",
    )
      .bind(uid)
      .first<{ uid: string; email: string }>();
    if (!userRow) {
      throw new HttpError(404, "user_not_found", "User was not found.");
    }
    resolvedUid = uid;
    userEmail = userRow.email;
  } else {
    throw new HttpError(
      401,
      "registration_not_authorized",
      "Sign in or use a valid invitation to register a passkey.",
    );
  }

  const challengeId = makeId("wac");
  const challenge = randomToken();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const now = nowIso();

  await env.DB.prepare(
    `INSERT INTO webauthn_challenges (challenge_id, challenge, uid, challenge_type, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(challengeId, challenge, resolvedUid, "register", expiresAt, now)
    .run();

  const rpId = new URL(request.url).hostname;
  const userIdForResponse = resolvedUid ?? "pending";

  return json({
    challengeId,
    challenge,
    rp: { id: rpId, name: "KuroCMS" },
    user: {
      id: userIdForResponse,
      name: userEmail,
      displayName: userEmail,
    },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    timeout: 60000,
    attestation: "none",
    authenticatorSelection: {
      userVerification: "required",
      residentKey: "required",
    },
  });
}

async function passkeyRegisterComplete(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await readJson(request);
  const challengeId = requireString(body, "challengeId", { min: 1, max: 80 });
  const invitationToken = optionalString(body, "invitationToken") ?? null;
  const recoveryToken = optionalString(body, "recoveryToken") ?? null;
  // Optional human-friendly device label shown in passkey management.
  const deviceName = (optionalString(body, "deviceName") ?? "").slice(0, 80);

  const credential = body.credential as {
    id: string;
    rawId: string;
    type: string;
    response: { clientDataJSON: string; attestationObject: string };
  };
  if (!credential || typeof credential !== "object") {
    throw new HttpError(400, "invalid_credential", "credential is required.");
  }

  const challengeRow = await env.DB.prepare(
    `SELECT challenge_id, challenge, uid, challenge_type, expires_at
     FROM webauthn_challenges WHERE challenge_id = ?`,
  )
    .bind(challengeId)
    .first<{
      challenge_id: string;
      challenge: string;
      uid: string | null;
      challenge_type: string;
      expires_at: string;
    }>();

  if (!challengeRow || challengeRow.challenge_type !== "register") {
    throw new HttpError(
      400,
      "invalid_challenge",
      "Challenge not found or invalid.",
    );
  }
  if (Date.parse(challengeRow.expires_at) <= Date.now()) {
    throw new HttpError(400, "challenge_expired", "Challenge has expired.");
  }

  // Delete challenge (one-time use)
  await env.DB.prepare("DELETE FROM webauthn_challenges WHERE challenge_id = ?")
    .bind(challengeId)
    .run();

  const rpId = new URL(request.url).hostname;

  let verifyResult: Awaited<ReturnType<typeof verifyRegistration>>;
  try {
    verifyResult = await verifyRegistration(
      challengeRow.challenge,
      rpId,
      credential.response,
    );
  } catch (err) {
    throw new HttpError(
      400,
      "webauthn_verification_failed",
      err instanceof Error ? err.message : "Verification failed.",
    );
  }

  // Determine uid
  let resolvedUid = challengeRow.uid;
  let resolvedEmail: string;

  if (!resolvedUid) {
    // Need to create user from invitation
    if (!invitationToken) {
      throw new HttpError(
        400,
        "invitation_required",
        "invitationToken is required for new user registration.",
      );
    }
    const invRow = await lookupInvitationToken(env, invitationToken);

    if (!invRow) {
      throw new HttpError(
        404,
        "invite_not_found",
        "Invitation was not found or already used.",
      );
    }
    if (Date.parse(invRow.expires_at) <= Date.now()) {
      throw new HttpError(400, "invite_expired", "Invitation has expired.");
    }

    const userCount = await env.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM users",
    ).first<{
      cnt: number;
    }>();
    resolvedUid = `usr_${String((userCount?.cnt ?? 0) + 1).padStart(3, "0")}`;
    resolvedEmail = invRow.email;
    const now = nowIso();
    await env.DB.prepare(
      `INSERT INTO users (uid, email, display_name, author_id, is_admin, is_author, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        resolvedUid,
        resolvedEmail,
        "KuroCMS",
        makeId("author"),
        invRow.is_admin,
        invRow.is_author,
        now,
        now,
      )
      .run();

    // Consume by the stored PK value (hash for new invites, legacy plaintext for
    // old ones) — not the presented plaintext, which won't match a hashed row.
    await env.DB.prepare(
      "UPDATE invitation_tokens SET used_at = ? WHERE token = ?",
    )
      .bind(now, invRow.token)
      .run();
  } else {
    const userRow = await env.DB.prepare(
      "SELECT email FROM users WHERE uid = ?",
    )
      .bind(resolvedUid)
      .first<{ email: string }>();
    resolvedEmail = userRow?.email ?? "";
  }

  // Check if credential already registered
  const existing = await env.DB.prepare(
    "SELECT credential_id FROM passkey_credentials WHERE credential_id = ?",
  )
    .bind(verifyResult.credentialId)
    .first<{ credential_id: string }>();
  if (existing) {
    throw new HttpError(
      409,
      "credential_exists",
      "This passkey credential is already registered.",
    );
  }

  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO passkey_credentials
      (credential_id, uid, public_key_spki, sign_count, aaguid, display_name, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      verifyResult.credentialId,
      resolvedUid,
      verifyResult.publicKeySpki,
      verifyResult.signCount,
      verifyResult.aaguid,
      deviceName || resolvedEmail,
      now,
      now,
    )
    .run();

  // Consume the recovery token (single-use). The guard prevents reuse if the
  // same link is opened twice concurrently.
  if (recoveryToken) {
    const tokenHash = await sha256Hex(recoveryToken);
    await env.DB.prepare(
      "UPDATE recovery_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL",
    )
      .bind(now, tokenHash)
      .run();
  }

  const sessionId = await createSession(
    env,
    resolvedUid,
    verifyResult.credentialId,
  );
  const secure = new URL(request.url).protocol === "https:";

  const resp = json({ ok: true, uid: resolvedUid, email: resolvedEmail });
  resp.headers.set("Set-Cookie", sessionCookieHeader(sessionId, secure));
  return withJsonHeaders(resp);
}

async function passkeyLoginBegin(
  request: Request,
  env: Env,
): Promise<Response> {
  const challengeId = makeId("wac");
  const challenge = randomToken();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const now = nowIso();

  await env.DB.prepare(
    `INSERT INTO webauthn_challenges (challenge_id, challenge, uid, challenge_type, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(challengeId, challenge, null, "authenticate", expiresAt, now)
    .run();

  const rpId = new URL(request.url).hostname;

  return json({
    challengeId,
    challenge,
    rpId,
    userVerification: "required",
    timeout: 60000,
  });
}

async function passkeyLoginComplete(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await readJson(request);
  const challengeId = requireString(body, "challengeId", { min: 1, max: 80 });

  const credential = body.credential as {
    id: string;
    rawId: string;
    type: string;
    response: {
      clientDataJSON: string;
      authenticatorData: string;
      signature: string;
      userHandle?: string;
    };
  };
  if (!credential || typeof credential !== "object") {
    throw new HttpError(400, "invalid_credential", "credential is required.");
  }

  const challengeRow = await env.DB.prepare(
    `SELECT challenge_id, challenge, uid, challenge_type, expires_at
     FROM webauthn_challenges WHERE challenge_id = ?`,
  )
    .bind(challengeId)
    .first<{
      challenge_id: string;
      challenge: string;
      uid: string | null;
      challenge_type: string;
      expires_at: string;
    }>();

  if (!challengeRow || challengeRow.challenge_type !== "authenticate") {
    throw new HttpError(
      400,
      "invalid_challenge",
      "Challenge not found or invalid.",
    );
  }
  if (Date.parse(challengeRow.expires_at) <= Date.now()) {
    throw new HttpError(400, "challenge_expired", "Challenge has expired.");
  }

  // Delete challenge (one-time use)
  await env.DB.prepare("DELETE FROM webauthn_challenges WHERE challenge_id = ?")
    .bind(challengeId)
    .run();

  // Look up passkey credential
  const passkeyRow = await env.DB.prepare(
    `SELECT credential_id, uid, public_key_spki, sign_count FROM passkey_credentials WHERE credential_id = ?`,
  )
    .bind(credential.id)
    .first<{
      credential_id: string;
      uid: string;
      public_key_spki: string;
      sign_count: number;
    }>();

  if (!passkeyRow) {
    throw new HttpError(
      401,
      "credential_not_found",
      "Passkey credential not found.",
    );
  }

  // Get user and check disabled
  const userRow = await env.DB.prepare(
    `SELECT uid, email, is_admin, is_author, disabled_at FROM users WHERE uid = ?`,
  )
    .bind(passkeyRow.uid)
    .first<{
      uid: string;
      email: string;
      is_admin: number;
      is_author: number;
      disabled_at: string | null;
    }>();

  if (!userRow) {
    throw new HttpError(401, "user_not_found", "User was not found.");
  }
  if (userRow.disabled_at) {
    throw new HttpError(403, "user_disabled", "User is disabled.");
  }

  const rpId = new URL(request.url).hostname;

  let verifyResult: Awaited<ReturnType<typeof verifyAuthentication>>;
  try {
    verifyResult = await verifyAuthentication(
      challengeRow.challenge,
      rpId,
      passkeyRow.public_key_spki,
      passkeyRow.sign_count,
      credential.response,
    );
  } catch (err) {
    throw new HttpError(
      401,
      "webauthn_verification_failed",
      err instanceof Error ? err.message : "Verification failed.",
    );
  }

  const now = nowIso();
  await env.DB.prepare(
    "UPDATE passkey_credentials SET sign_count = ?, last_used_at = ? WHERE credential_id = ?",
  )
    .bind(verifyResult.newSignCount, now, passkeyRow.credential_id)
    .run();

  const sessionId = await createSession(
    env,
    passkeyRow.uid,
    passkeyRow.credential_id,
  );
  const secure = new URL(request.url).protocol === "https:";

  const resp = json({ ok: true, uid: passkeyRow.uid, email: userRow.email });
  resp.headers.set("Set-Cookie", sessionCookieHeader(sessionId, secure));
  return withJsonHeaders(resp);
}

async function authLogout(
  request: Request,
  env: Env,
  user: AuthUser,
): Promise<Response> {
  if (user.sessionId) {
    await env.DB.prepare("DELETE FROM sessions WHERE session_id = ?")
      .bind(user.sessionId)
      .run();
  }
  const secure = new URL(request.url).protocol === "https:";
  const resp = json({ ok: true });
  resp.headers.set("Set-Cookie", clearSessionCookieHeader(secure));
  return withJsonHeaders(resp);
}

async function createInvitation(
  request: Request,
  env: Env,
  user: AuthUser,
): Promise<Response> {
  requireAdmin(user);
  const body = await readJson(request);
  const email = requireString(body, "email", {
    min: 3,
    max: 254,
  }).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new HttpError(
      400,
      "invalid_email",
      "email must be a valid email address.",
    );
  }
  const isAdmin = body.isAdmin === true;
  const isAuthor = body.isAuthor !== false; // default true
  // Return the plaintext token to the admin (the invite-link value), but persist
  // only its SHA-256 hash — same handling as recovery tokens and PATs, so a DB
  // read never yields a usable invitation.
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  const now = nowIso();

  await env.DB.prepare(
    `INSERT INTO invitation_tokens (token, email, is_admin, is_author, expires_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      tokenHash,
      email,
      isAdmin ? 1 : 0,
      isAuthor ? 1 : 0,
      expiresAt,
      user.uid,
      now,
    )
    .run();

  return json({ token, email, expiresAt, isAdmin, isAuthor }, { status: 201 });
}

// ─── User management ──────────────────────────────────────────────────────────

async function listUsers(env: Env, user: AuthUser): Promise<Response> {
  requireAdmin(user);
  const rows = await env.DB.prepare(
    `SELECT users.uid, users.email, users.display_name, users.author_id,
            users.is_admin, users.is_author, users.disabled_at,
            users.created_at, users.updated_at,
            (SELECT MAX(p.last_used_at) FROM passkey_credentials p WHERE p.uid = users.uid) AS last_login_at
     FROM users ORDER BY users.created_at ASC`,
  ).all<Record<string, unknown>>();
  return json({ users: rows.results as JsonValue });
}

async function updateUser(
  request: Request,
  env: Env,
  user: AuthUser,
  uid: string,
): Promise<Response> {
  requireAdmin(user);
  if (uid === user.uid)
    throw new HttpError(
      400,
      "cannot_modify_self",
      "自分自身の権限は変更できません。",
    );
  const target = await env.DB.prepare("SELECT uid FROM users WHERE uid = ?")
    .bind(uid)
    .first();
  if (!target)
    throw new HttpError(404, "user_not_found", "ユーザーが見つかりません。");
  const body = await readJson(request);
  const updates: string[] = [];
  const values: (string | number | null)[] = [];
  if (typeof body.isAdmin === "boolean") {
    updates.push("is_admin = ?");
    values.push(body.isAdmin ? 1 : 0);
  }
  if (typeof body.isAuthor === "boolean") {
    updates.push("is_author = ?");
    values.push(body.isAuthor ? 1 : 0);
  }
  if (typeof body.disabled === "boolean") {
    updates.push("disabled_at = ?");
    values.push(body.disabled ? nowIso() : null);
  }
  // メールの訂正。⚠ メールはパスキー復旧の宛先（recoverRequest が email で
  // 本人を引く）。打ち間違えたまま本人がログインできなくなると復旧不能に
  // なるので、管理者が直せる必要がある。検証は PUT /api/me と同じ規則。
  if (typeof body.email === "string") {
    const email = body.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new HttpError(
        400,
        "invalid_email",
        "email must be a valid email address.",
      );
    }
    const duplicate = await env.DB.prepare(
      "SELECT uid FROM users WHERE email = ? AND uid != ?",
    )
      .bind(email, uid)
      .first<{ uid: string }>();
    if (duplicate) {
      throw new HttpError(
        409,
        "email_taken",
        "email is already used by another user.",
      );
    }
    updates.push("email = ?");
    values.push(email);
  }
  if (!updates.length)
    throw new HttpError(400, "no_changes", "変更する項目がありません。");
  updates.push("updated_at = ?");
  values.push(nowIso(), uid);
  await env.DB.prepare(`UPDATE users SET ${updates.join(", ")} WHERE uid = ?`)
    .bind(...values)
    .run();
  await logActivity(env, user, "user.update", "user", uid, {
    fields: updates.map((u) => u.split(" ")[0]),
  });
  return json({ ok: true });
}

async function deleteUser(
  env: Env,
  user: AuthUser,
  uid: string,
): Promise<Response> {
  requireAdmin(user);
  if (uid === user.uid)
    throw new HttpError(
      400,
      "cannot_delete_self",
      "自分自身は削除できません。",
    );
  const target = await env.DB.prepare("SELECT uid FROM users WHERE uid = ?")
    .bind(uid)
    .first();
  if (!target)
    throw new HttpError(404, "user_not_found", "ユーザーが見つかりません。");
  await env.DB.prepare("DELETE FROM users WHERE uid = ?").bind(uid).run();
  await logActivity(env, user, "user.delete", "user", uid, {});
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function setupStatus(env: Env): Promise<Response> {
  const userCount = await countUsers(env);
  return json({
    needsSetup: userCount === 0,
  });
}

async function setup(request: Request, env: Env): Promise<Response> {
  if ((await countUsers(env)) > 0) {
    throw new HttpError(
      409,
      "setup_completed",
      "Initial setup has already been completed.",
    );
  }

  const body = await readJson(request);
  const email = requireString(body, "adminEmail", {
    min: 3,
    max: 254,
  }).toLowerCase();
  const publicDomain = optionalString(body, "publicDomain") ?? "";
  const defaultLang =
    optionalString(body, "defaultLang") ?? env.SITE_DEFAULT_LANG ?? "en";
  const initialLang = optionalString(body, "initialLang") ?? defaultLang;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new HttpError(
      400,
      "invalid_email",
      "adminEmail must be a valid email address.",
    );
  }
  if (publicDomain) validateDomain(publicDomain, "publicDomain");
  if (body.licenseAccepted !== true) {
    throw new HttpError(
      400,
      "license_required",
      "Kuro License acceptance is required.",
    );
  }

  const result = await bootstrapAdmin(env, { email });

  const acceptedAt = nowIso();
  await saveSettings(env, {
    public_domain: publicDomain,
    default_lang: defaultLang,
    initial_lang: initialLang,
    license_accepted_at: acceptedAt,
    license_accepted_by: result.uid,
    license_name: "Kuro License",
    license_attribution_phrase: "with KuroCMS",
    setup_completed_at: acceptedAt,
  });
  await env.DB.prepare(
    `INSERT INTO activity_logs
      (id, actor_uid, action, target_type, target_id, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      makeId("act"),
      result.uid,
      "license.accept",
      "license",
      "kuro-license",
      JSON.stringify({
        licenseName: "Kuro License",
        attributionPhrase: "with KuroCMS",
      }),
      acceptedAt,
    )
    .run();

  return json({ ok: true, uid: result.uid });
}

// Free tier limits
const FREE_D1_BYTES = 5 * 1024 * 1024 * 1024; //  5 GB
const FREE_R2_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB
const FREE_KV_BYTES = 1 * 1024 * 1024 * 1024; //  1 GB
const FREE_KV_WRITES_DAY = 1000; // KV writes/day (different keys), Free plan
const FREE_KV_READS_DAY = 100000; // KV reads/day, Free plan

// Max pages BUILT per /api/build invocation. Each built page costs several
// subrequests (D1 reads + KV/D1 writes); a Worker invocation allows ~1000
// subrequests. Keep this well under that so a full rebuild never trips the
// "Too many API requests by single Worker invocation" limit — the client
// resumes across invocations until the build reports more:false.
const BUILD_MAX_PER_INVOCATION = 50;

/**
 * Today's (UTC) KV operation counts from the Cloudflare GraphQL Analytics API
 * (`kvOperationsAdaptiveGroups`). Returns null when CF creds are missing or the
 * query fails — the dashboard then shows limits/reset only. KV op counts are NOT
 * exposed by the KV binding; GraphQL is the authoritative source.
 */
async function fetchKvOpsToday(env: Env): Promise<{
  reads: number;
  writes: number;
  deletes: number;
  lists: number;
} | null> {
  const token = env.CF_API_TOKEN;
  const accountId = env.CF_ACCOUNT_ID;
  if (!token || !accountId) return null;
  const today = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
  const query =
    "query($a:string!,$d:Date!){viewer{accounts(filter:{accountTag:$a}){" +
    "kvOperationsAdaptiveGroups(filter:{date_geq:$d,date_leq:$d},limit:10000){" +
    "sum{requests}dimensions{actionType}}}}}";
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables: { a: accountId, d: today } }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      data?: {
        viewer?: {
          accounts?: Array<{
            kvOperationsAdaptiveGroups?: Array<{
              sum?: { requests?: number };
              dimensions?: { actionType?: string };
            }>;
          }>;
        };
      };
    };
    const groups =
      body.data?.viewer?.accounts?.[0]?.kvOperationsAdaptiveGroups ?? [];
    const out = { reads: 0, writes: 0, deletes: 0, lists: 0 };
    for (const g of groups) {
      const n = Number(g.sum?.requests ?? 0);
      switch (g.dimensions?.actionType) {
        case "read":
          out.reads += n;
          break;
        case "write":
          out.writes += n;
          break;
        case "delete":
          out.deletes += n;
          break;
        case "list":
          out.lists += n;
          break;
      }
    }
    return out;
  } catch {
    return null;
  }
}

async function systemStorage(env: Env): Promise<Response> {
  // D1 size — estimate from total row/blob sizes across main tables
  const d1SizeRow = await env.DB.prepare(
    `
    SELECT (
      (SELECT COUNT(*) FROM documents) * 512 +
      (SELECT COALESCE(SUM(LENGTH(body_html) + LENGTH(COALESCE(title,'')) + LENGTH(COALESCE(summary,''))), 0) FROM document_translations) +
      (SELECT COALESCE(SUM(LENGTH(COALESCE(detail_json,''))), 0) FROM activity_logs) +
      (SELECT COUNT(*) FROM taxonomy_items) * 256 +
      (SELECT COUNT(*) FROM categories) * 256 +
      (SELECT COUNT(*) FROM users) * 256 +
      (SELECT COUNT(*) FROM sessions) * 128 +
      524288
    ) AS est
  `,
  ).first<{ est: number }>();
  const d1Bytes = Number(d1SizeRow?.est ?? 524288);

  // R2 usage tracked via media_assets.size_bytes in D1
  const r2Row = await env.DB.prepare(
    "SELECT COALESCE(SUM(size_bytes),0) AS total FROM media_assets",
  ).first<{ total: number }>();
  const r2Bytes = Number(r2Row?.total ?? 0);

  // KV public pages count — use D1 page_build_cache to avoid KV list operation
  let kvBytes = 0;
  try {
    const kvCountRow = await env.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM page_build_cache",
    ).first<{
      cnt: number;
    }>();
    kvBytes = Number(kvCountRow?.cnt ?? 0) * 50 * 1024; // 50KB average per page
  } catch {
    /* page_build_cache not yet migrated */
  }

  // Media file counts
  const mediaRow = await env.DB.prepare(
    "SELECT kind, COUNT(*) AS cnt, COALESCE(SUM(size_bytes),0) AS sz FROM media_assets GROUP BY kind",
  ).all<{ kind: string; cnt: number; sz: number }>();
  const mediaCounts: Record<string, { count: number; bytes: number }> = {};
  for (const row of mediaRow.results ?? []) {
    mediaCounts[row.kind] = { count: Number(row.cnt), bytes: Number(row.sz) };
  }

  // Article/document counts
  const docRow = await env.DB.prepare(
    "SELECT tid, COUNT(*) AS cnt FROM documents GROUP BY tid",
  ).all<{ tid: string; cnt: number }>();
  const docCounts: Record<string, number> = {};
  let totalDocs = 0;
  for (const row of docRow.results ?? []) {
    docCounts[row.tid] = Number(row.cnt);
    totalDocs += Number(row.cnt);
  }
  docCounts["total"] = totalDocs;

  // KV daily operation usage (Cloudflare GraphQL Analytics) + next reset (UTC 0:00).
  const kvOpsToday = await fetchKvOpsToday(env);
  const nowD = new Date();
  const kvResetUtc = new Date(
    Date.UTC(
      nowD.getUTCFullYear(),
      nowD.getUTCMonth(),
      nowD.getUTCDate() + 1,
      0,
      0,
      0,
    ),
  ).toISOString();

  // R2 availability: a present MEDIA_BUCKET binding is not enough — the binding
  // object stays truthy even after the R2 subscription is cancelled or the
  // bucket is deleted in the CF dashboard. Probe with a lightweight Class-B
  // list() and treat any failure as "R2 unavailable" so the dashboard grays out.
  let r2Available = false;
  if (env.MEDIA_BUCKET) {
    try {
      await (env.MEDIA_BUCKET as R2Bucket).list({ limit: 1 });
      r2Available = true;
    } catch {
      r2Available = false;
    }
  }

  return json({
    r2Available,
    d1: {
      usedBytes: d1Bytes,
      maxBytes: FREE_D1_BYTES,
      pct: Math.min(100, (d1Bytes / FREE_D1_BYTES) * 100),
    },
    r2: {
      usedBytes: r2Bytes,
      maxBytes: FREE_R2_BYTES,
      pct: Math.min(100, (r2Bytes / FREE_R2_BYTES) * 100),
    },
    kv: {
      usedBytes: kvBytes,
      maxBytes: FREE_KV_BYTES,
      pct: Math.min(100, (kvBytes / FREE_KV_BYTES) * 100),
    },
    kvOps: {
      available: kvOpsToday !== null,
      writes: kvOpsToday?.writes ?? 0,
      reads: kvOpsToday?.reads ?? 0,
      deletes: kvOpsToday?.deletes ?? 0,
      lists: kvOpsToday?.lists ?? 0,
      maxWrites: FREE_KV_WRITES_DAY,
      maxReads: FREE_KV_READS_DAY,
      writesPct: Math.min(
        100,
        ((kvOpsToday?.writes ?? 0) / FREE_KV_WRITES_DAY) * 100,
      ),
      readsPct: Math.min(
        100,
        ((kvOpsToday?.reads ?? 0) / FREE_KV_READS_DAY) * 100,
      ),
      resetUtc: kvResetUtc,
    },
    media: mediaCounts,
    docs: docCounts,
  });
}

interface WorkerCustomDomain {
  id: string;
  hostname: string;
  service: string;
  zone_name: string;
  cert_id?: string;
}

/**
 * Create KuroCMS's media bucket and attach it to this Worker. The installer
 * deliberately defers R2 creation until the owner opts in from Site Settings.
 * Repeated calls are safe: an existing bucket is reused and the binding PATCH
 * is idempotent.
 */
async function enableR2Storage(env: Env): Promise<Response> {
  const token = env.CF_API_TOKEN;
  const accountId = env.CF_ACCOUNT_ID;
  const workerName = env.CF_WORKER_NAME;
  if (!token || !accountId || !workerName) {
    throw new HttpError(
      400,
      "cf_creds_missing",
      "Cloudflare credentials are not configured.",
    );
  }

  const suffix = workerName.startsWith("kurocms-app-")
    ? workerName.slice("kurocms-app-".length)
    : workerName.replace(/^kurocms-/, "");
  const bucketName = `kurocms-media-${suffix}`.slice(0, 63).replace(/-+$/, "");
  const auth = { Authorization: `Bearer ${token}` };

  const existing = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucketName)}`,
    { headers: auth },
  );
  if (existing.status === 404) {
    const create = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets`,
      {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ name: bucketName }),
      },
    );
    const body = (await create.json()) as {
      success?: boolean;
      errors?: Array<{ message: string }>;
    };
    if (!create.ok || !body.success) {
      throw new HttpError(
        400,
        "r2_create_failed",
        body.errors?.[0]?.message ||
          `Cloudflare returned HTTP ${create.status}`,
      );
    }
  } else if (!existing.ok) {
    const body = (await existing.json().catch(() => null)) as {
      errors?: Array<{ message: string }>;
    } | null;
    throw new HttpError(
      400,
      "r2_check_failed",
      body?.errors?.[0]?.message ||
        `Cloudflare returned HTTP ${existing.status}`,
    );
  }

  // The settings PATCH endpoint replaces the entire bindings array. Supplying
  // only MEDIA_BUCKET therefore removes DB/PUBLIC_PAGES and breaks the Worker.
  // Read the current settings and perform a normal script upload with the full
  // non-secret binding set plus R2. Existing Worker secrets persist across the
  // upload, as they do in the regular KuroCMS system-update path.
  const cfBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}`;
  const settingsRes = await fetch(`${cfBase}/settings`, { headers: auth });
  const settingsBody = (await settingsRes.json().catch(() => null)) as {
    success?: boolean;
    result?: {
      bindings?: Array<
        Record<string, unknown> & { type?: string; name?: string }
      >;
      compatibility_date?: string;
      compatibility_flags?: string[];
    };
    errors?: Array<{ message: string }>;
  } | null;
  if (!settingsRes.ok || !settingsBody?.success || !settingsBody.result) {
    throw new HttpError(
      400,
      "worker_settings_failed",
      settingsBody?.errors?.[0]?.message ||
        `Cloudflare returned HTTP ${settingsRes.status}`,
    );
  }

  const supportedBindingTypes = new Set([
    "d1",
    "kv_namespace",
    "r2_bucket",
    "images",
    "plain_text",
    "json",
    "service",
  ]);
  const existingBindings = settingsBody.result.bindings ?? [];
  const hasRequiredBindings =
    existingBindings.some(
      (binding) => binding.type === "d1" && binding.name === "DB",
    ) &&
    existingBindings.some(
      (binding) =>
        binding.type === "kv_namespace" && binding.name === "PUBLIC_PAGES",
    );
  if (!hasRequiredBindings) {
    throw new HttpError(
      409,
      "required_worker_binding_missing",
      "R2 setup was stopped because the required DB or PUBLIC_PAGES binding is missing. Reinstall KuroCMS before trying again.",
    );
  }
  const unsupported = existingBindings.filter(
    (binding) =>
      binding.type !== "secret_text" &&
      binding.type !== "secret_key" &&
      !supportedBindingTypes.has(binding.type ?? ""),
  );
  if (unsupported.length > 0) {
    throw new HttpError(
      409,
      "unsupported_worker_binding",
      `R2 could not be enabled safely because this Worker has unsupported bindings: ${unsupported
        .map((binding) => `${binding.type}:${binding.name}`)
        .join(", ")}`,
    );
  }

  const bindings = existingBindings.filter(
    (binding) =>
      supportedBindingTypes.has(binding.type ?? "") &&
      binding.name !== "MEDIA_BUCKET",
  );
  bindings.push({
    type: "r2_bucket",
    name: "MEDIA_BUCKET",
    bucket_name: bucketName,
  });

  const scriptRes = await fetch(
    `https://github.com/${KUROCMS_GITHUB_REPO}/releases/download/v${KUROCMS_VERSION}/worker.js`,
    { redirect: "follow", signal: AbortSignal.timeout(30_000) },
  );
  if (!scriptRes.ok) {
    throw new HttpError(
      502,
      "worker_download_failed",
      `Failed to download KuroCMS worker.js (HTTP ${scriptRes.status}).`,
    );
  }

  const metadata = {
    main_module: "worker.js",
    compatibility_date: settingsBody.result.compatibility_date ?? "2024-11-01",
    compatibility_flags: settingsBody.result.compatibility_flags ?? [],
    bindings,
  };
  const form = new FormData();
  form.append(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" }),
    "metadata.json",
  );
  form.append(
    "worker.js",
    new Blob([await scriptRes.text()], {
      type: "application/javascript+module",
    }),
    "worker.js",
  );
  const bind = await fetch(cfBase, {
    method: "PUT",
    headers: auth,
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  const bindBody = (await bind.json().catch(() => null)) as {
    success?: boolean;
    errors?: Array<{ message: string }>;
  } | null;
  if (!bind.ok || !bindBody?.success) {
    throw new HttpError(
      400,
      "r2_binding_failed",
      bindBody?.errors?.[0]?.message ||
        `Cloudflare returned HTTP ${bind.status}`,
    );
  }

  return json({ ok: true, bucketName, reloadRequired: true });
}

/** Registrable domain ≈ last two labels (zone_name for Workers Custom Domains). */
function apexDomain(hostname: string): string {
  const parts = hostname.split(".").filter(Boolean);
  return parts.length <= 2 ? hostname : parts.slice(-2).join(".");
}

/**
 * List Workers Custom Domains attached to this Worker (Cloudflare-native: CF
 * auto-manages DNS + SSL). Returns `available:false` when CF creds/permissions
 * are missing so the UI can fall back to manual dashboard instructions.
 */
async function listCustomDomains(env: Env): Promise<Response> {
  const token = env.CF_API_TOKEN;
  const accountId = env.CF_ACCOUNT_ID;
  const workerName = env.CF_WORKER_NAME;
  if (!token || !accountId || !workerName) {
    return json({ available: false, reason: "cf_creds_missing", domains: [] });
  }
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/domains?service=${encodeURIComponent(workerName)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const body = (await res.json()) as {
      success: boolean;
      result?: WorkerCustomDomain[];
      errors?: Array<{ code: number; message: string }>;
    };
    if (!res.ok || !body.success) {
      return json({
        available: false,
        reason: body.errors?.[0]?.message || `HTTP ${res.status}`,
        domains: [],
      });
    }
    const domains = (body.result ?? [])
      .filter((d) => d.service === workerName)
      .map((d) => ({ id: d.id, hostname: d.hostname, zoneName: d.zone_name }));
    return json({ available: true, domains, workerName });
  } catch (err) {
    return json({
      available: false,
      reason: err instanceof Error ? err.message : String(err),
      domains: [],
    });
  }
}

/**
 * Attach a Workers Custom Domain (Cloudflare creates the DNS record + cert).
 * The zone must be owned by this account; surfaces CF's error message otherwise.
 */
async function addCustomDomain(request: Request, env: Env): Promise<Response> {
  const token = env.CF_API_TOKEN;
  const accountId = env.CF_ACCOUNT_ID;
  const workerName = env.CF_WORKER_NAME;
  if (!token || !accountId || !workerName) {
    throw new HttpError(
      400,
      "cf_creds_missing",
      "Cloudflare credentials are not configured.",
    );
  }
  const bodyIn = await readJson(request);
  const hostname = requireString(bodyIn, "hostname", { min: 3, max: 253 })
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(hostname)) {
    throw new HttpError(400, "invalid_hostname", "Invalid domain name.");
  }
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/domains`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        hostname,
        service: workerName,
        environment: "production",
        zone_name: apexDomain(hostname),
      }),
    },
  );
  const body = (await res.json()) as {
    success: boolean;
    result?: WorkerCustomDomain;
    errors?: Array<{ code: number; message: string }>;
  };
  if (!res.ok || !body.success) {
    throw new HttpError(
      400,
      "cf_domain_error",
      body.errors?.[0]?.message || `Cloudflare returned HTTP ${res.status}`,
    );
  }
  return json({ ok: true, hostname });
}

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] ?? 0,
      nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

// GitHub REST headers. When env.GITHUB_TOKEN is set, authenticate to lift the
// unauthenticated 60 req/hour/IP limit (shared across Cloudflare egress IPs) to
// 5,000 req/hour/token.
function githubApiHeaders(env: Env): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "KuroCMS-updater/1.0",
    Accept: "application/vnd.github+json",
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return headers;
}

// ── GitHub API を使わない経路（レート制限に当たらない） ────────────────────
//
// ⚠ 未認証の GitHub API 上限は【IP あたり 60 req/時】で、Worker の送信元 IP は
//   Cloudflare の共有 egress。つまり自分が 1 回も叩いていなくても、同じ IP に
//   相乗りしている他テナントの分で枯れて 403 が返る（新規インストールで頻発。
//   KV キャッシュが空なので初回から素通しで当たる）。GITHUB_TOKEN を入れれば
//   5,000 req/時 になるが、それは利用者ごとに PAT を用意させることになるので
//   既定解にはできない。
//
// そこで API ではない 3 つの経路を用意し、API が駄目でも更新が続けられるように
// する（いずれも実測でレート制限の対象外）:
//   - stable のタグ … /releases/latest の 302 Location（API の /releases/latest
//                     と同じ意味＝prerelease/draft を除いた最新）
//   - latest のタグ … /releases.atom の先頭 entry（prerelease も含む＝rolling）
//   - リリース資産  … /releases/download/{tag}/{name}（版固定・不変）
//
// ⚠ 資産は必ず /releases/download/{tag}/ の【版固定 URL】を使う。
//   /releases/latest/download/ は CDN キャッシュで stale を掴むうえ、選択中の
//   チャンネルに関係なく GitHub の真の最新へ解決してしまう。

/** レート制限の解除時刻（epoch ms）を置く KV キー。 */
const GITHUB_BACKOFF_KEY = "system:github_backoff_until";
/** KV の expirationTtl の下限は 60 秒。 */
const GITHUB_BACKOFF_MIN_TTL = 60;
/** 待ちすぎないための上限（GitHub の枠は毎時リセット）。 */
const GITHUB_BACKOFF_MAX_TTL = 3600;

/** レート制限中なら true。API を叩かずに非 API 経路へ回すための判定。 */
async function githubApiBackedOff(env: Env): Promise<boolean> {
  try {
    const until = await env.PUBLIC_PAGES.get(GITHUB_BACKOFF_KEY);
    return Boolean(until) && Number(until) > Date.now();
  } catch {
    return false;
  }
}

/**
 * 403/429 を受けたら解除時刻を KV に控える。連打しても API を叩かなくなるので、
 * 枠の回復を自分で妨げない（＝サブリクエストも無駄に使わない）。
 * 解除時刻は GitHub の `x-ratelimit-reset`（epoch 秒）に従う。
 */
async function noteGithubRateLimit(env: Env, res: Response): Promise<void> {
  if (res.status !== 403 && res.status !== 429) return;
  const resetSec = Number(res.headers.get("x-ratelimit-reset") || "");
  const seconds = Number.isFinite(resetSec)
    ? Math.ceil(resetSec - Date.now() / 1000)
    : GITHUB_BACKOFF_MIN_TTL;
  const ttl = Math.min(
    GITHUB_BACKOFF_MAX_TTL,
    Math.max(GITHUB_BACKOFF_MIN_TTL, seconds),
  );
  try {
    await env.PUBLIC_PAGES.put(
      GITHUB_BACKOFF_KEY,
      String(Date.now() + ttl * 1000),
      { expirationTtl: ttl },
    );
  } catch {
    /* KV が書けなくても更新自体は続けられる（次回また API を試すだけ） */
  }
}

/** リリース資産の版固定 URL（API 不要・不変）。 */
function releaseAssetUrl(tag: string, name: string): string {
  return buildReleaseAssetUrl(KUROCMS_GITHUB_REPO, tag, name);
}

/** API を使わずに stable のタグを取る（/releases/latest の 302 Location）。 */
async function stableTagNoApi(): Promise<string> {
  const res = await fetch(
    `https://github.com/${KUROCMS_GITHUB_REPO}/releases/latest`,
    { redirect: "manual", signal: AbortSignal.timeout(15_000) },
  );
  const tag = parseStableTagFromLocation(res.headers.get("location") || "");
  if (!tag) throw new Error("Could not resolve the stable release tag.");
  return tag;
}

/** API を使わずに rolling（prerelease 含む）のタグを取る（releases.atom の先頭）。 */
async function latestTagNoApi(): Promise<string> {
  const res = await fetch(
    `https://github.com/${KUROCMS_GITHUB_REPO}/releases.atom`,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) throw new Error(`releases.atom returned ${res.status}`);
  const tag = parseLatestTagFromAtom(await res.text());
  if (!tag) throw new Error("Could not resolve the latest release tag.");
  return tag;
}

/** チャンネルのタグを API 抜きで解決する。 */
async function resolveTagNoApi(channel: "stable" | "latest"): Promise<string> {
  return channel === "latest" ? latestTagNoApi() : stableTagNoApi();
}

// Cache the release-channel lookup so the dashboard's per-load + hourly version
// polling does not hit the GitHub API on every call (was the main rate-limit cause).
//
// Two channels, both derived from ONE `GET /releases` list call:
//  - "latest"  = the newest published release regardless of prerelease (the
//                rolling channel — every ./github_release_update.sh run lands
//                here immediately).
//  - "stable"  = the newest release that is NOT marked prerelease. Routine
//                releases are created with --prerelease (see
//                github_release_update.sh), so this stays pinned until a
//                maintainer explicitly promotes one via --promote-stable
//                (which clears its prerelease flag on GitHub). This is what
//                lets an install opt out of every micro-release landing on it
//                automatically.
const RELEASE_CHANNELS_CACHE_KEY = "system:release_channels";
const RELEASE_CHANNELS_CACHE_TTL = 1800; // 30 min
const UPDATE_CHANNEL_KEY = "system:update_channel"; // "stable" | "latest"

type ReleaseChannels = { stable: string; latest: string };

/**
 * API 経路と非 API 経路のどちらを先に試すか。
 *
 * 既定（GITHUB_TOKEN 無し）は【非 API を第一候補】にする。未認証 API の枠は
 * IP 単位 60 req/時で、Worker の送信元は Cloudflare の共有 egress ——
 * つまり「早い者勝ちの共有資源」であり、しかも世界中の KuroCMS が同じ枠を
 * 食い合う（自分のリクエストが他インストールの枠を削る）。非 API 経路は同じ
 * 情報を制限なしで返すので、共有資源を最初から使わないのが正しい。
 *
 * GITHUB_TOKEN があるときだけ API を第一候補にする。認証済みは 5,000 req/時
 * かつ【トークン単位】で共有 IP の問題が無く、prerelease フラグを直接読める
 * 最も確かな情報源だから。
 */
function preferGithubApi(env: Env): boolean {
  return Boolean(env.GITHUB_TOKEN);
}

/** API でチャンネルを解決する（1 回の呼び出しで両チャンネル）。 */
async function channelsViaApi(env: Env): Promise<ReleaseChannels> {
  if (await githubApiBackedOff(env))
    throw new Error("GitHub API is rate-limited (backing off).");
  const res = await fetch(
    `https://api.github.com/repos/${KUROCMS_GITHUB_REPO}/releases?per_page=10`,
    { headers: githubApiHeaders(env) },
  );
  if (!res.ok) {
    await noteGithubRateLimit(env, res);
    throw new Error(`GitHub API returned ${res.status}`);
  }
  const list = (await res.json()) as Array<{
    tag_name: string;
    prerelease: boolean;
    draft: boolean;
  }>;
  const rolling = list.find((r) => !r.draft);
  const stable = list.find((r) => !r.draft && !r.prerelease);
  if (!rolling || !stable) throw new Error("No published releases found.");
  return {
    latest: rolling.tag_name.replace(/^v/, ""),
    stable: stable.tag_name.replace(/^v/, ""),
  };
}

/** 非 API 経路でチャンネルを解決する（302 Location と Atom フィード）。 */
async function channelsViaUrl(): Promise<ReleaseChannels> {
  const [latestTag, stableTag] = await Promise.all([
    latestTagNoApi(),
    stableTagNoApi(),
  ]);
  return {
    latest: latestTag.replace(/^v/, ""),
    stable: stableTag.replace(/^v/, ""),
  };
}

/** 両経路を優先順に試す。片方が駄目でももう片方で解決できる。 */
async function resolveReleaseChannels(env: Env): Promise<ReleaseChannels> {
  const attempts = preferGithubApi(env)
    ? [() => channelsViaApi(env), channelsViaUrl]
    : [channelsViaUrl, () => channelsViaApi(env)];
  let lastError: unknown = null;
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Could not resolve release channels.");
}

/**
 * 更新対象のタグを優先順に解決する。
 * 資産 URL は API を使わずタグから組めるので（版固定・不変）、更新に必要なのは
 * タグだけ。既定構成では更新経路から API が完全に消える。
 */
async function resolveChannelTag(
  env: Env,
  channel: "stable" | "latest",
): Promise<string> {
  const viaUrl = () => resolveTagNoApi(channel);
  const viaApi = async () => {
    const channels = await channelsViaApi(env);
    return `v${channel === "latest" ? channels.latest : channels.stable}`;
  };
  const attempts = preferGithubApi(env) ? [viaApi, viaUrl] : [viaUrl, viaApi];
  let lastError: unknown = null;
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Could not resolve the "${channel}" release tag.`);
}

async function fetchReleaseChannels(
  env: Env,
  refresh = false,
): Promise<ReleaseChannels> {
  const cached = refresh
    ? null
    : await env.PUBLIC_PAGES.get(RELEASE_CHANNELS_CACHE_KEY);
  if (cached) {
    try {
      return JSON.parse(cached) as ReleaseChannels;
    } catch {
      /* stale/corrupt cache entry — refetch below */
    }
  }
  const channels = await resolveReleaseChannels(env);
  await env.PUBLIC_PAGES.put(
    RELEASE_CHANNELS_CACHE_KEY,
    JSON.stringify(channels),
    { expirationTtl: RELEASE_CHANNELS_CACHE_TTL },
  );
  return channels;
}

async function getUpdateChannel(env: Env): Promise<"stable" | "latest"> {
  const v = await env.PUBLIC_PAGES.get(UPDATE_CHANNEL_KEY);
  return v === "latest" ? "latest" : "stable";
}

async function setUpdateChannel(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const channel = body.channel === "latest" ? "latest" : "stable";
  await env.PUBLIC_PAGES.put(UPDATE_CHANNEL_KEY, channel);
  return json({ ok: true, channel });
}

async function systemVersion(env: Env, refresh = false): Promise<Response> {
  const current = KUROCMS_VERSION;
  const channel = await getUpdateChannel(env);
  let stable = current;
  let latest = current;
  try {
    const channels = await fetchReleaseChannels(env, refresh);
    stable = channels.stable;
    latest = channels.latest;
  } catch {
    /* GitHub unreachable — fall back to current for both */
  }
  const target = channel === "latest" ? latest : stable;
  const hasUpdate = target !== current && compareVersions(target, current) > 0;
  return json({ current, stable, latest, channel, hasUpdate });
}

// Apply any pending migrations from the latest release's migrations-manifest.json.
// Additive-only + run-once tracking (d1_migrations / _kurocms_migrations) makes this
// ── スキーマの自動収束 ───────────────────────────────────────────────────────
//
// 同じ KuroCMS でも DB の作られ方は 3 通りある: installer の一括適用 / 逐次
// migration / バックアップからの復元。⚠ 3 番目が曲者で、d1_migrations は
// バックアップ対象外なので復元後は適用済み記録が空になり、次の更新で【全
// migration が再実行】される。すると
//   0035 ADD COLUMN template_api_version → 0037 RENAME ... TO api_version
// のような並びで、再実行された 0035 が「重複ではない」ため成功し、改名で
// 消えたはずの旧列が復活する。2026-08 の本番移行では、この亡霊列が入った
// バックアップを正しい DB へ流して復元が丸ごと失敗した。
//
// 対策: 履歴に頼らず【現物と正本を突き合わせて収束させる】。更新のたびに走る。
//  - 足りない列は ALTER TABLE ADD COLUMN で足す
//  - ⚠ 余分な列は【落とさない】。SQLite の DROP COLUMN は制約が多く、何より
//    データを消す判断を自動でやるべきではない。報告だけして人に決めさせる
//  - ⚠ NOT NULL かつ既定値なしの列は後から足せない（SQLite の制限）。
//    これも報告に回す
export interface SchemaDriftReport {
  ok: boolean;
  added: string[];
  extra: string[];
  unfixable: string[];
  missingTables: string[];
}

async function reconcileSchema(
  env: Env,
  apply: boolean,
): Promise<SchemaDriftReport> {
  const added: string[] = [];
  const extra: string[] = [];
  const unfixable: string[] = [];
  const missingTables: string[] = [];

  for (const [table, cols] of Object.entries(SCHEMA_MANIFEST)) {
    const info = await env.DB.prepare(
      `SELECT name FROM pragma_table_info('${table}')`,
    )
      .all<{ name: string }>()
      .catch(() => null);
    const live = new Set((info?.results ?? []).map((r) => r.name));
    if (live.size === 0) {
      // 正本にあるテーブルが無い＝ migration が流れていない。ここでは作らない
      // （CREATE 文は正本に持っていない）。migration 側の仕事として報告する。
      missingTables.push(table);
      continue;
    }
    for (const [col, def] of Object.entries(cols)) {
      if (live.has(col)) continue;
      if (def.notnull && def.dflt === null) {
        unfixable.push(`${table}.${col}`);
        continue;
      }
      if (apply) {
        const parts = [`ALTER TABLE ${table} ADD COLUMN ${col} ${def.type}`];
        if (def.notnull) parts.push("NOT NULL");
        if (def.dflt !== null) parts.push(`DEFAULT ${def.dflt}`);
        try {
          await env.DB.prepare(parts.join(" ")).run();
        } catch {
          unfixable.push(`${table}.${col}`);
          continue;
        }
      }
      added.push(`${table}.${col}`);
    }
    for (const col of live) {
      if (!cols[col]) extra.push(`${table}.${col}`);
    }
  }
  return {
    ok:
      added.length === 0 &&
      unfixable.length === 0 &&
      missingTables.length === 0,
    added,
    extra,
    unfixable,
    missingTables,
  };
}

// idempotent. Shared by systemUpdate and the WorkerOps Contract POST /api/migrate.
async function applyPendingMigrations(
  env: Env,
  manifestUrl?: string,
): Promise<number> {
  // Prefer an immutable, version-pinned asset URL (passed by systemUpdate from
  // the GitHub API). The `latest/download` redirect is CDN-cached and the
  // Worker's own fetch() can be served a STALE manifest from Cloudflare's cache,
  // silently skipping freshly-released migrations. Cache-bust the fallback.
  const url =
    manifestUrl ??
    `https://github.com/${KUROCMS_GITHUB_REPO}/releases/latest/download/migrations-manifest.json?_cb=${Date.now()}`;
  const mRes = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
    cf: { cacheTtl: 0 },
  });
  if (!mRes.ok) return 0;
  const manifest = (await mRes.json()) as {
    migrations: Array<{ name: string; sql: string }>;
  };
  // Build applied set from both wrangler's d1_migrations and our _kurocms_migrations
  const appliedNames = new Set<string>();
  for (const tbl of ["d1_migrations", "_kurocms_migrations"]) {
    try {
      const { results } = await env.DB.prepare(`SELECT name FROM ${tbl}`).all<{
        name: string;
      }>();
      for (const r of results) appliedNames.add(r.name);
    } catch {
      /* table may not exist yet */
    }
  }
  const pending = manifest.migrations.filter((m) => !appliedNames.has(m.name));
  if (pending.length === 0) return 0;

  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
  ).run();
  let applied = 0;
  for (const migration of pending) {
    const stmts = migration.sql
      .split(/;\s*(?:\r?\n|$)/)
      .map((s) => s.trim())
      .filter((s) => s && !/^\s*PRAGMA\s/i.test(s));
    try {
      await env.DB.batch(
        stmts.filter((s) => s).map((sql) => env.DB.prepare(sql)),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        !/duplicate column|already exists|table .* already|no such column|no such table/i.test(
          msg,
        )
      ) {
        throw err;
      }
    }
    await env.DB.prepare(
      "INSERT OR IGNORE INTO d1_migrations (name) VALUES (?)",
    )
      .bind(migration.name)
      .run();
    applied++;
  }
  return applied;
}

async function systemUpdate(
  request: Request,
  env: Env,
  user: AuthUser,
): Promise<Response> {
  const token = env.CF_API_TOKEN;
  const accountId = env.CF_ACCOUNT_ID;
  const workerName = env.CF_WORKER_NAME;
  if (!token || !accountId || !workerName) {
    throw new HttpError(
      400,
      "cf_creds_missing",
      "CF credentials not configured. Please run bootstrap to set CF_API_TOKEN, CF_ACCOUNT_ID, CF_WORKER_NAME as Worker Secrets.",
    );
  }

  // Optional explicit target: { tag: "vX.Y.Z" }. The release pipeline passes
  // the tag it JUST published so the lookup is a per-tag point read —
  // /releases/tags/{tag} is visible immediately after publish, unlike the
  // /releases list below, which is eventually consistent and kept returning
  // the PREVIOUS release for seconds after a publish (the update then
  // "successfully" reinstalled the old version).
  const body = await readJson(request).catch(
    () => ({}) as Record<string, unknown>,
  );
  const requestedTag = typeof body.tag === "string" ? body.tag.trim() : "";
  if (requestedTag && !/^v\d+\.\d+\.\d+$/.test(requestedTag)) {
    throw new HttpError(400, "invalid_tag", "tag must look like vX.Y.Z.");
  }

  // Without an explicit tag (dashboard "今すぐ更新"), fetch the release for the
  // currently selected channel. "stable" reuses GitHub's own /releases/latest
  // (which already skips prerelease/draft); "latest" takes the newest release
  // regardless of prerelease. Both come back as full release objects (with
  // assets), unlike the lightweight tag-only lookup cached by
  // fetchReleaseChannels for the dashboard display.
  const channel = await getUpdateChannel(env);

  // 解決したいのは「タグ」と「worker.js / migrations-manifest.json の URL」だけ。
  // 必要なのは【タグ】だけ。資産は /releases/download/{tag}/... の版固定 URL で
  // 取れるので（不変＝CDN の stale もチャンネル取り違えも起きない）、API から
  // browser_download_url を貰う必要がない。既定構成では更新経路から GitHub API が
  // 完全に消える（resolveChannelTag は非 API を第一候補にする）。
  let resolvedTag = requestedTag;
  if (!resolvedTag) {
    try {
      resolvedTag = await resolveChannelTag(env, channel);
    } catch (err) {
      throw new HttpError(
        502,
        "github_unreachable",
        `Could not resolve the "${channel}" release from GitHub: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  const workerUrl = releaseAssetUrl(resolvedTag, "worker.js");
  const manifestUrl = releaseAssetUrl(resolvedTag, "migrations-manifest.json");

  // Apply pending migrations directly via D1 binding (run-once, additive-only).
  // Use the immutable, version-pinned manifest asset URL — NOT the CDN-cached
  // latest/download redirect, which the Worker's fetch() can serve stale,
  // skipping freshly-released migrations, AND which always resolves to GitHub's
  // true latest regardless of channel. (資産が無い古いリリースでも
  // applyPendingMigrations は 0 件で素通しするので安全。)
  const migrationsApplied = await applyPendingMigrations(env, manifestUrl);
  // ⚠ migration の後に必ずスキーマを突き合わせる。履歴（d1_migrations）は
  //   復元で失われうるので、履歴ではなく現物を正とする。
  const schemaDrift = await reconcileSchema(env, true);

  // Download the compiled Worker script from the version-pinned asset URL —
  // NOT /latest/download/, which always resolves to GitHub's true latest
  // release regardless of which channel was selected above.
  const scriptRes = await fetch(workerUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!scriptRes.ok)
    throw new HttpError(
      502,
      // 版固定 URL が 404 = そのタグのリリース（か worker.js 資産）が無い。
      // タグ指名で呼ばれたときは「指定が悪い」と分かる形で返す（リリース
      // パイプラインが直後に叩くので、取り違えでなく不在だと判別できること）。
      requestedTag && scriptRes.status === 404
        ? "release_not_found"
        : "download_failed",
      `Failed to download worker.js from ${workerUrl} (HTTP ${scriptRes.status}).`,
    );
  const scriptContent = await scriptRes.text();

  // Read current settings to preserve compatibility_date and non-secret bindings.
  // type:"inherit" for secrets is Enterprise-only — instead we upload without
  // secrets, then re-set them via the Secrets API using the values already in env.
  const cfBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}`;
  let compatDate = "2024-11-01";
  let nonSecretBindings: unknown[] | undefined;
  try {
    const settingsRes = await fetch(`${cfBase}/settings`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (settingsRes.ok) {
      const s = (await settingsRes.json()) as {
        result?: {
          bindings?: Array<{ type: string; name: string }>;
          compatibility_date?: string;
        };
      };
      compatDate = s.result?.compatibility_date ?? compatDate;
      // Allowlist: only include binding types known to work on all CF plans.
      // Enterprise-only types (secret_text, inherit, assets, ...) cause CF error 10023 if included.
      // Using an allowlist rather than a blocklist avoids missing future Enterprise-only types.
      nonSecretBindings = (s.result?.bindings ?? []).filter(
        (b) =>
          b.type === "d1" ||
          b.type === "kv_namespace" ||
          b.type === "r2_bucket" ||
          b.type === "images" ||
          b.type === "plain_text" ||
          b.type === "service",
      );
    }
  } catch {
    /* ignore — use fallback */
  }

  // Worker Secrets set via bootstrap persist across deployments automatically.
  // secret_text in PUT bindings is Enterprise-only (CF error 10023) — do not include.
  const allBindings = [...(nonSecretBindings ?? [])];
  if (
    !allBindings.some(
      (binding) =>
        (binding as { type?: string; name?: string }).type === "images" &&
        (binding as { type?: string; name?: string }).name === "IMAGES",
    )
  ) {
    allBindings.push({ type: "images", name: "IMAGES" });
  }

  const metaObj: Record<string, unknown> = {
    main_module: "worker.js",
    compatibility_date: compatDate,
    bindings: allBindings,
  };
  // Use FormData (same as bootstrap deployer) — avoids manual CRLF boundary encoding issues
  const form = new FormData();
  form.append(
    "metadata",
    new Blob([JSON.stringify(metaObj)], { type: "application/json" }),
    "metadata.json",
  );
  form.append(
    "worker.js",
    new Blob([scriptContent], { type: "application/javascript+module" }),
    "worker.js",
  );

  const uploadRes = await fetch(cfBase, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!uploadRes.ok) {
    const errBody = await uploadRes.json().catch(() => null);
    const bindingSummary = allBindings
      .map(
        (b: unknown) =>
          (b as { type: string; name: string }).type +
          ":" +
          (b as { type: string; name: string }).name,
      )
      .join(",");
    throw new HttpError(
      502,
      "cf_upload_failed",
      `CF ${uploadRes.status}: ${JSON.stringify(errBody).slice(0, 400)} [bindings: ${bindingSummary || "none"}]`,
    );
  }

  await logActivity(env, user, "system.update", "system", "worker", {
    version: resolvedTag,
    channel,
    migrationsApplied,
  });
  // Invalidate the cached channel lookup so the next check reflects reality now.
  await env.PUBLIC_PAGES.delete(RELEASE_CHANNELS_CACHE_KEY).catch(() => {});
  return json({
    ok: true,
    version: resolvedTag,
    channel,
    migrationsApplied,
    schema: schemaDrift as unknown as JsonValue,
  });
}

// URL カードのリッチ表示メタ取得。認証済み(Author=編集キャンバス)か、ビルドが発行した
// HMAC 署名(公開ページのカード)のどちらかを要求 → 任意 URL 代理(オープンプロキシ)を封じる。
// SSRF ガード + KV キャッシュ。結果は { ok:true, meta } / { ok:false, reason }。
export async function unfurlEndpoint(
  request: Request,
  env: Env,
): Promise<Response> {
  const cors = { "Access-Control-Allow-Origin": "*" };
  const jhead = { "content-type": "application/json; charset=utf-8", ...cors };
  const u = new URL(request.url);
  const target = u.searchParams.get("url") || "";
  const sig = u.searchParams.get("sig") || "";
  let authed = false;
  try {
    await requireAuth(env, request);
    authed = true;
  } catch {
    /* 未認証 → 署名で判定 */
  }
  if (!authed && !(await unfurlVerify(env, target, sig))) {
    return new Response(JSON.stringify({ ok: false, reason: "forbidden" }), {
      status: 403,
      headers: jhead,
    });
  }
  if (!unfurlUrlAllowed(target)) {
    return new Response(JSON.stringify({ ok: false, reason: "invalid_url" }), {
      status: 400,
      headers: jhead,
    });
  }
  const cacheKey = "unfurl:" + (await sha256Hex(target));
  const cached = await env.PUBLIC_PAGES.get(cacheKey);
  if (cached)
    return new Response(cached, {
      headers: { ...jhead, "Cache-Control": "public, max-age=1800" },
    });
  const result = await fetchUnfurl(target);
  const body = JSON.stringify(result);
  // 成功は長め・失敗は短めにキャッシュ（対象が復活する可能性を考慮）。
  await env.PUBLIC_PAGES.put(cacheKey, body, {
    expirationTtl: result.ok ? 21600 : 900,
  }).catch(() => {});
  return new Response(body, {
    headers: { ...jhead, "Cache-Control": "public, max-age=1800" },
  });
}

async function settings(
  request: Request,
  env: Env,
  user: AuthUser,
): Promise<Response> {
  requireAdmin(user);

  if (request.method === "GET") {
    const row = await env.DB.prepare(
      "SELECT * FROM site_settings WHERE id = 1",
    ).first<Record<string, string | number>>();
    const defaultLang =
      (row?.default_lang as string | undefined) ??
      env.SITE_DEFAULT_LANG ??
      "en";
    return json({
      settings: {
        siteName: (row?.site_name as string | undefined) ?? "KuroCMS",
        siteDescription: (row?.site_description as string | undefined) ?? "",
        ga4MeasurementId: (row?.ga4_measurement_id as string | undefined) ?? "",
        publicDomain: (row?.public_domain as string | undefined) ?? "",
        developmentDomain: deriveInternalPreviewUrl(request, env),
        defaultLang,
        initialLang: (row?.initial_lang as string | undefined) ?? defaultLang,
        licenseAcceptedAt:
          (row?.license_accepted_at as string | undefined) ?? "",
        licenseAcceptedBy:
          (row?.license_accepted_by as string | undefined) ?? "",
        licenseName:
          (row?.license_name as string | undefined) ?? "Kuro License",
        licenseAttributionPhrase:
          (row?.license_attribution_phrase as string | undefined) ??
          "with KuroCMS",
        themeAccent: (row?.theme_accent as string | undefined) ?? "#157a6e",
        themeSidebar: (row?.theme_sidebar as string | undefined) ?? "#ffffff",
        themeMainPane:
          (row?.theme_main_pane as string | undefined) ?? "#f7f8fb",
        blueskyHandle: (row?.bluesky_handle as string | undefined) ?? "",
        blueskySid: (row?.bluesky_sid as string | undefined) ?? "",
        blueskyTokenSet: !!(row?.bluesky_token as string | undefined),
        xApiKeySet: !!(row?.x_api_key as string | undefined),
        xApiSecretSet: !!(row?.x_api_secret as string | undefined),
        xAccessTokenSet: !!(row?.x_access_token as string | undefined),
        xAccessSecretSet: !!(row?.x_access_secret as string | undefined),
        xLinkInReply: (row?.x_link_in_reply as number | undefined) !== 0,
        mobileMediaFullWidth:
          (row?.mobile_media_full_width as number | undefined) === 1,
        threadsTokenSet: !!(row?.threads_token as string | undefined),
        siteIsPublished: (row?.site_is_published as number | undefined) === 1,
        templateId: (row?.template_id as string | undefined) ?? "",
      },
    });
  }

  if (request.method === "PUT") {
    const body = await readJson(request);
    const siteName = requireString(body, "siteName", { min: 1, max: 120 });
    // site_description / ga4_measurement_id are managed on a SEPARATE "Analytics"
    // tab. The main settings form doesn't send them, so only update each when it
    // is explicitly present — otherwise saving the main form would wipe them.
    const hasSiteDescription = "siteDescription" in body;
    const hasGa4 = "ga4MeasurementId" in body;
    const siteDescription = (
      optionalString(body, "siteDescription") ?? ""
    ).slice(0, 500);
    const ga4MeasurementId = optionalString(body, "ga4MeasurementId") ?? "";
    const publicDomain = optionalString(body, "publicDomain") ?? "";
    const defaultLang = requireString(body, "defaultLang", { min: 2, max: 20 });
    // initial_lang (初期作成言語) is unified into default_lang: the admin UI no
    // longer exposes it, so default to default_lang when the client omits it.
    const initialLang = optionalString(body, "initialLang") ?? defaultLang;
    const themeAccent = optionalString(body, "themeAccent") ?? "#157a6e";

    const themeSidebar = optionalString(body, "themeSidebar") ?? "#ffffff";
    const themeMainPane = optionalString(body, "themeMainPane") ?? "#f7f8fb";
    const hasBlueskyHandle = "blueskyHandle" in body;
    const hasBlueskySid = "blueskySid" in body;
    const blueskyHandle = optionalString(body, "blueskyHandle") ?? "";
    const blueskySid = optionalString(body, "blueskySid") ?? "";
    // Bluesky app password: only update when a non-empty value is sent, so saving
    // the form without re-typing the password keeps the stored one.
    const blueskyToken = optionalString(body, "blueskyToken") ?? "";
    const hasBlueskyToken = "blueskyToken" in body && blueskyToken !== "";
    // X (Twitter) OAuth 1.0a credentials: same only-when-non-empty rule.
    const xApiKey = optionalString(body, "xApiKey") ?? "";
    const xApiSecret = optionalString(body, "xApiSecret") ?? "";
    const xAccessToken = optionalString(body, "xAccessToken") ?? "";
    const xAccessSecret = optionalString(body, "xAccessSecret") ?? "";
    const hasXLinkInReply = "xLinkInReply" in body;
    const xLinkInReply =
      body.xLinkInReply === true || body.xLinkInReply === "true";
    // スマホでのメディアレイアウト解除（サイトビルドの出力を変える設定）。
    const hasMobileMediaFullWidth = "mobileMediaFullWidth" in body;
    const mobileMediaFullWidth =
      body.mobileMediaFullWidth === true ||
      body.mobileMediaFullWidth === "true";

    if (publicDomain) validateDomain(publicDomain, "publicDomain");
    if (ga4MeasurementId && !/^G-[A-Z0-9]+$/.test(ga4MeasurementId)) {
      throw new HttpError(
        400,
        "invalid_field",
        "ga4MeasurementId must look like G-XXXXXXXXXX.",
      );
    }
    validateLanguage(defaultLang, "defaultLang");
    validateLanguage(initialLang, "initialLang");
    validateHexColor(themeAccent, "themeAccent");
    validateHexColor(themeSidebar, "themeSidebar");
    validateHexColor(themeMainPane, "themeMainPane");

    const settingsToSave: Record<string, string | number> = {
      site_name: siteName,
      public_domain: publicDomain,
      default_lang: defaultLang,
      initial_lang: initialLang,
      theme_accent: themeAccent,
      theme_sidebar: themeSidebar,
      theme_main_pane: themeMainPane,
    };
    // Preserve unless explicitly provided (see notes above).
    if (hasBlueskyHandle) settingsToSave.bluesky_handle = blueskyHandle;
    if (hasBlueskySid) settingsToSave.bluesky_sid = blueskySid;
    if (hasSiteDescription) settingsToSave.site_description = siteDescription;
    if (hasGa4) settingsToSave.ga4_measurement_id = ga4MeasurementId;
    if (hasBlueskyToken) settingsToSave.bluesky_token = blueskyToken;
    // Threads access token: only update when non-empty; a new token may belong
    // to a different account, so the cached threads_user_id is reset with it.
    const threadsToken = optionalString(body, "threadsToken") ?? "";
    if (threadsToken) {
      settingsToSave.threads_token = threadsToken;
      settingsToSave.threads_user_id = "";
    }
    if (xApiKey) settingsToSave.x_api_key = xApiKey;
    if (xApiSecret) settingsToSave.x_api_secret = xApiSecret;
    if (xAccessToken) settingsToSave.x_access_token = xAccessToken;
    if (xAccessSecret) settingsToSave.x_access_secret = xAccessSecret;
    if (hasXLinkInReply) settingsToSave.x_link_in_reply = xLinkInReply ? 1 : 0;
    if (hasMobileMediaFullWidth)
      settingsToSave.mobile_media_full_width = mobileMediaFullWidth ? 1 : 0;
    await saveSettings(env, settingsToSave);

    // 公開フラグは本来 PUT /api/v1/published の担当（テンプレート系の一族に
    // 同居している歴史的経緯）。だが GET /api/settings は siteIsPublished を
    // **返す**ので、読めた値をそのまま投げ返すクライアントが必ず現れる。
    // 黙って捨てて 200 を返すと「保存したのに公開されない」になるため、
    // 送られてきたときだけ専用処理と同じ更新へ委譲する。
    // ⚠ updated_at は触らない（v1 側と同じ理由：site_is_published は配信の
    //   キルスイッチで HTML を変えないのに、updated_at を進めると contentTs が
    //   動き、次のビルドが全ページを無駄に作り直す）。
    if ("siteIsPublished" in body) {
      const published = body.siteIsPublished === true ? 1 : 0;
      await env.DB.prepare(
        "UPDATE site_settings SET site_is_published = ? WHERE id = 1",
      )
        .bind(published)
        .run();
    }

    await logActivity(env, user, "settings.update", "settings", "site", {
      siteName,
      publicDomain,
      defaultLang,
      initialLang,
      themeAccent,
      themeSidebar,
      themeMainPane,
    });

    return json({
      ok: true,
      updatedAt: nowIso(),
    });
  }

  throw new HttpError(405, "method_not_allowed", "Method is not allowed.");
}

// ── SNS posting (Bluesky) — explicit, decoupled from publishing ──────────────
const BSKY_IMAGE_MAX_BYTES = 950_000;
const BSKY_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

async function readResponseBodyUpTo(
  response: Response,
  maxBytes: number,
): Promise<ArrayBuffer | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (size === 0) return null;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

async function transformBlueskyCover(
  env: Env,
  key: string,
  width: number,
  quality: number,
): Promise<{ bytes: ArrayBuffer; mime: string } | null> {
  if (!env.MEDIA_BUCKET || !env.IMAGES) return null;
  const source = await env.MEDIA_BUCKET.get(key);
  if (!source?.body) return null;
  const result = await env.IMAGES.input(source.body)
    .transform({ fit: "scale-down", width })
    .output({ anim: false, format: "image/webp", quality });
  const response = result.response();
  if (!response.ok) return null;
  const bytes = await readResponseBodyUpTo(response, BSKY_IMAGE_MAX_BYTES);
  return bytes ? { bytes, mime: "image/webp" } : null;
}

type BlueskyPostResult =
  | { ok: true; postedAt: string }
  | {
      ok: false;
      code:
        | "not_configured"
        | "no_public_domain"
        | "not_published"
        | "already_posted"
        | "cover_failed"
        | "post_failed";
      /** Upstream error (service HTTP status + response snippet) for the admin toast. */
      detail?: string;
    };

/**
 * Prepare an article's cover image for an SNS post. Uses an already-small
 * compatible R2 object directly; oversized/AVIF/GIF assets are normalized from
 * R2 by the Images binding immediately before posting. Never falls through to
 * an image-less post when the article HAS a cover but preparation failed —
 * that case returns ok:false. Shared by the Bluesky and X post paths.
 */
async function prepareSnsCoverImage(
  env: Env,
  did: string,
  seoJsonRaw: string | null,
  logEvent: string,
): Promise<
  | { ok: true; image: { bytes: ArrayBuffer; mime: string } | null }
  | { ok: false }
> {
  let image: { bytes: ArrayBuffer; mime: string } | null = null;
  let hasCover: boolean;
  try {
    const seo = seoJsonRaw ? JSON.parse(seoJsonRaw) : {};
    const coverPath =
      seo && typeof seo.coverPath === "string" ? seo.coverPath : "";
    hasCover = Boolean(coverPath);
    if (coverPath && env.MEDIA_BUCKET) {
      const key = coverPath.replace(/^\//, "").split("?")[0];
      const obj = await (env.MEDIA_BUCKET as R2Bucket).get(key);
      if (obj) {
        const mime = (obj.httpMetadata?.contentType || "image/jpeg")
          .split(";", 1)[0]
          .trim()
          .toLowerCase();
        if (
          obj.size > 0 &&
          obj.size <= BSKY_IMAGE_MAX_BYTES &&
          BSKY_IMAGE_MIMES.has(mime)
        ) {
          const buf = await obj.arrayBuffer();
          image = {
            bytes: buf,
            mime,
          };
        } else {
          image =
            (await transformBlueskyCover(env, key, 1200, 72)) ??
            (await transformBlueskyCover(env, key, 800, 55));
        }
      }
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: logEvent,
        did,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return { ok: false };
  }
  if (hasCover && !image) {
    console.warn(
      JSON.stringify({
        event: logEvent,
        did,
        error: "cover could not be reduced below the size limit",
      }),
    );
    return { ok: false };
  }
  return { ok: true, image };
}

/**
 * "🌐 日本語, English, 中文, …" — the article's available translation languages
 * in their NATIVE names, appended to SNS posts so each language's speakers can
 * see at a glance that the article is readable for them. Built dynamically
 * from document_translations (same content-presence filter as
 * buildDocumentPages), with names from the registered languages
 * (taxonomy_items kind='language', whose name holds the native label from the
 * language picker; falls back to the raw code). The article's own language
 * comes first, the rest in code order. Returns "" for articles with fewer
 * than 2 languages — a language line on a monolingual post is just noise.
 */
async function snsLanguagesLine(
  env: Env,
  did: string,
  initialLang: string,
  slug: string,
): Promise<string> {
  const result = await env.DB.prepare(
    `SELECT dt.lang, ti.name
     FROM document_translations dt
     LEFT JOIN taxonomy_items ti ON ti.id = dt.lang AND ti.kind = 'language'
     WHERE dt.did = ?
       AND (NULLIF(dt.body_html, '') IS NOT NULL
         OR NULLIF(dt.summary, '') IS NOT NULL
         OR (NULLIF(dt.title, '') IS NOT NULL AND dt.title <> ?))
     ORDER BY (dt.lang <> ?), dt.lang`,
  )
    .bind(did, slug, initialLang)
    .all<{ lang: string; name: string | null }>();
  const rows = result.results ?? [];
  if (rows.length < 2) return "";
  const names = rows.map((r) => (r.name ?? "").trim() || r.lang);
  return `🌐 ${names.join(", ")}`;
}

/**
 * Build and post a single article to Bluesky, returning a discriminated result
 * (no throwing for expected conditions). Used by the on-demand "投稿" button
 * (postDocumentToBluesky). Requires Bluesky credentials, a public_domain, the
 * document published (mode=1) and sns_bsky_posted_at NULL; the final UPDATE is
 * guarded by `WHERE sns_bsky_posted_at IS NULL` so it never double-posts.
 */
async function postBlueskyForDoc(
  env: Env,
  did: string,
): Promise<BlueskyPostResult> {
  const s = await env.DB.prepare(
    "SELECT bluesky_handle, bluesky_token, public_domain FROM site_settings WHERE id = 1",
  ).first<{
    bluesky_handle: string | null;
    bluesky_token: string | null;
    public_domain: string | null;
  }>();
  const handle = (s?.bluesky_handle ?? "").trim();
  const password = (s?.bluesky_token ?? "").trim();
  if (!handle || !password) return { ok: false, code: "not_configured" };
  let origin = "";
  try {
    if (s?.public_domain) origin = new URL(s.public_domain).origin;
  } catch {
    /* invalid public_domain */
  }
  if (!origin) return { ok: false, code: "no_public_domain" };

  const doc = await env.DB.prepare(
    // live (not just mode): the flag alone is unbuilt state — the public URL
    // is not served yet, so posting would share a dead link.
    "SELECT tid, slug, initial_lang, sns_bsky_posted_at FROM documents WHERE did = ? AND mode = 1 AND live = 1",
  )
    .bind(did)
    .first<{
      tid: string;
      slug: string;
      initial_lang: string;
      sns_bsky_posted_at: string | null;
    }>();
  if (!doc) return { ok: false, code: "not_published" };
  if (doc.sns_bsky_posted_at) return { ok: false, code: "already_posted" };

  const tl = await env.DB.prepare(
    "SELECT title, summary, seo_json FROM document_translations WHERE did = ? AND lang = ?",
  )
    .bind(did, doc.initial_lang)
    .first<{
      title: string | null;
      summary: string | null;
      seo_json: string | null;
    }>();
  const title = (tl?.title ?? doc.slug).trim() || doc.slug;
  const summary = (tl?.summary ?? "").trim();
  const url = `${origin}/${doc.tid}/${doc.slug}/`;
  const langLine = await snsLanguagesLine(env, did, doc.initial_lang, doc.slug);

  const cover = await prepareSnsCoverImage(
    env,
    did,
    tl?.seo_json ?? null,
    "bsky_cover_prepare_failed",
  );
  if (!cover.ok) return { ok: false, code: "cover_failed" };
  const image = cover.image;

  try {
    await postToBluesky(handle, password, title, summary, url, image, langLine);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(
      JSON.stringify({ event: "bsky_post_failed", did, error: detail }),
    );
    return { ok: false, code: "post_failed", detail };
  }

  const postedAt = nowIso();
  await env.DB.prepare(
    "UPDATE documents SET sns_bsky_posted_at = ? WHERE did = ? AND sns_bsky_posted_at IS NULL",
  )
    .bind(postedAt, did)
    .run();
  return { ok: true, postedAt };
}

/**
 * On-demand "投稿" button: post an article to Bluesky now. Surfaces failures as
 * HTTP errors (unlike the silent auto-post path, which has been removed).
 */
async function postDocumentToBluesky(
  env: Env,
  user: AuthUser,
  did: string,
): Promise<Response> {
  requireAuthor(user);
  const result = await postBlueskyForDoc(env, did);
  if (result.ok) {
    await logActivity(env, user, "document.sns_post", "document", did, {
      bsky: true,
    });
    return json({
      did,
      bsky: { posted: true, postedAt: result.postedAt },
    });
  }
  const failures: Record<string, [number, string]> = {
    not_configured: [400, "Bluesky is not configured in Settings → SNS."],
    no_public_domain: [400, "Set the site's public domain first."],
    not_published: [
      409,
      "Publish AND build the article before posting to Bluesky.",
    ],
    already_posted: [409, "This article was already posted to Bluesky."],
    cover_failed: [502, "The cover image could not be prepared for Bluesky."],
    post_failed: [502, "Posting to Bluesky failed."],
  };
  const [status, message] = failures[result.code] ?? [500, "Posting failed."];
  // Surface the upstream response (e.g. "bsky createRecord failed: 401 …") so a
  // transient service error can be told from bad credentials without opening
  // the Worker logs.
  const detail =
    "detail" in result && result.detail ? ` — ${result.detail}` : "";
  throw new HttpError(status, "bsky_" + result.code, message + detail);
}

// Post a single article to Bluesky (AT Protocol), mirroring kuro-boo's
// scripts/post-bluesky.mjs: createSession -> (uploadBlob) -> createRecord with a
// link facet and an optional external embed card carrying the cover thumbnail.
async function postToBluesky(
  handle: string,
  password: string,
  title: string,
  summary: string,
  url: string,
  image: { bytes: ArrayBuffer; mime: string } | null,
  langLine = "",
): Promise<void> {
  const HOST = "https://bsky.social";
  const sessRes = await fetch(`${HOST}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: handle, password }),
  });
  if (!sessRes.ok) {
    throw new HttpError(
      502,
      "bsky_login_failed",
      `Bluesky login failed: ${sessRes.status}`,
    );
  }
  const session = (await sessRes.json()) as { accessJwt: string; did: string };

  // The language line ("🌐 日本語, English, …") is a FIXED suffix: reserved out
  // of the 300-char budget before the title/summary trim, so it can never be
  // cut itself. Dropped entirely only if it alone would blow the budget
  // (pathological many-language case) — the title/summary always win.
  const urlPart = `\n\n${url}`;
  let langPart = langLine ? `\n\n${langLine}` : "";
  if (langPart.length > 300 - urlPart.length - 40) langPart = "";
  const maxBody = 300 - urlPart.length - langPart.length;
  // Post body = title + summary (Bluesky's 300-char limit; trim if needed). The
  // URL is always appended below with a link facet.
  let body = summary ? `${title}\n\n${summary}` : title;
  if (body.length > maxBody)
    body = `${body.slice(0, Math.max(0, maxBody - 1))}…`;
  const text = `${body}${urlPart}${langPart}`;

  const enc = new TextEncoder();
  const byteStart = enc.encode(text.slice(0, text.indexOf(url))).length;
  const byteEnd = byteStart + enc.encode(url).length;

  const record: Record<string, unknown> = {
    $type: "app.bsky.feed.post",
    text,
    createdAt: new Date().toISOString(),
    facets: [
      {
        index: { byteStart, byteEnd },
        features: [{ $type: "app.bsky.richtext.facet#link", uri: url }],
      },
    ],
  };

  if (image) {
    const upRes = await fetch(`${HOST}/xrpc/com.atproto.repo.uploadBlob`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.accessJwt}`,
        "Content-Type": image.mime,
      },
      body: image.bytes,
    });
    if (upRes.ok) {
      const blob = ((await upRes.json()) as { blob: unknown }).blob;
      record.embed = {
        $type: "app.bsky.embed.external",
        external: { uri: url, title, description: summary, thumb: blob },
      };
    } else {
      throw new HttpError(
        502,
        "bsky_image_upload_failed",
        `Bluesky image upload failed: ${upRes.status}`,
      );
    }
  }

  const postRes = await fetch(`${HOST}/xrpc/com.atproto.repo.createRecord`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.accessJwt}`,
    },
    body: JSON.stringify({
      repo: session.did,
      collection: "app.bsky.feed.post",
      record,
    }),
  });
  if (!postRes.ok) {
    throw new HttpError(
      502,
      "bsky_post_failed",
      `Bluesky post failed: ${postRes.status}`,
    );
  }
}

// ─── X (Twitter) auto-post ────────────────────────────────────────────────────
// OAuth 1.0a user-context signing (HMAC-SHA1). Only the oauth_* params enter
// the signature base string: the tweet body is JSON and the media upload is
// multipart/form-data, neither of which is signed per the OAuth 1.0a spec.

interface XCreds {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
}

/** RFC 3986 percent-encoding (encodeURIComponent + the five extra chars). */
function oauthPctEncode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

async function oauth1Header(
  method: string,
  url: string,
  creds: XCreds,
): Promise<string> {
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };
  const paramStr = Object.keys(oauth)
    .sort()
    .map((k) => `${oauthPctEncode(k)}=${oauthPctEncode(oauth[k])}`)
    .join("&");
  const base = [
    method.toUpperCase(),
    oauthPctEncode(url),
    oauthPctEncode(paramStr),
  ].join("&");
  const signingKey = `${oauthPctEncode(creds.apiSecret)}&${oauthPctEncode(creds.accessSecret)}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingKey),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(base),
  );
  oauth.oauth_signature = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return (
    "OAuth " +
    Object.keys(oauth)
      .sort()
      .map((k) => `${oauthPctEncode(k)}="${oauthPctEncode(oauth[k])}"`)
      .join(", ")
  );
}

/**
 * X's weighted character count: code points in the official "light" ranges
 * (0–4351, 8192–8205, 8208–8223, 8242–8247) weigh 1, everything else (CJK,
 * emoji, …) weighs 2. The limit per tweet is 280 weight units; any URL is
 * always counted as 23 (t.co wrapping) regardless of its length.
 */
function xCharWeight(cp: number): number {
  const light =
    cp <= 0x10ff ||
    (cp >= 0x2000 && cp <= 0x200d) ||
    (cp >= 0x2010 && cp <= 0x201f) ||
    (cp >= 0x2032 && cp <= 0x2037);
  return light ? 1 : 2;
}

function xWeightedLength(s: string): number {
  let n = 0;
  for (const ch of s) n += xCharWeight(ch.codePointAt(0) ?? 0);
  return n;
}

/** Trim to the weighted budget, appending "…" when anything was cut. */
function xTrimToWeight(s: string, maxWeight: number): string {
  if (xWeightedLength(s) <= maxWeight) return s;
  let out = "";
  let n = 0;
  for (const ch of s) {
    const w = xCharWeight(ch.codePointAt(0) ?? 0);
    if (n + w > maxWeight - 2) break; // reserve 2 for the ellipsis
    out += ch;
    n += w;
  }
  return out.replace(/\s+$/, "") + "…";
}

const X_UPLOAD_URL = "https://upload.twitter.com/1.1/media/upload.json";
const X_TWEET_URL = "https://api.x.com/2/tweets";
const X_URL_WEIGHT = 23;

/** "Read more" lead-in for the link reply, per article language. Non-English
 *  posts append "(Read more)" so the reply is readable to everyone. */
const X_READMORE_LABELS: Record<string, string> = {
  ja: "詳細はこちら",
  en: "Read more",
  ko: "자세히 보기",
  zh: "查看详情",
  de: "Mehr erfahren",
  fr: "En savoir plus",
  it: "Scopri di più",
  es: "Más información",
  uk: "Детальніше",
};

function xReplyText(lang: string, url: string): string {
  const label = X_READMORE_LABELS[lang] || X_READMORE_LABELS.en;
  const en =
    lang === "en"
      ? ""
      : lang === "ja" || lang === "zh"
        ? "（Read more）"
        : " (Read more)";
  return `📖 ${label}${en}\n${url}`;
}

/**
 * Post an article to X: parent tweet = cover image + title/summary text;
 * the article URL goes into a REPLY tweet by default (`linkInReply`) — on X's
 * API pricing a link-bearing post is billed higher, so splitting parent
 * ($0.015) + reply ($0.015) is the cheaper shape. With linkInReply=false the
 * URL is appended to the parent text instead (single tweet).
 */
/**
 * Thrown when the parent tweet WAS posted but the link reply failed. The
 * caller must treat the article as posted (set the flag): retrying the whole
 * flow would post a duplicate parent, which X rejects — or worse, doubles the
 * post if the text changed.
 */
class XReplyFailedError extends Error {}

async function postToX(
  creds: XCreds,
  title: string,
  summary: string,
  url: string,
  image: { bytes: ArrayBuffer; mime: string } | null,
  linkInReply: boolean,
  lang: string,
  tags: string[],
  langLine = "",
): Promise<void> {
  let mediaId = "";
  if (image) {
    const form = new FormData();
    form.append(
      "media",
      new Blob([image.bytes], { type: image.mime }),
      "cover",
    );
    const res = await fetch(X_UPLOAD_URL, {
      method: "POST",
      headers: {
        Authorization: await oauth1Header("POST", X_UPLOAD_URL, creds),
      },
      body: form,
    });
    if (!res.ok) {
      throw new Error(
        `x media upload failed: ${res.status} ${(await res.text()).slice(0, 300)}`,
      );
    }
    const j = (await res.json()) as { media_id_string?: string };
    mediaId = j.media_id_string || "";
    if (!mediaId) throw new Error("x media upload returned no media_id");
  }

  // Hashtags: up to 3 from the article's per-language hashtag list, appended
  // to the parent post (X still uses them for search/topic grouping; more than
  // a few reads as spam). They are reserved out of the weighted budget first.
  const tagsText = tags
    .map((t) => String(t || "").replace(/[\s#]+/g, ""))
    .filter(Boolean)
    .slice(0, 3)
    .map((t) => `#${t}`)
    .join(" ");
  // The language line rides ONLY on the link reply (2-post shape below) —
  // never on the parent. In single-post mode it is omitted entirely: the
  // parent's 280-weight budget is the scarce resource there, and per the
  // maintainer the line isn't worth spending it on.
  let budget = 280;
  if (!linkInReply) budget -= X_URL_WEIGHT + 2; // "\n\n" + wrapped URL
  if (tagsText) budget -= xWeightedLength(tagsText) + 2; // "\n\n" + tags
  let text = summary ? `${title}\n\n${summary}` : title;
  text = xTrimToWeight(text, budget);
  if (tagsText) text = `${text}\n\n${tagsText}`;
  if (!linkInReply) text = `${text}\n\n${url}`;

  const parentBody: Record<string, unknown> = { text };
  if (mediaId) parentBody.media = { media_ids: [mediaId] };
  const parentRes = await fetch(X_TWEET_URL, {
    method: "POST",
    headers: {
      Authorization: await oauth1Header("POST", X_TWEET_URL, creds),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(parentBody),
  });
  if (!parentRes.ok) {
    throw new Error(
      `x tweet failed: ${parentRes.status} ${(await parentRes.text()).slice(0, 300)}`,
    );
  }
  const parent = (await parentRes.json()) as { data?: { id?: string } };
  const parentId = parent.data?.id || "";

  if (linkInReply) {
    // From here on the parent tweet is live — any failure must NOT be retried
    // from scratch (duplicate parent), so it is raised as XReplyFailedError.
    if (!parentId)
      throw new XReplyFailedError("x tweet returned no id for the reply");
    // Reply = lead-in + URL (~50 weight) — plenty of room for the language
    // line. Still guard the 280 budget for a pathological language count.
    let replyText = xReplyText(lang, url);
    if (langLine) {
      const withLangs = `${replyText}\n\n${langLine}`;
      const weight = xWeightedLength(withLangs.replace(url, "")) + X_URL_WEIGHT;
      if (weight <= 280) replyText = withLangs;
    }
    let replyRes: Response;
    try {
      replyRes = await fetch(X_TWEET_URL, {
        method: "POST",
        headers: {
          Authorization: await oauth1Header("POST", X_TWEET_URL, creds),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: replyText,
          reply: { in_reply_to_tweet_id: parentId },
        }),
      });
    } catch (err) {
      throw new XReplyFailedError(
        `x reply fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!replyRes.ok) {
      throw new XReplyFailedError(
        `x reply failed: ${replyRes.status} ${(await replyRes.text()).slice(0, 300)}`,
      );
    }
  }
}

type XPostResult =
  | { ok: true; postedAt: string }
  | {
      ok: false;
      code:
        | "not_configured"
        | "no_public_domain"
        | "not_published"
        | "already_posted"
        | "cover_failed"
        | "post_failed"
        // Parent tweet posted, link reply failed. The posted flag IS set (a
        // retry would duplicate the parent); the admin replies manually on X.
        | "reply_failed";
      /** Upstream error (X HTTP status + response snippet) for the admin toast. */
      detail?: string;
    };

/** X twin of postBlueskyForDoc — same guards, sns_x_posted_at flag. */
async function postXForDoc(env: Env, did: string): Promise<XPostResult> {
  const s = await env.DB.prepare(
    "SELECT x_api_key, x_api_secret, x_access_token, x_access_secret, x_link_in_reply, public_domain FROM site_settings WHERE id = 1",
  ).first<{
    x_api_key: string | null;
    x_api_secret: string | null;
    x_access_token: string | null;
    x_access_secret: string | null;
    x_link_in_reply: number | null;
    public_domain: string | null;
  }>();
  const creds: XCreds = {
    apiKey: (s?.x_api_key ?? "").trim(),
    apiSecret: (s?.x_api_secret ?? "").trim(),
    accessToken: (s?.x_access_token ?? "").trim(),
    accessSecret: (s?.x_access_secret ?? "").trim(),
  };
  if (
    !creds.apiKey ||
    !creds.apiSecret ||
    !creds.accessToken ||
    !creds.accessSecret
  ) {
    return { ok: false, code: "not_configured" };
  }
  const linkInReply = (s?.x_link_in_reply ?? 1) !== 0;
  let origin = "";
  try {
    if (s?.public_domain) origin = new URL(s.public_domain).origin;
  } catch {
    /* invalid public_domain */
  }
  if (!origin) return { ok: false, code: "no_public_domain" };

  const doc = await env.DB.prepare(
    // live (not just mode): see the matching Bluesky comment.
    "SELECT tid, slug, initial_lang, sns_x_posted_at FROM documents WHERE did = ? AND mode = 1 AND live = 1",
  )
    .bind(did)
    .first<{
      tid: string;
      slug: string;
      initial_lang: string;
      sns_x_posted_at: string | null;
    }>();
  if (!doc) return { ok: false, code: "not_published" };
  if (doc.sns_x_posted_at) return { ok: false, code: "already_posted" };

  const tl = await env.DB.prepare(
    "SELECT title, summary, seo_json, hashtag_json FROM document_translations WHERE did = ? AND lang = ?",
  )
    .bind(did, doc.initial_lang)
    .first<{
      title: string | null;
      summary: string | null;
      seo_json: string | null;
      hashtag_json: string | null;
    }>();
  const title = (tl?.title ?? doc.slug).trim() || doc.slug;
  const summary = (tl?.summary ?? "").trim();
  const url = `${origin}/${doc.tid}/${doc.slug}/`;
  let tags: string[] = [];
  try {
    const parsed = tl?.hashtag_json ? JSON.parse(tl.hashtag_json) : [];
    if (Array.isArray(parsed))
      tags = parsed.filter((t): t is string => typeof t === "string");
  } catch {
    /* ignore malformed hashtag_json */
  }

  const langLine = await snsLanguagesLine(env, did, doc.initial_lang, doc.slug);

  const cover = await prepareSnsCoverImage(
    env,
    did,
    tl?.seo_json ?? null,
    "x_cover_prepare_failed",
  );
  if (!cover.ok) return { ok: false, code: "cover_failed" };

  try {
    await postToX(
      creds,
      title,
      summary,
      url,
      cover.image,
      linkInReply,
      doc.initial_lang || "en",
      tags,
      langLine,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (error instanceof XReplyFailedError) {
      // The parent tweet is live: mark the article posted so a retry cannot
      // create a duplicate parent, and tell the admin the reply is missing.
      console.warn(
        JSON.stringify({ event: "x_reply_failed", did, error: detail }),
      );
      await env.DB.prepare(
        "UPDATE documents SET sns_x_posted_at = ? WHERE did = ? AND sns_x_posted_at IS NULL",
      )
        .bind(nowIso(), did)
        .run();
      return { ok: false, code: "reply_failed", detail };
    }
    console.warn(
      JSON.stringify({ event: "x_post_failed", did, error: detail }),
    );
    return { ok: false, code: "post_failed", detail };
  }

  const postedAt = nowIso();
  await env.DB.prepare(
    "UPDATE documents SET sns_x_posted_at = ? WHERE did = ? AND sns_x_posted_at IS NULL",
  )
    .bind(postedAt, did)
    .run();
  return { ok: true, postedAt };
}

/** On-demand "投稿" button for X (mirrors postDocumentToBluesky). */
async function postDocumentToX(
  env: Env,
  user: AuthUser,
  did: string,
): Promise<Response> {
  requireAuthor(user);
  const result = await postXForDoc(env, did);
  if (result.ok) {
    await logActivity(env, user, "document.sns_post", "document", did, {
      x: true,
    });
    return json({
      did,
      x: { posted: true, postedAt: result.postedAt },
    });
  }
  const failures: Record<string, [number, string]> = {
    not_configured: [400, "X is not configured in Settings → SNS."],
    no_public_domain: [400, "Set the site's public domain first."],
    not_published: [409, "Publish AND build the article before posting to X."],
    already_posted: [409, "This article was already posted to X."],
    cover_failed: [502, "The cover image could not be prepared for X."],
    post_failed: [502, "Posting to X failed."],
    reply_failed: [
      502,
      "Posted to X, but the link reply failed. The article is marked as posted (retrying would duplicate the parent post) — reply with the article URL manually on X.",
    ],
  };
  const [status, message] = failures[result.code] ?? [500, "Posting failed."];
  // Surface the upstream response (e.g. "x tweet failed: 429 …") so a rate
  // limit / transient X error can be told from bad credentials without opening
  // the Worker logs.
  const detail =
    "detail" in result && result.detail ? ` — ${result.detail}` : "";
  throw new HttpError(status, "x_" + result.code, message + detail);
}

// ─── Threads (Meta) auto-post ─────────────────────────────────────────────────
// Official Threads API (graph.threads.net). Auth = one long-lived access token
// (threads_basic + threads_content_publish). Images are passed as a PUBLIC URL
// (no binary upload); publishing is two-step (create container → publish).
// One post per article: cover image + title/summary + 1 topic tag + link
// (Threads has no per-post pricing, so no parent/reply split like X).

const THREADS_API = "https://graph.threads.net/v1.0";
const THREADS_TEXT_LIMIT = 500;

/** Simple code-point trim with ellipsis (Threads counts plain characters). */
function trimToLen(s: string, max: number): string {
  const chars = [...s];
  if (chars.length <= max) return s;
  return (
    chars
      .slice(0, Math.max(0, max - 1))
      .join("")
      .replace(/\s+$/, "") + "…"
  );
}

async function postToThreads(
  token: string,
  userId: string,
  text: string,
  imageUrl: string | null,
): Promise<void> {
  const create = async (withImage: boolean): Promise<string> => {
    const params = new URLSearchParams();
    params.set("access_token", token);
    params.set("text", text);
    if (withImage && imageUrl) {
      params.set("media_type", "IMAGE");
      params.set("image_url", imageUrl);
    } else {
      params.set("media_type", "TEXT");
    }
    const res = await fetch(`${THREADS_API}/${userId}/threads`, {
      method: "POST",
      body: params,
    });
    if (!res.ok) {
      throw new Error(
        `threads container failed: ${res.status} ${(await res.text()).slice(0, 300)}`,
      );
    }
    const j = (await res.json()) as { id?: string };
    if (!j.id) throw new Error("threads container returned no id");
    return j.id;
  };
  const publish = async (creationId: string): Promise<void> => {
    // Image containers can take a moment to become ready — retry briefly.
    let lastErr = "";
    for (let i = 0; i < 4; i++) {
      const params = new URLSearchParams();
      params.set("access_token", token);
      params.set("creation_id", creationId);
      const res = await fetch(`${THREADS_API}/${userId}/threads_publish`, {
        method: "POST",
        body: params,
      });
      if (res.ok) return;
      lastErr = `${res.status} ${(await res.text()).slice(0, 300)}`;
      await new Promise((r) => setTimeout(r, 2500));
    }
    throw new Error(`threads publish failed: ${lastErr}`);
  };

  if (imageUrl) {
    // Threads officially supports JPEG/PNG image URLs; if the cover can't be
    // used (e.g. webp), fall back to a text post rather than failing the whole
    // announcement. The unpublished container is simply abandoned.
    try {
      await publish(await create(true));
      return;
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "threads_image_post_failed_fallback_text",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  await publish(await create(false));
}

type ThreadsPostResult =
  | { ok: true; postedAt: string }
  | {
      ok: false;
      code:
        | "not_configured"
        | "no_public_domain"
        | "not_published"
        | "already_posted"
        | "post_failed";
    };

/** Threads twin of postBlueskyForDoc / postXForDoc — sns_threads_posted_at. */
async function postThreadsForDoc(
  env: Env,
  did: string,
): Promise<ThreadsPostResult> {
  const s = await env.DB.prepare(
    "SELECT threads_token, threads_user_id, public_domain FROM site_settings WHERE id = 1",
  ).first<{
    threads_token: string | null;
    threads_user_id: string | null;
    public_domain: string | null;
  }>();
  const token = (s?.threads_token ?? "").trim();
  if (!token) return { ok: false, code: "not_configured" };
  let origin = "";
  try {
    if (s?.public_domain) origin = new URL(s.public_domain).origin;
  } catch {
    /* invalid public_domain */
  }
  if (!origin) return { ok: false, code: "no_public_domain" };

  // Resolve and cache the Threads user id on first use.
  let userId = (s?.threads_user_id ?? "").trim();
  if (!userId) {
    try {
      const res = await fetch(
        `${THREADS_API}/me?fields=id&access_token=${encodeURIComponent(token)}`,
      );
      if (res.ok) {
        const j = (await res.json()) as { id?: string };
        userId = (j.id ?? "").trim();
      }
    } catch {
      /* handled below */
    }
    if (!userId) return { ok: false, code: "not_configured" };
    await env.DB.prepare(
      "UPDATE site_settings SET threads_user_id = ? WHERE id = 1",
    )
      .bind(userId)
      .run();
  }

  const doc = await env.DB.prepare(
    // live (not just mode): see the matching Bluesky comment.
    "SELECT tid, slug, initial_lang, sns_threads_posted_at FROM documents WHERE did = ? AND mode = 1 AND live = 1",
  )
    .bind(did)
    .first<{
      tid: string;
      slug: string;
      initial_lang: string;
      sns_threads_posted_at: string | null;
    }>();
  if (!doc) return { ok: false, code: "not_published" };
  // The flag was already CLAIMED by postDocumentToThreads before this job was
  // queued (it doubles as the in-flight lock), so a set value here is our own
  // claim — not a prior post. Don't bail out as already_posted.

  const tl = await env.DB.prepare(
    "SELECT title, summary, seo_json, hashtag_json FROM document_translations WHERE did = ? AND lang = ?",
  )
    .bind(did, doc.initial_lang)
    .first<{
      title: string | null;
      summary: string | null;
      seo_json: string | null;
      hashtag_json: string | null;
    }>();
  const title = (tl?.title ?? doc.slug).trim() || doc.slug;
  const summary = (tl?.summary ?? "").trim();
  const url = `${origin}/${doc.tid}/${doc.slug}/`;

  // Cover as a PUBLIC URL (the Threads API fetches it itself).
  let imageUrl: string | null = null;
  try {
    const seo = tl?.seo_json ? JSON.parse(tl.seo_json) : {};
    const coverPath =
      seo && typeof seo.coverPath === "string" ? seo.coverPath : "";
    if (coverPath) imageUrl = `${origin}${coverPath}`;
  } catch {
    /* ignore malformed seo_json */
  }

  // Threads renders only ONE topic tag per post — append just the first.
  let tagText = "";
  try {
    const parsed = tl?.hashtag_json ? JSON.parse(tl.hashtag_json) : [];
    if (Array.isArray(parsed)) {
      const t = parsed.find(
        (v): v is string => typeof v === "string" && v.trim() !== "",
      );
      if (t) tagText = `#${t.replace(/[\s#]+/g, "")}`;
    }
  } catch {
    /* ignore */
  }

  // Language line as a fixed suffix, reserved out of the 500-char budget like
  // the tag/URL so the title/summary trim can never cut it.
  const langLine = await snsLanguagesLine(env, did, doc.initial_lang, doc.slug);
  const langPart = langLine ? `\n\n${langLine}` : "";
  const reserved =
    [...url].length +
    2 +
    (tagText ? [...tagText].length + 2 : 0) +
    [...langPart].length;
  let text = summary ? `${title}\n\n${summary}` : title;
  text = trimToLen(text, THREADS_TEXT_LIMIT - reserved);
  if (tagText) text = `${text}\n\n${tagText}`;
  text = `${text}\n\n${url}${langPart}`;

  try {
    await postToThreads(token, userId, text, imageUrl);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "threads_post_failed",
        did,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return { ok: false, code: "post_failed" };
  }

  // The posted flag is already set (claimed at queue time), so nothing to
  // write here — the claim simply "sticks" now that the post succeeded.
  return { ok: true, postedAt: nowIso() };
}

/**
 * On-demand "投稿" button for Threads. Unlike Bluesky/X this runs in the
 * BACKGROUND (ctx.waitUntil): Meta processes the cover image server-side and
 * the publish step can take tens of seconds, which is too long to hold the
 * HTTP request open (the dialog appeared to hang). Cheap guards run first so
 * config/state errors still surface immediately; the client then polls the
 * /sns flag to learn when the background post lands.
 */
async function postDocumentToThreads(
  env: Env,
  ctx: ExecutionContext,
  user: AuthUser,
  did: string,
): Promise<Response> {
  requireAuthor(user);
  const failures: Record<string, [number, string]> = {
    not_configured: [400, "Threads is not configured in Settings → SNS."],
    no_public_domain: [400, "Set the site's public domain first."],
    not_published: [
      409,
      "Publish AND build the article before posting to Threads.",
    ],
    already_posted: [409, "This article was already posted to Threads."],
    post_failed: [502, "Posting to Threads failed. Check your access token."],
  };
  const fail = (code: string): never => {
    const [status, message] = failures[code] ?? [500, "Posting failed."];
    throw new HttpError(status, "threads_" + code, message);
  };

  // Preflight (same guards postThreadsForDoc re-checks): fail fast while the
  // request is still open.
  const st = await env.DB.prepare(
    "SELECT threads_token, public_domain FROM site_settings WHERE id = 1",
  ).first<{ threads_token: string | null; public_domain: string | null }>();
  if (!(st?.threads_token ?? "").trim()) fail("not_configured");
  let origin = "";
  try {
    if (st?.public_domain) origin = new URL(st.public_domain).origin;
  } catch {
    /* invalid public_domain */
  }
  if (!origin) fail("no_public_domain");
  const doc = await env.DB.prepare(
    "SELECT sns_threads_posted_at FROM documents WHERE did = ? AND mode = 1 AND live = 1",
  )
    .bind(did)
    .first<{ sns_threads_posted_at: string | null }>();
  if (!doc) fail("not_published");
  if (doc!.sns_threads_posted_at) fail("already_posted");

  // Atomically CLAIM the posted flag BEFORE queueing the background job. This
  // one timestamp is both the "posted" marker and the in-flight lock, which
  // closes the double-post window the old activity_logs guard left open:
  //   • Any second press (a double click, a poll-timeout re-enable, or a fresh
  //     screen after remount) now sees the flag set and is refused with
  //     already_posted — deterministically, with no 3-minute expiry to race.
  //   • It survives isolate eviction: if the background job reaches Threads but
  //     the worker is killed before it could confirm, the flag is already set,
  //     so the article can never be posted a second time.
  // The claim is RELEASED (set back to NULL) by the handler below only if the
  // post ultimately fails, so a genuine failure stays retryable.
  const claim = await env.DB.prepare(
    "UPDATE documents SET sns_threads_posted_at = ? WHERE did = ? AND mode = 1 AND live = 1 AND sns_threads_posted_at IS NULL",
  )
    .bind(nowIso(), did)
    .run();
  if ((claim.meta?.changes ?? 0) === 0) fail("already_posted");

  await logActivity(env, user, "document.sns_post", "document", did, {
    threads: true,
    queued: true,
  });
  ctx.waitUntil(
    postThreadsForDoc(env, did).then(async (result) => {
      if (!result.ok) {
        // Release the claim so the row reverts to un-posted and the user can
        // retry. (config/domain/publish were preflighted above, so a failure
        // here is almost always a Threads-side post_failed.)
        await env.DB.prepare(
          "UPDATE documents SET sns_threads_posted_at = NULL WHERE did = ?",
        )
          .bind(did)
          .run()
          .catch(() => {});
        console.warn(
          JSON.stringify({
            event: "threads_background_post_failed",
            did,
            code: result.code,
          }),
        );
      }
    }),
  );
  return json({ did, threads: { queued: true } });
}

/**
 * POST /api/documents/sns/bulk-flag { service, posted } — set or clear the
 * posted flag on ALL documents for one service. Setting only fills NULL flags
 * (existing timestamps are preserved); clearing NULLs every flag.
 */
async function documentSnsBulkFlag(
  request: Request,
  env: Env,
  user: AuthUser,
): Promise<Response> {
  requireAuthor(user);
  const body = await readJson(request);
  const service = optionalString(body, "service") ?? "";
  const SNS_FLAG_COLS: Record<string, string> = {
    bsky: "sns_bsky_posted_at",
    x: "sns_x_posted_at",
    threads: "sns_threads_posted_at",
  };
  const col = SNS_FLAG_COLS[service];
  if (!col) {
    throw new HttpError(
      400,
      "invalid_field",
      "service must be bsky, x or threads.",
    );
  }
  if (typeof body.posted !== "boolean") {
    throw new HttpError(400, "invalid_field", "posted must be a boolean.");
  }
  let changed: number;
  if (body.posted) {
    const r = await env.DB.prepare(
      `UPDATE documents SET ${col} = ? WHERE ${col} IS NULL`,
    )
      .bind(nowIso())
      .run();
    changed = r.meta?.changes ?? 0;
  } else {
    const r = await env.DB.prepare(
      `UPDATE documents SET ${col} = NULL WHERE ${col} IS NOT NULL`,
    ).run();
    changed = r.meta?.changes ?? 0;
  }
  await logActivity(env, user, "document.sns_flag_bulk", "document", "*", {
    service,
    posted: body.posted === true,
    changed,
  });
  return json({ service, posted: body.posted === true, changed });
}

// REST: read / set the per-article Bluesky "already posted" flag.
//   GET /api/documents/:did/sns        -> { did, bsky: { posted, postedAt } }
//   PUT /api/documents/:did/sns {bsky}  -> bsky:true marks posted (so the "投稿"
//      button hides), bsky:false clears it (re-enables the button).
async function documentSnsFlag(
  request: Request,
  env: Env,
  user: AuthUser,
  did: string,
): Promise<Response> {
  requireAuthor(user);
  const row = await env.DB.prepare(
    "SELECT sns_bsky_posted_at, sns_x_posted_at, sns_threads_posted_at FROM documents WHERE did = ?",
  )
    .bind(did)
    .first<{
      sns_bsky_posted_at: string | null;
      sns_x_posted_at: string | null;
      sns_threads_posted_at: string | null;
    }>();
  if (!row) {
    throw new HttpError(404, "document_not_found", "Document was not found.");
  }

  if (request.method === "GET") {
    return json({
      did,
      bsky: {
        posted: !!row.sns_bsky_posted_at,
        postedAt: row.sns_bsky_posted_at ?? null,
      },
      x: {
        posted: !!row.sns_x_posted_at,
        postedAt: row.sns_x_posted_at ?? null,
      },
      threads: {
        posted: !!row.sns_threads_posted_at,
        postedAt: row.sns_threads_posted_at ?? null,
      },
    });
  }

  if (request.method === "PUT") {
    const body = await readJson(request);
    const hasBsky = typeof body.bsky === "boolean";
    const hasX = typeof body.x === "boolean";
    const hasThreads = typeof body.threads === "boolean";
    if (!hasBsky && !hasX && !hasThreads) {
      throw new HttpError(
        400,
        "invalid_field",
        "bsky, x or threads must be a boolean: true = mark posted, false = clear.",
      );
    }
    let bskyAt = row.sns_bsky_posted_at;
    let xAt = row.sns_x_posted_at;
    if (hasBsky) {
      bskyAt = body.bsky ? nowIso() : null;
      await env.DB.prepare(
        "UPDATE documents SET sns_bsky_posted_at = ? WHERE did = ?",
      )
        .bind(bskyAt, did)
        .run();
    }
    if (hasX) {
      xAt = body.x ? nowIso() : null;
      await env.DB.prepare(
        "UPDATE documents SET sns_x_posted_at = ? WHERE did = ?",
      )
        .bind(xAt, did)
        .run();
    }
    let threadsAt = row.sns_threads_posted_at;
    if (hasThreads) {
      threadsAt = body.threads ? nowIso() : null;
      await env.DB.prepare(
        "UPDATE documents SET sns_threads_posted_at = ? WHERE did = ?",
      )
        .bind(threadsAt, did)
        .run();
    }
    await logActivity(env, user, "document.sns_flag", "document", did, {
      ...(hasBsky ? { bsky: body.bsky === true } : {}),
      ...(hasX ? { x: body.x === true } : {}),
      ...(hasThreads ? { threads: body.threads === true } : {}),
    });
    return json({
      did,
      bsky: { posted: !!bskyAt, postedAt: bskyAt },
      x: { posted: !!xAt, postedAt: xAt },
      threads: { posted: !!threadsAt, postedAt: threadsAt },
    });
  }

  throw new HttpError(405, "method_not_allowed", "Method is not allowed.");
}

async function workerSecretsSettings(
  _request: Request,
  env: Env,
  user: AuthUser,
): Promise<Response> {
  requireAdmin(user);
  // CF credentials are stored as Cloudflare Worker Secrets (CF_API_TOKEN, CF_ACCOUNT_ID, CF_WORKER_NAME)
  // set by the KuroCMS installer. This endpoint reports their status.
  const tokenConfigured = !!env.CF_API_TOKEN;
  const accountId = env.CF_ACCOUNT_ID ?? "";
  const workerName = env.CF_WORKER_NAME ?? "";
  return json({
    workerSecrets: {
      tokenConfigured,
      accountId,
      workerName,
      note: "Credentials are stored as Cloudflare Worker Secrets, set automatically by the KuroCMS installer.",
    },
  });
}

async function debugClientError(
  request: Request,
  env: Env,
  user: AuthUser,
): Promise<Response> {
  const body = await readJson(request);
  const message = requireString(body, "message", { min: 1, max: 1000 });
  const context = optionalString(body, "context") ?? "ui";
  const route = optionalString(body, "route") ?? "";
  const stack = optionalString(body, "stack") ?? "";
  const source = optionalString(body, "source") ?? "admin";

  await logDebugEvent(env, {
    requestId: request.headers.get("cf-ray") || makeId("req"),
    level: "error",
    eventType: "client_error",
    phase: "client",
    action: context,
    route,
    method: request.method,
    statusCode: 200,
    latencyMs: 0,
    actorUid: user.uid,
    actorEmail: user.email,
    cfRay: request.headers.get("cf-ray"),
    userAgent: request.headers.get("user-agent"),
    errorCode: "client_error",
    errorMessage: message,
    errorStack: stack || null,
    metadata: sanitizeDebugMetadata({
      source,
      metadata: body.metadata ?? null,
    }),
  });

  return json({ ok: true });
}

async function me(
  request: Request,
  env: Env,
  user: AuthUser,
): Promise<Response> {
  if (request.method === "GET") {
    const row = await env.DB.prepare(
      `SELECT uid, email, display_name, author_id, is_admin, is_author, created_at, updated_at
       FROM users WHERE uid = ?`,
    )
      .bind(user.uid)
      .first<UserProfileRow>();
    if (!row) {
      throw new HttpError(404, "user_not_found", "User was not found.");
    }
    let authorId = (row.author_id || "").trim();
    if (!authorId) {
      authorId = makeId("author");
      await env.DB.prepare(
        "UPDATE users SET author_id = ?, updated_at = ? WHERE uid = ?",
      )
        .bind(authorId, nowIso(), user.uid)
        .run();
    }
    return json({
      user: {
        uid: row.uid,
        email: row.email,
        displayName: row.display_name ?? "",
        authorId,
        isAdmin: row.is_admin === 1,
        isAuthor: row.is_author === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    });
  }

  if (request.method === "PUT") {
    const body = await readJson(request);
    const email = requireString(body, "email", {
      min: 3,
      max: 254,
    }).toLowerCase();
    const displayName = optionalString(body, "displayName") ?? "";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new HttpError(
        400,
        "invalid_email",
        "email must be a valid email address.",
      );
    }
    // author_id（所有者判定 ID）。指定があれば更新（既存公開テンプレ更新時に合わせる用途）。
    // 未指定なら変更しない。
    const rawAuthorId = optionalString(body, "authorId");
    const newAuthorId =
      rawAuthorId && rawAuthorId.trim() ? rawAuthorId.trim() : null;
    if (newAuthorId && !/^[a-zA-Z0-9_-]+$/.test(newAuthorId)) {
      throw new HttpError(
        400,
        "invalid_author_id",
        "author_id must match [a-zA-Z0-9_-]+.",
      );
    }
    const duplicate = await env.DB.prepare(
      "SELECT uid FROM users WHERE email = ? AND uid != ?",
    )
      .bind(email, user.uid)
      .first<{ uid: string }>();
    if (duplicate) {
      throw new HttpError(
        409,
        "email_taken",
        "email is already used by another user.",
      );
    }
    const now = nowIso();
    await env.DB.prepare(
      "UPDATE users SET email = ?, display_name = ?, author_id = COALESCE(?, author_id), updated_at = ? WHERE uid = ?",
    )
      .bind(email, displayName || null, newAuthorId, now, user.uid)
      .run();
    await logActivity(env, user, "profile.update", "user", user.uid, {
      email,
      displayName,
    });
    return json({ ok: true, updatedAt: now });
  }

  throw new HttpError(405, "method_not_allowed", "Method is not allowed.");
}

async function meTokens(
  request: Request,
  env: Env,
  user: AuthUser,
): Promise<Response> {
  if (request.method === "GET") {
    const limit = Math.min(
      Math.max(
        Number(new URL(request.url).searchParams.get("limit") ?? 500),
        1,
      ),
      500,
    );
    const result = await env.DB.prepare(
      `SELECT token_id, name, scopes_json, last_used_at, expires_at, revoked_at, created_at
       FROM personal_access_tokens
       WHERE uid = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
      .bind(user.uid, limit)
      .all<TokenListRow>();
    return json({
      tokens: (result.results ?? []).map((row) => ({
        tokenId: row.token_id,
        name: row.name,
        scopes: JSON.parse(row.scopes_json || "[]"),
        lastUsedAt: row.last_used_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        createdAt: row.created_at,
      })),
    });
  }

  if (request.method === "POST") {
    const body = await readJson(request);
    const name = optionalString(body, "name") ?? "Personal token";
    const scopes = [
      user.isAdmin ? "admin" : "",
      user.isAuthor ? "author" : "",
    ].filter(Boolean);
    const token = await createPersonalAccessToken(
      env,
      user.uid,
      name,
      scopes.length ? scopes : ["author"],
    );
    await logActivity(env, user, "token.create", "user", user.uid, { name });
    return json(
      {
        ok: true,
        token,
        note: "Store this PAT now. It will not be shown again.",
      },
      { status: 201 },
    );
  }

  throw new HttpError(405, "method_not_allowed", "Method is not allowed.");
}

async function revokeMeToken(
  env: Env,
  user: AuthUser,
  tokenId: string,
): Promise<Response> {
  const result = await env.DB.prepare(
    "UPDATE personal_access_tokens SET revoked_at = ? WHERE token_id = ? AND uid = ? AND revoked_at IS NULL",
  )
    .bind(nowIso(), tokenId, user.uid)
    .run();
  if (!result.success) {
    throw new HttpError(500, "revoke_failed", "Token revoke failed.");
  }
  await logActivity(env, user, "token.revoke", "token", tokenId, {});
  return json({ ok: true, tokenId });
}

async function deleteMeToken(
  env: Env,
  user: AuthUser,
  tokenId: string,
): Promise<Response> {
  await env.DB.prepare(
    "DELETE FROM personal_access_tokens WHERE token_id = ? AND uid = ? AND revoked_at IS NOT NULL",
  )
    .bind(tokenId, user.uid)
    .run();
  await logActivity(env, user, "token.delete", "token", tokenId, {});
  return json({ ok: true, tokenId });
}

// ─── Passkey (device) management ───────────────────────────────────────────────

/** List the signed-in user's registered passkeys (devices). */
async function listMyPasskeys(env: Env, user: AuthUser): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT credential_id, display_name, aaguid, created_at, last_used_at
     FROM passkey_credentials WHERE uid = ? ORDER BY created_at ASC`,
  )
    .bind(user.uid)
    .all<Record<string, unknown>>();
  // Mark the credential that authenticated the current session.
  const passkeys = (rows.results as Record<string, unknown>[]).map((r) => ({
    ...r,
    current: Boolean(
      user.currentCredentialId && r.credential_id === user.currentCredentialId,
    ),
  }));
  return json({ passkeys: passkeys as JsonValue });
}

/** Rename one of the signed-in user's passkeys (display label only). */
async function renameMyPasskey(
  request: Request,
  env: Env,
  user: AuthUser,
  credentialId: string,
): Promise<Response> {
  const body = await readJson(request);
  const displayName = requireString(body, "displayName", {
    min: 1,
    max: 80,
  });
  const result = await env.DB.prepare(
    "UPDATE passkey_credentials SET display_name = ? WHERE credential_id = ? AND uid = ?",
  )
    .bind(displayName, credentialId, user.uid)
    .run();
  if (!result.meta.changes) {
    throw new HttpError(404, "passkey_not_found", "Passkey was not found.");
  }
  return json({ ok: true, credentialId, displayName });
}

/**
 * Delete one of the signed-in user's passkeys. The last remaining passkey
 * cannot be removed — that would lock the user out of their own account.
 */
async function deleteMyPasskey(
  env: Env,
  user: AuthUser,
  credentialId: string,
): Promise<Response> {
  const owned = await env.DB.prepare(
    "SELECT credential_id FROM passkey_credentials WHERE credential_id = ? AND uid = ?",
  )
    .bind(credentialId, user.uid)
    .first<{ credential_id: string }>();
  if (!owned) {
    throw new HttpError(404, "passkey_not_found", "Passkey was not found.");
  }
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS cnt FROM passkey_credentials WHERE uid = ?",
  )
    .bind(user.uid)
    .first<{ cnt: number }>();
  if ((count?.cnt ?? 0) <= 1) {
    throw new HttpError(
      409,
      "last_passkey",
      "Cannot remove your only passkey. Add another device first.",
    );
  }
  await env.DB.prepare(
    "DELETE FROM passkey_credentials WHERE credential_id = ? AND uid = ?",
  )
    .bind(credentialId, user.uid)
    .run();
  await logActivity(env, user, "passkey.delete", "passkey", credentialId, {});
  return json({ ok: true, credentialId });
}

async function types(
  request: Request,
  env: Env,
  user: AuthUser,
): Promise<Response> {
  if (request.method === "GET") {
    const result = await env.DB.prepare(
      "SELECT id AS tid, name, slug, source_type, schema_json, is_system, created_at, updated_at FROM taxonomy_items WHERE kind='type' ORDER BY name",
    ).all();
    return json({ types: result.results as JsonValue });
  }
  if (request.method === "POST") {
    requireAdmin(user);
    const body = await readJson(request);
    const inputTid = optionalString(body, "tid");
    const tid = inputTid ? requireSlug(inputTid, "tid") : await nextTypeId(env);
    const name = requireString(body, "name", { min: 1, max: 120 });
    const slug = requireSlug(
      requireString(body, "slug", { min: 1, max: 120 }),
      "slug",
    );
    const now = nowIso();
    await env.DB.prepare(
      "INSERT INTO taxonomy_items (id, kind, name, slug, source_type, schema_json, is_system, created_at, updated_at) VALUES (?, 'type', ?, ?, 'collection', '{}', 0, ?, ?)",
    )
      .bind(tid, name, slug, now, now)
      .run();
    return json({ tid, name, slug }, { status: 201 });
  }
  throw new HttpError(405, "method_not_allowed", "Method is not allowed.");
}

async function typeDetail(
  request: Request,
  env: Env,
  user: AuthUser,
  tidParam: string,
): Promise<Response> {
  requireAdmin(user);
  const tid = requireSlug(tidParam, "tid");

  if (request.method === "PUT") {
    const body = await readJson(request);
    const name = requireString(body, "name", { min: 1, max: 120 });
    const slug = requireSlug(
      requireString(body, "slug", { min: 1, max: 120 }),
      "slug",
    );
    const now = nowIso();
    const row = await env.DB.prepare(
      "SELECT id FROM taxonomy_items WHERE id = ? AND kind = 'type'",
    )
      .bind(tid)
      .first<{ id: string }>();
    if (!row) {
      throw new HttpError(404, "type_not_found", "Type was not found.");
    }
    await env.DB.prepare(
      "UPDATE taxonomy_items SET name = ?, slug = ?, updated_at = ? WHERE id = ? AND kind = 'type'",
    )
      .bind(name, slug, now, tid)
      .run();
    await logActivity(env, user, "type.update", "type", tid, { tid, slug });
    return json({ ok: true, tid, name, slug, updatedAt: now });
  }

  if (request.method === "DELETE") {
    const usage = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM documents WHERE tid = ?",
    )
      .bind(tid)
      .first<{ count: number }>();
    if (Number(usage?.count ?? 0) > 0) {
      throw new HttpError(
        409,
        "type_in_use",
        "This type is used by existing documents.",
      );
    }
    await env.DB.prepare(
      "DELETE FROM taxonomy_items WHERE id = ? AND kind = 'type'",
    )
      .bind(tid)
      .run();
    await logActivity(env, user, "type.delete", "type", tid, { tid });
    return json({ ok: true, tid });
  }

  throw new HttpError(405, "method_not_allowed", "Method is not allowed.");
}

async function nextTypeId(env: Env): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(MAX(CAST(id AS INTEGER)), 0) + 1 AS next_id
     FROM taxonomy_items
     WHERE kind = 'type'
       AND id GLOB '[0-9]*'
       AND id NOT GLOB '*[^0-9]*'`,
  ).first<{ next_id?: number | string | null }>();
  const numeric = Number(row?.next_id ?? 1);
  const safe =
    Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 1;
  return String(safe);
}

async function categories(
  request: Request,
  env: Env,
  user: AuthUser,
): Promise<Response> {
  if (request.method === "GET") {
    const result = await env.DB.prepare(
      `SELECT
        ti.id AS cid, ti.name, ti.slug, ti.created_at, ti.updated_at,
        (SELECT COUNT(*) FROM document_categories WHERE cid = ti.id) AS article_count
       FROM categories ti
       ORDER BY ti.name, ti.id`,
    ).all<CategoryRow>();
    return json({
      categories: (result.results ?? []).map((row) => ({
        cid: row.cid,
        name: row.name,
        slug: row.slug,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        articleCount: Number(row.article_count ?? 0),
      })),
    });
  }
  if (request.method === "POST") {
    requireAdmin(user);
    const body = await readJson(request);
    const name = requireString(body, "name", { min: 1, max: 120 });
    const slug = requireSlug(
      requireString(body, "slug", { min: 1, max: 120 }),
      "slug",
    );
    // cid IS the slug — a category is identified by its slug (single source of
    // truth). Display changes use `name`; the slug/cid is the stable key.
    const cid = slug;
    const dup = await env.DB.prepare("SELECT id FROM categories WHERE id = ?")
      .bind(cid)
      .first<{ id: string }>();
    if (dup) {
      throw new HttpError(
        409,
        "category_exists",
        "A category with this slug already exists.",
      );
    }
    const now = nowIso();
    await env.DB.prepare(
      "INSERT INTO categories (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(cid, name, slug, now, now)
      .run();
    return json({ cid, name, slug }, { status: 201 });
  }
  throw new HttpError(405, "method_not_allowed", "Method is not allowed.");
}

async function categoryDetail(
  request: Request,
  env: Env,
  user: AuthUser,
  cidParam: string,
): Promise<Response> {
  requireAdmin(user);
  const cid = requireSlug(cidParam, "cid");

  if (request.method === "PUT") {
    const body = await readJson(request);
    const name = requireString(body, "name", { min: 1, max: 120 });
    // slug is the stable key (cid === slug) and is NOT editable here — only the
    // display name changes. Renaming the slug would
    // move the cid and orphan article links; to rename, delete + recreate.
    const now = nowIso();
    const row = await env.DB.prepare("SELECT id FROM categories WHERE id = ?")
      .bind(cid)
      .first<{ id: string }>();
    if (!row) {
      throw new HttpError(404, "category_not_found", "Category was not found.");
    }
    await env.DB.prepare(
      "UPDATE categories SET name = ?, updated_at = ? WHERE id = ?",
    )
      .bind(name, now, cid)
      .run();
    await logActivity(env, user, "category.update", "category", cid, {
      cid,
      slug: cid,
    });
    return json({ ok: true, cid, name, slug: cid, updatedAt: now });
  }

  if (request.method === "DELETE") {
    const usage = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM document_categories WHERE cid = ?",
    )
      .bind(cid)
      .first<{ count: number }>();
    if (Number(usage?.count ?? 0) > 0) {
      throw new HttpError(
        409,
        "category_in_use",
        "This category is used by existing documents.",
      );
    }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM categories WHERE id = ?").bind(cid),
    ]);
    await logActivity(env, user, "category.delete", "category", cid, { cid });
    return json({ ok: true, cid });
  }

  throw new HttpError(405, "method_not_allowed", "Method is not allowed.");
}

async function languages(
  request: Request,
  env: Env,
  user: AuthUser,
): Promise<Response> {
  requireAdmin(user);

  if (request.method === "GET") {
    const result = await env.DB.prepare(
      `SELECT
        ti.id AS lang,
        ti.name AS display_name,
        ti.created_at,
        ti.updated_at,
        (SELECT COUNT(*) FROM document_translations dt WHERE dt.lang = ti.id) AS document_count,
        (SELECT COUNT(*) FROM search_entries se WHERE se.lang = ti.id) AS search_count
       FROM taxonomy_items ti
       WHERE ti.kind = 'language'
       ORDER BY ti.id`,
    ).all<ManagedLanguageRow>();
    const rows = (result.results ?? []).map((row) => ({
      lang: row.lang,
      displayName: row.display_name ?? "",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      usage: {
        documents: Number(row.document_count ?? 0),
        searchEntries: Number(row.search_count ?? 0),
      },
    }));
    return json({ languages: rows });
  }

  if (request.method === "POST") {
    const body = await readJson(request);
    const lang = requireString(body, "lang", { min: 2, max: 20 }).toLowerCase();
    validateLanguage(lang, "lang");
    const displayName = optionalString(body, "displayName") ?? "";
    const now = nowIso();
    await env.DB.prepare(
      `INSERT INTO taxonomy_items (id, kind, lang, name, created_at, updated_at)
       VALUES (?, 'language', '', ?, ?, ?)
       ON CONFLICT(id, kind, lang) DO UPDATE SET
         name = excluded.name,
         updated_at = excluded.updated_at`,
    )
      .bind(lang, displayName || lang, now, now)
      .run();
    await logActivity(env, user, "language.upsert", "language", lang, {
      lang,
      displayName,
    });
    return json({ ok: true, lang, displayName }, { status: 201 });
  }

  throw new HttpError(405, "method_not_allowed", "Method is not allowed.");
}

async function deleteLanguage(
  env: Env,
  user: AuthUser,
  lang: string,
  url: URL,
): Promise<Response> {
  requireAdmin(user);
  const safeLang = lang.trim().toLowerCase();
  validateLanguage(safeLang, "lang");
  const purgeData = url.searchParams.get("purgeData") === "1";

  const statements = [
    env.DB.prepare(
      "DELETE FROM taxonomy_items WHERE id = ? AND kind = 'language'",
    ).bind(safeLang),
  ];
  if (purgeData) {
    statements.push(
      env.DB.prepare("DELETE FROM document_translations WHERE lang = ?").bind(
        safeLang,
      ),
      env.DB.prepare("DELETE FROM search_entries WHERE lang = ?").bind(
        safeLang,
      ),
    );
  }
  await env.DB.batch(statements);
  await logActivity(env, user, "language.delete", "language", safeLang, {
    purgeData,
  });
  return json({ ok: true, lang: safeLang, purgeData });
}

function optionalIsoTimestamp(
  body: Record<string, unknown>,
  key: string,
): string | null {
  const value = optionalString(body, key);
  if (value === null) return null;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new HttpError(
      400,
      "invalid_timestamp",
      `${key} must be an ISO 8601 date-time with a timezone.`,
    );
  }
  return new Date(value).toISOString();
}

/** Query-string counterpart of optionalIsoTimestamp. Accepts a bare date
 *  (`2026-08-01` → start of that UTC day) too, since a date is the natural
 *  thing to type into a `?updatedSince=` filter. */
function queryIsoTimestamp(url: URL, key: string): string | null {
  const value = url.searchParams.get(key)?.trim();
  if (!value) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value;
  if (!Number.isFinite(Date.parse(iso))) {
    throw new HttpError(
      400,
      "invalid_timestamp",
      `${key} must be an ISO 8601 date-time (or a YYYY-MM-DD date).`,
    );
  }
  return new Date(iso).toISOString();
}

/** Bounded integer query param (`?limit=20`). Returns null when absent. */
function queryInt(
  url: URL,
  key: string,
  min: number,
  max: number,
): number | null {
  const raw = url.searchParams.get(key)?.trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(
      400,
      "invalid_field",
      `${key} must be an integer between ${min} and ${max}.`,
    );
  }
  return n;
}

async function updateContentTimestamps(
  request: Request,
  env: Env,
  user: AuthUser,
  did: string,
  lang?: string,
): Promise<Response> {
  if (request.method !== "PUT") {
    throw new HttpError(405, "method_not_allowed", "Method is not allowed.");
  }
  requireAuthor(user);
  const body = await readJson(request);
  const createdAt = optionalIsoTimestamp(body, "createdAt");
  const updatedAt = optionalIsoTimestamp(body, "updatedAt");
  if (createdAt === null && updatedAt === null) {
    throw new HttpError(
      400,
      "missing_timestamp",
      "createdAt or updatedAt is required.",
    );
  }

  if (lang) {
    const result = await env.DB.prepare(
      `UPDATE document_translations
       SET created_at = COALESCE(?, created_at),
           updated_at = COALESCE(?, updated_at),
           updated_by = ?
       WHERE did = ? AND lang = ?`,
    )
      .bind(createdAt, updatedAt, user.uid, did, lang)
      .run();
    if (!result.meta.changes) {
      throw new HttpError(
        404,
        "translation_not_found",
        "Translation was not found.",
      );
    }
    const row = await env.DB.prepare(
      "SELECT created_at, updated_at FROM document_translations WHERE did = ? AND lang = ?",
    )
      .bind(did, lang)
      .first<{ created_at: string; updated_at: string }>();
    await logActivity(
      env,
      user,
      "translation.timestamps.update",
      "document",
      did,
      {
        lang,
        createdAt,
        updatedAt,
      },
    );
    return json({
      ok: true,
      did,
      lang,
      createdAt: row?.created_at ?? createdAt,
      updatedAt: row?.updated_at ?? updatedAt,
    });
  }

  const result = await env.DB.prepare(
    `UPDATE documents
     SET created_at = COALESCE(?, created_at),
         updated_at = COALESCE(?, updated_at),
         updated_by = ?
     WHERE did = ?`,
  )
    .bind(createdAt, updatedAt, user.uid, did)
    .run();
  if (!result.meta.changes) {
    throw new HttpError(404, "document_not_found", "Document was not found.");
  }
  const row = await env.DB.prepare(
    "SELECT created_at, updated_at FROM documents WHERE did = ?",
  )
    .bind(did)
    .first<{ created_at: string; updated_at: string }>();
  await logActivity(env, user, "document.timestamps.update", "document", did, {
    createdAt,
    updatedAt,
  });
  return json({
    ok: true,
    did,
    createdAt: row?.created_at ?? createdAt,
    updatedAt: row?.updated_at ?? updatedAt,
  });
}

/** Resolve a globally-unique slug to its did (404 when no such document). */
async function resolveDidBySlug(env: Env, slug: string): Promise<string> {
  const row = await env.DB.prepare("SELECT did FROM documents WHERE slug = ?")
    .bind(decodeURIComponent(slug))
    .first<{ did: string }>();
  if (!row) {
    throw new HttpError(
      404,
      "document_not_found",
      `No document with slug "${slug}".`,
    );
  }
  return row.did;
}

// A did is `doc_` + 12 hex (see makeId). Slugs can never contain `_`
// (requireSlug = [a-z0-9-] only), so a path segment matching this is
// unambiguously a did, otherwise it is a slug. This lets `/api/documents/:id`
// accept EITHER a did or a slug with zero ambiguity.
const DID_RE = /^doc_[0-9a-f]{12}$/;

/** Resolve a `:id` path segment (did OR globally-unique slug) to a did. */
async function resolveDid(env: Env, idOrSlug: string): Promise<string> {
  if (DID_RE.test(idOrSlug)) return idOrSlug;
  return resolveDidBySlug(env, idOrSlug);
}

async function documents(
  request: Request,
  env: Env,
  user: AuthUser,
  url: URL,
): Promise<Response> {
  if (request.method === "GET") {
    const query = url.searchParams.get("q")?.trim() ?? "";
    // Preferred display language for the list title (the admin UI language).
    // Title falls back: requested lang → the document's base language
    // (initial_lang) → any (so the base-language title isn't hidden just because
    // another translation sorts earlier alphabetically).
    const displayLang = url.searchParams.get("lang")?.trim() ?? "";
    // ── Server-side filters ───────────────────────────────────────────────
    // The unfiltered list is the admin article table's data source, so it stays
    // (newest-updated first, capped at 1000). Everything below exists so a REST
    // / MCP client can ask for the few rows it actually wants instead of pulling
    // the whole catalogue and filtering client-side:
    //   ?slug=a,b   exact slug(s) — ?q= is a LIKE substring match, not this
    //   ?tid=       article type
    //   ?mode= / ?live=   publish FLAG state / last built state (0|1)
    //   ?updatedSince= / ?updatedUntil=   updated_at window (ISO or YYYY-MM-DD)
    //   ?limit= / ?offset=                paging (limit 1..1000)
    //   ?fields=slug,updated_at           trim the response to these keys
    // datetime() on both sides so imported rows stored as "YYYY-MM-DD HH:MM:SS"
    // compare correctly against an ISO bound.
    const slugs = (url.searchParams.get("slug") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 100);
    const tid = url.searchParams.get("tid")?.trim() ?? "";
    const updatedSince = queryIsoTimestamp(url, "updatedSince");
    const updatedUntil = queryIsoTimestamp(url, "updatedUntil");
    const limit = queryInt(url, "limit", 1, 1000) ?? 1000;
    const offset = queryInt(url, "offset", 0, 1000000) ?? 0;
    const flagFilter = (key: "mode" | "live"): number | null => {
      const raw = url.searchParams.get(key)?.trim();
      if (!raw) return null;
      if (raw !== "0" && raw !== "1") {
        throw new HttpError(400, "invalid_field", `${key} must be 0 or 1.`);
      }
      return Number(raw);
    };
    const modeFilter = flagFilter("mode");
    const liveFilter = flagFilter("live");

    const conds: string[] = [];
    const filterBinds: (string | number)[] = [];
    if (query) {
      conds.push("(d.slug LIKE ? OR dt.title LIKE ?)");
      filterBinds.push(`%${query}%`, `%${query}%`);
    }
    if (slugs.length) {
      conds.push(`d.slug IN (${slugs.map(() => "?").join(",")})`);
      filterBinds.push(...slugs);
    }
    if (tid) {
      conds.push("d.tid = ?");
      filterBinds.push(tid);
    }
    if (modeFilter !== null) {
      conds.push("d.mode = ?");
      filterBinds.push(modeFilter);
    }
    if (liveFilter !== null) {
      conds.push("d.live = ?");
      filterBinds.push(liveFilter);
    }
    if (updatedSince) {
      conds.push("datetime(d.updated_at) >= datetime(?)");
      filterBinds.push(updatedSince);
    }
    if (updatedUntil) {
      conds.push("datetime(d.updated_at) <= datetime(?)");
      filterBinds.push(updatedUntil);
    }
    // ?lastEditSource=mcp,api — 「今の本文を最後に書いたのが AI の記事」を
    // 1 回で洗い出すためのフィルタ。どれか 1 言語でも該当すれば拾う
    // （被害の見落としより、確認対象が少し増える方を選ぶ）。'unknown' は
    // 記録が始まる前から更新されていない翻訳。
    const lastEditSources = (url.searchParams.get("lastEditSource") ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    if (lastEditSources.length) {
      const named = lastEditSources.filter((v) => v !== "unknown");
      const parts: string[] = [];
      if (named.length) {
        parts.push(`dt2.source IN (${named.map(() => "?").join(",")})`);
        filterBinds.push(...named);
      }
      if (lastEditSources.includes("unknown")) parts.push("dt2.source IS NULL");
      conds.push(
        `EXISTS (SELECT 1 FROM document_translations dt2
                  WHERE dt2.did = d.did AND (${parts.join(" OR ")}))`,
      );
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const bindings: (string | number)[] = [
      displayLang,
      ...filterBinds,
      limit,
      offset,
    ];
    const result = await env.DB.prepare(
      `SELECT
        d.*,
        COALESCE(
          (SELECT title FROM document_translations WHERE did = d.did AND lang = ?),
          (SELECT title FROM document_translations WHERE did = d.did AND lang = d.initial_lang),
          MIN(dt.title)
        ) AS title,
        GROUP_CONCAT(dt.lang) AS languages,
        (SELECT GROUP_CONCAT(cid) FROM document_categories WHERE did = d.did) AS category_ids,
        (SELECT GROUP_CONCAT(COALESCE(c.name, dc.cid))
           FROM document_categories dc
           LEFT JOIN categories c ON c.id = dc.cid
          WHERE dc.did = d.did) AS category_names,
        -- 言語ごとの「今の本文を最後に書いた側」。"ja=mcp,en=admin" の形。
        (SELECT GROUP_CONCAT(dt3.lang || '=' || COALESCE(dt3.source, 'unknown'))
           FROM document_translations dt3
          WHERE dt3.did = d.did) AS last_edit_sources
      FROM documents d
      LEFT JOIN document_translations dt ON dt.did = d.did
      ${where}
      GROUP BY d.did
      ORDER BY d.updated_at DESC
      LIMIT ? OFFSET ?`,
    )
      .bind(...bindings)
      .all<DocumentRow>();
    // ?fields= trims each row to the requested keys (unknown names ignored; an
    // all-unknown list is treated as "no trimming" rather than empty objects).
    const wanted = new Set(
      (url.searchParams.get("fields") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    let rows = (result.results ?? []) as unknown as Array<
      Record<string, unknown>
    >;
    if (wanted.size) {
      const trimmed = rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).filter(([key]) => wanted.has(key)),
        ),
      );
      if (trimmed.some((row) => Object.keys(row).length)) rows = trimmed;
    }
    return json({ documents: rows as unknown as JsonValue });
  }

  if (request.method === "POST") {
    requireAuthor(user);
    const body = await readJson(request);
    const tid = requireSlug(
      requireString(body, "tid", { min: 1, max: 80 }),
      "tid",
    );
    const slug = requireSlug(
      requireString(body, "slug", { min: 1, max: 120 }),
      "slug",
    );
    // Reserve the did shape (`doc_<hex>`) so a slug can never be mistaken for a
    // did in the did-OR-slug routing. requireSlug already forbids `_`, so this is
    // defense-in-depth that keeps the routing disambiguation valid even if the
    // slug rules ever loosen.
    if (DID_RE.test(slug) || slug.startsWith("doc_")) {
      throw new HttpError(
        400,
        "slug_reserved",
        'Slug must not start with "doc_" (reserved for document IDs).',
      );
    }
    const initialLang = requireString(body, "initialLang", { min: 2, max: 20 });
    const fallbackLang = optionalString(body, "fallbackLang") ?? initialLang;
    const unpublishAt = optionalString(body, "unpublishAt") ?? null;
    const requestedCreatedAt = optionalIsoTimestamp(body, "createdAt");
    const requestedUpdatedAt = optionalIsoTimestamp(body, "updatedAt");

    // Reject an unregistered type so REST/AI clients can't create orphan
    // articles whose tid the editor can't represent.
    const typeRow = await env.DB.prepare(
      "SELECT id FROM taxonomy_items WHERE id = ? AND kind = 'type'",
    )
      .bind(tid)
      .first();
    if (!typeRow) {
      throw new HttpError(
        400,
        "invalid_type",
        `Type "${tid}" is not registered.`,
      );
    }

    // POST is CREATE-ONLY: slug is globally unique, so an existing slug is a
    // conflict (409). Updates go through PUT /api/documents/:slug (and
    // .../translations/:lang), which accept the slug directly.
    const existing = await env.DB.prepare(
      "SELECT did FROM documents WHERE slug = ?",
    )
      .bind(slug)
      .first<{ did: string }>();
    if (existing) {
      throw new HttpError(
        409,
        "slug_exists",
        `Slug "${slug}" is already in use. Use PUT /api/documents/${slug} to update it.`,
      );
    }

    const now = nowIso();
    // Auto-register the base/fallback languages so a REST-posted article is
    // immediately representable (idempotent — DO NOTHING on conflict).
    const langStmts = [registerLanguageStatement(env, initialLang, now)];
    if (fallbackLang && fallbackLang !== initialLang)
      langStmts.push(registerLanguageStatement(env, fallbackLang, now));

    // Create a fresh draft document (mode 0).
    const did = makeId("doc");
    const createdAt = requestedCreatedAt ?? now;
    const updatedAt = requestedUpdatedAt ?? createdAt;
    const publishAt = optionalString(body, "publishAt") ?? now;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO documents
          (did, slug, tid, mode, initial_lang, fallback_lang, publish_at, unpublish_at,
           created_at, updated_at, created_by, updated_by)
        VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        did,
        slug,
        tid,
        initialLang,
        fallbackLang,
        publishAt,
        unpublishAt,
        createdAt,
        updatedAt,
        user.uid,
        user.uid,
      ),
      ...langStmts,
    ]);

    await logActivity(env, user, "document.create", "document", did, {
      tid,
      slug,
    });
    return json(
      {
        did,
        tid,
        slug,
        initialLang,
        fallbackLang,
        publishAt,
        unpublishAt,
        createdAt,
        updatedAt,
        created: true,
      },
      { status: 201 },
    );
  }

  throw new HttpError(405, "method_not_allowed", "Method is not allowed.");
}

async function documentCategories(
  request: Request,
  env: Env,
  user: AuthUser,
  did: string,
  ctx?: ExecutionContext,
): Promise<Response> {
  if (request.method === "GET") {
    const rows = await env.DB.prepare(
      "SELECT cid FROM document_categories WHERE did = ? ORDER BY cid",
    )
      .bind(did)
      .all<{ cid: string }>();
    return json({ categories: (rows.results ?? []).map((r) => r.cid) });
  }
  if (request.method === "PUT") {
    requireAuthor(user);
    const body = await readJson(request);
    const cats = Array.isArray(body.categories)
      ? ((body.categories as unknown[]).filter(
          (c) => typeof c === "string",
        ) as string[])
      : [];
    // Change detection: the editor PUTs categories on EVERY save, so only a
    // real assignment change may bump documents.updated_at below — otherwise
    // every metadata autosave would dirty the build hashes for nothing.
    const existingRows = await env.DB.prepare(
      "SELECT cid FROM document_categories WHERE did = ? ORDER BY cid",
    )
      .bind(did)
      .all<{ cid: string }>();
    const before = (existingRows.results ?? []).map((r) => r.cid).join(",");
    const after = [...new Set(cats)].sort().join(",");
    const categoriesChanged = before !== after;
    // metaChanged: the editor's doSave() always PUTs documents → translations
    // → categories as one logical save, and this is the LAST of the three —
    // so it's the one that fires the single consolidated build once mode/
    // translations are already committed (see the deferBuild comments in
    // documentDetail/documentTranslations). The editor sets this when either
    // of those earlier PUTs actually changed something, so a save that only
    // touches the cover/body (categories untouched) still triggers a build.
    const metaChanged = body.metaChanged === true;
    if (!categoriesChanged && !metaChanged) {
      return json({ ok: true, changed: false });
    }
    if (categoriesChanged) {
      await env.DB.prepare("DELETE FROM document_categories WHERE did = ?")
        .bind(did)
        .run();
      for (const cid of cats) {
        await env.DB.prepare(
          "INSERT OR IGNORE INTO document_categories (did, cid) VALUES (?, ?)",
        )
          .bind(did, cid)
          .run();
      }
      // Category assignments live only in document_categories, which no build
      // signature reads — without this bump the article page and the listings
      // (whose cards show the category chips) never become build targets after
      // a category change. documents.updated_at feeds the article-page hash and
      // the type/home listing hashes.
      await env.DB.prepare("UPDATE documents SET updated_at = ? WHERE did = ?")
        .bind(nowIso(), did)
        .run();
    }
    // Immediate refresh of the LIVE article's pages (chips render there). Runs
    // AFTER the assignment is committed, so it can't build stale data. Gated on
    // live (not mode): a flagged-but-unbuilt article must not be published as a
    // side effect of a category edit — buildDocumentPages no-ops on live=0
    // anyway, so this check just saves the wasted invocation.
    if (ctx) {
      const doc = await env.DB.prepare(
        "SELECT live FROM documents WHERE did = ?",
      )
        .bind(did)
        .first<{ live: number }>();
      if (doc?.live === 1) {
        ctx.waitUntil(
          buildDocumentPages(env, did).catch(() => {
            /* non-fatal: full build will reconcile */
          }),
        );
      }
    }
    return json({ ok: true, changed: categoriesChanged });
  }
  throw new HttpError(405, "method_not_allowed", "Method is not allowed.");
}

async function documentDetail(
  request: Request,
  env: Env,
  user: AuthUser,
  did: string,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method === "GET") {
    const document = await env.DB.prepare(
      "SELECT * FROM documents WHERE did = ?",
    )
      .bind(did)
      .first();
    if (!document) {
      throw new HttpError(404, "document_not_found", "Document was not found.");
    }
    const translations = await env.DB.prepare(
      "SELECT lang, title, summary, body_html, updated_at FROM document_translations WHERE did = ? ORDER BY lang",
    )
      .bind(did)
      .all<{
        lang: string;
        title: string | null;
        summary: string | null;
        body_html: string | null;
        updated_at: string | null;
      }>();
    // body_html: AI/REST が編集前に本文を読むため (data-bid 込み)。
    // body_hash: その版のキー。次回 update の baseBodyHash にそのまま渡すと、
    //            他クライアントと交錯した場合にサーバーがブロック単位で 3-way
    //            マージする (C4)。
    const rows = await Promise.all(
      translations.results.map(async (r) => ({
        ...r,
        body_hash: r.body_html ? await sha256Hex(r.body_html) : null,
      })),
    );
    return json({
      document: document as JsonValue,
      translations: rows as JsonValue,
    });
  }

  if (request.method === "PUT") {
    requireAuthor(user);
    const body = await readJson(request);
    const modeValue = body.mode;
    if (typeof modeValue !== "number" || ![0, 1, 2].includes(modeValue)) {
      throw new HttpError(400, "invalid_mode", "mode must be 0, 1, or 2.");
    }
    const existing = await env.DB.prepare(
      "SELECT tid, slug, mode, publish_at, unpublish_at FROM documents WHERE did = ?",
    )
      .bind(did)
      .first<{
        tid: string;
        slug: string;
        mode: number;
        publish_at: string | null;
        unpublish_at: string | null;
      }>();
    if (!existing) {
      throw new HttpError(404, "document_not_found", "Document was not found.");
    }
    const publishAt = optionalString(body, "publishAt");
    // unpublishAt is PARTIAL like publishAt: omitted = keep the stored value
    // (so an editor save can never wipe an expiry set via REST/MCP); explicit
    // null/"" = clear it.
    const unpublishAt =
      body.unpublishAt === undefined
        ? existing.unpublish_at
        : optionalString(body, "unpublishAt");
    // tid is optional (the article type). A change is validated against the
    // registered types, mirrored into search_entries, and the OLD type's pages
    // are cleaned up/rebuilt below (the article's public URL contains the tid).
    const inputTid = optionalString(body, "tid");
    let tid = existing.tid;
    if (inputTid && inputTid !== existing.tid) {
      tid = requireSlug(inputTid, "tid");
      const typeRow = await env.DB.prepare(
        "SELECT id FROM taxonomy_items WHERE id = ? AND kind = 'type'",
      )
        .bind(tid)
        .first();
      if (!typeRow) {
        throw new HttpError(
          400,
          "invalid_type",
          `Type "${tid}" is not registered.`,
        );
      }
    }
    const tidChanged = tid !== existing.tid;
    // No-op guard: the editor PUTs {mode, publishAt, tid} on EVERY save. When
    // nothing actually changed, skip the write entirely — otherwise every save
    // bumps documents.updated_at (dirtying the article/listing/monthly build
    // hashes for nothing), spams the activity log, and re-triggers the
    // immediate page build below.
    const docChanged =
      tidChanged ||
      modeValue !== existing.mode ||
      (publishAt !== null && publishAt !== existing.publish_at) ||
      (unpublishAt || null) !== (existing.unpublish_at || null);
    if (!docChanged) {
      return json({ ok: true, changed: false });
    }
    const statements = [
      env.DB.prepare(
        `UPDATE documents
         SET tid = ?, mode = ?, publish_at = COALESCE(?, publish_at), unpublish_at = ?, updated_at = ?, updated_by = ?
         WHERE did = ?`,
      ).bind(tid, modeValue, publishAt, unpublishAt, nowIso(), user.uid, did),
    ];
    if (tidChanged) {
      statements.push(
        env.DB.prepare("UPDATE search_entries SET tid = ? WHERE did = ?").bind(
          tid,
          did,
        ),
      );
    }
    await env.DB.batch(statements);
    await logActivity(env, user, "document.update", "document", did, {
      mode: modeValue,
      ...(tidChanged ? { tid, previousTid: existing.tid } : {}),
    });
    // The publish flag (mode) and the type/publish-window fields are pure
    // STATE — this endpoint deliberately triggers NO page generation and NO KV
    // deletion. Flag changes only take effect when a build materializes them
    // into documents.live: the manual "Build now", the auto-build cron (which
    // detects the resulting mode/live disagreement), or the explicit
    // single-document POST /api/documents/:did/build. Until then the public
    // site keeps serving exactly what the last build published.
    //
    // SNS posting is decoupled from publishing: articles publish without touching
    // SNS. Posting to Bluesky is an explicit action via the "投稿" button
    // (POST /api/documents/:did/sns/bsky/post → postDocumentToBluesky).
    return json({ ok: true, changed: true });
  }

  if (request.method === "DELETE") {
    requireAdmin(user);
    // Read the row BEFORE deleting: the public page cleanup below needs the
    // tid/slug (the URL) and publish info, and the row is gone afterwards.
    const doc = await env.DB.prepare(
      "SELECT tid, slug, mode, publish_at FROM documents WHERE did = ?",
    )
      .bind(did)
      .first<{
        tid: string;
        slug: string;
        mode: number;
        publish_at: string | null;
      }>();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM document_categories WHERE did = ?").bind(did),
      env.DB.prepare("DELETE FROM search_entries WHERE did = ?").bind(did),
      env.DB.prepare(
        "DELETE FROM document_translation_revisions WHERE did = ?",
      ).bind(did),
      env.DB.prepare("DELETE FROM document_translations WHERE did = ?").bind(
        did,
      ),
      env.DB.prepare("DELETE FROM documents WHERE did = ?").bind(did),
    ]);
    await logActivity(env, user, "document.delete", "document", did, {});
    // Remove the article's static page from KV (serving prefers KV, so a stale
    // bundle would keep the deleted article's URL alive) and refresh the index
    // pages it appeared on. Non-fatal: a full build reconciles the indexes,
    // though only this cleanup removes the detail page itself.
    if (doc) {
      ctx.waitUntil(
        (async () => {
          await deleteArticlePages(env, doc.tid, doc.slug);
          if (doc.mode === 1) {
            await rebuildIndexPages(env, [doc.tid], doc.publish_at);
          }
        })().catch(() => {
          /* non-fatal */
        }),
      );
    }
    return json({ ok: true });
  }

  throw new HttpError(405, "method_not_allowed", "Method is not allowed.");
}

// ─── Revision body sharing ────────────────────────────────────────────────────
// Revisions are FULL-TEXT snapshots (see the /revisions endpoint docs), and a
// save only has to change SOMETHING to trigger one: editing the summary, the
// hashtags, the cover, or a metadata autosave all snapshot the body again even
// when the body itself is byte-identical. Measured on a real install: 2,975
// revisions held only 1,861 distinct bodies — a third of the bytes were exact
// duplicates.
//
// So a body is stored ONCE per (did, lang, content). Any later revision whose
// body is unchanged stores `body_html = ''` and carries the SAME body_hash,
// which points at the sibling revision that owns the text. Chosen over a
// separate bodies table because it needs NO schema change (body_hash already
// exists), keeps backup/restore working unchanged (the dump is still a plain
// row dump, and an old backup with full bodies everywhere restores fine), and
// leaves every row independently deletable — deleting a document still drops
// its whole history in one statement.
//
// INVARIANT: for every (did, lang, body_hash) at least one row keeps the text.
// Never delete a row that owns a body while a sharer still points at it — the
// only bulk delete is per-document, which removes owners and sharers together.
const SHARED_BODY = "";

/** HTML から表示テキストだけを取り出して `max` 文字に切る（履歴一覧の説明文用。
 *  切り詰めの見せ方は UI 側の責務なので、ここでは省略記号を足さない）。 */
function plainExcerpt(html: string | null, max: number): string {
  return decodeBasicEntities(String(html ?? "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Correlated sub-select returning the body owned by the sibling revision that
 *  the row aliased `alias` shares (NULL when the row owns its body itself). */
function ownerBodySql(alias: string): string {
  return `(SELECT o.body_html FROM document_translation_revisions o
            WHERE o.did = ${alias}.did AND o.lang = ${alias}.lang
              AND o.body_hash = ${alias}.body_hash AND o.body_html <> ''
            ORDER BY o.revision_no LIMIT 1)`;
}

/** Where a write came from. The MACHINE-vs-HUMAN split is derived from the AUTH
 *  MECHANISM, so it cannot be spoofed by a header: a PAT is always machine
 *  traffic, a session cookie is always a signed-in human in the admin UI. The
 *  headers only refine WITHIN each family (a client faking one can at worst
 *  mislabel itself as its own sibling).
 *    api | mcp         — PAT. `mcp` is set by the MCP server on the internal
 *                        request it dispatches (src/mcp.ts).
 *    admin | autosave  — session. `autosave` is set by the admin editor when
 *                        the save came from a TIMER rather than a click.
 *  Server-side sweeps pass "maintenance" directly. Returns null when the actor
 *  is unknown — never guesses. */
type WriteSource =
  | "api"
  | "mcp"
  | "admin"
  | "autosave"
  | "maintenance"
  | "import";

function writeSource(request: Request, user: AuthUser): WriteSource | null {
  if (user.authSource === "pat") {
    return request.headers.get("x-kurocms-client") === "mcp" ? "mcp" : "api";
  }
  if (user.authSource === "session") {
    return request.headers.get("x-kurocms-save") === "auto"
      ? "autosave"
      : "admin";
  }
  return null;
}

/**
 * Build an INSERT statement that snapshots the CURRENT translation row (if one
 * exists) into document_translation_revisions, with the next sequential
 * revision_no. Returns null when there is no existing row to snapshot. The
 * caller includes the returned statement in a batch run BEFORE the overwrite/
 * delete so edits are recoverable.
 *
 * When an earlier revision of the same translation already holds this exact
 * body, the new row shares it instead of storing a second copy (see above).
 */
async function snapshotTranslationStatement(
  env: Env,
  did: string,
  lang: string,
  snapshotBy: string,
  /** Who is performing the write that DISPLACES this version (stored as
   *  replaced_by). The version's own author is carried over from the
   *  translation row — see the column comments in migration 0064. */
  replacedBy: WriteSource | null,
): Promise<D1PreparedStatement | null> {
  const existing = await env.DB.prepare(
    `SELECT title, summary, body_html, seo_json, hashtag_json, source
     FROM document_translations WHERE did = ? AND lang = ?`,
  )
    .bind(did, lang)
    .first<{
      title: string;
      summary: string | null;
      body_html: string;
      seo_json: string | null;
      hashtag_json: string | null;
      source: string | null;
    }>();
  if (!existing) return null;
  // 3-way マージの base 検索キー (baseBodyHash → この版のリビジョン) 兼、
  // 本文使い回しの同一性キー。
  const bodyHash = await sha256Hex(existing.body_html);
  const [maxRow, ownerRow] = await Promise.all([
    env.DB.prepare(
      `SELECT MAX(revision_no) AS n FROM document_translation_revisions
       WHERE did = ? AND lang = ?`,
    )
      .bind(did, lang)
      .first<{ n: number | null }>(),
    // An empty body can't be shared: '' is also the sharing marker, so a
    // genuinely empty body must stay literal (it costs nothing anyway).
    existing.body_html === SHARED_BODY
      ? Promise.resolve(null)
      : env.DB.prepare(
          `SELECT revision_id FROM document_translation_revisions
            WHERE did = ? AND lang = ? AND body_hash = ? AND body_html <> ''
            LIMIT 1`,
        )
          .bind(did, lang, bodyHash)
          .first<{ revision_id: string }>(),
  ]);
  const nextNo = (maxRow?.n ?? 0) + 1;
  return env.DB.prepare(
    `INSERT INTO document_translation_revisions
       (revision_id, did, lang, revision_no, title, summary, body_html,
        seo_json, hashtag_json, snapshot_at, snapshot_by, body_hash, source,
        replaced_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    makeId("rev"),
    did,
    lang,
    nextNo,
    existing.title,
    existing.summary,
    ownerRow ? SHARED_BODY : existing.body_html,
    existing.seo_json,
    existing.hashtag_json,
    nowIso(),
    snapshotBy,
    bodyHash,
    // この版の本文を「書いた」側。復旧はこの列で人間の版を選ぶので、
    // 「上書きした側」(replacedBy) と決して混ぜない。
    existing.source,
    replacedBy,
  );
}

/**
 * THE write path for a translation's content. Everything that stores article
 * text goes through here — the REST/MCP upsert and both bulk importers — so the
 * invariants hold no matter who writes:
 *   - 本文は正規化してから保存する（綴りのブレを持ち込ませない）
 *   - トップレベルブロックに data-bid を採番する（3-way マージの前提。C3）
 *   - RecipeCard を検証する（壊れたカードを本文経由で持ち込ませない）
 *   - 上書き前に必ず履歴へスナップショットを取る（復旧できる）
 *   - source を記録する（誰が書いた本文かが後から分かる）
 *   - search_entries を同期する（検索が本文から取り残されない）
 * 以前はインポータだけがこの経路を通らず直接 upsert していて、正規化も
 * data-bid も履歴も無いまま既存記事を潰していた。
 *
 * 呼び出し側に残すのは HTTP 都合（楽観ロック・3-way マージ・ビルド発火）だけ。
 * `bodyHtml` は正規化前の生の HTML を渡すこと。
 */
async function writeTranslationContent(
  env: Env,
  args: {
    did: string;
    lang: string;
    tid: string;
    title: string;
    summary: string | null;
    bodyHtml: string;
    seoJson: string;
    hashtagJson: string;
    actorUid: string;
    source: WriteSource | null;
    createdAt: string;
    updatedAt: string;
    /** 追加で同じバッチに入れたい文（インポータの documents 更新など）。 */
    extraStatements?: D1PreparedStatement[];
    /** 既定 true。PUT は 3-way マージ後の最終形を渡すので false にする
     *  （本文を送らないメタだけの保存で、保存済みの古い綴りを黙って書き換えて
     *  しまわないため）。 */
    normalizeBody?: boolean;
    /** 既定 true。PUT は「本文が送られたときだけ検証する」既存の挙動を保つ
     *  ため自前で判定して渡す（既存の壊れたカードでメタ保存が 422 になるのを
     *  避ける）。 */
    validateRecipe?: boolean;
  },
): Promise<{ bodyHtml: string }> {
  const bodyHtml =
    args.normalizeBody === false
      ? args.bodyHtml
      : normalizeBlockIds(normalizeContentHtml(args.bodyHtml));
  if (args.validateRecipe !== false) {
    const check = checkRecipeCards(bodyHtml);
    if (check.errors.length) {
      throw new HttpError(422, "invalid_recipe_card", check.errors.join(" / "));
    }
  }
  const now = nowIso();
  const prevRevision = await snapshotTranslationStatement(
    env,
    args.did,
    args.lang,
    args.actorUid,
    args.source,
  );
  const statements: D1PreparedStatement[] = [];
  if (prevRevision) statements.push(prevRevision);
  statements.push(
    env.DB.prepare(
      // `source` = 今の本文を書いたのは誰か。次にこの行が上書きされるとき、
      // スナップショットがこの値を引き継ぐ（＝「その版を書いた側」になる）。
      // 保守系の一括処理はこの列を触らない（本文の綴りを直すだけで、著者を
      // 奪うわけではないため）— それらは document_translations を直接
      // UPDATE していて、ここは通らない。
      `INSERT INTO document_translations
        (did, lang, title, summary, body_html, seo_json, hashtag_json, created_at, updated_at, created_by, updated_by, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(did, lang) DO UPDATE SET
        title = excluded.title,
        summary = excluded.summary,
        body_html = excluded.body_html,
        seo_json = excluded.seo_json,
        hashtag_json = excluded.hashtag_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by,
        source = excluded.source`,
    ).bind(
      args.did,
      args.lang,
      args.title,
      args.summary,
      bodyHtml,
      args.seoJson,
      args.hashtagJson,
      args.createdAt,
      args.updatedAt,
      args.actorUid,
      args.actorUid,
      args.source,
    ),
    env.DB.prepare(
      `INSERT INTO search_entries
        (id, did, lang, tid, title, body_text, hashtag_text, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        body_text = excluded.body_text,
        hashtag_text = excluded.hashtag_text,
        updated_at = excluded.updated_at`,
    ).bind(
      `${args.did}:${args.lang}`,
      args.did,
      args.lang,
      args.tid,
      args.title,
      stripHtml(bodyHtml),
      args.hashtagJson,
      args.updatedAt,
    ),
    env.DB.prepare(
      "UPDATE documents SET updated_at = ?, updated_by = ? WHERE did = ?",
    ).bind(now, args.actorUid, args.did),
    // Strong retention: auto-register the language so REST/AI-posted
    // translations are never orphaned/invisible. Keeps an existing display
    // name untouched (only inserts when the language row is missing).
    registerLanguageStatement(env, args.lang, now),
    ...(args.extraStatements ?? []),
  );
  await env.DB.batch(statements);
  return { bodyHtml };
}

// ─── Copy-noise style cleanup (maintenance) ───────────────────────────────────
// Chrome のリッチコピーは、要素に効いているスタイル宣言をインライン style として
// クリップボードに焼き込む。管理画面のエディタ保護 CSS（.kuro-editor * の
// all: revert-layer 系）はこのとき数百個のロングハンド `<prop>: revert-layer` に
// 展開され、テンプレートのリンク色等も `color: oklch(…)` として焼き込まれる。
// KuroEditor 2.0.10+ はペースト時に除去する（_pasteSanitizedHTML）が、それ以前に
// 貼り付け保存された本文にはこのノイズが残っている。この掃除はその救済。

const NOISE_STYLE_VALUES = new Set([
  "revert-layer",
  "revert",
  "initial",
  "unset",
  "inherit",
]);
// ノイズ署名を持つ要素からは色系も剥がす（KuroEditor のペーストサニタイザと
// 同じ方針: コピー時に焼き込まれたテーマ色はダーク/ライト切替を壊す）。
const NOISE_COLOR_PROPS = new Set([
  "color",
  "background",
  "background-color",
  "background-image",
]);

/** `;` で宣言を分割する（url(data:…;base64,…) 等の括弧・引用符内は無視）。 */
function splitDeclarations(css: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (quote) {
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) {
      out.push(css.slice(start, i));
      start = i + 1;
    }
  }
  out.push(css.slice(start));
  return out;
}

/**
 * 1 本文からコピー由来のスタイルノイズを除去する。CSS-wide キーワード宣言を
 * 含む style 属性（＝Chrome コピーの署名）だけを対象に、①ノイズ宣言と
 * ②同じ属性内の色系宣言を落とす。署名の無い style 属性（ユーザーが装飾で
 * 意図的に付けた色・サイズ等）には一切触れない。
 */
function stripCopyNoiseStyles(html: string): string {
  if (!/revert-layer|:\s*revert\b/i.test(html)) return html;
  return html.replace(/\sstyle="([^"]*)"/gi, (whole, css: string) => {
    if (!/revert-layer|:\s*revert\b/i.test(css)) return whole;
    const kept = splitDeclarations(css)
      .map((d) => d.trim())
      .filter(Boolean)
      .filter((decl) => {
        const idx = decl.indexOf(":");
        if (idx < 0) return false;
        const prop = decl.slice(0, idx).trim().toLowerCase();
        const value = decl
          .slice(idx + 1)
          .trim()
          .toLowerCase();
        return !NOISE_STYLE_VALUES.has(value) && !NOISE_COLOR_PROPS.has(prop);
      });
    return kept.length ? ` style="${kept.join("; ")}"` : "";
  });
}

/** ごく基本的な HTML エンティティのデコード（リンク正規化のラベル/URL 用）。 */
function decodeBasicEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) =>
      String.fromCodePoint(parseInt(n, 10)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) =>
      String.fromCodePoint(parseInt(n, 16)),
    )
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * 保存済み本文のプレーンな外部リンク `<a href>テキスト</a>` を KuroEditor の
 * リンク記法トークン（[[url|text]] / text==url は [[url]]）へ正規化する。
 * KuroEditor 2.6.1 のペースト時正規化（normalizePastedLinks）の保存データ版で、
 * 変換対象の判定も同じ:
 *   - href が http(s) であること（mailto:/tel:/#・相対パスはプレーン維持）
 *   - リンク内がプレーンテキストのみ（子要素があると装飾が失われるため維持）
 *   - テキストが空でない・] を含まない、URL が ] / | を含まない
 *   - 属性が href/target/rel/style のみ（class/id 等を持つリンクは
 *     kuro-media-open-link のような機能マークアップの可能性があるため維持）
 */
function normalizePlainLinks(html: string): string {
  if (!/<a[\s>]/i.test(html)) return html;
  return html.replace(
    /<a\b([^>]*)>([^<]*)<\/a>/gi,
    (whole, attrs: string, inner: string) => {
      if (/data-kuro/i.test(attrs)) return whole;
      // 属性名の列挙は引用符付きの値を消費するパターンで行う（href の
      // クエリ文字列内の a=1 等を属性名と誤認しないため）。
      const attrNames = [
        ...attrs.matchAll(
          /([a-zA-Z][a-zA-Z0-9:_-]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g,
        ),
      ].map((m) => m[1].toLowerCase());
      if (
        attrNames.some((n) => !["href", "target", "rel", "style"].includes(n))
      ) {
        return whole;
      }
      const hrefM =
        attrs.match(/href\s*=\s*"([^"]*)"/i) ||
        attrs.match(/href\s*=\s*'([^']*)'/i);
      if (!hrefM) return whole;
      const url = decodeBasicEntities(hrefM[1]).trim();
      if (!/^https?:\/\//i.test(url)) return whole;
      if (/[\]|<>"]/.test(url)) return whole;
      const text = decodeBasicEntities(inner).replace(/\s+/g, " ").trim();
      if (!text || /[\]<>]/.test(text)) return whole;
      return text === url ? `[[${url}]]` : `[[${url}|${text}]]`;
    },
  );
}

/**
 * Maintenance sweep: reclaim the duplicated bodies that revisions written
 * BEFORE body sharing left behind (see SHARED_BODY). For every group of
 * revisions of the same translation holding byte-identical text, the oldest one
 * keeps the body and the rest are turned into sharers (`body_html = ''` + the
 * group's body_hash). The same pass backfills body_hash where it is NULL
 * (rows predating the column), which is what lets FUTURE snapshots recognise an
 * unchanged body and share it instead of storing another copy.
 *
 * Chunked like the other maintenance sweeps: at most MAX_GROUPS_PER_RUN groups
 * per invocation, `more: true` while work remains. Idempotent — a processed
 * group stops matching (its duplicates no longer have a body, its hashes are
 * set), so re-running is a no-op.
 */
async function dedupeRevisionBodies(
  env: Env,
  user: AuthUser,
): Promise<Response> {
  requireAdmin(user);
  const MAX_GROUPS_PER_RUN = 25;
  // Groups needing work: more than one copy of the body, or a missing hash.
  // Sharers (body_html = '') are excluded — they hold no text to reclaim.
  const groups = await env.DB.prepare(
    `SELECT did, lang, body_html, COUNT(*) AS n, MIN(revision_no) AS keep_no
       FROM document_translation_revisions
      WHERE body_html <> ''
      GROUP BY did, lang, body_html
     HAVING COUNT(*) > 1 OR SUM(CASE WHEN body_hash IS NULL THEN 1 ELSE 0 END) > 0
      LIMIT ?`,
  )
    .bind(MAX_GROUPS_PER_RUN + 1)
    .all<{
      did: string;
      lang: string;
      body_html: string;
      n: number;
      keep_no: number;
    }>();
  const list = (groups.results ?? []).slice(0, MAX_GROUPS_PER_RUN);
  const more = (groups.results ?? []).length > MAX_GROUPS_PER_RUN;

  const statements: D1PreparedStatement[] = [];
  let shared = 0;
  let bytesReclaimed = 0;
  for (const g of list) {
    const hash = await sha256Hex(g.body_html);
    // 所有者（最古の版）は本文を保持し、ハッシュだけ埋める。
    statements.push(
      env.DB.prepare(
        `UPDATE document_translation_revisions SET body_hash = ?
          WHERE did = ? AND lang = ? AND revision_no = ?`,
      ).bind(hash, g.did, g.lang, g.keep_no),
    );
    if (g.n > 1) {
      // 残りは本文を捨てて所有者を指す。body_html の一致で絞るので、同一
      // 翻訳の「別の本文」を巻き込むことはない。
      statements.push(
        env.DB.prepare(
          `UPDATE document_translation_revisions
              SET body_html = '', body_hash = ?
            WHERE did = ? AND lang = ? AND revision_no <> ? AND body_html = ?`,
        ).bind(hash, g.did, g.lang, g.keep_no, g.body_html),
      );
      shared += g.n - 1;
      bytesReclaimed += g.body_html.length * (g.n - 1);
    }
  }
  if (statements.length) await env.DB.batch(statements);
  await logActivity(env, user, "revisions.dedupe", "system", "revisions", {
    groups: list.length,
    shared,
    bytesReclaimed,
  });
  return json({
    ok: true,
    groups: list.length,
    shared,
    bytesReclaimed,
    more,
  } as unknown as JsonValue);
}

/**
 * Maintenance sweep: run stripCopyNoiseStyles + normalizePlainLinks over every
 * stored translation body. Changed rows are revision-snapshotted first
 * (recoverable), then updated with a fresh updated_at so the next build
 * regenerates their pages; search_entries.body_text is re-synced too.
 * Processes at most 50 changed rows per invocation (subrequest budget); the
 * response carries `more: true` when another pass is needed.
 */
async function cleanupCopyNoise(env: Env, user: AuthUser): Promise<Response> {
  requireAdmin(user);
  const MAX_CHANGED_PER_RUN = 50;
  const rows = await env.DB.prepare(
    `SELECT did, lang, body_html FROM document_translations
     WHERE body_html LIKE '%revert-layer%' OR body_html LIKE '%<a %'`,
  ).all<{ did: string; lang: string; body_html: string | null }>();
  const candidates = rows.results ?? [];

  let changed = 0;
  const touchedDids = new Set<string>();
  const now = nowIso();
  for (const row of candidates) {
    if (changed >= MAX_CHANGED_PER_RUN) break;
    // スタイルノイズ除去 → リンク記法正規化の順（ノイズ style が消えた
    // プレーンリンクは属性ホワイトリストを通過して変換対象になる）。
    const cleaned = normalizePlainLinks(
      stripCopyNoiseStyles(row.body_html || ""),
    );
    if (cleaned === (row.body_html || "")) continue;
    const statements: D1PreparedStatement[] = [];
    const snapshot = await snapshotTranslationStatement(
      env,
      row.did,
      row.lang,
      user.uid,
      "maintenance",
    );
    if (snapshot) statements.push(snapshot);
    statements.push(
      env.DB.prepare(
        `UPDATE document_translations SET body_html = ?, updated_at = ?
         WHERE did = ? AND lang = ?`,
      ).bind(cleaned, now, row.did, row.lang),
      // 本文テキストが変わる（リンクがトークン化される）ため検索索引も同期。
      env.DB.prepare(
        `UPDATE search_entries SET body_text = ?, updated_at = ?
         WHERE did = ? AND lang = ?`,
      ).bind(stripHtml(cleaned), now, row.did, row.lang),
    );
    await env.DB.batch(statements);
    touchedDids.add(row.did);
    changed++;
  }
  // Dirty the affected documents so the article/listing build hashes change
  // and the next build regenerates their pages with the cleaned HTML.
  if (touchedDids.size) {
    await env.DB.batch(
      Array.from(touchedDids).map((did) =>
        env.DB.prepare(
          "UPDATE documents SET updated_at = ? WHERE did = ?",
        ).bind(now, did),
      ),
    );
  }
  const more = changed >= MAX_CHANGED_PER_RUN;
  await logActivity(env, user, "document.cleanup_styles", "system", "content", {
    scanned: candidates.length,
    changed,
    more,
  });
  return json({ ok: true, scanned: candidates.length, changed, more });
}

/**
 * Maintenance sweep: apply normalizeContentHtml — the SAME normalization the
 * editor runs on paste and on save — to every stored translation body, so
 * articles written before the rule existed get the canonical spelling too.
 *
 *   <b> / font-weight-only <span> → <strong>
 *   <div> paragraph               → <p>   (attributes preserved)
 *   bare <div> block wrapper      → unwrapped
 *   empty block                   → <p><br></p>, or <br> when nested
 *
 * Rendering is unchanged by every one of those rewrites — this is a spelling
 * fix, not a restyle. Changed rows are revision-snapshotted first (recoverable
 * from the article's history), then written with a fresh updated_at so the next
 * build regenerates their pages. Same 50-changed-rows-per-invocation budget as
 * cleanupCopyNoise; `more: true` asks the client for another pass.
 */
async function normalizeBodyFormat(
  env: Env,
  user: AuthUser,
): Promise<Response> {
  requireAdmin(user);
  const MAX_CHANGED_PER_RUN = 50;
  // Cheap pre-filter — only bodies that can possibly contain a target. The
  // authoritative decision is normalizeContentHtml's own output comparison.
  const rows = await env.DB.prepare(
    `SELECT did, lang, body_html FROM document_translations
     WHERE body_html LIKE '%<b>%' OR body_html LIKE '%<b %'
        OR body_html LIKE '%<div%' OR body_html LIKE '%font-weight%'
        -- 復旧対象: 旧版が段落化してしまった構造コンテナ（callout / code block）。
        -- これらは <div> が残っていない行もあるため、上の条件では拾えない。
        OR body_html LIKE '%<p class="kuro-%' OR body_html LIKE '%<p data-%'
        OR body_html LIKE '%<p spellcheck%'`,
  ).all<{ did: string; lang: string; body_html: string | null }>();
  const candidates = rows.results ?? [];

  let changed = 0;
  const touchedDids = new Set<string>();
  const now = nowIso();
  for (const row of candidates) {
    if (changed >= MAX_CHANGED_PER_RUN) break;
    const original = row.body_html || "";
    const cleaned = normalizeContentHtml(original);
    if (cleaned === original) continue;
    const statements: D1PreparedStatement[] = [];
    const snapshot = await snapshotTranslationStatement(
      env,
      row.did,
      row.lang,
      user.uid,
      "maintenance",
    );
    if (snapshot) statements.push(snapshot);
    statements.push(
      env.DB.prepare(
        `UPDATE document_translations SET body_html = ?, updated_at = ?
         WHERE did = ? AND lang = ?`,
      ).bind(cleaned, now, row.did, row.lang),
      // 可視テキストは変わらない設計だが、索引は本文から機械的に作るので
      // 念のため同じ変換後の HTML から張り直しておく。
      env.DB.prepare(
        `UPDATE search_entries SET body_text = ?, updated_at = ?
         WHERE did = ? AND lang = ?`,
      ).bind(stripHtml(cleaned), now, row.did, row.lang),
    );
    await env.DB.batch(statements);
    touchedDids.add(row.did);
    changed++;
  }
  if (touchedDids.size) {
    await env.DB.batch(
      Array.from(touchedDids).map((did) =>
        env.DB.prepare(
          "UPDATE documents SET updated_at = ? WHERE did = ?",
        ).bind(now, did),
      ),
    );
  }
  const more = changed >= MAX_CHANGED_PER_RUN;
  await logActivity(
    env,
    user,
    "document.normalize_format",
    "system",
    "content",
    {
      scanned: candidates.length,
      changed,
      more,
    },
  );
  return json({ ok: true, scanned: candidates.length, changed, more });
}

/**
 * Report — without writing anything — how many stored translations the format
 * normalization would change, and the per-rule totals. Backs the maintenance
 * screen's "check first" affordance so an admin can see the scale before
 * rewriting bodies.
 */
async function normalizeBodyFormatPreview(
  env: Env,
  user: AuthUser,
): Promise<Response> {
  requireAdmin(user);
  const rows = await env.DB.prepare(
    `SELECT body_html FROM document_translations
     WHERE body_html LIKE '%<b>%' OR body_html LIKE '%<b %'
        OR body_html LIKE '%<div%' OR body_html LIKE '%font-weight%'
        -- 復旧対象: 旧版が段落化してしまった構造コンテナ（callout / code block）。
        -- これらは <div> が残っていない行もあるため、上の条件では拾えない。
        OR body_html LIKE '%<p class="kuro-%' OR body_html LIKE '%<p data-%'
        OR body_html LIKE '%<p spellcheck%'`,
  ).all<{ body_html: string | null }>();
  const totals = { bTags: 0, boldSpans: 0, divBlocks: 0, emptyBlocks: 0 };
  let affected = 0;
  for (const row of rows.results ?? []) {
    const s = inspectContentHtml(row.body_html || "");
    if (!s.changed) continue;
    affected++;
    totals.bTags += s.bTags;
    totals.boldSpans += s.boldSpans;
    totals.divBlocks += s.divBlocks;
    totals.emptyBlocks += s.emptyBlocks;
  }
  return json({
    ok: true,
    scanned: (rows.results ?? []).length,
    affected,
    ...totals,
  });
}

/**
 * Build an idempotent statement that registers `lang` as a site language
 * (kind='language') if it isn't already. Used when a translation is upserted so
 * REST/AI-posted translations never become orphaned/invisible. An existing
 * display name is preserved (DO NOTHING on conflict).
 */
function registerLanguageStatement(
  env: Env,
  lang: string,
  now: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO taxonomy_items (id, kind, lang, name, created_at, updated_at)
     VALUES (?, 'language', '', ?, ?, ?)
     ON CONFLICT(id, kind, lang) DO NOTHING`,
  ).bind(lang, lang, now, now);
}

/**
 * Read side of the revision history (`document_translation_revisions`), which
 * until now was write-only from the API's point of view (snapshot on save /
 * overwrite / delete, read back only internally as the 3-way merge base, and
 * dumped whole into backups).
 *
 * Storage is FULL-TEXT, not diffs: every row already holds the complete
 * body_html of the version it snapshots, so a single revision is self-contained
 * and nothing has to be replayed or merged on read. The flip side is size (a
 * long-lived article accumulates hundreds of full copies), which is exactly why
 * this endpoint is filter-first:
 *   - the LIST never returns bodies — only metadata plus `bytes`/`bodyHash`
 *   - one revision's body is fetched explicitly, by number
 *   - `lang` / `since` / `until` / `limit` / `offset` narrow it server-side
 */
async function documentRevisions(
  env: Env,
  did: string,
  url: URL,
  revisionNo?: string,
): Promise<Response> {
  const lang = url.searchParams.get("lang")?.trim() ?? "";
  // Stored JSON columns are handed back parsed (a malformed value must not turn
  // a history read into a 500 — the snapshot is still worth returning).
  const parseJson = (raw: string | null, fallback: JsonValue): JsonValue => {
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as JsonValue;
    } catch {
      return fallback;
    }
  };

  // ── One revision, WITH the full body ──────────────────────────────────────
  if (revisionNo !== undefined) {
    const no = Number(revisionNo);
    if (!Number.isInteger(no) || no < 1) {
      throw new HttpError(
        400,
        "invalid_field",
        "revisionNo must be a positive integer.",
      );
    }
    // revision_no is sequential PER LANGUAGE (UNIQUE(did, lang, revision_no)),
    // so an omitted lang is resolved to the article's base language rather than
    // silently returning whichever language sorts first.
    const targetLang =
      lang ||
      (
        await env.DB.prepare("SELECT initial_lang FROM documents WHERE did = ?")
          .bind(did)
          .first<{ initial_lang: string }>()
      )?.initial_lang ||
      "";
    // body_html は「この行が持つ本文、無ければ共有元の本文」— 呼び出し側から
    // 見れば使い回しは透明で、常に完全な全文が返る（bodyShared でどちらか判る）。
    const row = await env.DB.prepare(
      `SELECT r.revision_id, r.lang, r.revision_no, r.title, r.summary, r.seo_json,
              r.hashtag_json, r.snapshot_at, r.snapshot_by, r.body_hash,
              r.source, r.replaced_by,
              CASE WHEN r.body_html <> '' THEN r.body_html
                   ELSE COALESCE(${ownerBodySql("r")}, '') END AS body_html,
              (r.body_html = '') AS body_shared
         FROM document_translation_revisions r
        WHERE r.did = ? AND r.lang = ? AND r.revision_no = ?`,
    )
      .bind(did, targetLang, no)
      .first<{
        revision_id: string;
        lang: string;
        revision_no: number;
        title: string;
        summary: string | null;
        body_html: string;
        body_shared: number;
        seo_json: string | null;
        hashtag_json: string | null;
        snapshot_at: string;
        snapshot_by: string | null;
        body_hash: string | null;
        source: string | null;
        replaced_by: string | null;
      }>();
    if (!row) {
      throw new HttpError(
        404,
        "revision_not_found",
        `Revision ${no} was not found for language "${targetLang}".`,
      );
    }
    return json({
      revision: {
        revisionId: row.revision_id,
        lang: row.lang,
        revisionNo: row.revision_no,
        title: row.title,
        summary: row.summary,
        bodyHtml: row.body_html,
        seo: parseJson(row.seo_json, {}),
        hashtags: parseJson(row.hashtag_json, []),
        snapshotAt: row.snapshot_at,
        snapshotBy: row.snapshot_by,
        source: row.source,
        replacedBy: row.replaced_by,
        bodyHash: row.body_hash,
        // この版は本文を別の版と共有している（同一本文なので中身は同じ）。
        bodyShared: row.body_shared === 1,
      },
    } as unknown as JsonValue);
  }

  // ── List: metadata only ───────────────────────────────────────────────────
  const since = queryIsoTimestamp(url, "since");
  const until = queryIsoTimestamp(url, "until");
  const limit = queryInt(url, "limit", 1, 200) ?? 50;
  const offset = queryInt(url, "offset", 0, 1000000) ?? 0;
  const conds = ["r.did = ?"];
  const binds: (string | number)[] = [did];
  if (lang) {
    conds.push("r.lang = ?");
    binds.push(lang);
  }
  if (since) {
    conds.push("datetime(r.snapshot_at) >= datetime(?)");
    binds.push(since);
  }
  if (until) {
    conds.push("datetime(r.snapshot_at) <= datetime(?)");
    binds.push(until);
  }
  // ?source= はその版の本文を書いた側、?replacedBy= はその版を消した側。
  // 両方カンマ区切りで複数指定でき、'unknown' は NULL（記録前の版）を指す。
  //   ?source=admin,autosave                → 人が書いた版だけ＝復旧候補
  //   ?source=admin,autosave&replacedBy=mcp,api → 人の本文を AI が消した版
  const sourceFilter = (param: string, column: string): void => {
    const values = (url.searchParams.get(param) ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    if (!values.length) return;
    const named = values.filter((v) => v !== "unknown");
    const parts: string[] = [];
    if (named.length) {
      parts.push(`${column} IN (${named.map(() => "?").join(",")})`);
      binds.push(...named);
    }
    if (values.includes("unknown")) parts.push(`${column} IS NULL`);
    conds.push(`(${parts.join(" OR ")})`);
  };
  sourceFilter("source", "r.source");
  sourceFilter("replacedBy", "r.replaced_by");
  // bytes は「その版の本文の実サイズ」— 共有している版は共有元のサイズを返す
  // （行の LENGTH をそのまま出すと共有版が 0 バイトに見えてしまう）。
  const rows = await env.DB.prepare(
    `SELECT r.revision_id, r.lang, r.revision_no, r.title, r.summary,
            r.snapshot_at, r.snapshot_by, r.source, r.replaced_by, r.body_hash,
            (r.body_html = '') AS body_shared,
            -- 一覧の説明文は要約が正。要約を記録する前の版もあるので、本文の
            -- 冒頭を代替として返す（タグを剥がす分の余裕を見て多めに取る）。
            substr(CASE WHEN r.body_html <> '' THEN r.body_html
                        ELSE COALESCE(${ownerBodySql("r")}, '') END,
                   1, 1200) AS body_head,
            CASE WHEN r.body_html <> '' THEN LENGTH(r.body_html)
                 ELSE COALESCE(LENGTH(${ownerBodySql("r")}), 0) END AS bytes
       FROM document_translation_revisions r
      WHERE ${conds.join(" AND ")}
      ORDER BY r.snapshot_at DESC, r.revision_no DESC
      LIMIT ? OFFSET ?`,
  )
    .bind(...binds, limit, offset)
    .all<{
      revision_id: string;
      lang: string;
      revision_no: number;
      title: string;
      summary: string | null;
      body_head: string | null;
      snapshot_at: string;
      snapshot_by: string | null;
      source: string | null;
      replaced_by: string | null;
      body_hash: string | null;
      body_shared: number;
      bytes: number;
    }>();
  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM document_translation_revisions r
      WHERE ${conds.join(" AND ")}`,
  )
    .bind(...binds)
    .first<{ n: number }>();
  return json({
    revisions: (rows.results ?? []).map((r) => ({
      revisionId: r.revision_id,
      lang: r.lang,
      revisionNo: r.revision_no,
      title: r.title,
      summary: r.summary,
      // 説明文として使える1行。要約 → 無ければ本文の冒頭。
      excerpt: (r.summary || "").trim() || plainExcerpt(r.body_head, 200),
      snapshotAt: r.snapshot_at,
      snapshotBy: r.snapshot_by,
      source: r.source,
      replacedBy: r.replaced_by,
      bodyHash: r.body_hash,
      bodyShared: r.body_shared === 1,
      bytes: r.bytes,
    })),
    total: total?.n ?? 0,
    limit,
    offset,
  } as unknown as JsonValue);
}

async function documentTranslations(
  request: Request,
  env: Env,
  user: AuthUser,
  did: string,
  lang?: string,
  ctx?: ExecutionContext,
): Promise<Response> {
  // Mutations MUST target an explicit language. Never fall back to the base
  // language on a forgotten `:lang` — that would silently overwrite/delete the
  // base translation. (GET without :lang is the valid "list translations" call.)
  if ((request.method === "PUT" || request.method === "DELETE") && !lang) {
    throw new HttpError(
      400,
      "lang_required",
      "Language is required: use /api/documents/:id/translations/{lang}.",
    );
  }
  if (request.method === "GET" && !lang) {
    const result = await env.DB.prepare(
      "SELECT lang, title, summary, updated_at FROM document_translations WHERE did = ? ORDER BY lang",
    )
      .bind(did)
      .all();
    return json({ translations: result.results as JsonValue });
  }

  if (request.method === "GET" && lang) {
    const row = await env.DB.prepare(
      `SELECT did, lang, title, summary, body_html, seo_json, hashtag_json,
              created_at, updated_at, created_by, updated_by, source
       FROM document_translations
       WHERE did = ? AND lang = ?`,
    )
      .bind(did, lang)
      .first();
    if (!row) {
      throw new HttpError(
        404,
        "translation_not_found",
        "Translation was not found.",
      );
    }
    return json({ translation: row as JsonValue });
  }

  if (request.method === "PUT" && lang) {
    requireAuthor(user);
    const body = await readJson(request);
    const title = requireString(body, "title", { min: 1, max: 240 });
    // ⚠ summary / seo / hashtags は bodyHtml と同じ「省略＝現状維持」。
    //   以前は省略を「空で上書き」として扱っていたため、本文だけを更新する
    //   クライアント（MCP の update_article_body は送られたキーしか転送しない）
    //   が、概要・ハッシュタグ・SEO（カバー画像パスを含む）を毎回黙って消して
    //   いた。空にしたいときは "" / {} / [] を明示して送る。
    const summaryInput =
      body.summary === undefined && body.subject === undefined
        ? undefined
        : (optionalString(body, "summary") ?? optionalString(body, "subject"));
    if (summaryInput && summaryInput.length > 200) {
      throw new HttpError(400, "invalid_field", "summary is too long.");
    }
    // bodyHtml is OPTIONAL on updates: when omitted, the existing body is kept
    // unchanged. This lets the admin editor autosave metadata (title/summary/
    // hashtags/seo) without overwriting a body that another client (e.g. an AI
    // via REST/MCP) edited while the article was open. Creating a translation
    // still requires a body.
    const bodyHtmlInput =
      body.bodyHtml === undefined
        ? null
        : requireString(body, "bodyHtml", { min: 1 });
    // Optimistic lock for body-including saves: SHA-256 hex of the body_html the
    // client loaded (or last saved). When it no longer matches the stored body,
    // someone else edited it in the meantime → 409 so the client can decide.
    // Omitting baseBodyHash skips the check (existing REST/AI clients keep
    // working unchanged, and it doubles as the explicit force-overwrite path).
    const baseBodyHash = optionalString(body, "baseBodyHash");
    const seoInput =
      body.seo === undefined
        ? undefined
        : JSON.stringify(body.seo as JsonValue);
    const hashtagsInput =
      body.hashtags === undefined
        ? undefined
        : JSON.stringify(body.hashtags as JsonValue);
    const requestedCreatedAt = optionalIsoTimestamp(body, "createdAt");
    const requestedUpdatedAt = optionalIsoTimestamp(body, "updatedAt");
    const document = await env.DB.prepare(
      `SELECT d.did, d.tid, d.mode, d.live, dt.created_at AS translation_created_at,
              dt.updated_at AS translation_updated_at,
              dt.body_html AS translation_body_html,
              dt.title AS translation_title,
              dt.summary AS translation_summary,
              dt.seo_json AS translation_seo_json,
              dt.hashtag_json AS translation_hashtag_json
       FROM documents d
       LEFT JOIN document_translations dt ON dt.did = d.did AND dt.lang = ?
       WHERE d.did = ?`,
    )
      .bind(lang, did)
      .first<{
        did: string;
        tid: string;
        mode: number;
        live: number;
        translation_created_at: string | null;
        translation_updated_at: string | null;
        translation_body_html: string | null;
        translation_title: string | null;
        translation_summary: string | null;
        translation_seo_json: string | null;
        translation_hashtag_json: string | null;
      }>();
    if (!document) {
      throw new HttpError(404, "document_not_found", "Document was not found.");
    }
    if (bodyHtmlInput === null && document.translation_body_html === null) {
      throw new HttpError(
        400,
        "invalid_field",
        "bodyHtml is required when creating a translation.",
      );
    }
    // 省略されたフィールドは保存済みの値を引き継ぐ（新規作成時は空が既定）。
    const summary =
      summaryInput === undefined ? document.translation_summary : summaryInput;
    const seo =
      seoInput === undefined
        ? (document.translation_seo_json ?? "{}")
        : seoInput;
    const hashtags =
      hashtagsInput === undefined
        ? (document.translation_hashtag_json ?? "[]")
        : hashtagsInput;
    // 書き込み境界の不変条件 (C3): 保存される本文は常に一意な data-bid を持つ。
    // 編集画面 (blockIds:true) 由来は no-op。bid を持たない AI/REST 由来や
    // 新規ブロックはここで採番される (壊れた HTML は normalize が無変換で通す)。
    // 正規化 → ブロック ID 採番の順。normalizeContentHtml は段落の <div> を <p>
    // にしたり素のラッパー <div> を unwrap したりしてトップレベルの構成を変える
    // ので、ID は「正規形になった後のブロック」に振る。エディタ側も getContent()
    // で同じ関数を通すため、保存経路がどこでも同一の形になる（＝ AI/REST が
    // 書いた本文と人が書いた本文で綴りが割れない）。
    const incomingBody =
      bodyHtmlInput === null
        ? null
        : normalizeBlockIds(normalizeContentHtml(bodyHtmlInput));

    // 楽観ロック → サーバー 3-way マージ (C4):
    // baseBodyHash が現在の本文と一致しない = 他クライアントが先に保存した。
    // 旧来は 409 で突き返すだけだったが、申告 base のリビジョンが履歴にあれば
    // ブロック単位 3-way マージで両者の編集を統合する (別ブロックの編集は両立、
    // 同一ブロックの分岐は現在値を保持し conflicts で申告側に返す = local-wins
    // + report。人間と AI の同時編集を双方向とも無音で失わない)。
    let mergeConflicts: MergeConflict[] | null = null;
    let bodyHtml = incomingBody ?? (document.translation_body_html as string);
    if (
      incomingBody !== null &&
      baseBodyHash &&
      document.translation_body_html !== null &&
      (await sha256Hex(document.translation_body_html)) !== baseBodyHash
    ) {
      // `body_html <> ''` ＝ 本文を実際に持っている版だけを見る。同じ
      // body_hash の版は定義上まったく同じ本文なので、共有側の行を飛ばして
      // 所有者の行を拾えばよい（共有行を引くと本文が空のままマージしてしまう）。
      const baseRev = await env.DB.prepare(
        `SELECT body_html FROM document_translation_revisions
         WHERE did = ? AND lang = ? AND body_hash = ? AND body_html <> ''
         ORDER BY revision_no DESC LIMIT 1`,
      )
        .bind(did, lang, baseBodyHash)
        .first<{ body_html: string }>();
      if (!baseRev) {
        throw new HttpError(
          409,
          "body_conflict",
          "The body was updated by another client after it was loaded, and the declared base revision is unknown so it cannot be merged. Re-fetch the article (GET returns bodyHtml + bodyHash) and retry with that bodyHash, or resend without baseBodyHash to overwrite (the current version is snapshotted to revision history).",
        );
      }
      const merged = mergeBlocks(
        baseRev.body_html,
        document.translation_body_html,
        incomingBody,
      );
      bodyHtml = merged.html;
      mergeConflicts = merged.conflicts;
    }

    // RecipeCard の検証（仕様 §7・§10）。エディタ側の検証は「親切」であって
    // 「保証」ではない（REST/MCP/インポートも同じ列へ書く）ので、**保存前に
    // 必ずここで見る**。マージ後の最終形を対象にするのが要点 — 3-way マージの
    // 結果としてカードが 2 枚になることもある。
    if (incomingBody !== null) {
      const check = checkRecipeCards(bodyHtml);
      if (check.errors.length) {
        throw new HttpError(
          422,
          "invalid_recipe_card",
          check.errors.join(" / "),
        );
      }
    }

    // No-op guard: the editor PUTs the full metadata payload on EVERY save.
    // When the stored translation is byte-identical, skip the write — the
    // unconditional upsert would otherwise bump dt/d updated_at (dirtying the
    // build hashes for nothing) AND snapshot a pointless revision each save.
    // Explicit createdAt/updatedAt requests (import flows) are data changes.
    const translationUnchanged =
      document.translation_created_at !== null &&
      requestedCreatedAt == null &&
      requestedUpdatedAt == null &&
      title === (document.translation_title ?? "") &&
      (summary ?? "") === (document.translation_summary ?? "") &&
      seo === (document.translation_seo_json ?? "") &&
      hashtags === (document.translation_hashtag_json ?? "") &&
      bodyHtml === document.translation_body_html;
    if (translationUnchanged) {
      // マージの結果「保存済みと同一」に収束した場合もここに来る。申告側 (AI 等)
      // が正しい base を掴み直せるよう bodyHash と、分岐があったなら conflicts を返す
      return json({
        ok: true,
        did,
        lang,
        createdAt: document.translation_created_at,
        updatedAt: document.translation_updated_at,
        changed: false,
        bodyHash: await sha256Hex(bodyHtml),
        ...(mergeConflicts !== null
          ? { merged: true, bodyHtml, conflicts: mergeConflicts }
          : {}),
      });
    }

    const now0 = nowIso();
    const createdAt =
      requestedCreatedAt ?? document.translation_created_at ?? now0;
    const updatedAt = requestedUpdatedAt ?? now0;

    // 保存の本体は共通経路へ（履歴・data-bid・検索索引・出所はそこで面倒を見る）。
    await writeTranslationContent(env, {
      did,
      lang,
      tid: document.tid,
      title,
      summary,
      bodyHtml,
      seoJson: seo,
      hashtagJson: hashtags,
      actorUid: user.uid,
      source: writeSource(request, user),
      createdAt,
      updatedAt,
      // 本文は既に正規化＋マージ済み。メタだけの保存で保存済み本文を
      // 触らないよう、ここで再正規化はしない。
      normalizeBody: false,
      validateRecipe: false,
    });

    await logActivity(env, user, "translation.upsert", "document", did, {
      lang,
    });
    // Immediate page refresh for a REAL content change on a LIVE article (one
    // the last build published). Runs after the new content is committed.
    // Gated on live, NOT mode: the publish flag is pure state until a build
    // materializes it, so a content save on a flagged-but-unbuilt article must
    // not publish it (buildDocumentPages also no-ops on live=0).
    // deferBuild: the editor's doSave() always follows this PUT with a
    // categories PUT, which fires the one consolidated refresh for the whole
    // save once everything is committed.
    const deferBuild = body.deferBuild === true;
    if (!deferBuild && ctx && document.live === 1) {
      ctx.waitUntil(
        buildDocumentPages(env, did).catch(() => {
          /* non-fatal: full build will reconcile */
        }),
      );
    }
    // bodyHash は次回保存の baseBodyHash としてそのまま使える (再 GET 不要)。
    // マージが走った場合は正準の統合結果 bodyHtml と分岐 conflicts を返す —
    // 申告側 (AI) は conflicts の各 remote が「取り込まれなかった自分の版」。
    return json({
      ok: true,
      did,
      lang,
      createdAt,
      updatedAt,
      changed: true,
      bodyHash: await sha256Hex(bodyHtml),
      ...(mergeConflicts !== null
        ? { merged: true, bodyHtml, conflicts: mergeConflicts }
        : {}),
    });
  }

  if (request.method === "DELETE" && lang) {
    requireAuthor(user);
    const document = await env.DB.prepare(
      "SELECT did, initial_lang FROM documents WHERE did = ?",
    )
      .bind(did)
      .first<{ did: string; initial_lang: string }>();
    if (!document) {
      throw new HttpError(404, "document_not_found", "Document was not found.");
    }
    // Deleting the base language means deleting the whole article — that path is
    // a separate, explicitly-confirmed action (DELETE /api/documents/:did).
    if (lang === document.initial_lang) {
      throw new HttpError(
        400,
        "base_language_delete",
        "Cannot delete the base language alone; delete the whole article instead.",
      );
    }
    const existing = await env.DB.prepare(
      "SELECT lang FROM document_translations WHERE did = ? AND lang = ?",
    )
      .bind(did, lang)
      .first();
    if (!existing) {
      throw new HttpError(
        404,
        "translation_not_found",
        "Translation was not found.",
      );
    }
    const countRow = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM document_translations WHERE did = ?",
    )
      .bind(did)
      .first<{ n: number }>();
    if ((countRow?.n ?? 0) <= 1) {
      throw new HttpError(
        400,
        "last_translation",
        "Cannot delete the only translation; delete the whole article instead.",
      );
    }
    // Snapshot before delete so it stays recoverable in the revision history.
    const snapshot = await snapshotTranslationStatement(
      env,
      did,
      lang,
      user.uid,
      writeSource(request, user),
    );
    const statements: D1PreparedStatement[] = [];
    if (snapshot) statements.push(snapshot);
    statements.push(
      env.DB.prepare(
        "DELETE FROM document_translations WHERE did = ? AND lang = ?",
      ).bind(did, lang),
      env.DB.prepare(
        "DELETE FROM search_entries WHERE did = ? AND lang = ?",
      ).bind(did, lang),
      env.DB.prepare(
        "UPDATE documents SET updated_at = ?, updated_by = ? WHERE did = ?",
      ).bind(nowIso(), user.uid, did),
    );
    await env.DB.batch(statements);
    await logActivity(env, user, "translation.delete", "document", did, {
      lang,
    });
    return json({ ok: true, did, lang });
  }

  throw new HttpError(405, "method_not_allowed", "Method is not allowed.");
}

async function nextMediaId(
  env: Env,
  kind: "image" | "video" | "audio",
): Promise<string> {
  const prefix = kind === "image" ? "img" : kind === "video" ? "vid" : "aud";
  // Derive the next number from the HIGHEST existing id, NOT COUNT(*): deleting a
  // media row (e.g. the orphan-cleanup) leaves a gap, so COUNT+1 would land on an
  // id that still exists and fail the `mid` UNIQUE constraint on INSERT. Parse the
  // trailing number off each mid of this kind. Current ids look like "img-163";
  // legacy ones used an underscore ("img_146") — `(\d+)$` covers both.
  const rows = await env.DB.prepare(
    "SELECT mid FROM media_assets WHERE kind = ?",
  )
    .bind(kind)
    .all<{ mid: string }>();
  let max = 0;
  for (const r of rows.results) {
    const m = /(\d+)$/.exec(r.mid || "");
    if (m) {
      const num = parseInt(m[1], 10);
      if (num > max) max = num;
    }
  }
  // NEVER re-issue a number: deleting the newest asset would otherwise free its
  // mid, and the re-issued /images/{mid}.{ext} URL is poisoned by the 1-year
  // immutable browser/CDN cache of the deleted content (the new image then
  // LOOKS like the old one everywhere). media_id_seq remembers the highest
  // number ever issued, independent of surviving rows (migration 0056).
  const seqRow = await env.DB.prepare(
    "SELECT last_n FROM media_id_seq WHERE kind = ?",
  )
    .bind(kind)
    .first<{ last_n: number }>()
    .catch(() => null);
  const n = Math.max(max, seqRow?.last_n ?? 0) + 1;
  await env.DB.prepare(
    `INSERT INTO media_id_seq (kind, last_n) VALUES (?, ?)
     ON CONFLICT(kind) DO UPDATE SET last_n = excluded.last_n
     WHERE excluded.last_n > media_id_seq.last_n`,
  )
    .bind(kind, n)
    .run()
    .catch(() => {});
  // Hyphen separator for consistency with all other [[...]] tokens (content
  // keys, SNS ids). The [[...]] parser accepts both, but we standardize on "-".
  return `${prefix}-${String(n).padStart(3, "0")}`;
}

async function listMediaAssets(
  env: Env,
  user: AuthUser,
  kind: "image" | "video" | "audio",
): Promise<Response> {
  requireAuthor(user);
  const rows = await env.DB.prepare(
    "SELECT mid AS id, kind, filename, mime, width, height, size_bytes AS sizeBytes, public_path AS publicPath, cache_version AS cacheVersion, created_at AS createdAt FROM media_assets WHERE kind = ? ORDER BY created_at DESC LIMIT 200",
  )
    .bind(kind)
    .all();
  return json({ items: rows.results as JsonValue }, { status: 200 });
}

/** Resolve a single media asset by its mid (e.g. to display [[img-xxx]] as a cover). */
async function getMediaAssetByMid(env: Env, mid: string): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT mid AS id, kind, filename, mime, width, height, size_bytes AS sizeBytes, public_path AS publicPath, cache_version AS cacheVersion, created_at AS createdAt FROM media_assets WHERE mid = ?",
  )
    .bind(mid)
    .first<Record<string, unknown>>();
  if (!row) {
    throw new HttpError(404, "media_not_found", "Media asset was not found.");
  }
  return json({ item: row as JsonValue });
}

async function deleteMediaAsset(
  env: Env,
  user: AuthUser,
  mid: string,
): Promise<Response> {
  requireAuthor(user);
  const row = await env.DB.prepare(
    "SELECT mid, kind, ext, public_path AS publicPath FROM media_assets WHERE mid = ?",
  )
    .bind(mid)
    .first<{ mid: string; kind: string; ext: string; publicPath: string }>();
  if (!row) throw new HttpError(404, "not_found", "Media asset not found.");
  if (env.MEDIA_BUCKET) {
    const r2Key = row.publicPath.replace(/^\//, "").split("?")[0];
    await (env.MEDIA_BUCKET as R2Bucket).delete(r2Key).catch(() => {});
  }
  await env.DB.prepare("DELETE FROM media_assets WHERE mid = ?")
    .bind(mid)
    .run();
  await logActivity(env, user, `${row.kind}.delete`, row.kind, mid, {
    publicPath: row.publicPath,
  });
  return json({ ok: true }, { status: 200 });
}

// ── Site management: templates ────────────────────────────────────────────

// html2canvas は srcdoc iframe 内の相対 URL を解決できないため、
// src/href 属性と CSS url(...) の両方を origin 付き絶対 URL に変換する。
function absolutizeMediaUrls(html: string, origin: string): string {
  const media = "(images|videos|audios)";
  return html
    .replace(
      new RegExp(` (src|href)="(/${media}/[^"]+)"`, "g"),
      ` $1="${origin}$2"`,
    )
    .replace(new RegExp(`url\\((/${media}/[^)]+)\\)`, "g"), `url(${origin}$1)`);
}

async function siteTemplatePreview(
  request: Request,
  env: Env,
  user: AuthUser,
  id: string,
): Promise<Response> {
  requireAuthor(user);
  const templateRow = await env.DB.prepare(
    "SELECT id, is_active, source_html FROM page_templates WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; is_active: number; source_html: string | null }>();
  if (!templateRow?.source_html) {
    if (templateRow?.is_active) {
      await deactivateTemplatesWithoutSource(env);
    }
    return templatePreviewUnavailable();
  }
  const settings = await env.DB.prepare(
    "SELECT default_lang FROM site_settings WHERE id = 1",
  ).first<{ default_lang: string | null }>();
  const lang = settings?.default_lang || "en";
  const rawHtml = await generatePage(env, "/", {}, lang, {
    id: templateRow.id,
    sourceHtml: templateRow.source_html,
  });
  const origin = new URL(request.url).origin;
  const absoluteHtml = absolutizeMediaUrls(rawHtml ?? "", origin);
  return new Response(absoluteHtml, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "X-Frame-Options": "SAMEORIGIN",
    },
  });
}

function templatePreviewUnavailable(): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f8fafc;color:#334155;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .card{max-width:560px;margin:24px;padding:24px;border:1px solid #cbd5e1;border-radius:16px;background:white;box-shadow:0 10px 30px rgba(15,23,42,.08)}
    h1{margin:0 0 10px;font-size:20px;color:#0f172a}
    p{margin:0;line-height:1.7}
  </style>
</head>
<body>
  <div class="card">
    <h1>Template source is not loaded</h1>
    <p>This template is no longer available as a loaded KuroCMS template. Select or install another template from the template selection tab.</p>
  </div>
</body>
</html>`,
    {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "X-Frame-Options": "SAMEORIGIN",
      },
    },
  );
}

async function setSitePublished(
  request: Request,
  env: Env,
  user: AuthUser,
): Promise<Response> {
  requireAdmin(user);
  const body = await readJson(request);
  const published = body.published === true ? 1 : 0;
  // IMPORTANT: do NOT touch updated_at here. `site_is_published` is a serving
  // kill-switch and does not change any page's HTML, but `updated_at` feeds
  // `contentTs`, which is folded into the build hash of home/type/about/article
  // pages. The build marks the site published on EVERY successful run, so
  // bumping updated_at here made contentTs advance every build → the next build
  // needlessly rebuilt every content page. Keeping updated_at out decouples the
  // publish flag from content versioning.
  await env.DB.prepare(
    "UPDATE site_settings SET site_is_published = ? WHERE id = 1",
  )
    .bind(published)
    .run();
  return json({ ok: true, siteIsPublished: published === 1 });
}

async function siteUnpublish(env: Env, user: AuthUser): Promise<Response> {
  requireAdmin(user);
  let cursor: string | undefined;
  do {
    const result = await (env.PUBLIC_PAGES as KVNamespace).list({ cursor });
    if (result.keys.length > 0) {
      await Promise.all(
        result.keys.map((k) =>
          (env.PUBLIC_PAGES as KVNamespace).delete(k.name),
        ),
      );
    }
    cursor = result.list_complete
      ? undefined
      : (result as { cursor?: string }).cursor;
  } while (cursor);
  await env.DB.prepare(
    "UPDATE site_settings SET site_is_published = 0, updated_at = ? WHERE id = 1",
  )
    .bind(nowIso())
    .run();
  return json({ ok: true, siteIsPublished: false });
}

function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}

type ContentKeyDef = {
  key: string;
  defaultValue: string;
  description?: string;
};

/**
 * contentKeys を**唯一の正規形** `{key,defaultValue,description?}` に揃える。
 *
 * ⚠ Community テンプレート API は contentKeys を**受け取ったまま保存して返す**
 *   だけ（`entry.ts` の型は `unknown[]`）で、システム間の形式差は存在しない。
 *   実際に混在していたのは**送り手ごとに形が違った**からで、文字列配列
 *   （`["logo","favicon",…]`）で登録されたテンプレートが存在した。
 *   読み取り側だけ寛容にするとバラバラのまま増えるので、**書き込み時にここを
 *   必ず通して正規化する**（読み取りは互換のため引き続き両形式を受ける）。
 */
function normalizeContentKeys(value: unknown): ContentKeyDef[] {
  if (!Array.isArray(value)) return [];
  const out: ContentKeyDef[] = [];
  const seen = new Set<string>();
  for (const ck of value) {
    let key = "";
    let defaultValue = "";
    let description: string | undefined;
    if (typeof ck === "string") {
      key = ck.trim();
    } else if (ck && typeof ck === "object") {
      const o = ck as Record<string, unknown>;
      key = typeof o.key === "string" ? o.key.trim() : "";
      defaultValue = typeof o.defaultValue === "string" ? o.defaultValue : "";
      if (typeof o.description === "string" && o.description)
        description = o.description;
    }
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, defaultValue, ...(description ? { description } : {}) });
  }
  return out;
}

function parseContentKeys(raw: string | null | undefined): ContentKeyDef[] {
  if (!raw) return [];
  try {
    return normalizeContentKeys(JSON.parse(raw));
  } catch {
    return [];
  }
}

const TEMPLATE_SELECT = `id, name, author, author_id, source_url, preview_url, version, description,
  is_active, tags_json, bg, content_keys_json, api_version AS apiVersion,
  installed_at, community_published, community_id, user_modified`;

function serializeTemplateRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const { tags_json, content_keys_json, ...template } = row;
  return {
    ...template,
    tags: parseTags(tags_json as string | null),
    contentKeys: parseContentKeys(content_keys_json as string | null),
  };
}

async function getTemplateAuthorProfile(
  env: Env,
  user: AuthUser,
): Promise<{ displayName: string; authorId: string }> {
  const row = await env.DB.prepare(
    "SELECT email, display_name, author_id FROM users WHERE uid = ?",
  )
    .bind(user.uid)
    .first<{
      email: string;
      display_name: string | null;
      author_id: string | null;
    }>();
  if (!row) throw new HttpError(404, "user_not_found", "User was not found.");
  const displayName = (row.display_name || row.email || user.email).trim();
  // author_id の遅延補完はプロフィール画面（GET /api/me）の1箇所のみで行う。
  // ここでは生成せず、現在値（通常はユーザー作成時に採番済み）を返すだけ。
  return { displayName, authorId: (row.author_id || "").trim() };
}

async function deactivateTemplatesWithoutSource(env: Env): Promise<void> {
  await env.DB.prepare(
    `UPDATE page_templates
       SET is_active = 0, updated_at = ?
     WHERE is_active = 1
       AND (source_html IS NULL OR TRIM(source_html) = '')`,
  )
    .bind(nowIso())
    .run();
}

async function siteTemplatesList(env: Env, user: AuthUser): Promise<Response> {
  requireAuthor(user);
  await deactivateTemplatesWithoutSource(env);
  const rows = await env.DB.prepare(
    `SELECT ${TEMPLATE_SELECT} FROM page_templates ORDER BY installed_at DESC`,
  ).all<Record<string, unknown>>();
  const templates = (rows.results ?? []).map(serializeTemplateRow);
  return json({ templates } as unknown as JsonValue);
}

async function siteTemplateDetail(
  env: Env,
  user: AuthUser,
  id: string,
): Promise<Response> {
  requireAuthor(user);
  const row = await env.DB.prepare(
    `SELECT ${TEMPLATE_SELECT} FROM page_templates WHERE id = ?`,
  )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) throw new HttpError(404, "not_found", "Template not found.");
  return json({ template: serializeTemplateRow(row) } as unknown as JsonValue);
}

async function siteTemplateSetCommunity(
  request: Request,
  env: Env,
  user: AuthUser,
  id: string,
): Promise<Response> {
  requireAdmin(user);
  const row = await env.DB.prepare("SELECT id FROM page_templates WHERE id = ?")
    .bind(id)
    .first();
  if (!row) throw new HttpError(404, "not_found", "Template not found.");
  const body = await readJson(request);
  const published = body.published === true ? 1 : 0;
  const communityId =
    typeof body.communityId === "string" ? body.communityId : null;
  await env.DB.prepare(
    "UPDATE page_templates SET community_published = ?, community_id = ?, updated_at = ? WHERE id = ?",
  )
    .bind(published, communityId, nowIso(), id)
    .run();
  return json({ ok: true, communityPublished: published === 1, communityId });
}

async function siteTemplateDeleteCommunity(
  env: Env,
  user: AuthUser,
  id: string,
): Promise<Response> {
  requireAdmin(user);
  if (!communityPat(env))
    throw new HttpError(
      503,
      "no_community_pat",
      "Community PAT is not available (neither the COMMUNITY_PAT Worker Secret nor the built-in shared PAT).",
    );

  const authorProfile = await getTemplateAuthorProfile(env, user);
  const local = await env.DB.prepare(
    "SELECT id, author_id, community_id FROM page_templates WHERE id = ?",
  )
    .bind(id)
    .first<{
      id: string;
      author_id: string | null;
      community_id: string | null;
    }>();
  let targetId = id;

  if (local) {
    if (!local.author_id) {
      await env.DB.prepare(
        "UPDATE page_templates SET author_id = ?, updated_at = ? WHERE id = ?",
      )
        .bind(authorProfile.authorId, nowIso(), id)
        .run();
    } else if (local.author_id !== authorProfile.authorId) {
      throw new HttpError(
        403,
        "template_owner_required",
        "Only the template owner can remove it from the community library.",
      );
    }
    targetId = local.community_id || local.id;
  } else {
    const metaReq = new Request(
      `${KUROCMS_COMMUNITY_BASE_URL}/api/v1/get/${encodeURIComponent(id)}/meta.json`,
      { headers: { Accept: "application/json" } },
    );
    const metaRes = await (env.COMMUNITY_API
      ? env.COMMUNITY_API.fetch(metaReq)
      : fetch(metaReq));
    if (!metaRes.ok)
      throw new HttpError(
        404,
        "community_template_not_found",
        "Community template was not found.",
      );
    const meta = (await metaRes.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const communityAuthorId = String(
      meta.authorId || meta.author_id || "",
    ).trim();
    if (!communityAuthorId || communityAuthorId !== authorProfile.authorId) {
      throw new HttpError(
        403,
        "template_owner_required",
        "Only the community template owner can remove it.",
      );
    }
  }

  const deleteReq = new Request(
    `${KUROCMS_COMMUNITY_BASE_URL}/api/v1/delete/${encodeURIComponent(targetId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${communityPat(env)}` },
    },
  );
  const res = await (env.COMMUNITY_API
    ? env.COMMUNITY_API.fetch(deleteReq)
    : fetch(deleteReq));
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpError(
      502,
      "community_error",
      `HTTP ${res.status}: ${text.slice(0, 300)}`,
    );
  }
  if (local) {
    await env.DB.prepare(
      "UPDATE page_templates SET community_published = 0, community_id = NULL, updated_at = ? WHERE id = ?",
    )
      .bind(nowIso(), id)
      .run();
  }
  return json({ ok: true, communityId: targetId });
}

async function siteTemplateRegister(
  request: Request,
  env: Env,
  user: AuthUser,
): Promise<Response> {
  requireAdmin(user);
  const body = await readJson(request);
  const sourceUrl = optionalString(body, "sourceUrl") ?? "";
  // ⚠ 既存経路（sourceUrl を worker が取りに行く）は一切変えない。CMS が Community と
  //   同じゾーンに載っていて自ゾーン fetch が 522 になる場合【だけ】、管理画面が
  //   ブラウザで取得した HTML を受け取る。詳細は templates/community-source.ts。
  //   sameZone が false なら sourceHtml は無視するので、他ユーザーの挙動は不変。
  const origin = chooseTemplateSourceOrigin({
    sourceUrl,
    sourceHtml: optionalString(body, "sourceHtml") ?? "",
    sameZone: isSameZoneAsCommunity(request.url, KUROCMS_COMMUNITY_BASE_URL),
  });
  let sourceHtml: string | null = null;
  if (origin === "inline") {
    // ⚠ fetch 経路と同じ検証を通す。URL は出所の記録なので、付いているなら
    //   Community の形式であることまで確かめる（inline だけ緩くしない）。
    if (sourceUrl) assertCommunitySourceUrl(sourceUrl);
    sourceHtml = optionalString(body, "sourceHtml") ?? "";
    assertTemplateSource(sourceHtml);
  } else if (origin === "fetch") {
    sourceHtml = await fetchCommunityTemplateSource(env, sourceUrl);
  }
  const authorProfile = await getTemplateAuthorProfile(env, user);
  const name = requireString(body, "name", { min: 1, max: 120 });
  // author は常にユーザーの display_name 由来の単一ソース（body の author は使わない）。
  const author = authorProfile.displayName;
  const authorId = authorProfile.authorId;
  const previewUrl = optionalString(body, "previewUrl") ?? "";
  const version = optionalString(body, "version") ?? "1.0.0";
  const description = optionalString(body, "description") ?? "";
  const tags = Array.isArray(body.tags)
    ? (body.tags as string[]).filter((t) => typeof t === "string")
    : [];
  const bg = optionalString(body, "bg") ?? "";
  // 保存は必ず正規形に揃える（文字列配列で来ても {key,defaultValue} へ）。
  const contentKeysJson = Array.isArray(body.contentKeys)
    ? JSON.stringify(normalizeContentKeys(body.contentKeys))
    : null;
  const apiVersion = parseApiVersion(body.apiVersion);
  // Community コピー(sourceUrl あり)は新規 tmpl_xxx を発番する。
  // 公開時の tid はテンプレ名の slug を使うため（siteTemplatePublish）、ローカル id は一意で良い。
  //
  // ⚠ id の許容文字にアンダースコアを含めること。KuroCMS 自身が発番する id は
  //   `makeId("tmpl")` → **`tmpl_050d91e8d9fa`** の形式なので、`[a-z0-9-]` だけだと
  //   「自分が作った id を渡した upsert」が必ず判定に落ち、**黙って別テンプレートが
  //   新規作成される**（201 が返るので気付けない）。実際に事故を起こした。
  // ⚠ id が指定されているのに形式不正なら、勝手に発番せず 400 で弾く。
  //   「指定した id と違うものが出来る」のを黙認しない。
  const providedId = sourceUrl ? null : optionalString(body, "id");
  if (providedId && !/^[a-zA-Z0-9_-]+$/.test(providedId)) {
    throw new HttpError(
      400,
      "invalid_id",
      "id must match [a-zA-Z0-9_-]+ (a new template is NOT created silently).",
    );
  }
  const id = providedId || makeId("tmpl");

  const now = nowIso();
  const existing = await env.DB.prepare(
    "SELECT id FROM page_templates WHERE id = ?",
  )
    .bind(id)
    .first();
  if (existing) {
    await env.DB.prepare(
      "UPDATE page_templates SET name=?, author=?, author_id=?, source_url=?, preview_url=?, version=?, description=?, tags_json=?, bg=?, content_keys_json=COALESCE(?,content_keys_json), api_version=?, source_html=COALESCE(?,source_html), updated_at=? WHERE id=?",
    )
      .bind(
        name,
        author,
        authorId,
        sourceUrl,
        previewUrl,
        version,
        description,
        JSON.stringify(tags),
        bg,
        contentKeysJson,
        apiVersion,
        sourceHtml,
        now,
        id,
      )
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO page_templates (id, name, author, author_id, source_url, preview_url, version, description, is_active, tags_json, bg, content_keys_json, api_version, source_html, installed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        name,
        author,
        authorId,
        sourceUrl,
        previewUrl,
        version,
        description,
        JSON.stringify(tags),
        bg,
        contentKeysJson,
        apiVersion,
        sourceHtml,
        now,
        now,
      )
      .run();
  }
  await logActivity(env, user, "template.register", "template", id, { name });
  return json({ ok: true, id }, { status: 201 });
}

/**
 * 取り込む HTML の受け入れ判定。⚠ Community から fetch した場合も、同一ゾーン運用で
 * クライアントから渡された場合も【必ずここを通す】。片方だけ緩いと事故になる。
 */
function assertTemplateSource(html: string): void {
  if (!isAcceptableTemplateSource(html, isKuroCmsHtmlTemplate)) {
    throw new HttpError(
      400,
      "invalid_template_source",
      "Template source must be KuroCMS template HTML and no larger than 2 MB.",
    );
  }
}

/**
 * sourceUrl が Community テンプレート API を指しているか。⚠ fetch 経路と inline 経路
 * （同一ゾーン運用）で共通。inline 側だけ素通ししていると、出所不明の URL が
 * source_url に残り「どこ由来のテンプレートか」が追えなくなる。
 */
function assertCommunitySourceUrl(sourceUrl: string): URL {
  let url: URL;
  try {
    url = new URL(sourceUrl, `${KUROCMS_COMMUNITY_BASE_URL}/`);
  } catch {
    throw new HttpError(
      400,
      "invalid_source_url",
      "Template source URL is invalid.",
    );
  }
  if (
    url.origin !== "https://kuro.boo" ||
    !/^\/kurocms\/api\/v1\/get\/[^/]+\/src\.html$/.test(url.pathname)
  ) {
    throw new HttpError(
      400,
      "invalid_source_url",
      "Template source URL must point to the KuroCMS Community template API.",
    );
  }
  return url;
}

async function fetchCommunityTemplateSource(
  env: Env,
  sourceUrl: string,
): Promise<string> {
  const url = assertCommunitySourceUrl(sourceUrl);

  const sourceRequest = new Request(url.toString(), {
    headers: {
      Accept: "text/html",
      "User-Agent": "KuroCMS-template-installer/1.0",
    },
  });
  let response: Response;
  try {
    // Use Service Binding when available — direct fetch() is bypassed by kuro.boo zone _redirects
    // for intra-zone subrequests, causing the wrong HTML to be returned.
    response = await (env.COMMUNITY_API
      ? env.COMMUNITY_API.fetch(sourceRequest)
      : fetch(sourceRequest));
  } catch {
    throw new HttpError(
      502,
      "template_source_fetch_failed",
      "Failed to fetch template source.",
    );
  }
  if (!response.ok) {
    throw new HttpError(
      502,
      "template_source_fetch_failed",
      `Template source returned HTTP ${response.status}.`,
    );
  }

  const html = await response.text();
  assertTemplateSource(html);
  return html;
}

async function siteTemplateActivate(
  env: Env,
  user: AuthUser,
  id: string,
): Promise<Response> {
  requireAdmin(user);
  const row = await env.DB.prepare(
    "SELECT id, content_keys_json, source_html FROM page_templates WHERE id = ?",
  )
    .bind(id)
    .first<{
      id: string;
      content_keys_json: string | null;
      source_html: string | null;
    }>();
  if (!row) throw new HttpError(404, "not_found", "Template not found.");
  if (!row.source_html)
    throw new HttpError(400, "invalid_template", "Template HTML is required.");
  const now = nowIso();
  await env.DB.prepare(
    "UPDATE page_templates SET is_active = 0, updated_at = ?",
  )
    .bind(now)
    .run();
  await env.DB.prepare(
    "UPDATE page_templates SET is_active = 1, updated_at = ? WHERE id = ?",
  )
    .bind(now, id)
    .run();
  await env.DB.prepare(
    "UPDATE site_settings SET template_id = ?, updated_at = ? WHERE id = 1",
  )
    .bind(id, now)
    .run();
  // Provision missing content keys for all registered languages (never overwrites existing entries).
  const contentKeys = parseContentKeys(row.content_keys_json);
  if (contentKeys.length) {
    const langRows = await env.DB.prepare(
      `SELECT id FROM taxonomy_items WHERE kind = 'language' ORDER BY id`,
    ).all<{ id: string }>();
    const provLangs = (langRows.results ?? []).map((r) => r.id);
    if (!provLangs.length) {
      const sRow = await env.DB.prepare(
        "SELECT default_lang FROM site_settings WHERE id = 1",
      ).first<{ default_lang: string }>();
      provLangs.push(sRow?.default_lang || "en");
    }
    for (const ck of contentKeys) {
      for (const lang of provLangs) {
        await env.DB.prepare(
          `INSERT INTO taxonomy_items (id, kind, lang, name, is_system, created_at, updated_at)
           VALUES (?, 'template', ?, ?, 1, ?, ?)
           ON CONFLICT(id, kind, lang) DO NOTHING`,
        )
          .bind(ck.key, lang, ck.defaultValue, now, now)
          .run();
      }
    }
  }
  await logActivity(env, user, "template.activate", "template", id, {});
  return json({ ok: true });
}

async function siteTemplateDelete(
  env: Env,
  user: AuthUser,
  id: string,
): Promise<Response> {
  requireAdmin(user);
  const row = await env.DB.prepare(
    "SELECT id, is_active FROM page_templates WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; is_active: number }>();
  if (!row) throw new HttpError(404, "not_found", "Template not found.");
  await env.DB.prepare("DELETE FROM page_templates WHERE id = ?")
    .bind(id)
    .run();
  await logActivity(env, user, "template.delete", "template", id, {});
  return json({ ok: true });
}

async function siteTemplateServeThumbnail(
  env: Env,
  id: string,
): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT thumbnail_blob FROM page_templates WHERE id = ?",
  )
    .bind(id)
    .first<{ thumbnail_blob: string | null }>();
  if (row?.thumbnail_blob) {
    const dataUrl = row.thumbnail_blob;
    const commaIdx = dataUrl.indexOf(",");
    const mimeMatch = dataUrl.match(/^data:([^;]+);base64,/);
    const ct = mimeMatch ? mimeMatch[1] : "image/jpeg";
    const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new Response(bytes, {
      headers: { "Content-Type": ct, "Cache-Control": "public, max-age=3600" },
    });
  }
  // D1 に blob なし → Promotion_Installer の公開画像 URL にリダイレクト
  // NOTE: Worker 内部から fetch()/Service Binding で kuro.boo/kurocms/* を取得すると
  // 同一ゾーン宛てサブリクエストが Worker Routes を経由せず kuro-boo 本体サイトの
  // ホームページ HTML を返してしまうため、ブラウザ側で直接取得させる
  const piUrl = `${KUROCMS_COMMUNITY_BASE_URL}/api/v1/get/${encodeURIComponent(id)}/image.jpg`;
  return Response.redirect(piUrl, 302);
}

// Community Library API へのサブリクエスト。Worker から直接 fetch() で kuro.boo/kurocms/* を
// 叩くと同一ゾーン宛サブリクエストが Routes を経由せず本体サイトを返すため、
// COMMUNITY_API サービスバインディング経由を優先する。
/**
 * Community テンプレート API 用の PAT を解決する。
 *
 * 優先順位は **Worker Secret `COMMUNITY_PAT` → 埋め込み共有 PAT**。
 * 埋め込みを用意しているのは、Community が「全 KuroCMS が共有する 1 つのライブラリ」
 * であり、インストールごとに鍵を配る UI も API も無いため — 必須にすると新規
 * インストールでは「公開」が常に 503 になる（実際にそうなっていた）。
 * 運用者が自分のトークンを Worker Secret で入れた場合はそちらが勝つ。
 */
function communityPat(env: Env): string {
  return (env.COMMUNITY_PAT || COMMUNITY_SHARED_PAT || "").trim();
}

function communityFetch(
  env: Env,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const req = new Request(`${KUROCMS_COMMUNITY_BASE_URL}/api/v1/${path}`, init);
  return env.COMMUNITY_API ? env.COMMUNITY_API.fetch(req) : fetch(req);
}

// テンプレート名から Community tid(slug) を生成。例: "Kuro Boo" → "kuro-boo"。
// 英数字以外（日本語など）しか無く slug が空になる場合は空文字を返す（呼び出し側でフォールバック）。
function slugifyName(name: string): string {
  return (name || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// JSON 文字列を配列としてパース（不正なら空配列）
function parseJsonArray(value: string | null | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// base64 data URL（data:image/jpeg;base64,...）→ バイト列
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const commaIdx = dataUrl.indexOf(",");
  const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

// ローカルテンプレート(D1)を Community Library へ upsert（初回公開 or 更新）。
// source_html + meta + 画像(D1 thumbnail_blob をデコード)をすべて送る正規ルート。
// ___temp_regist___ / html2canvas ステージングは使わない。AI からも curl で操作可能。
async function siteTemplatePublish(
  env: Env,
  user: AuthUser,
  id: string,
): Promise<Response> {
  requireAdmin(user);
  if (!communityPat(env))
    throw new HttpError(
      503,
      "no_community_pat",
      "Community PAT is not available (neither the COMMUNITY_PAT Worker Secret nor the built-in shared PAT).",
    );
  const tpl = await env.DB.prepare(
    `SELECT id, name, author, author_id, version, description, tags_json, bg,
            content_keys_json, api_version, source_html, thumbnail_blob,
            community_id, source_url
       FROM page_templates WHERE id = ?`,
  )
    .bind(id)
    .first<{
      id: string;
      name: string;
      author: string | null;
      author_id: string | null;
      version: string | null;
      description: string | null;
      tags_json: string | null;
      bg: string | null;
      content_keys_json: string | null;
      api_version: number | null;
      source_html: string | null;
      thumbnail_blob: string | null;
      community_id: string | null;
      source_url: string | null;
    }>();
  if (!tpl) throw new HttpError(404, "not_found", "Template not found.");
  if (!tpl.source_html || !tpl.source_html.trim())
    throw new HttpError(
      400,
      "no_source",
      "Template has no source HTML to publish.",
    );
  // tid の決定順:
  //   1) 既存の community_id（公開済み）
  //   2) Community からコピーした場合は source_url の tid（.../get/{tid}/src.html）
  //      ← 名前と tid が不一致でも正しい既存テンプレを更新できる（例: "Docs & Wiki" → docs）
  //   3) 新規公開はテンプレ名の slug（例: "Kuro Boo" → "kuro-boo"）
  //   4) ローカル id
  const sourceTid =
    tpl.source_url?.match(/\/get\/([^/]+)\/src\.html/)?.[1] ?? "";
  const targetTid =
    tpl.community_id || sourceTid || slugifyName(tpl.name) || id;
  const authorProfile = await getTemplateAuthorProfile(env, user);

  // Community 上の既存メタを取得（存在判定 + author_id）
  const metaGet = await communityFetch(
    env,
    `get/${encodeURIComponent(targetTid)}/meta.json`,
    { headers: { Accept: "application/json" } },
  );
  const exists = metaGet.ok;
  let communityAuthorId = "";
  if (exists) {
    const meta = (await metaGet.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    communityAuthorId = String(meta.authorId || meta.author_id || "").trim();
  } else {
    await metaGet.text().catch(() => "");
  }

  // 所有者チェック（更新時）。author_id が一致しなければ更新不可。
  // 保守者が既存テンプレ（authorId が異なる）を更新したい場合は、先に
  // PUT /api/me で自分の author_id を対象テンプレの author_id に合わせる。
  const authorIdToSend = authorProfile.authorId;
  if (
    exists &&
    communityAuthorId &&
    communityAuthorId !== authorProfile.authorId
  ) {
    throw new HttpError(
      403,
      "template_owner_required",
      "Only the template owner can update this community template.",
    );
  }

  // 初回公開（insert）時の同名衝突チェック
  if (!exists) {
    const listRes = await communityFetch(env, "list", {
      headers: { Accept: "application/json" },
    });
    if (listRes.ok) {
      const data = (await listRes.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const items = (
        Array.isArray(data) ? data : (data.templates ?? [])
      ) as Array<Record<string, unknown>>;
      const nameLc = (tpl.name || "").trim().toLowerCase();
      const clash = items.some(
        (it) =>
          String(it.name ?? "")
            .trim()
            .toLowerCase() === nameLc && String(it.id ?? "") !== targetTid,
      );
      if (clash)
        throw new HttpError(
          409,
          "name_conflict",
          "A community template with the same name already exists.",
        );
    }
  }

  if (!tpl.author_id) {
    await env.DB.prepare(
      "UPDATE page_templates SET author_id = ?, updated_at = ? WHERE id = ?",
    )
      .bind(authorProfile.authorId, nowIso(), id)
      .run();
  }

  const tags = parseJsonArray(tpl.tags_json);
  // Community へ送るのも正規形に統一する。ここを素通しにしていたため、文字列配列で
  // 登録されたテンプレートが Community 側にもその形のまま増えていた。
  const contentKeys = parseContentKeys(tpl.content_keys_json);
  const apiVersion = Number(tpl.api_version) || 1;
  const authHeader = `Bearer ${communityPat(env)}`;
  const jsonCt = {
    Authorization: authHeader,
    "Content-Type": "application/json",
  };

  // 新規なら insert
  if (!exists) {
    const insRes = await communityFetch(
      env,
      `insert/${encodeURIComponent(targetTid)}`,
      {
        method: "POST",
        headers: jsonCt,
        body: JSON.stringify({
          name: tpl.name,
          author: authorProfile.displayName,
          authorId: authorIdToSend,
          version: tpl.version ?? "1.0.0",
          description: tpl.description ?? "",
          apiVersion,
        }),
      },
    );
    // ⚠ insert の結果を握り潰さない。ここを無視すると、たとえば「同じ tid を別の
    //   所有者が既に使っている(409)」のような**本当の原因**が失われ、続く meta 更新が
    //   404 になって `meta update HTTP 404` という無関係なエラーだけが利用者に出る
    //   （実際にそうなっていた）。Community の応答本文をそのまま添えて即中断する。
    if (!insRes.ok) {
      const detail = (await insRes.text().catch(() => "")).slice(0, 500);
      throw new HttpError(
        insRes.status === 409 ? 409 : 502,
        insRes.status === 409 ? "community_conflict" : "community_error",
        insRes.status === 409
          ? `Community 側で tid "${targetTid}" を登録できませんでした（別の所有者が使用中、または削除済みで所有者が一致しません）。${detail}`
          : `insert HTTP ${insRes.status}: ${detail}`,
      );
    }
    await insRes.text().catch(() => "");
  }

  // meta
  const metaRes = await communityFetch(
    env,
    `update/${encodeURIComponent(targetTid)}/meta.json`,
    {
      method: "POST",
      headers: jsonCt,
      body: JSON.stringify({
        name: tpl.name,
        author: authorProfile.displayName,
        authorId: authorIdToSend,
        version: tpl.version ?? "1.0.0",
        description: tpl.description ?? "",
        tags,
        bg: tpl.bg ?? "",
        contentKeys,
        apiVersion,
      }),
    },
  );
  if (!metaRes.ok)
    throw new HttpError(
      502,
      "community_error",
      `meta update HTTP ${metaRes.status}: ${(await metaRes.text().catch(() => "")).slice(0, 200)}`,
    );
  await metaRes.text().catch(() => "");

  // src.html
  const srcRes = await communityFetch(
    env,
    `update/${encodeURIComponent(targetTid)}/src.html`,
    {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "text/html; charset=utf-8",
      },
      body: tpl.source_html,
    },
  );
  if (!srcRes.ok)
    throw new HttpError(
      502,
      "community_error",
      `src update HTTP ${srcRes.status}: ${(await srcRes.text().catch(() => "")).slice(0, 200)}`,
    );
  await srcRes.text().catch(() => "");

  // image.jpg（D1 thumbnail_blob をデコードして送信）
  let imageSent = false;
  if (tpl.thumbnail_blob) {
    const imgRes = await communityFetch(
      env,
      `update/${encodeURIComponent(targetTid)}/image.jpg`,
      {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "image/jpeg" },
        body: dataUrlToBytes(tpl.thumbnail_blob),
      },
    );
    if (!imgRes.ok)
      throw new HttpError(
        502,
        "community_error",
        `image update HTTP ${imgRes.status}: ${(await imgRes.text().catch(() => "")).slice(0, 200)}`,
      );
    await imgRes.text().catch(() => "");
    imageSent = true;
  }

  // author はユーザーの display_name 由来の単一ソース。ローカルのキャッシュ列も同期する。
  await env.DB.prepare(
    "UPDATE page_templates SET community_published = 1, community_id = ?, author = ?, updated_at = ? WHERE id = ?",
  )
    .bind(targetTid, authorProfile.displayName, nowIso(), id)
    .run();
  await logActivity(
    env,
    user,
    exists ? "template.community_update" : "template.community_publish",
    "template",
    id,
    { communityId: targetTid },
  );
  return json({
    ok: true,
    communityId: targetTid,
    created: !exists,
    imageSent,
  });
}

// ArrayBuffer → base64（大きな画像でもコールスタックを溢れさせないようチャンク変換）
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// 更新日時を JST の YYYYMMDDHHMMSS（例: 20260609170100）で返す。
// サムネイル URL のキャッシュバスター（?updated=...）に使う。可読で生成時刻が分かる。
function compactStampJst(date: Date = new Date()): string {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${jst.getUTCFullYear()}${p(jst.getUTCMonth() + 1)}${p(jst.getUTCDate())}` +
    `${p(jst.getUTCHours())}${p(jst.getUTCMinutes())}${p(jst.getUTCSeconds())}`
  );
}

async function siteTemplateLocalThumbnail(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  // サムネイルは D1 (page_templates.thumbnail_blob) に base64 data URL で保存する。
  // R2 は使わない（R2 未設定のユーザーでもテンプレートを利用できるようにするため）。
  const row = await env.DB.prepare("SELECT id FROM page_templates WHERE id = ?")
    .bind(id)
    .first<{ id: string }>();
  if (!row) throw new HttpError(404, "not_found", "Template not found.");
  const body = await request.arrayBuffer();
  if (!body.byteLength)
    throw new HttpError(400, "bad_request", "No image data.");
  const dataUrl = `data:image/jpeg;base64,${arrayBufferToBase64(body)}`;
  const ts = nowIso();
  // preview_url は D1 サムネイル配信エンドポイントを指す。再キャプチャ時のキャッシュ無効化に
  // 更新日時 ?updated=YYYYMMDDHHMMSS を付ける（GET /thumbnail はクエリを無視する）。
  const previewUrl = `/api/v1/templates/${encodeURIComponent(id)}/thumbnail?updated=${compactStampJst()}`;
  await env.DB.prepare(
    "UPDATE page_templates SET thumbnail_blob = ?, preview_url = ?, updated_at = ? WHERE id = ?",
  )
    .bind(dataUrl, previewUrl, ts, id)
    .run();
  return json({ ok: true, previewUrl });
}

async function siteTemplateGetSource(
  env: Env,
  user: AuthUser,
  id: string,
): Promise<Response> {
  requireAuthor(user);
  const row = await env.DB.prepare(
    "SELECT id, name, author, author_id, version, description, source_html FROM page_templates WHERE id = ?",
  )
    .bind(id)
    .first<{
      id: string;
      name: string;
      author: string;
      author_id: string | null;
      version: string;
      description: string;
      source_html: string | null;
    }>();
  if (!row) throw new HttpError(404, "not_found", "Template not found.");
  return json({
    id: row.id,
    name: row.name,
    author: row.author,
    authorId: row.author_id ?? "",
    version: row.version,
    description: row.description,
    html: row.source_html ?? null,
  });
}

function parseApiVersion(value: unknown): number {
  const version = value === undefined || value === null ? 1 : value;
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 1
  ) {
    throw new HttpError(
      400,
      "bad_request",
      "apiVersion must be a positive integer.",
    );
  }
  return version;
}

async function siteTemplateSaveSource(
  request: Request,
  env: Env,
  user: AuthUser,
  id: string,
): Promise<Response> {
  requireAdmin(user);
  const row = await env.DB.prepare("SELECT id FROM page_templates WHERE id = ?")
    .bind(id)
    .first();
  if (!row) throw new HttpError(404, "not_found", "Template not found.");
  const body = await readJson(request);
  const html = requireString(body, "html", { min: 0, max: 2000000 });
  if (!isKuroCmsHtmlTemplate(html)) {
    throw new HttpError(
      400,
      "invalid_template_source",
      "Only unrendered KuroCMS template HTML can be saved.",
    );
  }
  const now = nowIso();
  await env.DB.prepare(
    "UPDATE page_templates SET source_html = ?, user_modified = 1, updated_at = ? WHERE id = ?",
  )
    .bind(html, now, id)
    .run();
  await logActivity(env, user, "template.edit_source", "template", id, {});
  return json({ ok: true });
}

// ── Static Tailwind CSS (compiled in the admin browser, served at /_tw/) ────

/**
 * Token list + compile state for a template. The admin client compiles CSS
 * from exactly these tokens (Play-CDN JIT in a hidden iframe) and PUTs it
 * back; `covered` tells it whether a recompile is needed at all — with a
 * stable class set this stays true across ordinary template edits.
 */
async function siteTemplateTwTokens(
  env: Env,
  user: AuthUser,
  id: string,
): Promise<Response> {
  requireAdmin(user);
  const row = await env.DB.prepare(
    "SELECT id, source_html, compiled_css, compiled_tokens, compiled_hash, compiled_tw_version FROM page_templates WHERE id = ?",
  )
    .bind(id)
    .first<{
      id: string;
      source_html: string | null;
      compiled_css: string | null;
      compiled_tokens: string | null;
      compiled_hash: string | null;
      compiled_tw_version: string | null;
    }>();
  if (!row) throw new HttpError(404, "not_found", "Template not found.");
  const tokens = extractTwTokens(row.source_html || "");
  const cdnUrl = findTwCdnUrl(row.source_html || "");
  let covered = false;
  if (row.compiled_hash && row.compiled_tokens) {
    try {
      const have = new Set(JSON.parse(row.compiled_tokens) as string[]);
      covered = tokens.every((t) => have.has(t));
    } catch {
      covered = false;
    }
  }
  // Backfill the baseline version from the already-compiled CSS banner, so the
  // baseline = whatever Tailwind actually produced the currently-working CSS
  // (not "latest at next recompile"). One-time, for templates compiled before
  // migration 0058.
  let compiledTwVersion = row.compiled_tw_version ?? null;
  if (!compiledTwVersion && row.compiled_css) {
    compiledTwVersion = extractTwBannerVersion(row.compiled_css);
    if (compiledTwVersion) {
      await env.DB.prepare(
        "UPDATE page_templates SET compiled_tw_version = ? WHERE id = ?",
      )
        .bind(compiledTwVersion, id)
        .run()
        .catch(() => {});
    }
  }
  return json({
    id: row.id,
    cdnUrl,
    covered,
    compiledHash: row.compiled_hash ?? null,
    compiledTwVersion,
    tokens,
  });
}

/**
 * Extract the Tailwind version from a compiled stylesheet's banner comment
 * (`/*! tailwindcss v3.4.16 | ... `), which every Tailwind build emits. Returns
 * "" when absent (e.g. a future Play-CDN drops it) — callers then skip pinning.
 */
function extractTwBannerVersion(css: string): string {
  const m = String(css || "").match(/tailwindcss\s+v([0-9]+\.[0-9]+\.[0-9]+)/i);
  return m ? m[1] : "";
}

async function siteTemplateSaveCompiledCss(
  request: Request,
  env: Env,
  user: AuthUser,
  id: string,
): Promise<Response> {
  requireAdmin(user);
  const row = await env.DB.prepare("SELECT id FROM page_templates WHERE id = ?")
    .bind(id)
    .first();
  if (!row) throw new HttpError(404, "not_found", "Template not found.");
  const body = await readJson(request);
  const css = requireString(body, "css", { min: 1, max: 512 * 1024 });
  // Store the token list the client ACTUALLY compiled from (echoed back from
  // GET /tw-tokens), so (css, tokens) stay consistent even if the source was
  // edited between the GET and this PUT — the coverage check then correctly
  // falls back to the CDN script for the changed source.
  const rawTokens = Array.isArray(body.tokens) ? body.tokens : [];
  const tokens = rawTokens
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .slice(0, 20000);
  if (!tokens.length) {
    throw new HttpError(
      400,
      "invalid_field",
      "tokens must be a non-empty array.",
    );
  }
  const tokensJson = JSON.stringify(tokens);
  if (tokensJson.length > 256 * 1024) {
    throw new HttpError(400, "invalid_field", "tokens is too large.");
  }
  const hash = cheapHash(css);
  // Record the producing Tailwind version (banner comment is authoritative;
  // the client-sent value is a fallback when a future CDN omits the banner).
  // This becomes the pin baseline for the next recompile — see ensureTwCss.
  const twVersion =
    extractTwBannerVersion(css) ||
    (optionalString(body, "twVersion") ?? "").slice(0, 20);
  await env.DB.prepare(
    "UPDATE page_templates SET compiled_css = ?, compiled_tokens = ?, compiled_hash = ?, compiled_tw_version = ? WHERE id = ?",
  )
    .bind(css, tokensJson, hash, twVersion || null, id)
    .run();
  await logActivity(env, user, "template.compiled_css", "template", id, {
    bytes: css.length,
    tokenCount: tokens.length,
    hash,
    twVersion: twVersion || null,
  });
  return json({
    id,
    hash,
    bytes: css.length,
    tokenCount: tokens.length,
    twVersion,
  });
}

/** Clear the compiled CSS — public pages fall back to the CDN script. */
async function siteTemplateClearCompiledCss(
  env: Env,
  user: AuthUser,
  id: string,
): Promise<Response> {
  requireAdmin(user);
  await env.DB.prepare(
    "UPDATE page_templates SET compiled_css = NULL, compiled_tokens = NULL, compiled_hash = NULL WHERE id = ?",
  )
    .bind(id)
    .run();
  await logActivity(
    env,
    user,
    "template.compiled_css_clear",
    "template",
    id,
    {},
  );
  return json({ id, cleared: true });
}

async function siteTemplateUpdateMeta(
  request: Request,
  env: Env,
  user: AuthUser,
  id: string,
): Promise<Response> {
  requireAdmin(user);
  const row = await env.DB.prepare("SELECT id FROM page_templates WHERE id = ?")
    .bind(id)
    .first();
  if (!row) throw new HttpError(404, "not_found", "Template not found.");
  const body = await readJson(request);
  const name = requireString(body, "name", { min: 1, max: 120 });
  // author は display_name 由来の単一ソースのため、ここでは更新しない（body の author は無視）。
  await env.DB.prepare(
    `
    UPDATE page_templates SET
      name             = ?,
      description      = COALESCE(?, description),
      version          = COALESCE(?, version),
      tags_json        = COALESCE(?, tags_json),
      bg               = COALESCE(?, bg),
      content_keys_json = COALESCE(?, content_keys_json),
      api_version = COALESCE(?, api_version),
      source_url       = COALESCE(?, source_url),
      updated_at       = ?
    WHERE id = ?
  `,
  )
    .bind(
      name,
      "description" in body
        ? (optionalString(body, "description") ?? "")
        : null,
      "version" in body ? (optionalString(body, "version") ?? "1.0.0") : null,
      "tags" in body
        ? JSON.stringify(
            Array.isArray(body.tags)
              ? (body.tags as string[]).filter((t) => typeof t === "string")
              : [],
          )
        : null,
      "bg" in body ? (optionalString(body, "bg") ?? "") : null,
      "contentKeys" in body
        ? JSON.stringify(normalizeContentKeys(body.contentKeys))
        : null,
      "apiVersion" in body ? parseApiVersion(body.apiVersion) : null,
      // sourceUrl も更新できるようにする（v1.8.83）。publish の tid 解決は
      // community_id → **source_url の tid** → 名前の slug の順なので、Community から
      // コピーしたテンプレートをリネームしても source_url が残っていると tid が旧名の
      // ままになる。空文字を渡せばクリアでき、以後は名前の slug が使われる。
      "sourceUrl" in body ? (optionalString(body, "sourceUrl") ?? "") : null,
      nowIso(),
      id,
    )
    .run();
  await logActivity(env, user, "template.update_meta", "template", id, {
    name,
  });
  return json({ ok: true });
}

// ── Site management: single content ─────────────────────────────────────────

async function siteContentList(
  request: Request,
  env: Env,
  user: AuthUser,
): Promise<Response> {
  requireAuthor(user);
  const url = new URL(request.url);
  const lang = url.searchParams.get("lang") ?? "";
  // Fetch default lang to know what counts as "base"
  const settingsRow = await env.DB.prepare(
    "SELECT default_lang FROM site_settings WHERE id = 1",
  ).first<{ default_lang: string }>();
  const defaultLang = settingsRow?.default_lang || "en";
  // Return ALL keys (from defaultLang), with the requested lang's value where available.
  // is_inherited=1 means the key exists only in defaultLang, not in the requested lang.
  const rows = await env.DB.prepare(
    `SELECT
       base.id,
       base.is_system,
       base.created_at,
       base.updated_at,
       COALESCE(tgt.name, '')   AS name,
       CASE WHEN tgt.id IS NULL THEN 1 ELSE 0 END AS is_inherited
     FROM taxonomy_items base
     LEFT JOIN taxonomy_items tgt
       ON tgt.id = base.id AND tgt.kind = 'template' AND tgt.lang = ?
     WHERE base.kind = 'template' AND base.lang = ?
     ORDER BY base.id`,
  )
    .bind(lang, lang === defaultLang ? lang : defaultLang)
    .all();
  return json({ items: rows.results as JsonValue, lang, defaultLang });
}

async function siteContentCreate(
  request: Request,
  env: Env,
  user: AuthUser,
): Promise<Response> {
  requireAdmin(user);
  const body = await readJson(request);
  const id = requireSlug(requireString(body, "id", { min: 1, max: 120 }), "id");
  const now = nowIso();
  // Fetch all registered languages
  const langRows = await env.DB.prepare(
    `SELECT id FROM taxonomy_items WHERE kind = 'language' ORDER BY id`,
  ).all<{ id: string }>();
  const langs = (langRows.results ?? []).map((r) => r.id);
  // If no languages registered yet, fall back to site default lang
  if (!langs.length) {
    const settingsRow = await env.DB.prepare(
      "SELECT default_lang FROM site_settings WHERE id = 1",
    ).first<{ default_lang: string }>();
    langs.push(settingsRow?.default_lang || "en");
  }
  // Create an entry for every registered language (empty value — user fills per language tab)
  for (const lang of langs) {
    await env.DB.prepare(
      `INSERT INTO taxonomy_items (id, kind, lang, name, is_system, created_at, updated_at)
       VALUES (?, 'template', ?, '', 0, ?, ?)
       ON CONFLICT(id, kind, lang) DO NOTHING`,
    )
      .bind(id, lang, now, now)
      .run();
  }
  await logActivity(env, user, "site_content.create", "template", id, {
    langs,
  });
  return json({ ok: true, id }, { status: 201 });
}

// Per-language site-text values, mirroring documentTranslations: the language
// is a PATH segment, never taken from the body. A missing :lang is a LIST
// (GET only) — a mutation without :lang is rejected so a value is never written
// or cleared implicitly.
async function siteContentTranslations(
  request: Request,
  env: Env,
  user: AuthUser,
  id: string,
  lang?: string,
): Promise<Response> {
  // GET is the only method allowed without :lang (it lists a key's languages);
  // handle it first so the guard below can narrow `lang` to a definite string
  // for the mutation branches.
  if (request.method === "GET") {
    requireAuthor(user);
    if (!lang) {
      const rows = await env.DB.prepare(
        "SELECT lang, name, is_system, created_at, updated_at FROM taxonomy_items WHERE id = ? AND kind = 'template' ORDER BY lang",
      )
        .bind(id)
        .all();
      return json({ id, translations: rows.results as JsonValue });
    }
    const row = await env.DB.prepare(
      "SELECT id, lang, name, is_system, created_at, updated_at FROM taxonomy_items WHERE id = ? AND kind = 'template' AND lang = ?",
    )
      .bind(id, lang)
      .first();
    if (!row) {
      throw new HttpError(404, "not_found", "Site-text value was not found.");
    }
    return json({ content: row as JsonValue });
  }

  // Mutations MUST target an explicit language so a value is never written or
  // cleared implicitly (this also narrows `lang` to string below).
  if (!lang) {
    throw new HttpError(
      400,
      "lang_required",
      "Language is required: use /api/v1/content/:id/translations/{lang}.",
    );
  }

  if (request.method === "PUT") {
    requireAdmin(user);
    const body = await readJson(request);
    // Site-text values are rich KuroEditor HTML (same render path as article
    // bodies, incl. [[mid]] refs), so they are not capped at a short length. An
    // empty value is allowed (min: 0) so a content block can be intentionally
    // cleared/left blank. is_system is preserved: ON CONFLICT updates only the
    // value/timestamp, so a system key stays flagged.
    const name = requireString(body, "name", { min: 0 });
    const now = nowIso();
    await env.DB.prepare(
      `INSERT INTO taxonomy_items (id, kind, lang, name, is_system, created_at, updated_at)
       VALUES (?, 'template', ?, ?, 0, ?, ?)
       ON CONFLICT(id, kind, lang) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
    )
      .bind(id, lang, name, now, now)
      .run();
    await logActivity(env, user, "site_content.update", "template", id, {
      lang,
    });
    return json({ ok: true, id, lang });
  }

  if (request.method === "DELETE") {
    requireAdmin(user);
    const existing = await env.DB.prepare(
      "SELECT id FROM taxonomy_items WHERE id = ? AND kind = 'template' AND lang = ?",
    )
      .bind(id, lang)
      .first();
    if (!existing) {
      throw new HttpError(404, "not_found", "Site-text value was not found.");
    }
    await env.DB.prepare(
      "DELETE FROM taxonomy_items WHERE id = ? AND kind = 'template' AND lang = ?",
    )
      .bind(id, lang)
      .run();
    await logActivity(env, user, "site_content.delete", "template", id, {
      lang,
    });
    return json({ ok: true, id, lang });
  }

  throw new HttpError(405, "method_not_allowed", "Method is not allowed.");
}

async function siteContentDelete(
  _request: Request,
  env: Env,
  user: AuthUser,
  id: string,
): Promise<Response> {
  requireAdmin(user);
  // Keys are global — always delete all language variants
  const row = await env.DB.prepare(
    "SELECT id FROM taxonomy_items WHERE id = ? AND kind = 'template'",
  )
    .bind(id)
    .first();
  if (!row) throw new HttpError(404, "not_found", "Content not found.");
  await env.DB.prepare(
    "DELETE FROM taxonomy_items WHERE id = ? AND kind = 'template'",
  )
    .bind(id)
    .run();
  await logActivity(env, user, "site_content.delete", "template", id, {
    langs: "all",
  });
  return json({ ok: true });
}

const ALLOWED_MEDIA: Record<
  "image" | "video" | "audio",
  { exts: string[]; mimes: string[] }
> = {
  image: {
    exts: ["jpg", "jpeg", "png", "gif", "webp", "avif"],
    mimes: ["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"],
  },
  video: {
    exts: ["mp4", "webm", "mov", "m4v"],
    mimes: ["video/mp4", "video/webm", "video/quicktime", "video/x-m4v"],
  },
  audio: {
    exts: ["mp3", "wav", "ogg", "m4a", "aac", "flac"],
    mimes: [
      "audio/mpeg",
      "audio/wav",
      "audio/ogg",
      "audio/mp4",
      "audio/aac",
      "audio/flac",
      "audio/x-flac",
    ],
  },
};

// Per-kind upload size ceilings. Deliberately generous so normal media uploads
// are unaffected; this only rejects abusive/accidental oversized uploads before
// streaming them into R2.
const MAX_MEDIA_BYTES: Record<"image" | "video" | "audio", number> = {
  image: 25 * 1024 * 1024, //  25 MB
  video: 300 * 1024 * 1024, // 300 MB
  audio: 100 * 1024 * 1024, // 100 MB
};

async function uploadMediaFile(
  request: Request,
  env: Env,
  user: AuthUser,
  kindOverride?: "image" | "video" | "audio",
): Promise<Response> {
  requireAuthor(user);
  if (!env.MEDIA_BUCKET) {
    throw new HttpError(
      503,
      "r2_not_configured",
      "メディアの保存先（R2）が接続されていません。管理画面の「設定 → 基本 → R2 ストレージ」から接続してください。Cloudflare で R2 をまだ有効にしていない場合は、ダッシュボードで有効化してから同じボタンを押してください。",
    );
  }
  const formData = await request.formData();
  const fileEntry = formData.get("file");
  if (!fileEntry || typeof fileEntry === "string")
    throw new HttpError(400, "missing_file", "No file provided.");
  const file = fileEntry as unknown as File;
  const kind =
    kindOverride ??
    (((formData.get("kind") as string) || "image") as
      | "image"
      | "video"
      | "audio");
  const ext = (file.name.split(".").pop() || "bin").toLowerCase();
  const mime = file.type || "application/octet-stream";
  const allowed = ALLOWED_MEDIA[kind];
  if (!allowed.exts.includes(ext)) {
    throw new HttpError(
      400,
      "invalid_file_type",
      `Unsupported file extension ".${ext}" for ${kind}. Allowed: ${allowed.exts.join(", ")}`,
    );
  }
  if (!allowed.mimes.includes(mime)) {
    throw new HttpError(
      400,
      "invalid_file_type",
      `Unsupported MIME type "${mime}" for ${kind}.`,
    );
  }
  const sizeBytes = file.size;
  const maxBytes = MAX_MEDIA_BYTES[kind];
  if (sizeBytes > maxBytes) {
    throw new HttpError(
      413,
      "file_too_large",
      `File is too large for ${kind} (${Math.round(sizeBytes / 1048576)}MB). Limit: ${Math.round(maxBytes / 1048576)}MB.`,
    );
  }
  const width = kind === "image" ? Number(formData.get("width")) || null : null;
  const height =
    kind === "image" ? Number(formData.get("height")) || null : null;
  const folder =
    kind === "image" ? "images" : kind === "video" ? "videos" : "audios";

  // Content-hash dedup (images only — buffering a 300MB video to hash it is
  // not worth it): byte-identical re-uploads reuse the existing asset instead
  // of growing the library with duplicate rows + R2 objects. Judged by CONTENT,
  // never by filename — same-named but different images are stored separately.
  let contentHash: string | null = null;
  let imageBuffer: ArrayBuffer | null = null;
  if (kind === "image") {
    imageBuffer = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", imageBuffer);
    contentHash = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const dup = await env.DB.prepare(
      "SELECT mid, public_path AS publicPath, cache_version AS version FROM media_assets WHERE kind = 'image' AND content_hash = ? LIMIT 1",
    )
      .bind(contentHash)
      .first<{ mid: string; publicPath: string; version: string }>()
      .catch(() => null); // pre-0057 DB (no column) → behave as before
    if (dup) {
      // Audit trail: without this, a deduped drop leaves no trace and looks
      // like "nothing happened" when debugging from activity_logs.
      await logActivity(env, user, "image.reuse", kind, dup.mid, {
        filename: file.name,
        sizeBytes,
      });
      return json(
        {
          pid: dup.mid,
          mid: dup.mid,
          publicPath: dup.publicPath,
          url: `${dup.publicPath}?v=${dup.version}`,
          reused: true,
        },
        { status: 200 },
      );
    }
  }

  const mid = await nextMediaId(env, kind);
  const version = cacheVersion();
  const publicPath = `/${folder}/${mid}.${ext}`;
  const r2Key = `${folder}/${mid}.${ext}`;
  await (env.MEDIA_BUCKET as R2Bucket).put(
    r2Key,
    imageBuffer ?? file.stream(),
    {
      httpMetadata: { contentType: mime },
      customMetadata: { originalFilename: file.name, version },
    },
  );
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO media_assets (mid, kind, filename, ext, mime, width, height, size_bytes, public_path, cache_version, created_at, updated_at, created_by, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      mid,
      kind,
      file.name,
      ext,
      mime,
      width,
      height,
      sizeBytes,
      publicPath,
      version,
      now,
      now,
      user.uid,
      contentHash,
    )
    .run();
  await logActivity(env, user, `${kind}.upload`, kind, mid, {
    filename: file.name,
    sizeBytes,
  });
  return json(
    { pid: mid, mid, publicPath, url: `${publicPath}?v=${version}` },
    { status: 201 },
  );
}

async function createMediaAsset(
  request: Request,
  env: Env,
  user: AuthUser,
  kind: "image" | "video" | "audio",
): Promise<Response> {
  requireAuthor(user);
  const body = await readJson(request);
  const filename = requireString(body, "filename", { min: 1, max: 200 });
  const mime = requireString(body, "mime", { min: 3, max: 120 });
  const ext = requireSlug(
    requireString(body, "ext", { min: 2, max: 10 }).toLowerCase(),
    "ext",
  );
  // Enforce the same media-type allowlist as the multipart upload path, so this
  // JSON registration route can't introduce ext/mime combinations (e.g. svg/html)
  // that the upload path deliberately rejects.
  const allowed = ALLOWED_MEDIA[kind];
  if (!allowed.exts.includes(ext)) {
    throw new HttpError(
      400,
      "invalid_file_type",
      `Unsupported file extension ".${ext}" for ${kind}. Allowed: ${allowed.exts.join(", ")}`,
    );
  }
  if (!allowed.mimes.includes(mime)) {
    throw new HttpError(
      400,
      "invalid_file_type",
      `Unsupported MIME type "${mime}" for ${kind}.`,
    );
  }
  const sizeBytes = Number(body.sizeBytes ?? 0);
  const width =
    kind === "image" && body.width !== undefined ? Number(body.width) : null;
  const height =
    kind === "image" && body.height !== undefined ? Number(body.height) : null;
  const folder =
    kind === "image" ? "images" : kind === "video" ? "videos" : "audios";
  const mid = await nextMediaId(env, kind);
  const version = cacheVersion();
  const publicPath = `/${folder}/${mid}.${ext}`;
  const now = nowIso();

  await env.DB.prepare(
    `INSERT INTO media_assets
      (mid, kind, filename, ext, mime, width, height, size_bytes, public_path, cache_version,
       created_at, updated_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      mid,
      kind,
      filename,
      ext,
      mime,
      width,
      height,
      sizeBytes,
      publicPath,
      version,
      now,
      now,
      user.uid,
    )
    .run();

  await logActivity(env, user, `${kind}.create`, kind, mid, { filename });
  return json(
    { pid: mid, mid, publicPath, url: `${publicPath}?v=${version}` },
    { status: 201 },
  );
}

// ── Backup / Restore ─────────────────────────────────────────────────────────
// Content + settings + media binaries are exported as a ZIP assembled client-side
// (see src/admin/lib/zipstore.ts). Auth/secret tables are intentionally excluded.
// Tables are listed in INSERT order (parents → children) so a full-replace restore
// can re-insert without tripping references; deletion walks the reverse order.
const BACKUP_TABLES_INSERT_ORDER = [
  "site_settings",
  "page_templates",
  "external_connections", // SNS連携（[[sid]] ウィジェット / SNS投稿）。トークンを含む
  "categories",
  "taxonomy_items",
  "documents",
  "media_assets",
  "document_categories",
  "document_translations",
  "document_translation_revisions",
  "search_entries",
];
const BACKUP_TABLE_SET = new Set(BACKUP_TABLES_INSERT_ORDER);
const BACKUP_PAGE_SIZE = 500;
const RESTORE_KV_WIPE_PAGE = 500; // each KV delete is a subrequest — stay < 1000
const RESTORE_R2_WIPE_PAGE = 1000; // R2 delete takes an array (one subrequest)

async function backupManifest(env: Env): Promise<Response> {
  const tables: { name: string; count: number }[] = [];
  for (const name of BACKUP_TABLES_INSERT_ORDER) {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM ${name}`,
    ).first<{ c: number }>();
    tables.push({ name, count: Number(row?.c ?? 0) });
  }
  const m = await env.DB.prepare(
    "SELECT COUNT(*) AS c, COALESCE(SUM(size_bytes),0) AS b FROM media_assets",
  ).first<{ c: number; b: number }>();
  return json({
    format: "kurocms.full.v1",
    kurocmsVersion: KUROCMS_VERSION,
    createdAt: nowIso(),
    tables: tables as unknown as JsonValue,
    media: { count: Number(m?.c ?? 0), totalBytes: Number(m?.b ?? 0) },
  });
}

async function backupTable(
  env: Env,
  name: string,
  url: URL,
): Promise<Response> {
  if (!BACKUP_TABLE_SET.has(name)) {
    throw new HttpError(400, "bad_table", `Unknown table: ${name}`);
  }
  const cursor = Math.max(
    0,
    parseInt(url.searchParams.get("cursor") || "0", 10) || 0,
  );
  const res = await env.DB.prepare(
    `SELECT * FROM ${name} ORDER BY rowid LIMIT ? OFFSET ?`,
  )
    .bind(BACKUP_PAGE_SIZE + 1, cursor)
    .all();
  const rows = (res.results ?? []) as Record<string, unknown>[];
  const hasMore = rows.length > BACKUP_PAGE_SIZE;
  if (hasMore) rows.pop();
  return json({
    rows: rows as unknown as JsonValue,
    nextCursor: hasMore ? cursor + BACKUP_PAGE_SIZE : null,
  });
}

async function backupMedia(env: Env, mid: string): Promise<Response> {
  if (!env.MEDIA_BUCKET) {
    throw new HttpError(
      503,
      "r2_not_configured",
      "メディアの保存先（R2）が接続されていません。管理画面の「設定 → 基本 → R2 ストレージ」から接続してください。Cloudflare で R2 をまだ有効にしていない場合は、ダッシュボードで有効化してから同じボタンを押してください。",
    );
  }
  const row = await env.DB.prepare(
    "SELECT public_path, mime FROM media_assets WHERE mid = ?",
  )
    .bind(mid)
    .first<{ public_path: string; mime: string }>();
  if (!row) return jsonError(404, "not_found", "Media asset not found.");
  const key = row.public_path.replace(/^\//, "");
  let obj: R2ObjectBody | null;
  try {
    obj = await (env.MEDIA_BUCKET as R2Bucket).get(key);
  } catch {
    obj = null;
  }
  if (!obj) return jsonError(404, "not_found", "Media object missing in R2.");
  return new Response(obj.body, {
    headers: { "content-type": row.mime || "application/octet-stream" },
  });
}

async function restoreWipeDb(env: Env): Promise<Response> {
  const stmts = [...BACKUP_TABLES_INSERT_ORDER]
    .reverse()
    .map((n) => env.DB.prepare(`DELETE FROM ${n}`));
  await env.DB.batch(stmts);
  // page_build_cache is a derived cache; clear it so a later build won't skip.
  await env.DB.prepare("DELETE FROM page_build_cache")
    .run()
    .catch(() => {});
  return json({ ok: true });
}

async function restoreWipeMedia(env: Env, url: URL): Promise<Response> {
  if (!env.MEDIA_BUCKET) return json({ ok: true, done: true, cursor: null });
  const cursor = url.searchParams.get("cursor") || undefined;
  const listed = await (env.MEDIA_BUCKET as R2Bucket).list({
    limit: RESTORE_R2_WIPE_PAGE,
    cursor,
  });
  const keys = listed.objects.map((o) => o.key);
  if (keys.length) await (env.MEDIA_BUCKET as R2Bucket).delete(keys);
  return json({
    ok: true,
    done: !listed.truncated,
    cursor: listed.truncated
      ? ((listed as { cursor?: string }).cursor ?? null)
      : null,
    deleted: keys.length,
  });
}

async function restoreWipePages(env: Env, url: URL): Promise<Response> {
  if (!env.PUBLIC_PAGES) return json({ ok: true, done: true, cursor: null });
  const cursor = url.searchParams.get("cursor") || undefined;
  const listed = await env.PUBLIC_PAGES.list({
    limit: RESTORE_KV_WIPE_PAGE,
    cursor,
  });
  for (const k of listed.keys) {
    await env.PUBLIC_PAGES.delete(k.name);
  }
  const done = listed.list_complete;
  return json({
    ok: true,
    done,
    cursor: done ? null : ((listed as { cursor?: string }).cursor ?? null),
    deleted: listed.keys.length,
  });
}

async function restoreTable(
  request: Request,
  env: Env,
  name: string,
): Promise<Response> {
  if (!BACKUP_TABLE_SET.has(name)) {
    throw new HttpError(400, "bad_table", `Unknown table: ${name}`);
  }
  const body = (await request.json()) as { rows?: Record<string, unknown>[] };
  const rows = body.rows ?? [];
  if (!rows.length) return json({ ok: true, inserted: 0 });

  // 復元元と復元先でスキーマがずれていることがある。実例（2026-08 の本番移行）:
  // 0035 が page_templates に template_api_version を足し、0037 がそれを
  // api_version へ RENAME する。正しく migrate された DB には api_version しか
  // 無いが、0035 が 0037 の後にもう一度適用された環境では【両方】残る。その
  // バックアップを正しい DB へ流すと "no such column" で復元全体が死ぬ。
  //
  // バックアップは常に「別の時点・別の経路で作られた DB」から来るので、
  // 復元は【存在しない列を落として続行】する。⚠ ただし黙って落とさない —
  // 何を捨てたかを応答に載せ、呼び手がログに出す（本当に必要な列だったなら
  // 移行先のスキーマを直す判断ができるように）。
  const info = await env.DB.prepare(
    `SELECT name FROM pragma_table_info('${name}')`,
  ).all<{ name: string }>();
  const known = new Set((info.results ?? []).map((r) => r.name));
  const skipped = new Set<string>();

  const stmts = rows.map((row) => {
    const cols = Object.keys(row).filter((c) => {
      if (known.size === 0 || known.has(c)) return true;
      skipped.add(c);
      return false;
    });
    if (!cols.length) {
      throw new HttpError(400, "bad_row", "Empty row in restore payload.");
    }
    // Column names are interpolated as SQL identifiers, so they must be a strict
    // identifier charset. A key containing a double-quote would otherwise break
    // out of the "..." quoting and inject SQL into the batch (admin-only, but the
    // table name is already allowlisted — keep the column names just as strict).
    for (const c of cols) {
      if (!/^[A-Za-z0-9_]+$/.test(c)) {
        throw new HttpError(
          400,
          "bad_column",
          `Invalid column name in restore payload: ${c}`,
        );
      }
    }
    const sql = `INSERT OR REPLACE INTO ${name} (${cols
      .map((c) => `"${c}"`)
      .join(",")}) VALUES (${cols.map(() => "?").join(",")})`;
    return env.DB.prepare(sql).bind(
      ...cols.map((c) => normalizeRestoreValue(row[c])),
    );
  });
  try {
    await env.DB.batch(stmts);
  } catch (err) {
    // ⚠ 復元の失敗を汎用 500（"An unexpected error occurred."）で潰さない。
    //   移行時にこれをやると「どのテーブルの何が悪いのか」が一切分からず、
    //   利用者側からは打つ手が無くなる（2026-08 の本番移行で実際に詰まった）。
    //   D1 の生メッセージ（no such column / NOT NULL constraint failed: … 等）を
    //   そのまま返す。Admin 限定エンドポイントなので内部名の露出は許容する。
    const msg = err instanceof Error ? err.message : String(err);
    throw new HttpError(
      500,
      "restore_table_failed",
      `${name}: ${msg.slice(0, 400)}`,
    );
  }
  return json({
    ok: true,
    inserted: rows.length,
    skippedColumns: [...skipped],
  });
}

// D1 bind accepts string | number | null | ArrayBuffer. Backup JSON only carries
// scalars from SELECT *, but normalize defensively (bool → int, undefined → null).
function normalizeRestoreValue(v: unknown): string | number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string") return v;
  return JSON.stringify(v);
}

async function restoreMedia(
  request: Request,
  env: Env,
  mid: string,
): Promise<Response> {
  if (!env.MEDIA_BUCKET) {
    throw new HttpError(
      503,
      "r2_not_configured",
      "メディアの保存先（R2）が接続されていません。管理画面の「設定 → 基本 → R2 ストレージ」から接続してください。Cloudflare で R2 をまだ有効にしていない場合は、ダッシュボードで有効化してから同じボタンを押してください。",
    );
  }
  const row = await env.DB.prepare(
    "SELECT public_path, mime FROM media_assets WHERE mid = ?",
  )
    .bind(mid)
    .first<{ public_path: string; mime: string }>();
  if (!row) {
    return jsonError(
      404,
      "not_found",
      "Media row missing — restore tables before media.",
    );
  }
  if (!request.body) {
    throw new HttpError(400, "missing_body", "No file body provided.");
  }
  const key = row.public_path.replace(/^\//, "");
  // public_path comes from the restored media_assets row, which a crafted restore
  // payload could set arbitrarily. Constrain the derived R2 write key to the known
  // media namespaces so a malicious row can't redirect the write elsewhere.
  if (!/^(images|videos|audios)\/[A-Za-z0-9._-]+$/.test(key)) {
    throw new HttpError(
      400,
      "bad_media_path",
      `Refusing to write media to an unexpected key: ${key}`,
    );
  }
  await (env.MEDIA_BUCKET as R2Bucket).put(key, request.body, {
    httpMetadata: { contentType: row.mime || "application/octet-stream" },
  });
  return json({ ok: true, mid });
}

// ── 表紙（cover）の欠落補完（保守） ─────────────────────────────────────────
//
// 翻訳行が表紙を持たないことがある。⚠ 単に seo_json が空なのではなく
// `{"coverMid":"","coverPath":""}` のように【空の表紙を明示的に持つ】形があり、
// この場合 generatePage の seo_json 言語フォールバック（COALESCE）は「値がある」
// と見なしてそこで止まるため、表紙が消える（kuro.boo 実測 1871 行中 342 行。
// あとから足した ar / pt に集中）。
//
// ここでは基準言語（documents.initial_lang）の表紙を、表紙を持たない翻訳へ配る。
// ⚠ 基準言語にも表紙が無い記事は「元から画像がない」ので何もしない。
// ⚠ seo_json の他のキーは保持する（表紙の 2 キーだけ上書きする）。
// ⚠ 本文の綴りを直すのと同じ保守作業なので、writeTranslationContent は通さず
//   直接 UPDATE する（著者 = source を奪わない・リビジョンも積まない）。
async function coverFallbackSweep(env: Env, apply: boolean): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT dt.did, dt.lang, dt.seo_json, d.slug,
            COALESCE(NULLIF(d.initial_lang, ''), 'ja') AS base_lang
       FROM document_translations dt
       JOIN documents d ON d.did = dt.did`,
  ).all<{
    did: string;
    lang: string;
    seo_json: string | null;
    slug: string;
    base_lang: string;
  }>();

  const parseCover = (
    raw: string | null,
  ): { obj: Record<string, unknown>; path: string; mid: string } => {
    let obj: Record<string, unknown> = {};
    if (raw && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          obj = parsed as Record<string, unknown>;
      } catch {
        /* 壊れた JSON は空扱い（上書きせず、下で対象外にする） */
      }
    }
    return {
      obj,
      path: typeof obj.coverPath === "string" ? obj.coverPath : "",
      mid: typeof obj.coverMid === "string" ? obj.coverMid : "",
    };
  };

  // 基準言語の表紙を引く
  const baseCover = new Map<string, { path: string; mid: string }>();
  for (const r of rows.results ?? []) {
    if (r.lang !== r.base_lang) continue;
    const c = parseCover(r.seo_json);
    if (c.path) baseCover.set(r.did, { path: c.path, mid: c.mid });
  }

  const planned: {
    did: string;
    slug: string;
    lang: string;
    from: string;
    coverPath: string;
  }[] = [];
  const statements: D1PreparedStatement[] = [];
  const now = nowIso();
  for (const r of rows.results ?? []) {
    const base = baseCover.get(r.did);
    if (!base) continue; // 基準言語にも表紙が無い＝元から画像なし
    const c = parseCover(r.seo_json);
    if (c.path) continue; // 既に表紙がある
    const merged = { ...c.obj, coverMid: base.mid, coverPath: base.path };
    planned.push({
      did: r.did,
      slug: r.slug,
      lang: r.lang,
      from: r.base_lang,
      coverPath: base.path,
    });
    if (apply) {
      statements.push(
        env.DB.prepare(
          "UPDATE document_translations SET seo_json = ?, updated_at = ? WHERE did = ? AND lang = ?",
        ).bind(JSON.stringify(merged), now, r.did, r.lang),
      );
    }
  }

  if (!apply) {
    const byLang: Record<string, number> = {};
    for (const p of planned) byLang[p.lang] = (byLang[p.lang] ?? 0) + 1;
    return json({
      dryRun: true,
      candidates: planned.length,
      documents: new Set(planned.map((p) => p.did)).size,
      byLang: byLang as unknown as JsonValue,
      sample: planned.slice(0, 20) as unknown as JsonValue,
    });
  }

  // D1 のバッチ上限に配慮して分割する
  for (let i = 0; i < statements.length; i += 100) {
    await env.DB.batch(statements.slice(i, i + 100));
  }
  // 表紙が変わる＝公開ページの出力が変わるので、派生キャッシュを落とす
  await env.DB.prepare("DELETE FROM page_build_cache")
    .run()
    .catch(() => {});
  return json({
    dryRun: false,
    updated: planned.length,
    documents: new Set(planned.map((p) => p.did)).size,
  });
}

// ── 重複メディアの統合（保守） ──────────────────────────────────────────────
//
// 同じ実体の画像が別 mid で複数登録されていることがある（content_hash による
// 重複排除が入る前のアップロード分）。ここでは
//   ① 参照を「残す mid」へ書き換え → ② 余分な行と R2 実体を削除
// の順で統合する。⚠ 逆順にすると、書き換えの前に実体が消えて記事の画像が
// 一時的に壊れる。
//
// ⚠ 本文の綴りを直すだけなので、著者（document_translations.source）は
//   触らない。cleanup-styles / normalize-format と同じ「保守系の一括 UPDATE」
//   として document_translations を直接更新する（writeTranslationContent は
//   通さない＝リビジョンも積まない）。
//
// ⚠ mid の素の文字列を replace してはいけない。`img-159` は将来の `img-1590`
//   の前方一致になる。実際に保存されている【区切り付きの形】だけを置換する:
//     "img-159"            JSON の値（seo_json の coverMid など）
//     /images/img-159.jpg  public_path（seo_json の coverPath など）
//     [[img-159]]          本文のメディアトークン
//     [[img-159|          本文のメディアトークン（オプション付き）
const MEDIA_HASH_BATCH = 25; // 1 リクエストでハッシュ計算する最大件数

interface MediaRowForDedupe {
  mid: string;
  public_path: string;
  content_hash: string | null;
  size_bytes: number | null;
  created_at: string | null;
}

/** 置換ペア（区切り付きの形だけ）。 */
function mediaRefPairs(
  dupe: MediaRowForDedupe,
  keeper: MediaRowForDedupe,
): [string, string][] {
  return [
    [`"${dupe.mid}"`, `"${keeper.mid}"`],
    [dupe.public_path, keeper.public_path],
    [`[[${dupe.mid}]]`, `[[${keeper.mid}]]`],
    [`[[${dupe.mid}|`, `[[${keeper.mid}|`],
  ];
}

/** replace() を入れ子にした SQL 式と、そのバインド値を作る。 */
function nestedReplaceSql(
  column: string,
  pairs: [string, string][],
): { expr: string; binds: string[] } {
  let expr = column;
  const binds: string[] = [];
  for (const [from, to] of pairs) {
    expr = `replace(${expr}, ?, ?)`;
    binds.push(from, to);
  }
  return { expr, binds };
}

/** その mid を参照している行数（残す側を選ぶための概算。区切り付きで数える）。 */
async function countMediaRefs(
  env: Env,
  row: MediaRowForDedupe,
): Promise<number> {
  const like = [
    `%"${row.mid}"%`,
    `%${row.public_path}%`,
    `%[[${row.mid}]]%`,
    `%[[${row.mid}|%`,
  ];
  const q = async (sql: string) => {
    const r = await env.DB.prepare(sql)
      .bind(...like, ...like)
      .first<{ c: number }>()
      .catch(() => null);
    return Number(r?.c ?? 0);
  };
  const cond = (col: string) => like.map(() => `${col} LIKE ?`).join(" OR ");
  return (
    (await q(
      `SELECT COUNT(*) AS c FROM document_translations WHERE (${cond("body_html")}) OR (${cond("seo_json")})`,
    )) +
    (await q(
      `SELECT COUNT(*) AS c FROM document_translation_revisions WHERE (${cond("body_html")}) OR (${cond("seo_json")})`,
    ))
  );
}

/**
 * 重複メディアの検出と統合。
 * 既定は dry run。実行するには ?apply=1 を付ける。
 * content_hash が未設定の行があるうちは「ハッシュ計算だけ」を返すので、
 * 呼び手は phase が "hashing" の間ループする（ワイプ系と同じ作法）。
 */
async function mediaDedupe(env: Env, url: URL): Promise<Response> {
  if (!env.MEDIA_BUCKET) {
    throw new HttpError(
      503,
      "r2_not_configured",
      "メディアの保存先（R2）が接続されていません。",
    );
  }
  const apply = url.searchParams.get("apply") === "1";
  const bucket = env.MEDIA_BUCKET as R2Bucket;

  // ── フェーズ 1: content_hash の補完（古いアップロードは未設定） ──────────
  const missing = await env.DB.prepare(
    `SELECT mid, public_path, content_hash, size_bytes, created_at
       FROM media_assets WHERE content_hash IS NULL OR content_hash = ''
      ORDER BY mid LIMIT ?`,
  )
    .bind(MEDIA_HASH_BATCH)
    .all<MediaRowForDedupe>();
  const todo = missing.results ?? [];
  if (todo.length) {
    let hashed = 0;
    for (const row of todo) {
      const obj = await bucket.get(row.public_path.replace(/^\//, ""));
      if (!obj) continue; // 実体が無い行はハッシュを付けられない（統合対象外）
      const digest = await crypto.subtle.digest(
        "SHA-256",
        await obj.arrayBuffer(),
      );
      const hex = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      await env.DB.prepare(
        "UPDATE media_assets SET content_hash = ? WHERE mid = ?",
      )
        .bind(hex, row.mid)
        .run();
      hashed += 1;
    }
    const left = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM media_assets WHERE content_hash IS NULL OR content_hash = ''",
    ).first<{ c: number }>();
    return json({
      phase: "hashing",
      hashed,
      remaining: Number(left?.c ?? 0),
      done: false,
    });
  }

  // ── フェーズ 2: 重複のグループ化 ─────────────────────────────────────────
  const all = await env.DB.prepare(
    `SELECT mid, public_path, content_hash, size_bytes, created_at
       FROM media_assets WHERE content_hash IS NOT NULL AND content_hash != ''
      ORDER BY created_at, mid`,
  ).all<MediaRowForDedupe>();
  const byHash = new Map<string, MediaRowForDedupe[]>();
  for (const row of all.results ?? []) {
    const key = row.content_hash as string;
    const list = byHash.get(key);
    if (list) list.push(row);
    else byHash.set(key, [row]);
  }

  const plan: {
    hash: string;
    keep: string;
    remove: string[];
    refs: Record<string, number>;
    bytesFreed: number;
  }[] = [];
  for (const [hash, rows] of byHash) {
    if (rows.length < 2) continue;
    const refs: Record<string, number> = {};
    for (const r of rows) refs[r.mid] = await countMediaRefs(env, r);
    // 残すのは【参照が最も多い】もの。同数なら古い方（＝書き換え量が最小で、
    // 参照ゼロの孤児が自動的に消える側になる）。
    const sorted = [...rows].sort(
      (a, b) =>
        refs[b.mid] - refs[a.mid] ||
        String(a.created_at).localeCompare(String(b.created_at)) ||
        a.mid.localeCompare(b.mid),
    );
    const keep = sorted[0];
    const remove = sorted.slice(1);
    plan.push({
      hash,
      keep: keep.mid,
      remove: remove.map((r) => r.mid),
      refs,
      bytesFreed: remove.reduce((s, r) => s + Number(r.size_bytes ?? 0), 0),
    });
  }

  if (!apply) {
    return json({
      phase: "plan",
      done: true,
      dryRun: true,
      groups: plan as unknown as JsonValue,
      filesToRemove: plan.reduce((s, g) => s + g.remove.length, 0),
      bytesFreed: plan.reduce((s, g) => s + g.bytesFreed, 0),
    });
  }

  // ── フェーズ 3: 参照の書き換え → 実体の削除（この順を守る） ──────────────
  const byMid = new Map((all.results ?? []).map((r) => [r.mid, r]));
  const now = nowIso();
  const report: {
    keep: string;
    removed: string;
    rewritten: Record<string, number>;
  }[] = [];
  for (const group of plan) {
    const keeper = byMid.get(group.keep)!;
    for (const mid of group.remove) {
      const dupe = byMid.get(mid)!;
      const pairs = mediaRefPairs(dupe, keeper);
      const rewritten: Record<string, number> = {};

      const sweep = async (
        table: string,
        columns: string[],
      ): Promise<number> => {
        const sets: string[] = [];
        const binds: (string | number)[] = [];
        for (const col of columns) {
          const { expr, binds: b } = nestedReplaceSql(col, pairs);
          sets.push(`${col} = ${expr}`);
          binds.push(...b);
        }
        const where = columns
          .map((col) => pairs.map(() => `${col} LIKE ?`).join(" OR "))
          .join(" OR ");
        const whereBinds = columns.flatMap(() =>
          pairs.map(([from]) => `%${from}%`),
        );
        const res = await env.DB.prepare(
          `UPDATE ${table} SET ${sets.join(", ")} WHERE ${where}`,
        )
          .bind(...binds, ...whereBinds)
          .run()
          .catch(() => null);
        return Number(res?.meta?.changes ?? 0);
      };

      rewritten.document_translations = await sweep("document_translations", [
        "body_html",
        "seo_json",
      ]);
      rewritten.document_translation_revisions = await sweep(
        "document_translation_revisions",
        ["body_html", "seo_json"],
      );
      rewritten.taxonomy_items = await sweep("taxonomy_items", ["name"]);
      rewritten.page_templates = await sweep("page_templates", ["source_html"]);

      // ここまで来てから実体を消す（順序を逆にしない）
      await bucket.delete(dupe.public_path.replace(/^\//, "")).catch(() => {});
      await env.DB.prepare("DELETE FROM media_assets WHERE mid = ?")
        .bind(mid)
        .run();
      report.push({ keep: group.keep, removed: mid, rewritten });
    }
  }

  // 派生キャッシュを落として、次のビルドで確実に作り直させる
  await env.DB.prepare("DELETE FROM page_build_cache")
    .run()
    .catch(() => {});
  await env.DB.prepare("UPDATE site_settings SET updated_at = ? WHERE id = 1")
    .bind(now)
    .run()
    .catch(() => {});

  return json({
    phase: "applied",
    done: true,
    dryRun: false,
    removed: report.length,
    bytesFreed: plan.reduce((s, g) => s + g.bytesFreed, 0),
    detail: report as unknown as JsonValue,
  });
}

async function restoreFinish(env: Env): Promise<Response> {
  // Public pages were wiped from KV; drop the version cache so the next visit /
  // build regenerates everything from the restored D1 data.
  if (env.PUBLIC_PAGES) {
    await env.PUBLIC_PAGES.delete(RELEASE_CHANNELS_CACHE_KEY).catch(() => {});
  }
  return json({ ok: true });
}

async function createBackup(env: Env): Promise<Response> {
  const [
    documents,
    translations,
    translationRevisions,
    taxonomyItems,
    categories,
    documentCategories,
    mediaAssets,
    settings,
    backupRuns,
    buildJobs,
    webhookEndpoints,
    webhookDeliveries,
    deploymentReleases,
    deploymentChannelHeads,
  ] = await Promise.all([
    env.DB.prepare("SELECT * FROM documents").all(),
    env.DB.prepare("SELECT * FROM document_translations").all(),
    env.DB.prepare("SELECT * FROM document_translation_revisions").all(),
    env.DB.prepare("SELECT * FROM taxonomy_items").all(),
    env.DB.prepare("SELECT * FROM categories").all(),
    env.DB.prepare("SELECT * FROM document_categories").all(),
    env.DB.prepare("SELECT * FROM media_assets").all(),
    env.DB.prepare("SELECT * FROM site_settings").all(),
    env.DB.prepare("SELECT * FROM backups").all(),
    env.DB.prepare("SELECT * FROM build_jobs").all(),
    env.DB.prepare("SELECT * FROM webhook_endpoints").all(),
    env.DB.prepare("SELECT * FROM webhook_deliveries").all(),
    env.DB.prepare("SELECT * FROM deployment_releases").all(),
    env.DB.prepare("SELECT * FROM deployment_channel_heads").all(),
  ]);

  return json({
    manifest: {
      format: "kurocms.backup.v2",
      createdAt: nowIso(),
    },
    documents: documents.results as JsonValue,
    documentTranslations: translations.results as JsonValue,
    documentTranslationRevisions: translationRevisions.results as JsonValue,
    taxonomyItems: taxonomyItems.results as JsonValue,
    categories: categories.results as JsonValue,
    documentCategories: documentCategories.results as JsonValue,

    mediaAssets: mediaAssets.results as JsonValue,
    settings: settings.results as JsonValue,
    backups: backupRuns.results as JsonValue,
    buildJobs: buildJobs.results as JsonValue,
    webhookEndpoints: webhookEndpoints.results as JsonValue,
    webhookDeliveries: webhookDeliveries.results as JsonValue,
    deploymentReleases: deploymentReleases.results as JsonValue,
    deploymentChannelHeads: deploymentChannelHeads.results as JsonValue,
  });
}

interface DebugLogEvent {
  requestId: string;
  level: "debug" | "info" | "warn" | "error";
  eventType: string;
  phase: string;
  action: string;
  route?: string | null;
  method?: string | null;
  statusCode?: number | null;
  latencyMs?: number | null;
  actorUid?: string | null;
  actorEmail?: string | null;
  did?: string | null;
  lang?: string | null;
  releaseId?: string | null;
  buildId?: string | null;
  cfRay?: string | null;
  userAgent?: string | null;
  ipHash?: string | null;
  payloadSize?: number | null;
  payloadHash?: string | null;
  responseSize?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  errorStack?: string | null;
  metadata?: JsonValue;
}

function isDebugLoggingEnabled(env: Env): boolean {
  const value = String(env.DEBUG_LOG_ENABLED ?? "1")
    .trim()
    .toLowerCase();
  return value !== "0" && value !== "false" && value !== "off";
}

function debugDatabase(env: Env): D1Database | null {
  return env.DEBUG_DB ?? null;
}

async function logDebugEvent(env: Env, event: DebugLogEvent): Promise<void> {
  if (!isDebugLoggingEnabled(env)) {
    return;
  }
  const db = debugDatabase(env);
  if (!db) return;
  try {
    await db
      .prepare(
        `INSERT INTO debug_event_logs
        (id, request_id, level, event_type, phase, action, route, method, status_code, latency_ms,
         actor_uid, actor_email, did, lang, release_id, build_id, cf_ray, user_agent, ip_hash,
         payload_size, payload_hash, response_size, error_code, error_message, error_stack, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        makeId("dbg"),
        event.requestId,
        event.level,
        event.eventType,
        event.phase,
        event.action,
        event.route ?? null,
        event.method ?? null,
        event.statusCode ?? null,
        event.latencyMs ?? null,
        event.actorUid ?? null,
        event.actorEmail ?? null,
        event.did ?? null,
        event.lang ?? null,
        event.releaseId ?? null,
        event.buildId ?? null,
        event.cfRay ?? null,
        event.userAgent ?? null,
        event.ipHash ?? null,
        event.payloadSize ?? null,
        event.payloadHash ?? null,
        event.responseSize ?? null,
        event.errorCode ?? null,
        event.errorMessage ?? null,
        event.errorStack ?? null,
        JSON.stringify(sanitizeDebugMetadata(event.metadata ?? null)),
        nowIso(),
      )
      .run();
  } catch {
    // no-op: debug logging must not break normal API handling
  }
}

function sanitizeDebugMetadata(value: unknown, depth = 0): JsonValue {
  if (depth > 4) return "[max-depth]";
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value
      .slice(0, 40)
      .map((item) => sanitizeDebugMetadata(item, depth + 1));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.entries(record).slice(0, 60);
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of entries) {
      if (isSensitiveDebugKey(key)) continue;
      result[key] = sanitizeDebugMetadata(item, depth + 1);
    }
    return result;
  }
  return String(value);
}

function isSensitiveDebugKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized.includes("token") ||
    normalized.includes("authorization") ||
    normalized.includes("cookie") ||
    normalized.includes("password") ||
    normalized.includes("secret")
  );
}

async function countUsers(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM users",
  ).first<{
    count: number;
  }>();
  return row?.count ?? 0;
}

const SETTINGS_COLS = new Set([
  "site_name",
  "site_description",
  "ga4_measurement_id",
  "public_domain",
  "default_lang",
  "initial_lang",
  "theme_accent",
  "theme_sidebar",
  "theme_main_pane",
  "bluesky_handle",
  "bluesky_sid",
  "bluesky_token",
  "x_api_key",
  "x_api_secret",
  "x_access_token",
  "x_access_secret",
  "x_link_in_reply",
  "mobile_media_full_width",
  "sns_auto_post",
  "threads_token",
  "threads_user_id",
  "license_accepted_at",
  "license_accepted_by",
  "license_name",
  "license_attribution_phrase",
  "setup_completed_at",
  "strapi_url",
  "strapi_token",
  "strapi_content_type",
  "strapi_field_title",
  "strapi_field_slug",
  "strapi_field_summary",
  "strapi_field_body",
  "strapi_field_categories",
  "kurocms_import_url",
  "kurocms_import_pat",
  "fonts_json",
  "base_font",
  "font_configs_json",
]);

async function saveSettings(
  env: Env,
  settings: Record<string, string | number | boolean>,
): Promise<void> {
  const entries = Object.entries(settings).filter(([k]) =>
    SETTINGS_COLS.has(k),
  );
  if (entries.length === 0) return;
  const now = nowIso();
  const setClauses = [
    ...entries.map(([k]) => `${k} = ?`),
    "updated_at = ?",
  ].join(", ");
  const values: (string | number | boolean)[] = [
    ...entries.map(([, v]) => v),
    now,
  ];
  await env.DB.prepare(`UPDATE site_settings SET ${setClauses} WHERE id = 1`)
    .bind(...values)
    .run();
}

interface FontConfigItem {
  family: string;
  weights: number[];
}

interface LanguageFontConfig {
  fonts: FontConfigItem[];
  base: string;
}

type FontConfigMap = Record<string, LanguageFontConfig>;

/** Read the persisted font config (ordered loaded fonts + base font id). */
async function readFontConfig(
  env: Env,
  lang = "",
): Promise<{
  loaded: FontConfigItem[];
  base: string;
  configs: FontConfigMap;
}> {
  const row = await env.DB.prepare(
    "SELECT fonts_json, base_font, font_configs_json FROM site_settings WHERE id = 1",
  ).first<{
    fonts_json: string;
    base_font: string;
    font_configs_json: string;
  }>();
  const fallback = normalizeFontConfig(
    parseJsonValue(row?.fonts_json || "[]"),
    row?.base_font || "",
  );
  const configs = parseFontConfigMap(row?.font_configs_json || "{}");
  const selected = lang && configs[lang] ? configs[lang] : fallback;
  return { loaded: selected.fonts, base: selected.base, configs };
}

function parseJsonValue(raw: string): unknown {
  try {
    return JSON.parse(raw || "null");
  } catch {
    return null;
  }
}

function normalizeFontConfig(
  input: unknown,
  baseInput: unknown,
): LanguageFontConfig {
  const rawFonts =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as { fonts?: unknown }).fonts
      : input;
  const rawBase =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as { base?: unknown }).base
      : baseInput;
  const fonts: FontConfigItem[] = [];
  const seen = new Set<string>();
  if (Array.isArray(rawFonts)) {
    for (const item of rawFonts) {
      const rec =
        item && typeof item === "object"
          ? (item as { family?: unknown; weights?: unknown })
          : {};
      const family = String(rec.family || "");
      if (!family || seen.has(family) || !findCatalogEntry(family)) continue;
      seen.add(family);
      fonts.push({ family, weights: sanitizeWeights(rec.weights, family) });
    }
  }
  const base = typeof rawBase === "string" ? rawBase : "";
  return {
    fonts,
    base: base && (findSystemFont(base) || seen.has(base)) ? base : "",
  };
}

function parseFontConfigMap(raw: string): FontConfigMap {
  const parsed = parseJsonValue(raw || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: FontConfigMap = {};
  for (const [lang, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (!/^[a-z][a-z0-9-]{1,19}$/i.test(lang)) continue;
    out[lang.toLowerCase()] = normalizeFontConfig(value, "");
  }
  return out;
}

/** Resolve a base-font id (catalog family or system stack id) to a CSS stack. */
function resolveBaseFontStack(base: string): string {
  if (!base) return "";
  const sys = findSystemFont(base);
  if (sys) return sys.stack;
  return familyStack(base);
}

/** Coerce a requested weight list into valid Google Fonts weights (100–900). */
function sanitizeWeights(input: unknown, family: string): number[] {
  const entry = findCatalogEntry(family);
  const fallback = entry ? entry.defaultWeights : [400, 700];
  if (!Array.isArray(input)) return fallback.slice();
  const out = Array.from(
    new Set(
      input
        .map((w) => Number(w))
        .filter(
          (w) => Number.isInteger(w) && w >= 100 && w <= 900 && w % 100 === 0,
        ),
    ),
  ).sort((a, b) => a - b);
  return out.length ? out : fallback.slice();
}

/**
 * GET  /api/fonts?lang=ja → { catalog, systemFonts, loaded, base }
 * PUT  /api/fonts  { lang, fonts: [{family, weights}], base }
 * saves the order + base font for the selected language.
 *
 * The base font may be "" (template default), a system stack id, or a loaded
 * catalog family.
 */
/**
 * Tailwind neutral scales + white/black — enough to resolve the body
 * background/text classes real templates use. Colored bodies (or CSS the
 * regex can't see) fall back to the editor's own defaults, which is safe.
 */
const TW_BODY_PALETTE: Record<string, string> = {
  white: "#ffffff",
  black: "#000000",
  // prettier-ignore
  "slate-50": "#f8fafc",
  "slate-100": "#f1f5f9",
  "slate-200": "#e2e8f0",
  "slate-300": "#cbd5e1",
  "slate-400": "#94a3b8",
  "slate-500": "#64748b",
  "slate-600": "#475569",
  "slate-700": "#334155",
  "slate-800": "#1e293b",
  "slate-900": "#0f172a",
  "slate-950": "#020617",
  // prettier-ignore
  "gray-50": "#f9fafb",
  "gray-100": "#f3f4f6",
  "gray-200": "#e5e7eb",
  "gray-300": "#d1d5db",
  "gray-400": "#9ca3af",
  "gray-500": "#6b7280",
  "gray-600": "#4b5563",
  "gray-700": "#374151",
  "gray-800": "#1f2937",
  "gray-900": "#111827",
  "gray-950": "#030712",
  // prettier-ignore
  "zinc-50": "#fafafa",
  "zinc-100": "#f4f4f5",
  "zinc-200": "#e4e4e7",
  "zinc-300": "#d4d4d8",
  "zinc-400": "#a1a1aa",
  "zinc-500": "#71717a",
  "zinc-600": "#52525b",
  "zinc-700": "#3f3f46",
  "zinc-800": "#27272a",
  "zinc-900": "#18181b",
  "zinc-950": "#09090b",
  // prettier-ignore
  "neutral-50": "#fafafa",
  "neutral-100": "#f5f5f5",
  "neutral-200": "#e5e5e5",
  "neutral-300": "#d4d4d4",
  "neutral-400": "#a3a3a3",
  "neutral-500": "#737373",
  "neutral-600": "#525252",
  "neutral-700": "#404040",
  "neutral-800": "#262626",
  "neutral-900": "#171717",
  "neutral-950": "#0a0a0a",
  // prettier-ignore
  "stone-50": "#fafaf9",
  "stone-100": "#f5f5f4",
  "stone-200": "#e7e5e4",
  "stone-300": "#d6d3d1",
  "stone-400": "#a8a29e",
  "stone-500": "#78716c",
  "stone-600": "#57534e",
  "stone-700": "#44403c",
  "stone-800": "#292524",
  "stone-900": "#1c1917",
  "stone-950": "#0c0a09",
};

/**
 * Resolve the active template's <body> background/text colors so the editor's
 * 通常モード canvas can match the real site (KuroEditor canvasColors option).
 * Handles `bg-slate-50` style palette classes and `bg-[#hex]` arbitrary values;
 * anything else returns partial/null and the editor keeps its own defaults.
 */
function resolveTemplateCanvasColors(
  sourceHtml: string,
): { bg?: string; text?: string } | null {
  const m = String(sourceHtml || "").match(
    /<body\b[^>]*\bclass\s*=\s*["']([^"']*)["']/i,
  );
  if (!m) return null;
  let bg: string | undefined;
  let text: string | undefined;
  for (const cls of m[1].split(/\s+/)) {
    let mm = cls.match(/^bg-\[(#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6,8}))\]$/);
    if (mm) {
      bg = mm[1];
      continue;
    }
    mm = cls.match(/^bg-([a-z]+(?:-\d{2,3})?)$/);
    if (mm && TW_BODY_PALETTE[mm[1]]) {
      bg = TW_BODY_PALETTE[mm[1]];
      continue;
    }
    mm = cls.match(/^text-\[(#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6,8}))\]$/);
    if (mm) {
      text = mm[1];
      continue;
    }
    mm = cls.match(/^text-([a-z]+(?:-\d{2,3})?)$/);
    if (mm && TW_BODY_PALETTE[mm[1]]) {
      text = TW_BODY_PALETTE[mm[1]];
    }
  }
  if (!bg && !text) return null;
  return { ...(bg ? { bg } : {}), ...(text ? { text } : {}) };
}

async function fonts(
  request: Request,
  env: Env,
  user: AuthUser,
): Promise<Response> {
  if (request.method === "GET") {
    // Read is Author-level: the article editor (an Author feature) fetches
    // /api/fonts for its WYSIWYG base font and editorCanvas colors. Requiring
    // Admin here silently broke both for author-only accounts.
    requireAuthor(user);
    const url = new URL(request.url);
    const lang = (url.searchParams.get("lang") || "").trim().toLowerCase();
    if (lang) validateLanguage(lang, "lang");
    const { loaded, base, configs } = await readFontConfig(env, lang);
    // Active template's body colors — the admin passes them to KuroEditor's
    // canvasColors so the 通常モード canvas matches the real site palette
    // (dark-designed templates would otherwise preview on a white canvas).
    let editorCanvas: { bg?: string; text?: string } | null = null;
    try {
      const trow = await env.DB.prepare(
        "SELECT source_html FROM page_templates WHERE id = (SELECT template_id FROM site_settings WHERE id = 1)",
      ).first<{ source_html: string }>();
      if (trow?.source_html)
        editorCanvas = resolveTemplateCanvasColors(trow.source_html);
    } catch {
      /* non-fatal: editor keeps its default canvas palette */
    }
    return json({
      catalog: FONT_CATALOG as unknown as JsonValue,
      systemFonts: SYSTEM_FONTS as unknown as JsonValue,
      loaded: loaded as unknown as JsonValue,
      base,
      lang,
      configs: configs as unknown as JsonValue,
      // Resolved CSS font-family for the base font (catalog family or system
      // stack). The admin uses it to render the editor body in the site font.
      baseStack: resolveBaseFontStack(base),
      editorCanvas: editorCanvas as JsonValue,
    });
  }

  if (request.method === "PUT") {
    requireAdmin(user);
    const body = await readJson(request);
    const lang = optionalString(body, "lang")?.trim().toLowerCase() || "";
    if (lang) validateLanguage(lang, "lang");
    const next = normalizeFontConfig(body.fonts, body.base);
    const seen = new Set(next.fonts.map((f) => f.family));
    const base = typeof body.base === "string" ? body.base : next.base;
    // Base must be empty, a system stack, or one of the loaded families.
    if (base && !findSystemFont(base) && !seen.has(base)) {
      throw new HttpError(
        400,
        "invalid_base_font",
        "base font must be a system font or a loaded font",
      );
    }

    const settingsToSave: Record<string, string> = {};
    const current = await readFontConfig(env);
    if (lang) {
      const configs = { ...current.configs };
      configs[lang] = { fonts: next.fonts, base };
      settingsToSave.font_configs_json = JSON.stringify(configs);
    } else {
      settingsToSave.fonts_json = JSON.stringify(next.fonts);
      settingsToSave.base_font = base;
    }
    await saveSettings(env, settingsToSave);
    await logActivity(env, user, "settings.update", "settings", "fonts", {
      lang,
      fonts: next.fonts.map((f) => f.family),
      base,
    });
    return json({ ok: true, updatedAt: nowIso() });
  }

  throw new HttpError(405, "method_not_allowed", "Method not allowed");
}

function validateDomain(value: string, label: string): void {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("Invalid protocol.");
    }
  } catch {
    throw new HttpError(
      400,
      "invalid_domain",
      `${label} must be a valid http or https URL.`,
    );
  }
}

function validateLanguage(value: string, label: string): void {
  if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value)) {
    throw new HttpError(
      400,
      "invalid_language",
      `${label} must be a valid language code.`,
    );
  }
}

function validateHexColor(value: string, label: string): void {
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new HttpError(
      400,
      "invalid_color",
      `${label} must be a #RRGGBB color.`,
    );
  }
}

async function logActivity(
  env: Env,
  user: AuthUser,
  action: string,
  targetType: string,
  targetId: string,
  detail: JsonValue,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO activity_logs
      (id, actor_uid, action, target_type, target_id, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      makeId("act"),
      user.uid,
      action,
      targetType,
      targetId,
      JSON.stringify(detail),
      nowIso(),
    )
    .run();
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAdminApiPath(pathname: string): string {
  if (pathname === "/api/admin") return "/api";
  if (pathname.startsWith("/api/admin/")) {
    return `/api/${pathname.slice("/api/admin/".length)}`;
  }
  return pathname;
}

function withJsonHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(jsonHeaders)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function deriveInternalPreviewUrl(request: Request, env: Env): string {
  const raw = String(env.ACCESS_ADMIN_URL || "/kurocms/admin").trim();
  let adminPath: string;
  try {
    adminPath =
      (new URL(raw).pathname || "/kurocms/admin").replace(/\/+$/, "") ||
      "/kurocms/admin";
  } catch {
    adminPath =
      (raw.startsWith("/") ? raw : `/${raw}`).replace(/\/+$/, "") ||
      "/kurocms/admin";
  }
  const previewPath = `${adminPath}/preview`.replace(/\/{2,}/g, "/");
  return `${new URL(request.url).origin}${previewPath}`;
}

// ─── Strapi 5 import ──────────────────────────────────────────────────────────

interface StrapiTextNode {
  type: "text";
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  code?: boolean;
}

interface StrapiLinkNode {
  type: "link";
  url: string;
  children: (StrapiTextNode | StrapiLinkNode)[];
}

interface StrapiImageNode {
  type: "image";
  image?: {
    url?: string;
    alternativeText?: string;
    width?: number;
    height?: number;
  };
  children?: unknown[];
}

interface StrapiBlock {
  type: string;
  level?: number;
  format?: "ordered" | "unordered";
  language?: string;
  image?: {
    url?: string;
    alternativeText?: string;
    width?: number;
    height?: number;
  };
  url?: string;
  children?: (
    | StrapiBlock
    | StrapiTextNode
    | StrapiLinkNode
    | StrapiImageNode
  )[];
  [key: string]: unknown;
}

interface StrapiArticleRow {
  id: number;
  documentId?: string;
  publishedAt?: string | null;
  [key: string]: unknown;
}

function strapiEsc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function strapiInlineNodes(nodes: (StrapiTextNode | StrapiLinkNode)[]): string {
  return (nodes || [])
    .map((n) => {
      if (n.type === "link") {
        const ln = n as StrapiLinkNode;
        return `<a href="${strapiEsc(ln.url || "")}">${strapiInlineNodes((ln.children as (StrapiTextNode | StrapiLinkNode)[]) || [])}</a>`;
      }
      const t = n as StrapiTextNode;
      let text = strapiEsc(t.text || "");
      if (t.code) text = `<code>${text}</code>`;
      if (t.bold) text = `<strong>${text}</strong>`;
      if (t.italic) text = `<em>${text}</em>`;
      if (t.underline) text = `<u>${text}</u>`;
      if (t.strikethrough) text = `<s>${text}</s>`;
      return text;
    })
    .join("");
}

function strapiListItems(items: StrapiBlock[]): string {
  return (items || [])
    .map((item) => {
      const children = (item.children || []) as (
        | StrapiBlock
        | StrapiTextNode
        | StrapiLinkNode
      )[];
      const nested = children.filter(
        (c) => typeof c === "object" && (c as StrapiBlock).type === "list",
      ) as StrapiBlock[];
      const inline = children.filter(
        (c) => typeof c === "object" && (c as StrapiBlock).type !== "list",
      ) as (StrapiTextNode | StrapiLinkNode)[];
      const nestedHtml = nested.map((n) => strapiListBlock(n)).join("");
      return `<li>${strapiInlineNodes(inline)}${nestedHtml}</li>`;
    })
    .join("");
}

function strapiListBlock(block: StrapiBlock): string {
  const tag = block.format === "ordered" ? "ol" : "ul";
  return `<${tag}>${strapiListItems((block.children || []) as StrapiBlock[])}</${tag}>`;
}

// Normalize tables from foreign editors (e.g. Strapi's Quill quill-table-better)
// to KuroCMS's clean `.kuro-table` format. KuroCMS forbids fixed values, so we
// strip inline pixel widths / styles / data-attrs and the Quill <temporary>
// editing artifact at import time — leaving the layout to `.kuro-table` CSS.
function cleanImportedHtml(html: string): string {
  if (
    !html ||
    (html.indexOf("<table") === -1 &&
      html.indexOf("ql-") === -1 &&
      html.indexOf("<temporary") === -1)
  )
    return html;
  return (
    html
      // Quill table-better editing artifacts (invalid inside <table>)
      .replace(/<temporary\b[^>]*>[\s\S]*?<\/temporary>/gi, "")
      .replace(/<\/?temporary\b[^>]*>/gi, "")
      // <table> → clean .kuro-table (drops inline px widths + ql-* classes)
      .replace(/<table\b[^>]*>/gi, '<table class="kuro-table">')
      // structural tags: drop all presentational attributes
      .replace(/<(thead|tbody|tfoot|tr)\b[^>]*>/gi, "<$1>")
      // <colgroup>/<col> carry fixed px widths — remove them
      .replace(/<\/?colgroup\b[^>]*>/gi, "")
      .replace(/<col\b[^>]*\/?>/gi, "")
      // cells: keep only colspan/rowspan, drop style/width/class/data-*
      .replace(/<(t[dh])\b([^>]*)>/gi, (_m, tag: string, attrs: string) => {
        const keep: string[] = [];
        const cs = /\bcolspan\s*=\s*["']?(\d+)/i.exec(attrs);
        const rs = /\browspan\s*=\s*["']?(\d+)/i.exec(attrs);
        if (cs) keep.push(`colspan="${cs[1]}"`);
        if (rs) keep.push(`rowspan="${rs[1]}"`);
        return `<${tag}${keep.length ? " " + keep.join(" ") : ""}>`;
      })
      // Drop Quill cell paragraph attributes that linger inside cells.
      .replace(
        /\s+(?:data-cell|data-row|data-class)=("[^"]*"|'[^']*'|[^\s>]+)/gi,
        "",
      )
      // Remove dead Quill `ql-*` classes (KuroCMS loads no Quill CSS); keep the rest.
      .replace(/\sclass="([^"]*)"/gi, (_m, cls: string) => {
        const kept = cls
          .split(/\s+/)
          .filter((c) => c && !c.startsWith("ql-"))
          .join(" ");
        return kept ? ` class="${kept}"` : "";
      })
      // Strip fixed background-color values (e.g. Quill table-header shading).
      .replace(/\sstyle="([^"]*)"/gi, (_m, st: string) => {
        const kept = st
          .split(";")
          .map((d) => d.trim())
          .filter((d) => d && !/^background(-color)?\s*:/i.test(d))
          .join("; ");
        return kept ? ` style="${kept}"` : "";
      })
  );
}

function strapiBlocksToHtml(blocks: unknown): string {
  if (!Array.isArray(blocks))
    return typeof blocks === "string" ? cleanImportedHtml(blocks) : "";
  return (blocks as StrapiBlock[])
    .map((block) => {
      switch (block.type) {
        case "paragraph":
          return `<p>${strapiInlineNodes((block.children || []) as (StrapiTextNode | StrapiLinkNode)[])}</p>`;
        case "heading": {
          const lvl = block.level || 2;
          return `<h${lvl}>${strapiInlineNodes((block.children || []) as (StrapiTextNode | StrapiLinkNode)[])}</h${lvl}>`;
        }
        case "list":
          return strapiListBlock(block);
        case "quote":
          return `<blockquote>${strapiInlineNodes((block.children || []) as (StrapiTextNode | StrapiLinkNode)[])}</blockquote>`;
        case "code": {
          const lang = strapiEsc(String(block.language || ""));
          const code = ((block.children || []) as StrapiTextNode[])
            .map((n) => strapiEsc(n.text || ""))
            .join("");
          return `<pre><code${lang ? ` class="language-${lang}"` : ""}>${code}</code></pre>`;
        }
        case "image": {
          const img = (block as StrapiImageNode).image || {};
          // Only escape " in URLs (not & — HTML parsers handle &amp; but fetch() does not)
          const src = String(img.url || "").replace(/"/g, "&quot;");
          const alt = strapiEsc(String(img.alternativeText || ""));
          const dims =
            (img.width ? ` width="${img.width}"` : "") +
            (img.height ? ` height="${img.height}"` : "");
          return src ? `<img src="${src}" alt="${alt}"${dims}>` : "";
        }
        default:
          return "";
      }
    })
    .filter(Boolean)
    .join("\n");
}

function sanitizeImportSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^ -~]/g, "")
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

async function readStrapiSettings(env: Env): Promise<{
  url: string;
  token: string;
  contentType: string;
  fieldTitle: string;
  fieldSlug: string;
  fieldSummary: string;
  fieldBody: string;
  fieldCategories: string;
}> {
  const row = await env.DB.prepare(
    `SELECT strapi_url, strapi_token, strapi_content_type,
            strapi_field_title, strapi_field_slug, strapi_field_summary, strapi_field_body,
            strapi_field_categories
     FROM site_settings WHERE id = 1`,
  ).first<Record<string, string>>();
  return {
    url: (row?.strapi_url || "").replace(/\/+$/, ""),
    token: row?.strapi_token || "",
    contentType: row?.strapi_content_type || "articles",
    fieldTitle: row?.strapi_field_title || "title",
    fieldSlug: row?.strapi_field_slug || "slug",
    fieldSummary: row?.strapi_field_summary || "description",
    fieldBody: row?.strapi_field_body || "content",
    fieldCategories: row?.strapi_field_categories || "categories",
  };
}

async function strapiFetch(
  strapiUrl: string,
  token: string,
  path: string,
): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const resp = await fetch(`${strapiUrl}${path}`, { headers });
  if (!resp.ok)
    throw new HttpError(
      502,
      "strapi_error",
      `Strapi returned ${resp.status}: ${resp.statusText}`,
    );
  return resp.json();
}

async function strapiImportSettings(
  request: Request,
  env: Env,
  user: AuthUser,
): Promise<Response> {
  requireAdmin(user);
  if (request.method === "GET") {
    const cfg = await readStrapiSettings(env);
    return json({
      strapiUrl: cfg.url,
      strapiToken: cfg.token,
      strapiContentType: cfg.contentType,
      strapiFieldTitle: cfg.fieldTitle,
      strapiFieldSlug: cfg.fieldSlug,
      strapiFieldSummary: cfg.fieldSummary,
      strapiFieldBody: cfg.fieldBody,
      strapiFieldCategories: cfg.fieldCategories,
    });
  }
  if (request.method === "PUT") {
    const body = await readJson(request);
    await saveSettings(env, {
      strapi_url: optionalString(body, "strapiUrl") ?? "",
      strapi_token: optionalString(body, "strapiToken") ?? "",
      strapi_content_type:
        optionalString(body, "strapiContentType") ?? "articles",
      strapi_field_title: optionalString(body, "strapiFieldTitle") ?? "title",
      strapi_field_slug: optionalString(body, "strapiFieldSlug") ?? "slug",
      strapi_field_summary:
        optionalString(body, "strapiFieldSummary") ?? "description",
      strapi_field_body: optionalString(body, "strapiFieldBody") ?? "content",
      strapi_field_categories:
        optionalString(body, "strapiFieldCategories") ?? "categories",
    });
    return json({ ok: true });
  }
  throw new HttpError(405, "method_not_allowed", "Method not allowed.");
}

async function strapiImportPreview(
  _request: Request,
  env: Env,
  user: AuthUser,
  url: URL,
): Promise<Response> {
  requireAuthor(user);
  const rawTid = url.searchParams.get("tid") || "";
  // "すべて" (__all__) → check existence across all types (no tid filter).
  const tid = rawTid === STRAPI_TID_ALL ? "" : rawTid;
  const cfg = await readStrapiSettings(env);
  if (!cfg.url)
    throw new HttpError(
      400,
      "strapi_not_configured",
      "Strapi URL が設定されていません。",
    );

  // Fetch ALL articles for preview by paginating through every page (matching
  // the import, which also processes all pages). Fetching only page 1 hid any
  // article beyond the first 100 — it would import via "import all" but never
  // appear in the preview list.
  const PREVIEW_PAGE_SIZE = 100;
  const rows: StrapiArticleRow[] = [];
  let previewMeta:
    | { pagination?: { total?: number; pageCount?: number } }
    | undefined;
  let previewPage = 1;
  let previewPageCount: number;
  do {
    const qs = `populate=*&pagination[pageSize]=${PREVIEW_PAGE_SIZE}&pagination[page]=${previewPage}`;
    const pageData = (await strapiFetch(
      cfg.url,
      cfg.token,
      `/api/${cfg.contentType}?${qs}`,
    )) as {
      data?: StrapiArticleRow[];
      meta?: { pagination?: { total?: number; pageCount?: number } };
    };
    if (pageData.data) rows.push(...pageData.data);
    previewMeta = pageData.meta;
    previewPageCount = pageData.meta?.pagination?.pageCount ?? 1;
    previewPage++;
  } while (previewPage <= previewPageCount);

  // Check which slugs already exist — filtered by tid when provided
  const slugs = rows
    .map((a) => {
      const raw = String(a[cfg.fieldSlug] ?? a.slug ?? "");
      return sanitizeImportSlug(raw);
    })
    .filter(Boolean);

  const existingMap = new Map<
    string,
    { modifiedSinceImport: boolean; kurocmsUpdatedAt: string }
  >();
  if (slugs.length > 0) {
    // D1 limits bound params to ~100 per query; batch by 50 (leaves room for the optional tid param)
    const BATCH = 50;
    for (let i = 0; i < slugs.length; i += BATCH) {
      const chunk = slugs.slice(i, i + BATCH);
      const ph = chunk.map(() => "?").join(",");
      const query = tid
        ? `SELECT slug, created_at, updated_at FROM documents WHERE tid = ? AND slug IN (${ph})`
        : `SELECT slug, created_at, updated_at FROM documents WHERE slug IN (${ph})`;
      const bindings = tid ? [tid, ...chunk] : chunk;
      const existing = await env.DB.prepare(query)
        .bind(...bindings)
        .all<{ slug: string; created_at: string; updated_at: string }>();
      for (const r of existing.results ?? []) {
        existingMap.set(r.slug, {
          modifiedSinceImport: r.updated_at > r.created_at,
          kurocmsUpdatedAt: r.updated_at,
        });
      }
    }
  }

  const articles = rows.map((a) => {
    const rawSlug = String(a[cfg.fieldSlug] ?? a.slug ?? "");
    const slug = sanitizeImportSlug(rawSlug);
    const title = String(a[cfg.fieldTitle] ?? a.title ?? slug ?? "");
    const summary = String(a[cfg.fieldSummary] ?? a.description ?? "").slice(
      0,
      200,
    );
    const meta = existingMap.get(slug);
    return {
      id: String(a.documentId || a.id),
      title,
      slug,
      summary,
      publishedAt:
        ((a.displayPublishedAt ?? a.publishedAt) as string | null) || null,
      exists: !!meta,
      modifiedSinceImport: meta?.modifiedSinceImport ?? false,
      kurocmsUpdatedAt: meta?.kurocmsUpdatedAt ?? null,
    };
  });

  const rawFields = rows[0] ? Object.keys(rows[0]) : [];

  return json({
    articles,
    total: previewMeta?.pagination?.total ?? articles.length,
    pageCount: previewMeta?.pagination?.pageCount ?? 1,
    rawFields,
  });
}

// ─── Strapi media download ────────────────────────────────────────────────────

async function downloadStrapiImage(
  imageUrl: string,
  strapiBaseUrl: string,
  env: Env,
  userId: string,
  strapiToken = "",
): Promise<{ mid: string; publicPath: string; version: string } | null> {
  if (!env.MEDIA_BUCKET) return null;
  const fullUrl = imageUrl.startsWith("http")
    ? imageUrl
    : `${strapiBaseUrl}${imageUrl}`;
  // SSRF guard: only download from the configured Strapi host
  try {
    const allowedHost = new URL(strapiBaseUrl).hostname;
    const targetHost = new URL(fullUrl).hostname;
    if (targetHost !== allowedHost) return null;
  } catch {
    return null;
  }
  try {
    // Dedup: Strapi filenames carry a stable content hash (e.g. name_ab12cd34.jpg),
    // so the same source asset keeps the same filename across re-imports. Reuse an
    // already-imported asset instead of downloading + inserting a duplicate row.
    const urlFilename = fullUrl.split("/").pop()?.split("?")[0] || "";
    if (urlFilename) {
      const existing = await env.DB.prepare(
        "SELECT mid, public_path AS publicPath, cache_version AS version FROM media_assets WHERE kind = 'image' AND filename = ? ORDER BY created_at LIMIT 1",
      )
        .bind(urlFilename)
        .first<{ mid: string; publicPath: string; version: string }>();
      if (existing) return existing;
    }
    const fetchHeaders: Record<string, string> = { Accept: "image/*" };
    if (strapiToken) fetchHeaders["Authorization"] = `Bearer ${strapiToken}`;
    const resp = await fetch(fullUrl, { headers: fetchHeaders });
    if (!resp.ok) return null;
    const contentType = resp.headers.get("content-type") || "image/jpeg";
    if (contentType.includes("svg")) return null;
    const ext = contentType.includes("png")
      ? "png"
      : contentType.includes("gif")
        ? "gif"
        : contentType.includes("webp")
          ? "webp"
          : "jpg";
    const filename = fullUrl.split("/").pop()?.split("?")[0] || `image.${ext}`;
    const buffer = await resp.arrayBuffer();
    const sizeBytes = buffer.byteLength;
    const mid = await nextMediaId(env, "image");
    const version = cacheVersion();
    const publicPath = `/images/${mid}.${ext}`;
    await (env.MEDIA_BUCKET as R2Bucket).put(`images/${mid}.${ext}`, buffer, {
      httpMetadata: { contentType },
      customMetadata: {
        originalFilename: filename,
        version,
        source: "strapi-import",
      },
    });
    const now = nowIso();
    await env.DB.prepare(
      `INSERT INTO media_assets (mid, kind, filename, ext, mime, width, height, size_bytes, public_path, cache_version, created_at, updated_at, created_by)
       VALUES (?, 'image', ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        mid,
        filename,
        ext,
        contentType,
        sizeBytes,
        publicPath,
        version,
        now,
        now,
        userId,
      )
      .run();
    return { mid, publicPath, version };
  } catch {
    return null;
  }
}

async function rewriteStrapiImages(
  html: string,
  strapiBaseUrl: string,
  strapiToken: string,
  env: Env,
  userId: string,
  cache: Map<string, string>,
): Promise<{ html: string; count: number }> {
  if (!html || !env.MEDIA_BUCKET) return { html, count: 0 };
  const matches: Array<{ src: string }> = [];
  const pattern = /src="(https?:\/\/[^"]+|\/uploads\/[^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(html)) !== null) {
    matches.push({ src: m[1] });
  }
  let result = html;
  let count = 0;
  for (const { src } of matches) {
    if (result.indexOf(src) === -1) continue;
    let localPath = cache.get(src);
    if (!localPath) {
      const stored = await downloadStrapiImage(
        src,
        strapiBaseUrl,
        env,
        userId,
        strapiToken,
      );
      localPath = stored?.publicPath ?? src;
      cache.set(src, localPath);
      if (stored) count++;
    }
    result = result.split(src).join(localPath);
  }
  return { html: result, count };
}

async function ensureCategory(
  env: Env,
  name: string,
  rawSlug: string,
  now: string,
): Promise<string> {
  const slug =
    sanitizeImportSlug(rawSlug) ||
    sanitizeImportSlug(name.replace(/\s+/g, "-")) ||
    `cat-${makeId("c").slice(2)}`;
  const existing = await env.DB.prepare(
    "SELECT id FROM categories WHERE slug = ?",
  )
    .bind(slug)
    .first<{ id: string }>();
  if (existing) return existing.id;
  // cid IS the slug — keep import-created categories on the same key scheme as
  // UI-created ones (no more cat_* ids that the slug-validated admin can't edit).
  const cid = slug;
  await env.DB.prepare(
    "INSERT INTO categories (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(cid, name.slice(0, 120), slug, now, now)
    .run();
  return cid;
}

async function importKurocmsCategories(
  env: Env,
  baseUrl: string,
  pat: string,
  remoteDid: string,
  localDid: string,
  remoteCatMap: Map<string, { name: string; slug: string }>,
  now: string,
): Promise<void> {
  if (!remoteDid || remoteCatMap.size === 0) return;
  const catData = (await kurocmsFetch(
    baseUrl,
    pat,
    `/api/documents/${remoteDid}/categories`,
  ).catch(() => null)) as {
    categories?: string[];
  } | null;
  for (const remoteCid of catData?.categories ?? []) {
    const catInfo = remoteCatMap.get(remoteCid);
    if (!catInfo) continue;
    const localCid = await ensureCategory(env, catInfo.name, catInfo.slug, now);
    await env.DB.prepare(
      "INSERT OR IGNORE INTO document_categories (did, cid) VALUES (?, ?)",
    )
      .bind(localDid, localCid)
      .run();
  }
}

async function importStrapiCategories(
  env: Env,
  article: StrapiArticleRow,
  did: string,
  now: string,
  configuredField = "categories",
): Promise<void> {
  // Try configured field first, then common fallback names
  const catFields = [
    configuredField,
    ...["categories", "category", "tags"].filter((f) => f !== configuredField),
  ];
  for (const field of catFields) {
    const raw = article[field];
    if (!raw) continue;
    // Normalize: array (Strapi v5) or {data:[{attributes:{name,slug}}]} (Strapi v4)
    let items: Array<Record<string, unknown>> = [];
    if (Array.isArray(raw)) {
      items = raw as Array<Record<string, unknown>>;
    } else if (raw && typeof raw === "object") {
      const data = (raw as Record<string, unknown>).data;
      if (Array.isArray(data)) {
        items = data.map((d) => {
          const attrs = (d as Record<string, unknown>).attributes as
            | Record<string, unknown>
            | undefined;
          return attrs ? attrs : (d as Record<string, unknown>);
        });
      }
    }
    for (const item of items) {
      // Accept name / title / label as the display name (Strapi setups vary)
      const name = String(item.name ?? item.title ?? item.label ?? "").trim();
      if (!name) continue;
      const slug = String(item.slug ?? "").trim();
      const cid = await ensureCategory(env, name, slug, now);
      await env.DB.prepare(
        "INSERT OR IGNORE INTO document_categories (did, cid) VALUES (?, ?)",
      )
        .bind(did, cid)
        .run();
    }
    if (items.length > 0) break; // use first field that has data
  }
}

// Sentinel destination type meaning "map each article to its own Strapi `type`".
const STRAPI_TID_ALL = "__all__";

// Resolve the destination KuroCMS type id from a Strapi article's `type` field.
// Strapi `type` may be a plain enum string or a relation/component object.
function resolveStrapiTypeTid(article: StrapiArticleRow): string {
  const raw = article.type;
  if (typeof raw === "string") return raw.trim();
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const cand = o.slug ?? o.tid ?? o.key ?? o.value ?? o.name ?? o.id;
    if (cand != null) return String(cand).trim();
  }
  return "";
}

async function strapiImportExecute(
  request: Request,
  env: Env,
  user: AuthUser,
): Promise<Response> {
  requireAuthor(user);
  // 一括上書きは管理画面からの明示操作に限る（PAT では実行させない）。
  requireInteractiveUser(user);
  const body = await readJson(request);
  const ids: string[] | "all" =
    body.ids === "all"
      ? "all"
      : Array.isArray(body.ids)
        ? (body.ids as string[])
        : [];
  const overwriteIds: string[] = Array.isArray(body.overwriteIds)
    ? (body.overwriteIds as string[])
    : [];
  // overwriteAll: re-import (overwrite) every existing document, EXCEPT those in
  // protectIds (used by "全件" so unmodified existing docs aren't silently
  // skipped). Without it, only docs listed in overwriteIds are overwritten.
  const overwriteAll = body.overwriteAll === true;
  const protectIds: string[] = Array.isArray(body.protectIds)
    ? (body.protectIds as string[])
    : [];
  const tid = requireString(body, "tid", { min: 1, max: 80 });
  const lang = requireString(body, "lang", { min: 2, max: 20 });

  const cfg = await readStrapiSettings(env);
  if (!cfg.url)
    throw new HttpError(
      400,
      "strapi_not_configured",
      "Strapi URL が設定されていません。",
    );

  // "すべて" mode: each article goes to the KuroCMS type matching its Strapi
  // `type` field. Build a lookup keyed by BOTH id and slug (lowercased) → type
  // id, so e.g. Strapi type "product" resolves to an existing type whose slug is
  // "product" even if its id differs (avoids creating duplicate types).
  const perArticleType = tid === STRAPI_TID_ALL;
  const typeIdByKey = new Map<string, string>();
  if (perArticleType) {
    const typeRows = await env.DB.prepare(
      "SELECT id, slug FROM taxonomy_items WHERE kind='type'",
    ).all<{ id: string; slug: string | null }>();
    for (const r of typeRows.results || []) {
      const id = String(r.id);
      typeIdByKey.set(id.toLowerCase(), id);
      if (r.slug) typeIdByKey.set(String(r.slug).toLowerCase(), id);
    }
  }

  // Page mode: when `page` is given, process ONLY that page so each request
  // stays within Worker subrequest/CPU limits (full import = client loops pages).
  // Without `page`, keep the legacy all-pages behaviour (small selected sets).
  const singlePage =
    typeof body.page === "number" && Number.isFinite(body.page)
      ? Math.max(1, Math.floor(body.page))
      : null;
  const pageSize =
    typeof body.pageSize === "number" && body.pageSize > 0
      ? Math.min(50, Math.floor(body.pageSize))
      : singlePage
        ? 10
        : 25;

  const allArticles: StrapiArticleRow[] = [];
  let reqPageCount: number;
  let reqTotal: number;
  if (singlePage !== null) {
    const qs = `populate=*&pagination[pageSize]=${pageSize}&pagination[page]=${singlePage}`;
    const data = (await strapiFetch(
      cfg.url,
      cfg.token,
      `/api/${cfg.contentType}?${qs}`,
    )) as {
      data?: StrapiArticleRow[];
      meta?: { pagination?: { pageCount?: number; total?: number } };
    };
    allArticles.push(...(data.data || []));
    reqPageCount = data.meta?.pagination?.pageCount ?? 1;
    reqTotal = data.meta?.pagination?.total ?? allArticles.length;
  } else {
    let page = 1;
    let data: {
      data?: StrapiArticleRow[];
      meta?: { pagination?: { pageCount?: number; total?: number } };
    } = {};
    do {
      const qs = `populate=*&pagination[pageSize]=25&pagination[page]=${page}`;
      data = (await strapiFetch(
        cfg.url,
        cfg.token,
        `/api/${cfg.contentType}?${qs}`,
      )) as typeof data;
      allArticles.push(...(data.data || []));
      page++;
    } while (page <= (data.meta?.pagination?.pageCount ?? 1));
    reqPageCount = data.meta?.pagination?.pageCount ?? 1;
    reqTotal = data.meta?.pagination?.total ?? allArticles.length;
  }

  // Filter to requested ids
  const toImport =
    ids === "all"
      ? allArticles
      : allArticles.filter((a) => ids.includes(String(a.documentId || a.id)));

  let imported = 0;
  let overwritten = 0;
  let skipped = 0;
  let imagesDownloaded = 0;
  const errors: string[] = [];
  const now = nowIso();
  // Per-execution cache: Strapi URL → local publicPath (avoids duplicate downloads)
  const imageCache = new Map<string, string>();

  for (const article of toImport) {
    try {
      const rawSlug = String(article[cfg.fieldSlug] ?? article.slug ?? "");
      const slug = sanitizeImportSlug(rawSlug) || `imported-${makeId("s")}`;
      const title = String(article[cfg.fieldTitle] ?? article.title ?? slug);
      const rawSummary = String(
        article[cfg.fieldSummary] ?? article.description ?? "",
      );
      const summary = rawSummary.slice(0, 200);
      const rawBody = article[cfg.fieldBody] ?? article.content;
      let bodyHtml = strapiBlocksToHtml(rawBody);
      // Strapi's createdAt/updatedAt/publishedAt are all system-managed and
      // can't be set by the author, so the real publish date lives in the
      // custom `displayPublishedAt` field. Prefer it; fall back to publishedAt.
      const rawDate = article.displayPublishedAt ?? article.publishedAt;
      const publishAt = (() => {
        if (rawDate) {
          const d = new Date(String(rawDate));
          if (!Number.isNaN(d.getTime())) return d.toISOString();
        }
        return now;
      })();
      // Mirror Strapi's publish state: a published Strapi entry (publishedAt set)
      // becomes a published KuroCMS document (mode=1), so imported articles are
      // visible on the site without a manual publish step. Drafts stay mode=0.
      const pubMode = article.publishedAt ? 1 : 0;

      // Resolve destination type: fixed (selected type) or per-article ("すべて").
      let destTid = tid;
      if (perArticleType) {
        const rawType = resolveStrapiTypeTid(article);
        if (!rawType) {
          errors.push(`${slug}: タイプ未設定`);
          skipped++;
          continue;
        }
        let resolvedId = typeIdByKey.get(rawType.toLowerCase());
        if (!resolvedId) {
          // No matching type by id or slug → auto-create one so every article
          // can be imported (e.g. a "product" type that didn't exist).
          const typeId = sanitizeImportSlug(rawType);
          if (!typeId) {
            errors.push(`${slug}: 不正なタイプ (${rawType})`);
            skipped++;
            continue;
          }
          resolvedId = typeIdByKey.get(typeId.toLowerCase());
          if (!resolvedId) {
            await env.DB.prepare(
              "INSERT INTO taxonomy_items (id, kind, lang, name, slug, source_type, schema_json, is_system, created_at, updated_at) VALUES (?, 'type', '', ?, ?, 'collection', '{}', 0, ?, ?) ON CONFLICT(id, kind, lang) DO NOTHING",
            )
              .bind(typeId, rawType, typeId, now, now)
              .run();
            resolvedId = typeId;
            typeIdByKey.set(typeId.toLowerCase(), typeId);
          }
          typeIdByKey.set(rawType.toLowerCase(), resolvedId);
        }
        destTid = resolvedId;
      }

      const strapiId = String(article.documentId || article.id);
      // Find EVERY existing doc for this Strapi article. Match by the stable
      // strapi_document_id (catches type changes like blog→news via "すべて",
      // and any duplicate docs created by earlier imports), falling back to slug
      // only for legacy docs that predate strapi_document_id. Keeping the oldest
      // and deleting the rest collapses duplicates onto one document.
      const dupes = await env.DB.prepare(
        "SELECT did FROM documents WHERE strapi_document_id = ? OR (strapi_document_id IS NULL AND slug = ?) ORDER BY created_at ASC, did ASC",
      )
        .bind(strapiId, slug)
        .all<{ did: string }>();
      const dupRows = dupes.results || [];
      const existing = dupRows.length ? { did: dupRows[0].did } : null;

      const shouldOverwrite = overwriteAll
        ? !protectIds.includes(strapiId)
        : overwriteIds.includes(strapiId);
      if (existing && !shouldOverwrite) {
        skipped++;
        continue;
      }

      // Collapse duplicates: when overwriting, remove all but the kept doc.
      if (existing && dupRows.length > 1) {
        for (const extra of dupRows.slice(1)) {
          await env.DB.batch([
            env.DB.prepare(
              "DELETE FROM document_categories WHERE did = ?",
            ).bind(extra.did),
            env.DB.prepare("DELETE FROM search_entries WHERE did = ?").bind(
              extra.did,
            ),
            env.DB.prepare(
              "DELETE FROM document_translation_revisions WHERE did = ?",
            ).bind(extra.did),
            env.DB.prepare(
              "DELETE FROM document_translations WHERE did = ?",
            ).bind(extra.did),
            env.DB.prepare("DELETE FROM documents WHERE did = ?").bind(
              extra.did,
            ),
          ]);
        }
      }

      // Download images in body HTML and rewrite URLs to R2
      const { html: rewrittenHtml, count: imgCount } =
        await rewriteStrapiImages(
          bodyHtml,
          cfg.url,
          cfg.token,
          env,
          user.uid,
          imageCache,
        );
      bodyHtml = rewrittenHtml;
      imagesDownloaded += imgCount;

      // Extract cover image: check common Strapi cover field names
      let coverMid: string | null = null;
      let coverPath: string | null = null;
      const coverFields = [
        "cover",
        "image",
        "thumbnail",
        "featuredImage",
        "coverImage",
        "photo",
      ];
      for (const field of coverFields) {
        const rawCover = article[field];
        // Strapi media fields may be a single object or an array (multiple).
        const coverData = (
          Array.isArray(rawCover) ? rawCover[0] : rawCover
        ) as {
          url?: string;
          formats?: { medium?: { url?: string } };
        } | null;
        if (coverData && typeof coverData === "object") {
          const coverUrl = coverData.url || coverData.formats?.medium?.url;
          if (coverUrl && typeof coverUrl === "string") {
            const cached = imageCache.get(coverUrl);
            if (cached) {
              coverPath = cached;
            } else {
              const stored = await downloadStrapiImage(
                coverUrl,
                cfg.url,
                env,
                user.uid,
                cfg.token,
              );
              if (stored) {
                coverPath = stored.publicPath;
                imageCache.set(coverUrl, stored.publicPath);
                imagesDownloaded++;
              }
            }
            if (coverPath) {
              const midMatch = coverPath.match(/\/(img[-_]\d+)\./);
              if (midMatch) coverMid = midMatch[1];
            }
            break;
          }
        }
      }

      // Fallback: many articles have no dedicated cover/featured field — their
      // only image is inline in the body. Use the first body image (already
      // downloaded to R2 as /images/...) so the card still shows a thumbnail.
      if (!coverPath) {
        const m = bodyHtml.match(/<img[^>]+src=["'](\/images\/[^"']+)["']/i);
        if (m) {
          coverPath = m[1];
          const midMatch = coverPath.match(/\/(img[-_]\d+)\./);
          if (midMatch) coverMid = midMatch[1];
        }
      }

      // Store coverPath whenever we have one (cards read coverPath; coverMid is
      // a best-effort media reference and may be null for fallback images).
      const seoJson = coverPath
        ? JSON.stringify({ coverMid, coverPath })
        : "{}";

      if (existing) {
        // Overwrite: refresh the publish date too (Strapi displayPublishedAt is
        // the source of truth), so re-importing corrects previously-wrong dates.
        await env.DB.prepare(
          `UPDATE documents SET tid = ?, publish_at = ?, mode = ?, updated_at = ?, updated_by = ?, strapi_document_id = ? WHERE did = ?`,
        )
          .bind(
            destTid,
            publishAt,
            pubMode,
            now,
            user.uid,
            strapiId,
            existing.did,
          )
          .run();

        // 保存の本体は共通経路へ。以前ここだけが直接 upsert していて、
        // 正規化も data-bid も履歴も無いまま既存記事を潰していた。
        await writeTranslationContent(env, {
          did: existing.did,
          lang,
          tid: destTid,
          title,
          summary,
          bodyHtml,
          seoJson: seoJson,
          hashtagJson: "[]",
          actorUid: user.uid,
          source: "import",
          createdAt: now,
          updatedAt: now,
        });

        // Import categories for overwritten document
        await importStrapiCategories(
          env,
          article,
          existing.did,
          now,
          cfg.fieldCategories,
        );
        overwritten++;
      } else {
        // New document
        const did = makeId("doc");
        await env.DB.prepare(
          `INSERT INTO documents (did, slug, tid, mode, initial_lang, fallback_lang, publish_at, created_at, updated_at, created_by, updated_by, strapi_document_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            did,
            slug,
            destTid,
            pubMode,
            lang,
            lang,
            publishAt,
            now,
            now,
            user.uid,
            user.uid,
            strapiId,
          )
          .run();

        await writeTranslationContent(env, {
          did,
          lang,
          tid: destTid,
          title,
          summary,
          bodyHtml,
          seoJson: seoJson,
          hashtagJson: "[]",
          actorUid: user.uid,
          source: "import",
          createdAt: now,
          updatedAt: now,
        });

        // Import categories for new document
        await importStrapiCategories(
          env,
          article,
          did,
          now,
          cfg.fieldCategories,
        );
        imported++;
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return json({
    ok: true,
    imported,
    overwritten,
    skipped,
    imagesDownloaded,
    errors,
    page: singlePage,
    pageCount: reqPageCount,
    total: reqTotal,
  });
}

// ─── KuroCMS import ───────────────────────────────────────────────────────────

async function readKurocmsImportSettings(
  env: Env,
): Promise<{ url: string; pat: string }> {
  const row = await env.DB.prepare(
    "SELECT kurocms_import_url, kurocms_import_pat FROM site_settings WHERE id = 1",
  ).first<Record<string, string>>();
  return {
    url: (row?.kurocms_import_url || "").replace(/\/+$/, ""),
    pat: row?.kurocms_import_pat || "",
  };
}

async function kurocmsFetch(
  baseUrl: string,
  pat: string,
  path: string,
): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (pat) headers["Authorization"] = `Bearer ${pat}`;
  const resp = await fetch(`${baseUrl}${path}`, { headers });
  if (!resp.ok)
    throw new HttpError(
      502,
      "kurocms_error",
      `KuroCMS returned ${resp.status}: ${resp.statusText}`,
    );
  return resp.json();
}

async function downloadKurocmsImage(
  imageUrl: string,
  baseUrl: string,
  pat: string,
  env: Env,
  userId: string,
): Promise<{ mid: string; publicPath: string } | null> {
  if (!env.MEDIA_BUCKET) return null;
  const fullUrl = imageUrl.startsWith("http")
    ? imageUrl
    : `${baseUrl}${imageUrl}`;
  try {
    const allowedHost = new URL(baseUrl).hostname;
    const targetHost = new URL(fullUrl).hostname;
    if (targetHost !== allowedHost) return null;
  } catch {
    return null;
  }
  try {
    // Dedup: reuse an already-imported asset with the same (stable) filename
    // instead of inserting a duplicate media_assets row on every re-import.
    const urlFilename = fullUrl.split("/").pop()?.split("?")[0] || "";
    if (urlFilename) {
      const existing = await env.DB.prepare(
        "SELECT mid, public_path AS publicPath FROM media_assets WHERE kind = 'image' AND filename = ? ORDER BY created_at LIMIT 1",
      )
        .bind(urlFilename)
        .first<{ mid: string; publicPath: string }>();
      if (existing) return existing;
    }
    const fetchHeaders: Record<string, string> = { Accept: "image/*" };
    if (pat) fetchHeaders["Authorization"] = `Bearer ${pat}`;
    const resp = await fetch(fullUrl, { headers: fetchHeaders });
    if (!resp.ok) return null;
    const contentType = resp.headers.get("content-type") || "image/jpeg";
    if (contentType.includes("svg")) return null;
    const ext = contentType.includes("png")
      ? "png"
      : contentType.includes("gif")
        ? "gif"
        : contentType.includes("webp")
          ? "webp"
          : "jpg";
    const filename = fullUrl.split("/").pop()?.split("?")[0] || `image.${ext}`;
    const buffer = await resp.arrayBuffer();
    const mid = await nextMediaId(env, "image");
    const version = cacheVersion();
    const publicPath = `/images/${mid}.${ext}`;
    await (env.MEDIA_BUCKET as R2Bucket).put(`images/${mid}.${ext}`, buffer, {
      httpMetadata: { contentType },
      customMetadata: {
        originalFilename: filename,
        version,
        source: "kurocms-import",
      },
    });
    const now = nowIso();
    await env.DB.prepare(
      `INSERT INTO media_assets (mid, kind, filename, ext, mime, width, height, size_bytes, public_path, cache_version, created_at, updated_at, created_by)
       VALUES (?, 'image', ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        mid,
        filename,
        ext,
        contentType,
        buffer.byteLength,
        publicPath,
        version,
        now,
        now,
        userId,
      )
      .run();
    return { mid, publicPath };
  } catch {
    return null;
  }
}

async function rewriteKurocmsImages(
  html: string,
  baseUrl: string,
  pat: string,
  env: Env,
  userId: string,
  cache: Map<string, string>,
): Promise<{ html: string; count: number }> {
  if (!html || !env.MEDIA_BUCKET) return { html, count: 0 };
  const matches: string[] = [];
  const pattern = /src="(https?:\/\/[^"]+|\/[^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(html)) !== null) matches.push(m[1]);
  let result = html;
  let count = 0;
  for (const src of matches) {
    if (result.indexOf(src) === -1) continue;
    let localPath = cache.get(src);
    if (!localPath) {
      const stored = await downloadKurocmsImage(src, baseUrl, pat, env, userId);
      localPath = stored?.publicPath ?? src;
      cache.set(src, localPath);
      if (stored) count++;
    }
    result = result.split(src).join(localPath);
  }
  return { html: result, count };
}

async function kurocmsImportSettings(
  request: Request,
  env: Env,
  user: AuthUser,
): Promise<Response> {
  requireAdmin(user);
  if (request.method === "GET") {
    const cfg = await readKurocmsImportSettings(env);
    return json({ kurocmsUrl: cfg.url, kurocmsPat: cfg.pat });
  }
  if (request.method === "PUT") {
    const body = await readJson(request);
    await saveSettings(env, {
      kurocms_import_url: optionalString(body, "kurocmsUrl") ?? "",
      kurocms_import_pat: optionalString(body, "kurocmsPat") ?? "",
    });
    return json({ ok: true });
  }
  throw new HttpError(405, "method_not_allowed", "Method not allowed.");
}

async function kurocmsImportPreview(
  _request: Request,
  env: Env,
  user: AuthUser,
  url: URL,
): Promise<Response> {
  requireAuthor(user);
  const tid = url.searchParams.get("tid") || "";
  const cfg = await readKurocmsImportSettings(env);
  if (!cfg.url)
    throw new HttpError(
      400,
      "kurocms_not_configured",
      "KuroCMS URL が設定されていません。",
    );

  const data = (await kurocmsFetch(
    cfg.url,
    cfg.pat,
    "/kurocms/api/documents",
  )) as {
    documents?: Array<Record<string, unknown>>;
  };
  const rows = data.documents || [];

  const slugs = rows.map((d) => String(d.slug ?? "")).filter(Boolean);
  const existingMap = new Map<
    string,
    { modifiedSinceImport: boolean; updatedAt: string }
  >();
  if (slugs.length > 0) {
    const BATCH = 50;
    for (let i = 0; i < slugs.length; i += BATCH) {
      const chunk = slugs.slice(i, i + BATCH);
      const ph = chunk.map(() => "?").join(",");
      const query = tid
        ? `SELECT slug, created_at, updated_at FROM documents WHERE tid = ? AND slug IN (${ph})`
        : `SELECT slug, created_at, updated_at FROM documents WHERE slug IN (${ph})`;
      const bindings = tid ? [tid, ...chunk] : chunk;
      const existing = await env.DB.prepare(query)
        .bind(...bindings)
        .all<{ slug: string; created_at: string; updated_at: string }>();
      for (const r of existing.results ?? []) {
        existingMap.set(r.slug, {
          modifiedSinceImport: r.updated_at > r.created_at,
          updatedAt: r.updated_at,
        });
      }
    }
  }

  const articles = rows.map((d) => {
    const slug = String(d.slug ?? "");
    const title = String(d.title ?? slug);
    const meta = existingMap.get(slug);
    return {
      id: String(d.did ?? ""),
      title,
      slug,
      languages: typeof d.languages === "string" ? d.languages.split(",") : [],
      publishedAt: d.publish_at ? String(d.publish_at) : null,
      exists: !!meta,
      modifiedSinceImport: meta?.modifiedSinceImport ?? false,
      updatedAt: meta?.updatedAt ?? null,
    };
  });

  return json({ articles, total: articles.length });
}

async function kurocmsImportExecute(
  request: Request,
  env: Env,
  user: AuthUser,
): Promise<Response> {
  requireAuthor(user);
  // 一括上書きは管理画面からの明示操作に限る（PAT では実行させない）。
  requireInteractiveUser(user);
  const body = await readJson(request);
  const ids: string[] | "all" =
    body.ids === "all"
      ? "all"
      : Array.isArray(body.ids)
        ? (body.ids as string[])
        : [];
  const overwriteIds: string[] = Array.isArray(body.overwriteIds)
    ? (body.overwriteIds as string[])
    : [];
  const tid = requireString(body, "tid", { min: 1, max: 80 });
  const lang = requireString(body, "lang", { min: 2, max: 20 });

  const cfg = await readKurocmsImportSettings(env);
  if (!cfg.url)
    throw new HttpError(
      400,
      "kurocms_not_configured",
      "KuroCMS URL が設定されていません。",
    );

  const data = (await kurocmsFetch(
    cfg.url,
    cfg.pat,
    "/kurocms/api/documents",
  )) as {
    documents?: Array<Record<string, unknown>>;
  };
  const allDocs = data.documents || [];
  const toImport =
    ids === "all"
      ? allDocs
      : allDocs.filter((d) => ids.includes(String(d.did ?? "")));

  // Fetch remote categories once and build cid→{name,slug} map
  const remoteCatsData = (await kurocmsFetch(
    cfg.url,
    cfg.pat,
    "/api/categories",
  ).catch(() => null)) as {
    categories?: Array<{ cid: string; name: string; slug: string }>;
  } | null;
  const remoteCatMap = new Map<string, { name: string; slug: string }>();
  for (const cat of remoteCatsData?.categories ?? []) {
    if (cat.cid && cat.name)
      remoteCatMap.set(cat.cid, { name: cat.name, slug: cat.slug || cat.name });
  }

  let imported = 0;
  let overwritten = 0;
  let skipped = 0;
  let imagesDownloaded = 0;
  const errors: string[] = [];
  const now = nowIso();
  const imageCache = new Map<string, string>();

  for (const doc of toImport) {
    try {
      const slug = String(doc.slug ?? "") || `imported-${makeId("s")}`;
      const remoteDid = String(doc.did ?? "");
      const publishAt = doc.publish_at ? String(doc.publish_at) : now;

      const existing = await env.DB.prepare(
        "SELECT did FROM documents WHERE slug = ? AND tid = ?",
      )
        .bind(slug, tid)
        .first<{ did: string }>();
      if (existing && !overwriteIds.includes(remoteDid)) {
        skipped++;
        continue;
      }

      // Fetch the translation from remote
      const tlData = (await kurocmsFetch(
        cfg.url,
        cfg.pat,
        `/kurocms/api/documents/${remoteDid}/translations/${lang}`,
      ).catch(() => null)) as {
        translation?: Record<string, unknown>;
      } | null;
      const tl = tlData?.translation;
      if (!tl) {
        skipped++;
        continue;
      }

      const title = String(tl.title ?? slug);
      const summary = String(tl.summary ?? "").slice(0, 200);
      const rawHtml = String(tl.body_html ?? "");
      const seoRaw = tl.seo_json ? String(tl.seo_json) : "{}";
      const hashtagRaw = tl.hashtag_json ? String(tl.hashtag_json) : "[]";

      const { html: bodyHtml, count: imgCount } = await rewriteKurocmsImages(
        rawHtml,
        cfg.url,
        cfg.pat,
        env,
        user.uid,
        imageCache,
      );
      imagesDownloaded += imgCount;

      if (existing) {
        await env.DB.prepare(
          "UPDATE documents SET updated_at = ?, updated_by = ? WHERE did = ?",
        )
          .bind(now, user.uid, existing.did)
          .run();
        await writeTranslationContent(env, {
          did: existing.did,
          lang,
          tid,
          title,
          summary,
          bodyHtml,
          seoJson: seoRaw,
          hashtagJson: hashtagRaw,
          actorUid: user.uid,
          source: "import",
          createdAt: now,
          updatedAt: now,
        });
        await importKurocmsCategories(
          env,
          cfg.url,
          cfg.pat,
          remoteDid,
          existing.did,
          remoteCatMap,
          now,
        );
        overwritten++;
      } else {
        const did = makeId("doc");
        await env.DB.prepare(
          `INSERT INTO documents (did, slug, tid, mode, initial_lang, fallback_lang, publish_at, created_at, updated_at, created_by, updated_by)
           VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            did,
            slug,
            tid,
            lang,
            lang,
            publishAt,
            now,
            now,
            user.uid,
            user.uid,
          )
          .run();
        await writeTranslationContent(env, {
          did,
          lang,
          tid,
          title,
          summary,
          bodyHtml,
          seoJson: seoRaw,
          hashtagJson: hashtagRaw,
          actorUid: user.uid,
          source: "import",
          createdAt: now,
          updatedAt: now,
        });
        await importKurocmsCategories(
          env,
          cfg.url,
          cfg.pat,
          remoteDid,
          did,
          remoteCatMap,
          now,
        );
        imported++;
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return json({
    ok: true,
    imported,
    overwritten,
    skipped,
    imagesDownloaded,
    errors,
  });
}
