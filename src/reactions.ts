import { randomToken } from "./crypto.ts";
import type { Env } from "./types";

type ReactionType = "like" | "useful" | "excellent";
type Counts = Record<ReactionType, number>;
const TYPES: ReactionType[] = ["like", "useful", "excellent"];
const COOKIE = "kuro_reaction_id";
const COOKIE_AGE = 365 * 24 * 60 * 60;
const MAX_BODY = 1024;

/**
 * 新しい投票の 1 時間の上限(課題 b299a24e)。Cookie は外から好きな値を名乗れるので、Cookie ごとの上限
 * (VOTES_PER_COOKIE_HOUR)だけでは値を替えて抜けられる。そこで、接続元の回線ごと(IPv4 は 1 つ・IPv6 は /64)と、
 * サイト全体の数も数える。サイト全体の上限が、外からの要求で増やせる D1 の書き込みの量の上限になる。
 * 回線の上限は、同じ回線の後ろに人が多い所(学校・会社)でも普通の読者を止めない程度にする。
 */
export const VOTES_PER_COOKIE_HOUR = 20;
export const VOTES_PER_NETWORK_HOUR = 30;
export const VOTES_PER_SITE_HOUR = 600;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Keep manually positioned slots; make older DB templates work unchanged.
 *
 * ⚠ Match tokens the way the template parser does. It trims the token body
 * (`html-template.ts`), so `[[ html:article.bodyHtml ]]` is a valid spelling.
 * A literal string match missed it, and the failure was silent in both
 * directions: the widget never appeared, or — when a hand-placed slot was
 * written with spaces — it was appended a second time and the whole widget
 * (including its inline script) rendered twice.
 */
const BODY_TOKEN = /\[\[\s*html:article\.bodyHtml\s*\]\]/;
const SLOT_TOKEN = /\[\[\s*html:content\.article-reactions\s*\]\]/;
const REACTIONS_OFF = /<!--\s*kurocms-reactions:off\s*-->/i;
const REACTIONS_EXCLUDE =
  /<!--\s*kurocms-reactions:exclude=([a-z0-9_,-]+)\s*-->/gi;

/**
 * Template-owned reaction visibility policy.
 *
 * Removing the slot cannot mean "off": older templates predate the slot and
 * rely on placeReactionSlot() to add it after the article body.  Explicit
 * directives distinguish an intentional opt-out from that legacy shape.
 * `exclude` stays useful when a site turns reactions back on globally: article
 * types used as index/portfolio pages can remain excluded.
 */
export function templateAllowsReactions(
  sourceHtml: string,
  articleType: string,
): boolean {
  if (REACTIONS_OFF.test(sourceHtml)) return false;
  const excluded = new Set<string>();
  for (const match of sourceHtml.matchAll(REACTIONS_EXCLUDE)) {
    for (const tid of match[1].split(",")) {
      const normalized = tid.trim();
      if (normalized) excluded.add(normalized);
    }
  }
  return !excluded.has(articleType);
}

export function placeReactionSlot(
  sourceHtml: string,
  hasArticle: boolean,
): string {
  if (!hasArticle || SLOT_TOKEN.test(sourceHtml)) return sourceHtml;
  // Non-global: only the first body token gets the slot, as before.
  return sourceHtml.replace(
    BODY_TOKEN,
    (token) => `${token}[[html:content.article-reactions]]`,
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const TEXT: Record<
  string,
  {
    heading: string;
    labels: [string, string, string];
    thanks: string;
    error: string;
  }
> = {
  ja: {
    heading: "この記事はいかがでしたか？",
    labels: ["いいね", "参考になった", "素晴らしい"],
    thanks: "ありがとうございます！",
    error: "送信できませんでした。もう一度お試しください。",
  },
  en: {
    heading: "How was this article?",
    labels: ["Like", "Useful", "Excellent"],
    thanks: "Thank you!",
    error: "Could not send. Please try again.",
  },
};

/** Document ids the public endpoint will accept. Render nothing for anything else. */
const SAFE_DID = /^[a-zA-Z0-9_-]{1,128}$/;

/** The editor supplies only the heading; this trusted fragment supplies the controls. */
export function renderReactionWidget(
  did: string,
  basePath: string,
  lang: string,
  headingHtml = "",
): string {
  // ⚠ The id goes into an HTML attribute *and* a JS string literal. Escaping
  // differs between the two, so instead of escaping twice we only emit ids the
  // endpoint would accept anyway — anything else could never work, and a
  // widget that cannot work is worse than no widget (it shows an error).
  if (!SAFE_DID.test(did)) return "";
  const t = TEXT[lang] || TEXT.en;
  const heading = headingHtml || `<h2>${escapeHtml(t.heading)}</h2>`;
  const endpoint = `${basePath}/_reactions/${encodeURIComponent(did)}`;
  const boxId = `kuro-reactions-${did}`;
  const buttons = TYPES.map((type, i) => {
    const icon = ["👍", "💡", "👏"][i];
    return `<button type="button" data-type="${type}" disabled><span aria-hidden="true">${icon}</span><span>${escapeHtml(t.labels[i])}</span><span class="kuro-reaction-count" data-count="${type}">—</span></button>`;
  }).join("");
  // No script on the page: kuro-site.js (src/site/) finds `.kuro-reactions[data-endpoint]`
  // and drives it (the site CSP runs only the site's own files — cms-cms-security「CSP」).
  // Values from the article/editor enter only escaped HTML attributes.
  return `<section id="${boxId}" class="kuro-reactions" data-endpoint="${escapeHtml(endpoint)}" data-thanks="${escapeHtml(t.thanks)}" data-error="${escapeHtml(t.error)}" aria-label="${escapeHtml(t.heading)}">${heading}<div class="kuro-reaction-buttons">${buttons}</div><p class="kuro-reaction-status" role="status" aria-live="polite"></p></section>
<style>.kuro-reactions{margin:3rem 0 0;padding:1.5rem;border-top:1px solid #cbd5e1;text-align:center}.kuro-reactions h2{font-size:1.1rem;margin:0 0 1.25rem}.kuro-reaction-buttons{display:flex;flex-wrap:wrap;justify-content:center;gap:.75rem}.kuro-reaction-buttons button{display:flex;flex-direction:column;align-items:center;gap:.35rem;min-width:7rem;padding:.75rem;border:1px solid #cbd5e1;border-radius:1rem;background:#fff;color:#334155;cursor:pointer;font:inherit}.kuro-reaction-buttons button:hover:not(:disabled){background:#eff6ff}.kuro-reaction-buttons button:disabled{cursor:default;opacity:.6}.kuro-reaction-buttons button[data-voted="true"]{border-color:#2563eb;background:#eff6ff;opacity:1}.kuro-reaction-count{font-size:.8rem}.kuro-reaction-status{min-height:1.5em;margin:.7rem 0 0;font-size:.85rem}</style>`;
}

function response(
  data: Record<string, unknown>,
  status = 200,
  cookie?: string,
): Response {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (cookie) headers.set("Set-Cookie", cookie);
  return new Response(JSON.stringify(data), { status, headers });
}

function readCookie(request: Request): string | null {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const [name, value] = part.trim().split("=", 2);
    if (name === COOKIE && value && /^[0-9a-f-]{36}$/.test(value)) return value;
  }
  return null;
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

async function readBody(request: Request): Promise<string | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

/** 接続元の回線。IPv6 は利用者ごとに /64 を渡されることが多いので、/64 で 1 つに数える。 */
export function networkOf(ip: string | null): string {
  const v = (ip || "").trim().toLowerCase();
  if (!v) return "unknown";
  if (!v.includes(":")) return v;
  // 省略(::)を広げて、先頭の 4 組だけを取る。
  const [head, tail = ""] = v.split("::", 2);
  const h = head ? head.split(":") : [];
  const t = v.includes("::") ? (tail ? tail.split(":") : []) : [];
  const full = v.includes("::")
    ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t]
    : h;
  return (
    full
      .slice(0, 4)
      .map((g) => g.replace(/^0+(?=.)/, ""))
      .join(":") + "::/64"
  );
}

// 数え札の鍵。数え札に回線をそのまま置かないための、サイトごとの非公開の乱数(KV に一度だけ作る)。
// 公開ミラーに載る定数を鍵にしない(誰でも同じハッシュを作れる)。unfurl.ts の鍵とは分ける。
const RATE_KEY_KV = "reaction:ratekey:v1";
let cachedRateKey: CryptoKey | null = null;

async function rateKey(env: Env): Promise<CryptoKey> {
  if (cachedRateKey) return cachedRateKey;
  let material = env.PUBLIC_PAGES
    ? (await env.PUBLIC_PAGES.get(RATE_KEY_KV)) || ""
    : "";
  if (!material) {
    material = randomToken();
    if (env.PUBLIC_PAGES) await env.PUBLIC_PAGES.put(RATE_KEY_KV, material);
  }
  cachedRateKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("kurocms-reaction-rate-v1:" + material),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return cachedRateKey;
}

async function bucketOf(env: Env, label: string): Promise<string> {
  const sig = await crypto.subtle.sign(
    "HMAC",
    await rateKey(env),
    new TextEncoder().encode(label),
  );
  return Array.from(new Uint8Array(sig).slice(0, 16), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * 回線とサイト全体の、この 1 時間の新しい投票を 1 つ数え、どちらかが上限を超えたら false。
 * 期限の過ぎた数え札は先に消す(1 時間より長く残さない)。超えた試みも数える(繰り返すほど開かない)。
 */
async function withinRate(
  env: Env,
  request: Request,
  now: number,
): Promise<boolean> {
  const window = Math.floor(now / HOUR_MS);
  const expires = new Date((window + 1) * HOUR_MS).toISOString();
  await env.DB.prepare("DELETE FROM reaction_rate WHERE expires_at <= ?")
    .bind(new Date(now).toISOString())
    .run();
  const network = networkOf(request.headers.get("CF-Connecting-IP"));
  const take = async (label: string): Promise<number> => {
    const row = await env.DB.prepare(
      "INSERT INTO reaction_rate (bucket, n, expires_at) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET n = n + 1 RETURNING n",
    )
      .bind(await bucketOf(env, label), expires)
      .first<{ n: number }>();
    return row?.n ?? 0;
  };
  const byNetwork = await take(`net:${window}:${network}`);
  if (byNetwork > VOTES_PER_NETWORK_HOUR) return false;
  const bySite = await take(`site:${window}`);
  return bySite <= VOTES_PER_SITE_HOUR;
}

async function snapshot(
  env: Env,
  did: string,
  voterHash: string,
): Promise<{ counts: Counts; votedType: ReactionType | null }> {
  const [rows, vote] = await Promise.all([
    env.DB.prepare(
      "SELECT reaction_type, COUNT(*) AS n FROM article_reactions WHERE did = ? GROUP BY reaction_type",
    )
      .bind(did)
      .all<{ reaction_type: ReactionType; n: number }>(),
    env.DB.prepare(
      "SELECT reaction_type FROM article_reactions WHERE did = ? AND voter_hash = ?",
    )
      .bind(did, voterHash)
      .first<{ reaction_type: ReactionType }>(),
  ]);
  const counts: Counts = { like: 0, useful: 0, excellent: 0 };
  for (const row of rows.results ?? [])
    if (row.reaction_type in counts) counts[row.reaction_type] = row.n;
  return { counts, votedType: vote?.reaction_type || null };
}

/** Public, same-origin endpoint. No admin session or legacy reactions DB required. */
export async function reactionEndpoint(
  request: Request,
  env: Env,
  did: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST")
    return response({ error: "method_not_allowed" }, 405);
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(did))
    return response({ error: "not_found" }, 404);
  try {
    const article = await env.DB.prepare(
      "SELECT did FROM documents WHERE did = ? AND live = 1",
    )
      .bind(did)
      .first<{ did: string }>();
    if (!article) return response({ error: "not_found" }, 404);
    let voter = readCookie(request);
    if (request.method === "GET") {
      const newVoter = !voter;
      if (!voter) voter = crypto.randomUUID();
      const data = await snapshot(env, did, await digest(voter));
      const secure =
        new URL(request.url).protocol === "https:" ? "; Secure" : "";
      const cookie = newVoter
        ? `${COOKIE}=${voter}; Max-Age=${COOKIE_AGE}; Path=/; HttpOnly; SameSite=Lax${secure}`
        : undefined;
      return response(data, 200, cookie);
    }
    const origin = request.headers.get("Origin");
    if (!origin || origin !== new URL(request.url).origin)
      return response({ error: "forbidden_origin" }, 403);
    if (!voter) return response({ error: "reaction_cookie_required" }, 428);
    if (
      !/^application\/json(?:\s*;|$)/i.test(
        request.headers.get("Content-Type") || "",
      )
    )
      return response({ error: "invalid_content_type" }, 415);
    const raw = await readBody(request);
    if (raw === null) return response({ error: "invalid_body" }, 400);
    let type: unknown;
    try {
      const parsed: unknown = JSON.parse(raw);
      type =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as { type?: unknown }).type
          : undefined;
    } catch {
      return response({ error: "invalid_json" }, 400);
    }
    if (typeof type !== "string" || !TYPES.includes(type as ReactionType))
      return response({ error: "invalid_type" }, 400);
    const voterHash = await digest(voter);
    const existing = await snapshot(env, did, voterHash);
    if (existing.votedType)
      return response({ ...existing, error: "already_voted" }, 409);
    const recent = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM article_reactions WHERE voter_hash = ? AND created_at > datetime('now', '-1 hour')",
    )
      .bind(voterHash)
      .first<{ n: number }>();
    if ((recent?.n || 0) >= VOTES_PER_COOKIE_HOUR)
      return response({ error: "rate_limited" }, 429);
    // Cookie は好きな値を名乗れるので、回線とサイト全体でも数える(課題 b299a24e)。
    if (!(await withinRate(env, request, Date.now())))
      return response({ error: "rate_limited" }, 429);
    const inserted = await env.DB.prepare(
      "INSERT INTO article_reactions (id, did, reaction_type, voter_hash, created_at) VALUES (?, ?, ?, ?, datetime('now')) ON CONFLICT(did, voter_hash) DO NOTHING",
    )
      .bind(crypto.randomUUID(), did, type, voterHash)
      .run();
    const data = await snapshot(env, did, voterHash);
    return inserted.meta.changes
      ? response(data)
      : response({ ...data, error: "already_voted" }, 409);
  } catch (error) {
    console.error("reaction endpoint failed", error);
    return response({ error: "internal_error" }, 500);
  }
}
