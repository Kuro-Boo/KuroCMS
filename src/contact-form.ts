/**
 * 問い合わせフォーム(仕様 cms-contact・旗 contact-form)。
 *
 * - 公開の頁: 本文の contact-form の正本から本物のフォームを作り、形を署名して載せる(expandContactForms)。
 * - 口: POST {公開の根}/_contact/challenge(計算の課題)・POST {公開の根}/_contact/send(送信)。
 * - 送り先: フォームが名前(to)で選び、アドレスはサイト文字 mail-to-<名前>(「名前 <アドレス>」)から読む。
 *   サイト文字は管理者だけが書け、mail-to- は公開の頁へ出さない(fetchTemplateContent が外す)。
 *   サイトのドメインの外のアドレスは、確認のメールのボタンが押されるまで送らない(contact_verified)。
 * - 内容は保存しない。送り先ごとにメール 1 通(sendMail)。記録は数と誤りの種類だけ。
 * - 口: POST {公開の根}/_contact/verify も(確認のメールのリンクの先。GET は押すボタンを出すだけ)。
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
  RECIPIENT_NAME_RE,
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

// ── 送り先(サイト文字 mail-to-<名前>)──────────────────────────────────────────

/** 送り先を置くサイト文字の名前の頭。公開の頁へは出さない。 */
export const MAIL_TO_PREFIX = "mail-to-";
/** 確認のリンクの有効な間。 */
export const CONTACT_VERIFY_MS = 7 * 24 * 60 * 60_000;

export interface ContactRecipient {
  /** mail-to- の後ろ(フォームの to が指す名前) */
  name: string;
  label: string;
  email: string;
  /** サイトのドメインのアドレス(確認は要らない) */
  own: boolean;
  verified: boolean;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** サイト文字(KuroEditor の HTML)を平文へ。 */
function plainText(html: string): string {
  return String(html ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const n =
          e[1] === "x" || e[1] === "X"
            ? parseInt(e.slice(2), 16)
            : parseInt(e.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * mail-to- の値を読む。形はメールの普通の書き方「名前 <アドレス>」だけ(アドレスは 1 つ)。読めなければ null。
 * 値はエディタの HTML なので、段落(<p>)を外し、文字参照(&lt; &gt;)を戻してから読む。
 * 名前が無い(「<アドレス>」だけ)ときは、サイト文字の名前を表示名にする。
 */
export function parseRecipientText(
  html: string,
): { label: string; email: string } | null {
  const m = /^(.*?)\s*<\s*([^<>\s]+)\s*>$/.exec(plainText(html));
  if (!m || !isEmail(m[2])) return null;
  const label = m[1].replace(/^"(.*)"$/, "$1").trim();
  if (/[<>@]/.test(label) || label.length > 60) return null;
  return { label, email: m[2].toLowerCase() };
}

/** サイトの公開ドメイン(www. は外す)。 */
async function ownHost(env: Env): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT public_domain FROM site_settings WHERE id = 1",
  )
    .first<{ public_domain: string | null }>()
    .catch(() => null);
  try {
    return new URL(row?.public_domain ?? "").hostname
      .toLowerCase()
      .replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function isOwnAddress(email: string, host: string): boolean {
  if (!host) return false;
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  return domain === host || domain.endsWith("." + host);
}

/** 登録された送り先の全部(基準の言語の値から)。形の読めない行は落とす。 */
export async function contactRecipientList(
  env: Env,
): Promise<ContactRecipient[]> {
  const dl = await env.DB.prepare(
    "SELECT default_lang FROM site_settings WHERE id = 1",
  )
    .first<{ default_lang: string | null }>()
    .catch(() => null);
  const defaultLang = dl?.default_lang || "";
  const rows = await env.DB.prepare(
    `SELECT id, name, lang FROM taxonomy_items WHERE kind = 'template' AND id LIKE '${MAIL_TO_PREFIX}%' ORDER BY id`,
  )
    .all<{ id: string; name: string; lang: string }>()
    .catch(() => ({
      results: [] as { id: string; name: string; lang: string }[],
    }));
  // 基準の言語の値 → 言語の無い値 → ほかの言語の最初の値(送り先は言語で変わらない)
  const byId = new Map<string, string>();
  const rank = (lang: string) =>
    lang === defaultLang ? 0 : lang === "" ? 1 : 2;
  const best = new Map<string, number>();
  for (const r of rows.results ?? []) {
    if (!r.name) continue;
    const k = rank(r.lang);
    if (!best.has(r.id) || k < best.get(r.id)!) {
      best.set(r.id, k);
      byId.set(r.id, r.name);
    }
  }
  const host = await ownHost(env);
  const list: ContactRecipient[] = [];
  for (const [id, value] of byId) {
    const name = id.slice(MAIL_TO_PREFIX.length);
    if (!RECIPIENT_NAME_RE.test(name)) continue;
    const parsed = parseRecipientText(value);
    if (!parsed) continue;
    list.push({
      name,
      label: parsed.label || name,
      email: parsed.email,
      own: isOwnAddress(parsed.email, host),
      verified: false,
    });
  }
  const outside = [...new Set(list.filter((r) => !r.own).map((r) => r.email))];
  if (outside.length) {
    const v = await env.DB.prepare(
      `SELECT email FROM contact_verified WHERE email IN (${outside.map(() => "?").join(",")})`,
    )
      .bind(...outside)
      .all<{ email: string }>()
      .catch(() => ({ results: [] as { email: string }[] }));
    const ok = new Set((v.results ?? []).map((r) => r.email));
    for (const r of list) r.verified = ok.has(r.email);
  }
  return list;
}

export const deliverable = (r: ContactRecipient): boolean =>
  r.own || r.verified;

/** フォームの to を、登録の送り先へ(登録に無い名前は落とす)。 */
function recipientsFor(
  form: ContactForm,
  all: ContactRecipient[],
): ContactRecipient[] {
  const map = new Map(all.map((r) => [r.name, r]));
  return (form.to ?? [])
    .map((n) => map.get(n))
    .filter((r): r is ContactRecipient => Boolean(r));
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
  const all = await contactRecipientList(env);
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
    } else if (!recipientsFor(form, all).some(deliverable)) {
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

  const targets = recipientsFor(opened.form, await contactRecipientList(env));
  const sendTo = targets.filter(deliverable);
  const waiting = targets.filter((r) => !deliverable(r));
  if (!sendTo.length) return reply({ error: "not_configured" }, 503);

  const sendMail = deps.sendMail ?? (await import("./api.ts")).sendMail;
  const siteName = await siteNameOf(env);
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
  const text =
    `${opened.form.subject}\n\n${recipientsNotice(sendTo, waiting)}\n\n` +
    `頁: ${pageUrl}\n日時: ${at}\n\n${lines.join("\n\n")}\n`;
  // 送り先ごとに 1 通(同じメールに並べると、「全員に返信」で別の送り先のアドレスが送った人に見える)
  let delivered = 0;
  for (const r of sendTo) {
    try {
      const status = await sendMail(env, {
        to: [r.email],
        subject,
        text,
        lang: "ja",
        ...(replyTo ? { replyTo } : {}),
        idempotencyKey: `contact-${ch.salt}-${r.name}`,
      });
      if (status?.path) delivered++;
    } catch {
      console.warn("contact mail failed");
    }
  }
  if (!delivered) return reply({ error: "mail_failed" }, 502);
  return reply({ ok: true });
}

async function siteNameOf(env: Env): Promise<string> {
  return env.DB.prepare("SELECT site_name FROM site_settings WHERE id = 1")
    .first<{ site_name: string }>()
    .then((r) => r?.site_name || "")
    .catch(() => "");
}

/** メールの冒頭: どこへ届いているか(担当どうしで返事が重ならないように)。 */
export function recipientsNotice(
  sendTo: ContactRecipient[],
  waiting: ContactRecipient[] = [],
): string {
  const row = (r: ContactRecipient) => `  ・${r.label}  ${r.email}`;
  const head =
    sendTo.length > 1
      ? `このお問い合わせは、次の ${sendTo.length} か所へ同じ内容で届いています。`
      : "このお問い合わせは、次の送り先へ届いています。";
  const out = [head, ...sendTo.map(row)];
  for (const r of waiting)
    out.push(`${row(r)}(アドレスの確認が済んでいないため、送っていません)`);
  out.push(
    sendTo.length > 1
      ? "このメールに返信すると、お問い合わせをくださった方へ直接届きます(ほかの送り先には届きません)。\n返事が重ならないよう、どこから返事をするかを確かめてから返信してください。"
      : "このメールに返信すると、お問い合わせをくださった方へ直接届きます。",
  );
  return out.join("\n");
}

// ── 送り先の確認(サイトのドメインの外のアドレス)────────────────────────────────

/** 確認のリンク。署名に期限とアドレスを含める(表を引かずに確かめる)。 */
export async function contactVerifyLink(
  env: Env,
  publicBase: string,
  email: string,
  now = Date.now(),
): Promise<string> {
  const e = b64url(new TextEncoder().encode(email.toLowerCase()));
  const x = now + CONTACT_VERIFY_MS;
  const sig = await sign(env, `verify:${e}:${x}`);
  return `${publicBase.replace(/\/+$/, "")}/_contact/verify?e=${e}&x=${x}&s=${sig}`;
}

/** 確認のメールを送る(押されるまで、このアドレスへは問い合わせを届けない)。 */
export async function sendContactVerifyMail(
  env: Env,
  publicBase: string,
  r: { label: string; email: string },
  deps: Pick<ContactDeps, "sendMail" | "now"> = {},
): Promise<boolean> {
  const sendMail = deps.sendMail ?? (await import("./api.ts")).sendMail;
  const siteName = (await siteNameOf(env)) || "ホームページ";
  const link = await contactVerifyLink(env, publicBase, r.email, deps.now);
  const status = await sendMail(env, {
    to: [r.email],
    subject: `[${siteName}] 問い合わせフォームの送り先の確認`,
    text:
      `${siteName} の問い合わせフォームの送り先に、このアドレス(${r.email})が登録されました(送り先の名前: ${r.label})。\n\n` +
      `心当たりがあれば、次のリンクを開いて「確認する」を押してください。押すまでは、このアドレスへ問い合わせを届けません。\n` +
      `${link}\n(7 日のあいだ使えます)\n\n` +
      `心当たりが無ければ、このメールは捨ててください。何も届きません。\n`,
    lang: "ja",
    idempotencyKey: `contact-verify-${r.email}-${Math.floor((deps.now ?? Date.now()) / 60_000)}`,
  });
  return Boolean(status?.path);
}

function verifyPage(title: string, body: string, status = 200): Response {
  const esc = (v: string) =>
    v.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return new Response(
    `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>` +
      `<body style="font-family:sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.7"><h1 style="font-size:1.25rem">${esc(title)}</h1>${body}</body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      },
    },
  );
}

/**
 * GET/POST {公開の根}/_contact/verify?e=&x=&s=
 * GET は「確認する」のボタンを出すだけ(メールの安全確認の仕組みがリンクを先に開いても、確認にしない)。
 * POST(同じサイトから)で控える。
 */
export async function contactVerifyEndpoint(
  request: Request,
  env: Env,
  deps: Pick<ContactDeps, "now" | "flagOn"> = {},
): Promise<Response> {
  const now = deps.now ?? Date.now();
  const flagOn = deps.flagOn ?? (await contactFlagOn(env));
  if (!flagOn) return reply({ error: "not_found" }, 404);
  const url = new URL(request.url);
  const e = url.searchParams.get("e") ?? "";
  const x = Number(url.searchParams.get("x") ?? "");
  const s = url.searchParams.get("s") ?? "";
  let email: string;
  try {
    email = new TextDecoder().decode(b64urlDecode(e));
  } catch {
    email = "";
  }
  const bad = () =>
    verifyPage(
      "リンクが使えません",
      "<p>このリンクは期限が過ぎたか、正しくありません。サイトの管理者に、確認のメールを送り直してもらってください。</p>",
      400,
    );
  if (
    !email ||
    !isEmail(email) ||
    !Number.isFinite(x) ||
    x < now ||
    !(await verify(env, `verify:${e}:${x}`, s))
  )
    return bad();
  if (request.method === "GET") {
    const action = `${url.pathname}?e=${encodeURIComponent(e)}&x=${x}&s=${encodeURIComponent(s)}`;
    return verifyPage(
      "問い合わせフォームの送り先の確認",
      `<p>${email.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)} を、このサイトの問い合わせフォームの送り先にします。</p>` +
        `<form method="post" action="${action.replace(/&/g, "&amp;")}"><button type="submit" style="font-size:1rem;padding:.5rem 1.5rem">確認する</button></form>`,
    );
  }
  if (request.method !== "POST")
    return reply({ error: "method_not_allowed" }, 405);
  if (!sameOrigin(request)) return reply({ error: "forbidden" }, 403);
  await env.DB.prepare(
    "INSERT INTO contact_verified (email, verified_at) VALUES (?, ?) ON CONFLICT(email) DO NOTHING",
  )
    .bind(email.toLowerCase(), new Date(now).toISOString())
    .run();
  return verifyPage(
    "確認しました",
    "<p>これから、このアドレスへ問い合わせフォームの内容が届きます。この頁は閉じてかまいません。</p>",
  );
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
