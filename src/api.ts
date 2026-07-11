import {
  SESSION_COOKIE,
  bootstrapAdmin,
  clearSessionCookieHeader,
  createSession,
  createPersonalAccessToken,
  requireAdmin,
  requireAuth,
  requireAuthor,
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
import { KUROMAILER_SHARED_SECRET } from "./kuromailer-secret";
import { verifyRegistration, verifyAuthentication } from "./webauthn";
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
  FONT_CATALOG,
  SYSTEM_FONTS,
  findCatalogEntry,
  findSystemFont,
  familyStack,
} from "./templates/font-catalog";
import type { AuthUser, Env, JsonValue } from "./types";
import { handleMcp } from "./mcp";

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

export const KUROCMS_VERSION = "1.8.12";
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
};

export async function handleApi(
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
      return json({ ok: true, applied }, { headers: jsonHeaders });
    }

    if (request.method === "GET" && path === "/api/help") {
      return json(
        {
          ok: true,
          message: "KuroCMS REST API",
          base: "/kurocms/api/",
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
              "GET|POST /api/documents (POST=create; 409 if slug exists)",
              "GET|PUT|DELETE /api/documents/:id (:id = did or globally-unique slug)",
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
            settings: ["GET|PUT /api/settings"],
            operations: ["POST /api/build", "GET|POST /api/backups"],
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
      return withJsonHeaders(await systemVersion(env));
    }

    if (request.method === "POST" && path === "/api/system/update") {
      requireAdmin(user);
      return withJsonHeaders(await systemUpdate(env, user));
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
    // ── Site management: single content ─────────────────────────────────────
    if (request.method === "GET" && path === "/api/v1/content") {
      return withJsonHeaders(await siteContentList(request, env, user));
    }
    if (request.method === "POST" && path === "/api/v1/content") {
      return withJsonHeaders(await siteContentCreate(request, env, user));
    }
    const siteContentMatch = path.match(
      new RegExp("^/api/v1/content/([^/]+)$"),
    );
    if (request.method === "PUT" && siteContentMatch) {
      return withJsonHeaders(
        await siteContentUpdate(request, env, user, siteContentMatch[1]),
      );
    }
    if (request.method === "DELETE" && siteContentMatch) {
      return withJsonHeaders(
        await siteContentDelete(request, env, user, siteContentMatch[1]),
      );
    }

    // One-off: normalize legacy "_" media IDs (img_146) to "-" (img-146).
    // NOTE: not under /api/admin/* — that prefix is rewritten to /api/* by
    // normalizeAdminApiPath (the admin SPA's API access path).
    if (
      request.method === "POST" &&
      path === "/api/system/migrate-mid-separator"
    ) {
      return withJsonHeaders(await migrateMidSeparator(request, env, user));
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

    const buildDocMatch = path.match(/^\/api\/documents\/([^/]+)\/build$/);
    if (request.method === "POST" && buildDocMatch) {
      requireAuthor(user);
      await buildDocumentPages(env, buildDocMatch[1]);
      return json(
        { ok: true, did: buildDocMatch[1] },
        { headers: jsonHeaders },
      );
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
    WHERE d.tid = ? AND d.mode = 1
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
 * Resolve an unused invitation by its plaintext token. Invitations are stored as
 * a SHA-256 hash (like recovery tokens / PATs); a legacy plaintext row is still
 * matched for backward compatibility so outstanding invites keep working until
 * they expire. Returns the stored PK value (`token`) so callers consume the exact
 * row. Does NOT check expiry — each caller decides how to report it.
 */
async function lookupInvitationToken(
  env: Env,
  token: string,
): Promise<InvitationRow | null> {
  const tokenHash = await sha256Hex(token);
  return await env.DB.prepare(
    `SELECT token, email, is_admin, is_author, expires_at
     FROM invitation_tokens WHERE token IN (?, ?) AND used_at IS NULL`,
  )
    .bind(tokenHash, token)
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
  if (!updates.length)
    throw new HttpError(400, "no_changes", "変更する項目がありません。");
  updates.push("updated_at = ?");
  values.push(nowIso(), uid);
  await env.DB.prepare(`UPDATE users SET ${updates.join(", ")} WHERE uid = ?`)
    .bind(...values)
    .run();
  await logActivity(env, user, "user.update", "user", uid, {});
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
    enabled_languages: defaultLang,
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

async function fetchReleaseChannels(env: Env): Promise<ReleaseChannels> {
  const cached = await env.PUBLIC_PAGES.get(RELEASE_CHANNELS_CACHE_KEY);
  if (cached) {
    try {
      return JSON.parse(cached) as ReleaseChannels;
    } catch {
      /* stale/corrupt cache entry — refetch below */
    }
  }
  const ghRes = await fetch(
    `https://api.github.com/repos/${KUROCMS_GITHUB_REPO}/releases?per_page=10`,
    { headers: githubApiHeaders(env) },
  );
  if (!ghRes.ok) throw new Error(`GitHub API returned ${ghRes.status}`);
  const list = (await ghRes.json()) as Array<{
    tag_name: string;
    prerelease: boolean;
    draft: boolean;
  }>;
  const rolling = list.find((r) => !r.draft);
  const stableRelease = list.find((r) => !r.draft && !r.prerelease);
  if (!rolling || !stableRelease)
    throw new Error("No published releases found.");
  const channels: ReleaseChannels = {
    latest: rolling.tag_name.replace(/^v/, ""),
    stable: stableRelease.tag_name.replace(/^v/, ""),
  };
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

async function systemVersion(env: Env): Promise<Response> {
  const current = KUROCMS_VERSION;
  const channel = await getUpdateChannel(env);
  let stable = current;
  let latest = current;
  try {
    const channels = await fetchReleaseChannels(env);
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

async function systemUpdate(env: Env, user: AuthUser): Promise<Response> {
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

  // Fetch the release for the currently selected channel. "stable" reuses
  // GitHub's own /releases/latest (which already skips prerelease/draft);
  // "latest" takes the newest release regardless of prerelease. Both come
  // back as full release objects (with assets), unlike the lightweight
  // tag-only lookup cached by fetchReleaseChannels for the dashboard display.
  const channel = await getUpdateChannel(env);
  const ghRes = await fetch(
    channel === "latest"
      ? `https://api.github.com/repos/${KUROCMS_GITHUB_REPO}/releases?per_page=1`
      : `https://api.github.com/repos/${KUROCMS_GITHUB_REPO}/releases/latest`,
    { headers: githubApiHeaders(env) },
  );
  if (!ghRes.ok) {
    const ghBody = await ghRes.text().catch(() => "");
    throw new HttpError(
      502,
      "github_unreachable",
      `GitHub API returned ${ghRes.status}: ${ghBody.slice(0, 200)}`,
    );
  }
  const ghData = await ghRes.json();
  const release = (channel === "latest" ? (ghData as unknown[])[0] : ghData) as
    | {
        tag_name: string;
        assets: Array<{ name: string; browser_download_url: string }>;
      }
    | undefined;
  if (!release)
    throw new HttpError(
      502,
      "no_release_found",
      `No GitHub release found for the "${channel}" channel.`,
    );
  const workerAsset = release.assets.find((a) => a.name === "worker.js");
  if (!workerAsset)
    throw new HttpError(
      502,
      "no_worker_asset",
      `No worker.js asset found in the "${channel}" GitHub release.`,
    );
  // Apply pending migrations directly via D1 binding (run-once, additive-only).
  // Use the immutable, version-pinned manifest asset URL from the GitHub API
  // (release.assets) — NOT the CDN-cached latest/download redirect, which the
  // Worker's fetch() can serve stale, skipping freshly-released migrations,
  // AND which always resolves to GitHub's true latest regardless of channel.
  const manifestAsset = release.assets.find(
    (a) => a.name === "migrations-manifest.json",
  );
  const migrationsApplied = await applyPendingMigrations(
    env,
    manifestAsset?.browser_download_url,
  );

  // Download the compiled Worker script from the version-pinned asset URL —
  // NOT /latest/download/, which always resolves to GitHub's true latest
  // release regardless of which channel was selected above.
  const scriptRes = await fetch(workerAsset.browser_download_url, {
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!scriptRes.ok)
    throw new HttpError(
      502,
      "download_failed",
      `Failed to download worker.js from GitHub release (HTTP ${scriptRes.status}).`,
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
    version: release.tag_name,
    channel,
    migrationsApplied,
  });
  // Invalidate the cached channel lookup so the next check reflects reality now.
  await env.PUBLIC_PAGES.delete(RELEASE_CHANNELS_CACHE_KEY).catch(() => {});
  return json({
    ok: true,
    version: release.tag_name,
    channel,
    migrationsApplied,
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
    const enabledLanguages = parseLanguageList(
      row?.enabled_languages as string | undefined,
      [defaultLang],
    );
    return json({
      settings: {
        siteName: (row?.site_name as string | undefined) ?? "KuroCMS",
        siteDescription: (row?.site_description as string | undefined) ?? "",
        ga4MeasurementId: (row?.ga4_measurement_id as string | undefined) ?? "",
        publicDomain: (row?.public_domain as string | undefined) ?? "",
        developmentDomain: deriveInternalPreviewUrl(request, env),
        defaultLang,
        initialLang: (row?.initial_lang as string | undefined) ?? defaultLang,
        enabledLanguages,
        adminLogo: (row?.admin_logo as string | undefined) ?? "",
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
        blueskyShowFeed: row?.bluesky_show_feed === 1,
        blueskyFeedPosition:
          (row?.bluesky_feed_position as string | undefined) ?? "left",
        blueskySid: (row?.bluesky_sid as string | undefined) ?? "",
        blueskyTokenSet: !!(row?.bluesky_token as string | undefined),
        xApiKeySet: !!(row?.x_api_key as string | undefined),
        xApiSecretSet: !!(row?.x_api_secret as string | undefined),
        xAccessTokenSet: !!(row?.x_access_token as string | undefined),
        xAccessSecretSet: !!(row?.x_access_secret as string | undefined),
        xLinkInReply: (row?.x_link_in_reply as number | undefined) !== 0,
        threadsHandle: (row?.threads_handle as string | undefined) ?? "",
        threadsShowFeed: row?.threads_show_feed === 1,
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
    const developmentDomain = deriveInternalPreviewUrl(request, env);
    const defaultLang = requireString(body, "defaultLang", { min: 2, max: 20 });
    // initial_lang (初期作成言語) is unified into default_lang: the admin UI no
    // longer exposes it, so default to default_lang when the client omits it.
    const initialLang = optionalString(body, "initialLang") ?? defaultLang;
    const enabledLanguages = parseLanguageList(body.enabledLanguages, [
      defaultLang,
    ]);
    const adminLogo = optionalString(body, "adminLogo") ?? "";
    const themeAccent = optionalString(body, "themeAccent") ?? "#157a6e";

    const themeSidebar = optionalString(body, "themeSidebar") ?? "#ffffff";
    const themeMainPane = optionalString(body, "themeMainPane") ?? "#f7f8fb";
    const hasBlueskyHandle = "blueskyHandle" in body;
    const hasBlueskyShowFeed = "blueskyShowFeed" in body;
    const hasBlueskyFeedPosition = "blueskyFeedPosition" in body;
    const hasBlueskySid = "blueskySid" in body;
    const blueskyHandle = optionalString(body, "blueskyHandle") ?? "";
    const blueskyShowFeed =
      body.blueskyShowFeed === true || body.blueskyShowFeed === "true";
    const blueskyFeedPosition =
      optionalString(body, "blueskyFeedPosition") === "right"
        ? "right"
        : "left";
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
    // threads_* are NOT sent by the current settings form (Threads/X/etc. are
    // managed via external_connections). Like ga4/siteDescription, only update
    // them when explicitly present so a settings save doesn't reset them.
    const hasThreadsHandle = "threadsHandle" in body;
    const hasThreadsShowFeed = "threadsShowFeed" in body;
    const threadsHandle = optionalString(body, "threadsHandle") ?? "";
    const threadsShowFeed =
      body.threadsShowFeed === true || body.threadsShowFeed === "true";

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
    for (const lang of enabledLanguages) {
      validateLanguage(lang, "enabledLanguages");
    }
    validateHexColor(themeAccent, "themeAccent");
    validateHexColor(themeSidebar, "themeSidebar");
    validateHexColor(themeMainPane, "themeMainPane");

    const settingsToSave: Record<string, string | number> = {
      site_name: siteName,
      public_domain: publicDomain,
      development_domain: developmentDomain,
      default_lang: defaultLang,
      initial_lang: initialLang,
      enabled_languages: enabledLanguages.join(","),
      admin_logo: adminLogo,
      theme_accent: themeAccent,
      theme_sidebar: themeSidebar,
      theme_main_pane: themeMainPane,
    };
    // Preserve unless explicitly provided (see notes above).
    if (hasBlueskyHandle) settingsToSave.bluesky_handle = blueskyHandle;
    // INTEGER columns: store 1/0, not "true"/"false". A text value left the
    // admin GET (`=== 1`) and public read (truthy) disagreeing.
    if (hasBlueskyShowFeed)
      settingsToSave.bluesky_show_feed = blueskyShowFeed ? 1 : 0;
    if (hasBlueskyFeedPosition)
      settingsToSave.bluesky_feed_position = blueskyFeedPosition;
    if (hasBlueskySid) settingsToSave.bluesky_sid = blueskySid;
    if (hasSiteDescription) settingsToSave.site_description = siteDescription;
    if (hasGa4) settingsToSave.ga4_measurement_id = ga4MeasurementId;
    if (hasThreadsHandle) settingsToSave.threads_handle = threadsHandle;
    if (hasThreadsShowFeed)
      settingsToSave.threads_show_feed = threadsShowFeed ? 1 : 0;
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
    await saveSettings(env, settingsToSave);

    await logActivity(env, user, "settings.update", "settings", "site", {
      siteName,
      publicDomain,
      developmentDomain,
      defaultLang,
      initialLang,
      enabledLanguages,
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
    "SELECT tid, slug, initial_lang, sns_bsky_posted_at FROM documents WHERE did = ? AND mode = 1",
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
    console.warn(
      JSON.stringify({
        event: "bsky_post_failed",
        did,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return { ok: false, code: "post_failed" };
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
    not_published: [409, "Publish the article before posting to Bluesky."],
    already_posted: [409, "This article was already posted to Bluesky."],
    cover_failed: [502, "The cover image could not be prepared for Bluesky."],
    post_failed: [502, "Posting to Bluesky failed. Check your credentials."],
  };
  const [status, message] = failures[result.code] ?? [500, "Posting failed."];
  throw new HttpError(status, "bsky_" + result.code, message);
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
    if (!parentId) throw new Error("x tweet returned no id for the reply");
    // Reply = lead-in + URL (~50 weight) — plenty of room for the language
    // line. Still guard the 280 budget for a pathological language count.
    let replyText = xReplyText(lang, url);
    if (langLine) {
      const withLangs = `${replyText}\n\n${langLine}`;
      const weight = xWeightedLength(withLangs.replace(url, "")) + X_URL_WEIGHT;
      if (weight <= 280) replyText = withLangs;
    }
    const replyRes = await fetch(X_TWEET_URL, {
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
    if (!replyRes.ok) {
      throw new Error(
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
        | "post_failed";
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
    "SELECT tid, slug, initial_lang, sns_x_posted_at FROM documents WHERE did = ? AND mode = 1",
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
    console.warn(
      JSON.stringify({
        event: "x_post_failed",
        did,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return { ok: false, code: "post_failed" };
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
    not_published: [409, "Publish the article before posting to X."],
    already_posted: [409, "This article was already posted to X."],
    cover_failed: [502, "The cover image could not be prepared for X."],
    post_failed: [502, "Posting to X failed. Check your credentials."],
  };
  const [status, message] = failures[result.code] ?? [500, "Posting failed."];
  throw new HttpError(status, "x_" + result.code, message);
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
    "SELECT tid, slug, initial_lang, sns_threads_posted_at FROM documents WHERE did = ? AND mode = 1",
  )
    .bind(did)
    .first<{
      tid: string;
      slug: string;
      initial_lang: string;
      sns_threads_posted_at: string | null;
    }>();
  if (!doc) return { ok: false, code: "not_published" };
  if (doc.sns_threads_posted_at) return { ok: false, code: "already_posted" };

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

  const postedAt = nowIso();
  await env.DB.prepare(
    "UPDATE documents SET sns_threads_posted_at = ? WHERE did = ? AND sns_threads_posted_at IS NULL",
  )
    .bind(postedAt, did)
    .run();
  return { ok: true, postedAt };
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
    not_published: [409, "Publish the article before posting to Threads."],
    already_posted: [409, "This article was already posted to Threads."],
    already_queued: [
      409,
      "A Threads post for this article is already in progress.",
    ],
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
    "SELECT sns_threads_posted_at FROM documents WHERE did = ? AND mode = 1",
  )
    .bind(did)
    .first<{ sns_threads_posted_at: string | null }>();
  if (!doc) fail("not_published");
  if (doc!.sns_threads_posted_at) fail("already_posted");

  // Double-queue guard: the background job can run for tens of seconds and the
  // client UI state doesn't survive a screen remount, so block a second queue
  // while a recent one may still be in flight. The queue action below is the
  // lock record — no schema needed; a stuck job self-expires after 3 minutes.
  const recentQueue = await env.DB.prepare(
    "SELECT created_at FROM activity_logs WHERE action = 'document.sns_post' AND target_id = ? AND detail_json LIKE '%\"threads\":true%' AND detail_json LIKE '%\"queued\":true%' AND created_at > ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(did, new Date(Date.now() - 3 * 60_000).toISOString())
    .first<{ created_at: string }>()
    .catch(() => null);
  if (recentQueue) fail("already_queued");

  await logActivity(env, user, "document.sns_post", "document", did, {
    threads: true,
    queued: true,
  });
  ctx.waitUntil(
    postThreadsForDoc(env, did).then((result) => {
      if (!result.ok) {
        // postThreadsForDoc already logged the detail; keep a summary line.
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
      note: "Credentials are stored as Cloudflare Worker Secrets, set automatically by kurocms_manual_deploy.sh.",
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
    const where = query ? "WHERE (d.slug LIKE ? OR dt.title LIKE ?)" : "";
    const bindings = query
      ? [displayLang, `%${query}%`, `%${query}%`]
      : [displayLang];
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
          WHERE dc.did = d.did) AS category_names
      FROM documents d
      LEFT JOIN document_translations dt ON dt.did = d.did
      ${where}
      GROUP BY d.did
      ORDER BY d.updated_at DESC
      LIMIT 1000`,
    )
      .bind(...bindings)
      .all<DocumentRow>();
    return json({ documents: result.results as unknown as JsonValue });
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
    // Immediate refresh of the published article's pages (chips render there).
    // Runs AFTER the assignment is committed, so it can't build stale data.
    if (ctx) {
      const doc = await env.DB.prepare(
        "SELECT mode FROM documents WHERE did = ?",
      )
        .bind(did)
        .first<{ mode: number }>();
      if (doc?.mode === 1) {
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
      "SELECT lang, title, summary, updated_at FROM document_translations WHERE did = ? ORDER BY lang",
    )
      .bind(did)
      .all();
    return json({
      document: document as JsonValue,
      translations: translations.results as JsonValue,
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
    // Trigger static page generation when publishing (mode 1) or unpublishing
    // (mode 2). Run it AFTER the response via waitUntil: page generation
    // (esp. multi-language index rebuilds) can be heavy and must never block or
    // fail the publish request itself. Final reflection is guaranteed by the
    // full "Build now" (buildAllPublicPages).
    //
    // When a published article's detail page URL becomes stale — the type
    // changed (URL contains the tid) or the article left mode 1 (draft/hidden)
    // — the old KV page must be DELETED, not just left behind: serving prefers
    // KV, so a stale bundle would keep the old URL alive forever.
    const wasPublished = existing.mode === 1;
    const detailPageStale = wasPublished && (tidChanged || modeValue !== 1);
    // deferBuild: the admin editor's doSave() always PUTs documents →
    // translations → categories back-to-back for a single logical save. If
    // this endpoint fires its own immediate build, it races the later (and
    // more current) build fired from the translations/categories PUTs below —
    // whichever finishes LAST wins in KV, and completion order isn't
    // guaranteed to match commit order. The editor sets deferBuild so only the
    // last PUT in its sequence builds, using fully-committed data. Stale-page
    // DELETION still runs immediately (it can't race against a future build:
    // there's nothing to overwrite).
    const deferBuild = body.deferBuild === true;
    if (detailPageStale) {
      ctx.waitUntil(
        deleteArticlePages(env, existing.tid, existing.slug).catch(() => {
          /* non-fatal: full build will reconcile */
        }),
      );
    }
    if (
      !deferBuild &&
      (modeValue === 1 || modeValue === 2 || detailPageStale)
    ) {
      ctx.waitUntil(
        buildDocumentPages(env, did, tidChanged ? [existing.tid] : []).catch(
          () => {
            /* non-fatal: full build will reconcile */
          },
        ),
      );
    }
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

/**
 * Build an INSERT statement that snapshots the CURRENT translation row (if one
 * exists) into document_translation_revisions, with the next sequential
 * revision_no. Returns null when there is no existing row to snapshot. The
 * caller includes the returned statement in a batch run BEFORE the overwrite/
 * delete so edits are recoverable. (This history table was previously unused.)
 */
async function snapshotTranslationStatement(
  env: Env,
  did: string,
  lang: string,
  snapshotBy: string,
): Promise<D1PreparedStatement | null> {
  const existing = await env.DB.prepare(
    `SELECT title, body_html, seo_json, hashtag_json
     FROM document_translations WHERE did = ? AND lang = ?`,
  )
    .bind(did, lang)
    .first<{
      title: string;
      body_html: string;
      seo_json: string | null;
      hashtag_json: string | null;
    }>();
  if (!existing) return null;
  const maxRow = await env.DB.prepare(
    `SELECT MAX(revision_no) AS n FROM document_translation_revisions
     WHERE did = ? AND lang = ?`,
  )
    .bind(did, lang)
    .first<{ n: number | null }>();
  const nextNo = (maxRow?.n ?? 0) + 1;
  return env.DB.prepare(
    `INSERT INTO document_translation_revisions
       (revision_id, did, lang, revision_no, title, body_html, seo_json,
        hashtag_json, snapshot_at, snapshot_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    makeId("rev"),
    did,
    lang,
    nextNo,
    existing.title,
    existing.body_html,
    existing.seo_json,
    existing.hashtag_json,
    nowIso(),
    snapshotBy,
  );
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
              created_at, updated_at, created_by, updated_by
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
    const summary =
      optionalString(body, "summary") ?? optionalString(body, "subject");
    if (summary && summary.length > 200) {
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
    const seo = JSON.stringify((body.seo ?? {}) as JsonValue);
    const hashtags = JSON.stringify((body.hashtags ?? []) as JsonValue);
    const requestedCreatedAt = optionalIsoTimestamp(body, "createdAt");
    const requestedUpdatedAt = optionalIsoTimestamp(body, "updatedAt");
    const document = await env.DB.prepare(
      `SELECT d.did, d.tid, d.mode, dt.created_at AS translation_created_at,
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
    if (
      bodyHtmlInput !== null &&
      baseBodyHash &&
      document.translation_body_html !== null &&
      (await sha256Hex(document.translation_body_html)) !== baseBodyHash
    ) {
      throw new HttpError(
        409,
        "body_conflict",
        "The body was updated by another client after it was loaded. Reload it, or resend without baseBodyHash to overwrite (the current version is snapshotted to revision history).",
      );
    }
    const bodyHtml =
      bodyHtmlInput ?? (document.translation_body_html as string);

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
      return json({
        ok: true,
        did,
        lang,
        createdAt: document.translation_created_at,
        updatedAt: document.translation_updated_at,
        changed: false,
      });
    }

    const now = nowIso();
    const createdAt =
      requestedCreatedAt ?? document.translation_created_at ?? now;
    const updatedAt = requestedUpdatedAt ?? now;

    // Strong retention: snapshot the existing translation (if any) into the
    // revision history BEFORE it is overwritten, so edits/overwrites are
    // recoverable. Previously this table was never written.
    const prevRevision = await snapshotTranslationStatement(
      env,
      did,
      lang,
      user.uid,
    );

    const statements: D1PreparedStatement[] = [];
    if (prevRevision) statements.push(prevRevision);
    statements.push(
      env.DB.prepare(
        `INSERT INTO document_translations
          (did, lang, title, summary, body_html, seo_json, hashtag_json, created_at, updated_at, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(did, lang) DO UPDATE SET
          title = excluded.title,
          summary = excluded.summary,
          body_html = excluded.body_html,
          seo_json = excluded.seo_json,
          hashtag_json = excluded.hashtag_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by`,
      ).bind(
        did,
        lang,
        title,
        summary,
        bodyHtml,
        seo,
        hashtags,
        createdAt,
        updatedAt,
        user.uid,
        user.uid,
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
        `${did}:${lang}`,
        did,
        lang,
        document.tid,
        title,
        stripHtml(bodyHtml),
        hashtags,
        updatedAt,
      ),
      env.DB.prepare(
        "UPDATE documents SET updated_at = ?, updated_by = ? WHERE did = ?",
      ).bind(now, user.uid, did),
      // Strong retention: auto-register the language so REST/AI-posted
      // translations are never orphaned/invisible. Keeps an existing display
      // name untouched (only inserts when the language row is missing).
      registerLanguageStatement(env, lang, now),
    );
    await env.DB.batch(statements);

    await logActivity(env, user, "translation.upsert", "document", did, {
      lang,
    });
    // Immediate page refresh for a REAL content change on a published article.
    // This used to piggyback on the documents PUT (which fired on every save,
    // even no-ops, and raced ahead of this request so it could build the OLD
    // body); here it runs after the new content is committed.
    // deferBuild: see the matching comment in documentDetail — the editor's
    // doSave() always follows this PUT with a categories PUT, which fires the
    // one consolidated build for the whole save once everything is committed.
    const deferBuild = body.deferBuild === true;
    if (!deferBuild && ctx && document.mode === 1) {
      ctx.waitUntil(
        buildDocumentPages(env, did).catch(() => {
          /* non-fatal: full build will reconcile */
        }),
      );
    }
    return json({ ok: true, did, lang, createdAt, updatedAt, changed: true });
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

/**
 * One-off migration: normalize legacy media IDs that use "_" (e.g. img_146) to
 * the "-" separator (img-146) so every [[...]] token is consistent. Renames the
 * R2 object (copy → delete), updates media_assets (mid + public_path), and — once
 * every asset is migrated — rewrites the [[img_/vid_/aud_]] references in article
 * bodies, revisions, SEO cover fields and site-text content, then clears the page
 * build cache so the next build regenerates pages with the new URLs.
 *
 * Idempotent + chunked: it only touches assets whose mid still contains "_", and
 * processes up to `maxAssets` per call (R2 get+put+delete + a D1 write each), so
 * the client loops until `remaining` reaches 0.
 */
async function migrateMidSeparator(
  request: Request,
  env: Env,
  user: AuthUser,
): Promise<Response> {
  requireAdmin(user);
  const body = await readJson(request).catch(
    () => ({}) as Record<string, unknown>,
  );
  const maxAssets =
    typeof body.maxAssets === "number" && body.maxAssets > 0
      ? Math.min(200, Math.floor(body.maxAssets))
      : 60;

  // Legacy-format assets: mid still uses "_" (LIKE escapes it as a literal).
  const rows = await env.DB.prepare(
    "SELECT mid, public_path AS publicPath FROM media_assets WHERE mid LIKE '%\\_%' ESCAPE '\\' ORDER BY mid LIMIT ?",
  )
    .bind(maxAssets)
    .all<{ mid: string; publicPath: string }>();
  const assets = rows.results ?? [];
  const bucket = env.MEDIA_BUCKET as R2Bucket | undefined;

  let migrated = 0;
  const errors: string[] = [];
  for (const a of assets) {
    const newMid = a.mid.replace("_", "-");
    const newPath = a.publicPath.replace(a.mid, newMid);
    try {
      if (bucket) {
        const oldKey = a.publicPath.replace(/^\//, "").split("?")[0];
        const newKey = newPath.replace(/^\//, "").split("?")[0];
        // Copy-before-delete: only remove the old object after the new one is
        // written, so a failure mid-way never loses the file.
        const obj = await bucket.get(oldKey);
        if (obj) {
          await bucket.put(newKey, obj.body, {
            httpMetadata: obj.httpMetadata,
            customMetadata: obj.customMetadata,
          });
          await bucket.delete(oldKey);
        }
      }
      await env.DB.prepare(
        "UPDATE media_assets SET mid = ?, public_path = ? WHERE mid = ?",
      )
        .bind(newMid, newPath, a.mid)
        .run();
      migrated++;
    } catch (err) {
      errors.push(`${a.mid}: ${String(err)}`);
    }
  }

  const remRow = await env.DB.prepare(
    "SELECT COUNT(*) AS cnt FROM media_assets WHERE mid LIKE '%\\_%' ESCAPE '\\'",
  ).first<{ cnt: number }>();
  const remaining = Number(remRow?.cnt ?? 0);

  // Final pass: every asset renamed → rewrite content references + drop the
  // build cache (forces a full rebuild with the new image URLs).
  let referencesRewritten = false;
  if (remaining === 0 && errors.length === 0) {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE document_translations SET body_html = REPLACE(REPLACE(REPLACE(body_html,'[[img_','[[img-'),'[[vid_','[[vid-'),'[[aud_','[[aud-')",
      ),
      env.DB.prepare(
        "UPDATE document_translations SET seo_json = REPLACE(REPLACE(seo_json,'\"img_','\"img-'),'/images/img_','/images/img-') WHERE seo_json LIKE '%img\\_%' ESCAPE '\\'",
      ),
      env.DB.prepare(
        "UPDATE document_translation_revisions SET body_html = REPLACE(REPLACE(REPLACE(body_html,'[[img_','[[img-'),'[[vid_','[[vid-'),'[[aud_','[[aud-')",
      ),
      env.DB.prepare(
        "UPDATE document_translation_revisions SET seo_json = REPLACE(REPLACE(seo_json,'\"img_','\"img-'),'/images/img_','/images/img-') WHERE seo_json LIKE '%img\\_%' ESCAPE '\\'",
      ),
      env.DB.prepare(
        "UPDATE taxonomy_items SET name = REPLACE(REPLACE(REPLACE(name,'[[img_','[[img-'),'[[vid_','[[vid-'),'[[aud_','[[aud-')",
      ),
      env.DB.prepare("DELETE FROM page_build_cache"),
    ]);
    referencesRewritten = true;
  }

  await logActivity(env, user, "media.migrate_separator", "media", "*", {
    migrated,
    remaining,
    referencesRewritten,
  });
  return json({ migrated, remaining, referencesRewritten, errors });
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

function parseContentKeys(raw: string | null | undefined): ContentKeyDef[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (ck): ck is ContentKeyDef => ck && typeof ck.key === "string",
    );
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
  if (!env.COMMUNITY_PAT)
    throw new HttpError(
      503,
      "no_community_pat",
      "COMMUNITY_PAT not configured.",
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
      headers: { Authorization: `Bearer ${env.COMMUNITY_PAT}` },
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
  const sourceHtml = sourceUrl
    ? await fetchCommunityTemplateSource(env, sourceUrl)
    : null;
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
  const rawContentKeys = Array.isArray(body.contentKeys)
    ? body.contentKeys
    : null;
  const contentKeysJson = rawContentKeys
    ? JSON.stringify(rawContentKeys)
    : null;
  const apiVersion = parseApiVersion(body.apiVersion);
  // Community コピー(sourceUrl あり)は新規 tmpl_xxx を発番する。
  // 公開時の tid はテンプレ名の slug を使うため（siteTemplatePublish）、ローカル id は一意で良い。
  const providedId = sourceUrl ? null : optionalString(body, "id");
  const id =
    providedId && /^[a-z0-9-]+$/.test(providedId) ? providedId : makeId("tmpl");

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

async function fetchCommunityTemplateSource(
  env: Env,
  sourceUrl: string,
): Promise<string> {
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
  if (!html || html.length > 2_000_000 || !isKuroCmsHtmlTemplate(html)) {
    throw new HttpError(
      400,
      "invalid_template_source",
      "Template source must be KuroCMS template HTML and no larger than 2 MB.",
    );
  }
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
  if (!env.COMMUNITY_PAT)
    throw new HttpError(
      503,
      "no_community_pat",
      "COMMUNITY_PAT not configured.",
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
  const contentKeys = parseJsonArray(tpl.content_keys_json);
  const apiVersion = Number(tpl.api_version) || 1;
  const authHeader = `Bearer ${env.COMMUNITY_PAT}`;
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
        ? JSON.stringify(
            Array.isArray(body.contentKeys) ? body.contentKeys : [],
          )
        : null,
      "apiVersion" in body ? parseApiVersion(body.apiVersion) : null,
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

async function siteContentUpdate(
  request: Request,
  env: Env,
  user: AuthUser,
  id: string,
): Promise<Response> {
  requireAdmin(user);
  const body = await readJson(request);
  // Site-text values are rich KuroEditor HTML (same render path as article
  // bodies, incl. [[mid]] refs), so they are not capped at a short length. An
  // empty value is allowed (min: 0) so a content block can be intentionally
  // cleared/left blank.
  const name = requireString(body, "name", { min: 0 });
  const lang = optionalString(body, "lang") ?? "";
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO taxonomy_items (id, kind, lang, name, is_system, created_at, updated_at)
     VALUES (?, 'template', ?, ?, 0, ?, ?)
     ON CONFLICT(id, kind, lang) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
  )
    .bind(id, lang, name, now, now)
    .run();
  await logActivity(env, user, "site_content.update", "template", id, { lang });
  return json({ ok: true });
}

async function siteContentDelete(
  request: Request,
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
      "R2 storage is not configured. Add MEDIA_BUCKET binding to wrangler.toml.",
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
      "R2 storage is not configured.",
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
  const stmts = rows.map((row) => {
    const cols = Object.keys(row);
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
  await env.DB.batch(stmts);
  return json({ ok: true, inserted: rows.length });
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
      "R2 storage is not configured.",
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

function parseLanguageList(value: unknown, fallback: string[]): string[] {
  const fallbackList = fallback.map((item) => item.toLowerCase());
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
  const normalized = source
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const unique = Array.from(new Set(normalized));
  return unique.length ? unique : fallbackList;
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
  "development_domain",
  "default_lang",
  "initial_lang",
  "enabled_languages",
  "admin_logo",
  "theme_accent",
  "theme_sidebar",
  "theme_main_pane",
  "bluesky_handle",
  "bluesky_show_feed",
  "bluesky_feed_position",
  "bluesky_sid",
  "bluesky_token",
  "x_api_key",
  "x_api_secret",
  "x_access_token",
  "x_access_secret",
  "x_link_in_reply",
  "sns_auto_post",
  "threads_handle",
  "threads_show_feed",
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
export function resolveTemplateCanvasColors(
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
  requireAdmin(user);

  if (request.method === "GET") {
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
  request: Request,
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

        await env.DB.prepare(
          `INSERT INTO document_translations (did, lang, title, summary, body_html, seo_json, hashtag_json, created_at, updated_at, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)
           ON CONFLICT(did, lang) DO UPDATE SET title=excluded.title, summary=excluded.summary, body_html=excluded.body_html, seo_json=excluded.seo_json, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
        )
          .bind(
            existing.did,
            lang,
            title,
            summary,
            bodyHtml,
            seoJson,
            now,
            now,
            user.uid,
            user.uid,
          )
          .run();

        await env.DB.prepare(
          `INSERT INTO search_entries (id, did, lang, tid, title, body_text, hashtag_text, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, '[]', ?)
           ON CONFLICT(id) DO UPDATE SET title=excluded.title, body_text=excluded.body_text, updated_at=excluded.updated_at`,
        )
          .bind(
            `${existing.did}:${lang}`,
            existing.did,
            lang,
            destTid,
            title,
            stripHtml(bodyHtml),
            now,
          )
          .run();

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

        await env.DB.prepare(
          `INSERT INTO document_translations (did, lang, title, summary, body_html, seo_json, hashtag_json, created_at, updated_at, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)`,
        )
          .bind(
            did,
            lang,
            title,
            summary,
            bodyHtml,
            seoJson,
            now,
            now,
            user.uid,
            user.uid,
          )
          .run();

        await env.DB.prepare(
          `INSERT INTO search_entries (id, did, lang, tid, title, body_text, hashtag_text, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, '[]', ?)
           ON CONFLICT(id) DO UPDATE SET title=excluded.title, body_text=excluded.body_text, updated_at=excluded.updated_at`,
        )
          .bind(
            `${did}:${lang}`,
            did,
            lang,
            destTid,
            title,
            stripHtml(bodyHtml),
            now,
          )
          .run();

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
  request: Request,
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
        await env.DB.prepare(
          `INSERT INTO document_translations (did, lang, title, summary, body_html, seo_json, hashtag_json, created_at, updated_at, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(did, lang) DO UPDATE SET title=excluded.title, summary=excluded.summary, body_html=excluded.body_html, seo_json=excluded.seo_json, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
        )
          .bind(
            existing.did,
            lang,
            title,
            summary,
            bodyHtml,
            seoRaw,
            hashtagRaw,
            now,
            now,
            user.uid,
            user.uid,
          )
          .run();
        await env.DB.prepare(
          `INSERT INTO search_entries (id, did, lang, tid, title, body_text, hashtag_text, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, '[]', ?)
           ON CONFLICT(id) DO UPDATE SET title=excluded.title, body_text=excluded.body_text, updated_at=excluded.updated_at`,
        )
          .bind(
            `${existing.did}:${lang}`,
            existing.did,
            lang,
            tid,
            title,
            stripHtml(bodyHtml),
            now,
          )
          .run();
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
        await env.DB.prepare(
          `INSERT INTO document_translations (did, lang, title, summary, body_html, seo_json, hashtag_json, created_at, updated_at, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            did,
            lang,
            title,
            summary,
            bodyHtml,
            seoRaw,
            hashtagRaw,
            now,
            now,
            user.uid,
            user.uid,
          )
          .run();
        await env.DB.prepare(
          `INSERT INTO search_entries (id, did, lang, tid, title, body_text, hashtag_text, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, '[]', ?)
           ON CONFLICT(id) DO UPDATE SET title=excluded.title, body_text=excluded.body_text, updated_at=excluded.updated_at`,
        )
          .bind(
            `${did}:${lang}`,
            did,
            lang,
            tid,
            title,
            stripHtml(bodyHtml),
            now,
          )
          .run();
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
