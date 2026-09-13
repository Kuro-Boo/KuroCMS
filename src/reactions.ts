import type { Env } from "./types";

type ReactionType = "like" | "useful" | "excellent";
type Counts = Record<ReactionType, number>;
const TYPES: ReactionType[] = ["like", "useful", "excellent"];
const COOKIE = "kuro_reaction_id";
const COOKIE_AGE = 365 * 24 * 60 * 60;
const MAX_BODY = 1024;

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
  // Script is static. Values from the article/editor enter only escaped HTML attributes.
  return `<section id="${boxId}" class="kuro-reactions" data-endpoint="${escapeHtml(endpoint)}" aria-label="${escapeHtml(t.heading)}">${heading}<div class="kuro-reaction-buttons">${buttons}</div><p class="kuro-reaction-status" role="status" aria-live="polite"></p></section>
<style>.kuro-reactions{margin:3rem 0 0;padding:1.5rem;border-top:1px solid #cbd5e1;text-align:center}.kuro-reactions h2{font-size:1.1rem;margin:0 0 1.25rem}.kuro-reaction-buttons{display:flex;flex-wrap:wrap;justify-content:center;gap:.75rem}.kuro-reaction-buttons button{display:flex;flex-direction:column;align-items:center;gap:.35rem;min-width:7rem;padding:.75rem;border:1px solid #cbd5e1;border-radius:1rem;background:#fff;color:#334155;cursor:pointer;font:inherit}.kuro-reaction-buttons button:hover:not(:disabled){background:#eff6ff}.kuro-reaction-buttons button:disabled{cursor:default;opacity:.6}.kuro-reaction-buttons button[data-voted="true"]{border-color:#2563eb;background:#eff6ff;opacity:1}.kuro-reaction-count{font-size:.8rem}.kuro-reaction-status{min-height:1.5em;margin:.7rem 0 0;font-size:.85rem}</style>
<script>(function(){var box=document.getElementById(${JSON.stringify(boxId)});if(!box)return;var url=box.dataset.endpoint,buttons=Array.from(box.querySelectorAll('button[data-type]')),status=box.querySelector('[role=status]');function paint(data){buttons.forEach(function(b){var type=b.dataset.type,count=b.querySelector('[data-count]');count.textContent=String(data.counts[type]||0);b.disabled=!!data.votedType;b.dataset.voted=String(data.votedType===type)})}function load(){return fetch(url,{credentials:'same-origin',cache:'no-store'}).then(function(r){if(!r.ok)throw Error('GET '+r.status);return r.json()}).then(paint)}load().then(function(){buttons.forEach(function(b){if(!b.disabled)b.addEventListener('click',vote)})}).catch(function(){status.textContent=${JSON.stringify(t.error)}});function vote(e){var type=e.currentTarget.dataset.type;buttons.forEach(function(b){b.disabled=true});fetch(url,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:type})}).then(function(r){return r.json().then(function(d){if(!r.ok)throw Error(d.error||String(r.status));return d})}).then(function(d){paint(d);status.textContent=${JSON.stringify(t.thanks)}}).catch(function(){status.textContent=${JSON.stringify(t.error)};load().then(function(){if(!buttons.some(function(b){return b.dataset.voted==='true'}))buttons.forEach(function(b){b.disabled=false})}).catch(function(){buttons.forEach(function(b){b.disabled=false})})})}})();</script>`;
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
    if ((recent?.n || 0) >= 20) return response({ error: "rate_limited" }, 429);
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
