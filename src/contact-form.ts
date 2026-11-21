/**
 * 問い合わせフォーム(仕様 cms-contact・旗 contact-form)。
 *
 * - 公開の頁: 本文の contact-form の正本から本物のフォームを作り、形を署名して載せる(expandContactForms)。
 * - 口: POST {公開の根}/_contact/challenge(計算の課題)・POST {公開の根}/_contact/send(送信)。
 * - 内容は保存しない。設定で選んだ管理者へメール 1 通(sendMail)。記録は数と誤りの種類だけ。
 * - ロボット避けは自前の計算の課題(SHA-256 の先頭 bits ビットが 0)。salt は 1 回だけ使える(contact_spent)。
 */
import {
  CONTACT_BLOCK,
  decodeContactForm,
  normalizeContactForm,
  renderContactFormHtml,
  validateContactForm,
  validateSubmission,
  isEmail,
  type ContactForm,
} from "../../KuroEditor/src/contact.js";
import { randomToken } from "./crypto.ts";
import { readLimitedBody, withinPublicRate } from "./reactions.ts";
import type { Env } from "./types.ts";

/** 旗(この isolate で控える)。静的な import にしない —— 試験(node)で static-only の依存を読まないため。 */
async function contactFlagOn(env: Env): Promise<boolean> {
  return (await import("./static-only.ts")).cmsFlagHeld(env, "contact-form");
}

/** 計算の課題の重さ(先頭の 0 のビット数)。普通の端末で数秒。 */
export const CONTACT_POW_BITS = 16;
/** 課題の有効な間(課題を受け取ってから送るまで)。 */
export const CONTACT_CHALLENGE_MS = 10 * 60_000;
export const CONTACT_PER_NETWORK_HOUR = 5;
export const CONTACT_PER_SITE_HOUR = 50;
const MAX_BODY = 20 * 1024;

// ── 鍵(サイトごとの非公開の乱数・KV に一度だけ作る。公開ミラーに載る定数を鍵にしない)──────────────
const KEY_KV = "contact:sigkey:v1";
let cachedKey: CryptoKey | null = null;

async function contactKey(env: Env): Promise<CryptoKey | null> {
  if (cachedKey) return cachedKey;
  if (!env.PUBLIC_PAGES) return null;
  let material = (await env.PUBLIC_PAGES.get(KEY_KV)) || "";
  if (!material) {
    material = randomToken();
    await env.PUBLIC_PAGES.put(KEY_KV, material);
    // 同時に 2 つの isolate が作ったときは、後から書かれた方に揃える(読み直す)
    material = (await env.PUBLIC_PAGES.get(KEY_KV)) || material;
  }
  cachedKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("kurocms-contact-v1:" + material),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return cachedKey;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function sign(env: Env, text: string): Promise<string> {
  const key = await contactKey(env);
  if (!key) return "";
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(text),
  );
  return b64url(new Uint8Array(sig));
}

async function verify(env: Env, text: string, sig: string): Promise<boolean> {
  const key = await contactKey(env);
  if (!key || !sig) return false;
  try {
    return await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlDecode(sig),
      new TextEncoder().encode(text),
    );
  } catch {
    return false;
  }
}

/** フォームの形 + 置いた頁 を署名する。送られた形はこの署名で確かめる(作った覚えのない形を断る)。 */
async function signForm(
  env: Env,
  form: ContactForm,
  path: string,
): Promise<{ form: string; sig: string }> {
  const payload = b64url(
    new TextEncoder().encode(JSON.stringify({ path, form })),
  );
  return { form: payload, sig: await sign(env, "form:" + payload) };
}

// ── 公開の頁: 本文の contact-form をフォームへ ─────────────────────────────────

/** 開始タグの終わり(引用符の中の > を読み飛ばす)。 */
function tagEnd(html: string, from: number): number {
  let q = "";
  for (let i = from; i < html.length; i++) {
    const c = html[i];
    if (q) {
      if (c === q) q = "";
    } else if (c === '"' || c === "'") q = c;
    else if (c === ">") return i;
  }
  return -1;
}

/** html[start] の <div …> に対応する </div> の後ろの位置(見つからなければ -1)。 */
function divEnd(html: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) return -1;
    if (/^<div[\s>]/i.test(html.slice(lt, lt + 5))) {
      const e = tagEnd(html, lt);
      if (e < 0) return -1;
      depth++;
      i = e + 1;
    } else if (/^<\/div\s*>/i.test(html.slice(lt, lt + 7))) {
      const e = html.indexOf(">", lt);
      depth--;
      i = e + 1;
      if (depth === 0) return i;
    } else {
      const e = tagEnd(html, lt + 1);
      i = e < 0 ? lt + 1 : e + 1;
    }
  }
  return -1;
}

const BLOCK_OPEN = new RegExp(
  `<div\\b[^>]*\\bdata-kuro-block="${CONTACT_BLOCK}"`,
  "gi",
);

/** 送り先が選ばれているか(選ばれていなければ、フォームは受け付けていないと出す)。 */
async function recipientsOf(
  env: Env,
): Promise<{ uid: string; email: string }[]> {
  const row = await env.DB.prepare(
    "SELECT contact_recipients_json AS j FROM site_settings WHERE id = 1",
  )
    .first<{ j: string | null }>()
    .catch(() => null);
  let uids: string[] = [];
  try {
    const v: unknown = JSON.parse(row?.j || "[]");
    if (Array.isArray(v))
      uids = v.filter((x): x is string => typeof x === "string").slice(0, 10);
  } catch {
    /* 壊れていれば空 */
  }
  if (!uids.length) return [];
  // 管理者で、メールを確かめ済みで、止めていない人だけ(設定のあとで外れた人には送らない)
  const rows = await env.DB.prepare(
    `SELECT uid, email FROM users WHERE uid IN (${uids.map(() => "?").join(",")})
       AND is_admin = 1 AND disabled_at IS NULL AND email_verified_at IS NOT NULL`,
  )
    .bind(...uids)
    .all<{ uid: string; email: string }>()
    .catch(() => ({ results: [] as { uid: string; email: string }[] }));
  return (rows.results ?? []).filter((r) => isEmail(r.email));
}

/**
 * 公開の頁の HTML の contact-form を、本物のフォームに置き換える。旗が効かないサイトでは何もしない
 * (本文の押せない見本のまま)。送り先が無いときは、フォームの代わりに受け付けていないと出す。
 */
export async function expandContactForms(
  html: string,
  env: Env,
  publicBase: string,
  path: string,
  flagOn?: boolean,
): Promise<string> {
  if (!html.includes(`data-kuro-block="${CONTACT_BLOCK}"`)) return html;
  if (!(flagOn ?? (await contactFlagOn(env)))) return html;
  const configured = (await recipientsOf(env)).length > 0;
  let out = "";
  let pos = 0;
  BLOCK_OPEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BLOCK_OPEN.exec(html))) {
    const start = m.index;
    if (start < pos) continue;
    const tEnd = tagEnd(html, start);
    const end = divEnd(html, start);
    if (tEnd < 0 || end < 0) break;
    const tag = html.slice(start, tEnd + 1);
    const attr = /\bdata-contact="([^"]*)"/i.exec(tag)?.[1] ?? "";
    const decoded = decodeContactForm(attr);
    const form = decoded ? normalizeContactForm(decoded) : null;
    let replacement: string;
    if (!form || validateContactForm(form).length) {
      replacement = ""; // 壊れた形は出さない(保存の口で断っているので普通は起きない)
    } else if (!configured) {
      replacement = `<div class="kuro-contact kuro-contact--closed"><p class="kuro-contact__status">現在、このフォームではお問い合わせを受け付けていません。</p></div>`;
    } else {
      const signed = await signForm(env, form, path);
      replacement = renderContactFormHtml(form, {
        ...signed,
        endpoint: `${publicBase}/_contact`,
      });
    }
    out += html.slice(pos, start) + replacement;
    pos = end;
    BLOCK_OPEN.lastIndex = end;
  }
  return out + html.slice(pos);
}

// ── 口 ─────────────────────────────────────────────────────────────────────

function reply(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/** Origin がこのサイトの公開の根と同じか(要求の URL の origin = このサイト)。 */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  return Boolean(origin) && origin === new URL(request.url).origin;
}

/** 先頭 bits ビットが 0 か。 */
function leadingZeroBits(bytes: Uint8Array, bits: number): boolean {
  let left = bits;
  for (const b of bytes) {
    if (left <= 0) return true;
    if (left >= 8) {
      if (b !== 0) return false;
      left -= 8;
    } else {
      return b >> (8 - left) === 0;
    }
  }
  return left <= 0;
}

async function readJson(
  request: Request,
): Promise<Record<string, unknown> | null> {
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get("Content-Type") || "",
    )
  )
    return null;
  const raw = await readLimitedBody(request, MAX_BODY);
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 署名した形を読み戻す。 */
async function openForm(
  env: Env,
  payload: unknown,
  sig: unknown,
): Promise<{ path: string; form: ContactForm } | null> {
  if (
    typeof payload !== "string" ||
    typeof sig !== "string" ||
    payload.length > MAX_BODY
  )
    return null;
  if (!(await verify(env, "form:" + payload, sig))) return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))) as {
      path?: unknown;
      form?: unknown;
    };
    if (typeof v.path !== "string") return null;
    const form = normalizeContactForm(v.form);
    if (validateContactForm(form).length) return null;
    return { path: v.path, form };
  } catch {
    return null;
  }
}

/**
 * POST {公開の根}/_contact/challenge  { form, sig } → { salt, bits, exp, sig }
 * POST {公開の根}/_contact/send       { form, sig, challenge: {salt,bits,exp,sig}, nonce, values, website }
 */
/** 試験で差し替える部品(既定は本物)。 */
export interface ContactDeps {
  now?: number;
  flagOn?: boolean;
  sendMail?: (
    env: Env,
    msg: {
      to: string[];
      subject: string;
      text: string;
      lang: "ja";
      replyTo?: string;
      idempotencyKey: string;
    },
  ) => Promise<{ path: string | null } | null>;
}

export async function contactEndpoint(
  request: Request,
  env: Env,
  action: string,
  deps: ContactDeps = {},
): Promise<Response> {
  const now = deps.now ?? Date.now();
  const flagOn = deps.flagOn ?? (await contactFlagOn(env));
  if (!flagOn) return reply({ error: "not_found" }, 404);
  if (request.method !== "POST")
    return reply({ error: "method_not_allowed" }, 405);
  if (!sameOrigin(request)) return reply({ error: "forbidden" }, 403);
  const body = await readJson(request);
  if (!body) return reply({ error: "invalid" }, 400);
  const opened = await openForm(env, body.form, body.sig);
  if (!opened) return reply({ error: "forbidden" }, 403);

  if (action === "challenge") {
    const salt = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const exp = now + CONTACT_CHALLENGE_MS;
    const bits = CONTACT_POW_BITS;
    return reply({
      salt,
      bits,
      exp,
      sig: await sign(env, `pow:${salt}:${bits}:${exp}:${body.sig}`),
    });
  }
  if (action !== "send") return reply({ error: "not_found" }, 404);

  // 計算の課題
  const ch = body.challenge as
    | { salt?: unknown; bits?: unknown; exp?: unknown; sig?: unknown }
    | undefined;
  const nonce = body.nonce;
  if (
    !ch ||
    typeof ch.salt !== "string" ||
    typeof ch.bits !== "number" ||
    typeof ch.exp !== "number" ||
    typeof ch.sig !== "string" ||
    typeof nonce !== "string" ||
    nonce.length > 32 ||
    ch.bits < CONTACT_POW_BITS ||
    ch.exp < now ||
    !(await verify(
      env,
      `pow:${ch.salt}:${ch.bits}:${ch.exp}:${body.sig}`,
      ch.sig,
    ))
  ) {
    return reply({ error: "forbidden" }, 403);
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${ch.salt}:${nonce}`),
    ),
  );
  if (!leadingZeroBits(digest, ch.bits))
    return reply({ error: "forbidden" }, 403);
  // salt は 1 回だけ(同じ課題の答えで何通も送らせない)
  const spent = await env.DB.prepare(
    "INSERT INTO contact_spent (salt, expires_at) VALUES (?, ?) ON CONFLICT(salt) DO NOTHING",
  )
    .bind(ch.salt, ch.exp)
    .run();
  if (!spent.meta.changes) return reply({ error: "forbidden" }, 403);

  // 回数の上限(回線ごと・サイト全体)
  if (
    !(await withinPublicRate(env, request, now, {
      scope: "contact:",
      perNetwork: CONTACT_PER_NETWORK_HOUR,
      perSite: CONTACT_PER_SITE_HOUR,
    }))
  ) {
    return reply({ error: "rate_limited" }, 429);
  }

  // 罠の欄に値があれば、送ったふりをして捨てる(ロボットに見分けさせない)
  if (typeof body.website === "string" && body.website.trim())
    return reply({ ok: true });

  const values =
    body.values && typeof body.values === "object"
      ? (body.values as Record<string, unknown>)
      : {};
  const checked = validateSubmission(opened.form, values);
  if (!checked.ok)
    return reply({ error: "invalid", fields: checked.errors }, 400);

  const recipients = await recipientsOf(env);
  if (!recipients.length) return reply({ error: "not_configured" }, 503);

  const sendMail = deps.sendMail ?? (await import("./api.ts")).sendMail;
  const siteName = await env.DB.prepare(
    "SELECT site_name FROM site_settings WHERE id = 1",
  )
    .first<{ site_name: string }>()
    .then((r) => r?.site_name || "")
    .catch(() => "");
  const pageUrl = new URL(opened.path, new URL(request.url).origin).toString();
  const at = new Date(now).toISOString();
  const lines = checked.clean.map(
    (f) => `■ ${f.label}\n${f.value || "(未記入)"}`,
  );
  const replyTo = checked.clean.find(
    (f) => f.kind === "email" && isEmail(f.value),
  )?.value;
  const subject =
    `[${siteName || "お問い合わせ"}] ${opened.form.subject}`.replace(
      /[\r\n]+/g,
      " ",
    );
  try {
    const status = await sendMail(env, {
      to: recipients.map((r) => r.email),
      subject,
      text: `${opened.form.subject}\n\n頁: ${pageUrl}\n日時: ${at}\n\n${lines.join("\n\n")}\n`,
      lang: "ja",
      ...(replyTo ? { replyTo } : {}),
      idempotencyKey: `contact-${ch.salt}`,
    });
    if (!status?.path) return reply({ error: "mail_failed" }, 502);
  } catch {
    console.warn("contact mail failed");
    return reply({ error: "mail_failed" }, 502);
  }
  return reply({ ok: true });
}

/** 期限を過ぎた課題の札を消す(毎分の刻み)。 */
export async function sweepContactSpent(
  env: Env,
  now = Date.now(),
): Promise<void> {
  await env.DB.prepare("DELETE FROM contact_spent WHERE expires_at < ?")
    .bind(now)
    .run()
    .catch(() => {});
}

/** 設定の届け先(管理者のうちメールを確かめ済みの人から選ぶ)。 */
export async function contactRecipientsSetting(env: Env): Promise<{
  selected: string[];
  candidates: { uid: string; email: string; name: string }[];
}> {
  const row = await env.DB.prepare(
    "SELECT contact_recipients_json AS j FROM site_settings WHERE id = 1",
  ).first<{ j: string | null }>();
  let selected: string[] = [];
  try {
    const v: unknown = JSON.parse(row?.j || "[]");
    if (Array.isArray(v))
      selected = v.filter((x): x is string => typeof x === "string");
  } catch {
    /* 空 */
  }
  const rows = await env.DB.prepare(
    "SELECT uid, email, COALESCE(display_name, '') AS name FROM users WHERE is_admin = 1 AND disabled_at IS NULL AND email_verified_at IS NOT NULL ORDER BY created_at",
  ).all<{ uid: string; email: string; name: string }>();
  return { selected, candidates: rows.results ?? [] };
}

export async function setContactRecipients(
  env: Env,
  uids: unknown,
): Promise<string[]> {
  const { candidates } = await contactRecipientsSetting(env);
  const allowed = new Set(candidates.map((c) => c.uid));
  const list = (Array.isArray(uids) ? uids : [])
    .filter((u): u is string => typeof u === "string" && allowed.has(u))
    .slice(0, 10);
  await env.DB.prepare(
    "UPDATE site_settings SET contact_recipients_json = ?, updated_at = ? WHERE id = 1",
  )
    .bind(JSON.stringify([...new Set(list)]), new Date().toISOString())
    .run();
  return list;
}
