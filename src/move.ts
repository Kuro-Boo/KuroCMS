/**
 * 委託運用から顧客導入への引っ越し（仕様 cms-move-to-self・2026-10-20）。KuroCMS の側の口。
 *
 * 写すのは受付（install.entamy.com）。受付が移す元（委託）から読み、移す先（顧客導入）へ書く。
 * 移す先はお客様の無料の Cloudflare で動くので、1 回の要求で使える CPU が少ない（10 ms）。
 * そのため、行のハッシュの計算と突き合わせは受付がする。KuroCMS は行をそのまま渡し、受け取るだけ。
 * メディアの中身の確かめは R2 に任せる（書くときに SHA-256 を渡すと、R2 が照合して違えば断る）。
 *
 * 鍵は move_state（migration 0076）の 1 行。受付が両方の D1 へ直接置く。役（source / target）ごとに
 * 使える口を分ける —— 移す元の鍵で書き込みはできず、移す先の鍵で移す元は読めない。
 *
 * 逆向き（顧客導入 → 委託運用・2026-10-21）は、移す元がお客様の Cloudflare にあり、導入口はその D1 に
 * 触れない。移す元の鍵は KuroCMS が自分で置き（startMoveOut）、導入口は延長（renew）と引き渡し
 * （handoff）を移す元の口で頼む。引き渡した後は moved_to へ案内する（movedTo・movedPage）。
 */
import { sha256Hex } from "./crypto.ts";
import { HttpError } from "./http.ts";
import type { Env } from "./types.ts";

export type MoveRole = "source" | "target";

export interface MoveState {
  role: MoveRole;
  token_hash: string;
  expires_at: number;
  frozen: number;
  created_at: number;
  finished_at: number | null;
  /** 引き渡しの後の新しいアドレス（migration 0078。前の版の表には列が無い）。 */
  moved_to?: string | null;
}

const TOKEN = /^Bearer\s+(kmove_[A-Za-z0-9_-]{32,128})$/i;
const IDENT = /^[A-Za-z0-9_]+$/;

/** 引っ越しの鍵（kmove_…）で名乗っているか。 */
export function hasMoveToken(request: Request): boolean {
  return TOKEN.test(request.headers.get("authorization")?.trim() ?? "");
}

/** move_state の行。表が無い（migration の前）・行が無いときは null。 */
export async function readMoveState(env: Env): Promise<MoveState | null> {
  try {
    // 列を名指ししない（moved_to は migration 0078 から。前の版の表でも読めるように）。
    return await env.DB.prepare(
      "SELECT * FROM move_state WHERE id = 1",
    ).first<MoveState>();
  } catch {
    return null;
  }
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 鍵を確かめ、その役が許されているかを見る。通らなければ投げる。 */
export async function authorizeMove(
  request: Request,
  env: Env,
  roles: readonly MoveRole[],
): Promise<MoveState> {
  const m = TOKEN.exec(request.headers.get("authorization")?.trim() ?? "");
  if (!m) throw new HttpError(401, "move_unauthorized", "Move token required.");
  const state = await readMoveState(env);
  if (!state || !state.token_hash)
    throw new HttpError(401, "move_unauthorized", "No move in progress.");
  if (!sameText(await sha256Hex(m[1]!), state.token_hash))
    throw new HttpError(401, "move_unauthorized", "Move token is invalid.");
  if (state.expires_at <= Date.now())
    throw new HttpError(401, "move_expired", "Move token has expired.");
  if (!roles.includes(state.role))
    throw new HttpError(403, "move_wrong_role", "Not allowed for this side.");
  return state;
}

/** 移す元が最後の突き合わせの間（書き込みとビルドを止める）か。 */
export async function moveFrozen(env: Env): Promise<boolean> {
  const state = await readMoveState(env);
  return !!state && state.role === "source" && state.frozen === 1;
}

/**
 * 引っ越しを終えた移す元か（鍵を消して止めたまま・委託運用 → 顧客導入でも、顧客導入 → 委託運用の引き渡しでも）。
 * 最後の突き合わせの間（止めているが鍵はある）とは分ける。終えた移す元は、もうこのサイトの本体ではない ——
 * Entamy ID への導入の報告・Mailer の鍵の更新・SNS の鍵の更新をしない（ID から見て、引っ越した古いサイトが
 * 動き続けているように見えないように。サイトの持ち主と契約は移す先の導入の記録に移っている）。
 */
export async function moveRetired(env: Env): Promise<boolean> {
  const state = await readMoveState(env);
  return (
    !!state &&
    state.role === "source" &&
    state.frozen === 1 &&
    !state.token_hash
  );
}

/** 移す先で、仕上げがまだ（初期化を受け付けない）か。 */
export async function moveTargetPending(env: Env): Promise<boolean> {
  const state = await readMoveState(env);
  return !!state && state.role === "target" && !state.finished_at;
}

export interface TableShape {
  pk: string[];
  cols: string[];
}

/** 表の列と主キー（現物の pragma から。版が違っても、その導入の今の形を答える）。 */
export async function tableShape(env: Env, name: string): Promise<TableShape> {
  if (!IDENT.test(name)) throw new HttpError(400, "bad_table", "Bad table.");
  const info = await env.DB.prepare(
    `SELECT name, pk FROM pragma_table_info('${name}')`,
  ).all<{ name: string; pk: number }>();
  const rows = info.results ?? [];
  return {
    cols: rows.map((r) => r.name),
    pk: rows
      .filter((r) => r.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((r) => r.name),
  };
}

/**
 * rowid の順に読む。続きは最後に読んだ rowid から（行が増えても位置がずれない）。
 * 読んでいる間に書かれた行・消された行は、最後の突き合わせで拾う。
 */
export async function readRows(
  env: Env,
  name: string,
  after: number,
  limit: number,
): Promise<{ rows: Record<string, unknown>[]; last: number | null }> {
  if (!IDENT.test(name)) throw new HttpError(400, "bad_table", "Bad table.");
  const res = await env.DB.prepare(
    `SELECT rowid AS __move_rowid, * FROM ${name} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
  )
    .bind(after, limit)
    .all<Record<string, unknown>>();
  const rows = res.results ?? [];
  let last: number | null = null;
  for (const row of rows) {
    last = Number(row.__move_rowid);
    delete row.__move_rowid;
  }
  return { rows, last: rows.length < limit ? null : last };
}

/**
 * 主キーの順に読む(最後の突き合わせ用)。両側を同じ順に並べて、受付が突き合わせる。
 * 続きは最後に読んだ主キーから(行の値の比べ・SQLite の並びのまま)。
 */
export async function readRowsByKey(
  env: Env,
  name: string,
  pk: string[],
  afterKey: unknown[] | null,
  limit: number,
): Promise<{ rows: Record<string, unknown>[]; lastKey: unknown[] | null }> {
  if (!IDENT.test(name) || !pk.length || !pk.every((c) => IDENT.test(c)))
    throw new HttpError(400, "bad_table", "Bad table.");
  if (afterKey && (!Array.isArray(afterKey) || afterKey.length !== pk.length))
    throw new HttpError(
      400,
      "bad_keys",
      "afterKey must list the primary key values.",
    );
  const cols = pk.map((c) => `"${c}"`).join(", ");
  const where = afterKey
    ? pk.length === 1
      ? `WHERE ${cols} > ?`
      : `WHERE (${cols}) > (${pk.map(() => "?").join(", ")})`
    : "";
  const res = await env.DB.prepare(
    `SELECT * FROM ${name} ${where} ORDER BY ${cols} LIMIT ?`,
  )
    .bind(...((afterKey ?? []) as (string | number | null)[]), limit)
    .all<Record<string, unknown>>();
  const rows = res.results ?? [];
  const last = rows[rows.length - 1];
  return {
    rows,
    lastKey: rows.length < limit || !last ? null : pk.map((c) => last[c]),
  };
}

function keyWhere(pk: string[], count: number): string {
  const one = "(" + pk.map((c) => `"${c}" = ?`).join(" AND ") + ")";
  return Array.from({ length: count }, () => one).join(" OR ");
}

function checkKeys(pk: string[], keys: unknown): unknown[][] {
  if (!pk.length || !pk.every((c) => IDENT.test(c)))
    throw new HttpError(400, "bad_table", "Table has no usable primary key.");
  if (!Array.isArray(keys) || keys.length > 100)
    throw new HttpError(400, "bad_keys", "keys must be an array of up to 100.");
  return keys.map((k) => {
    if (!Array.isArray(k) || k.length !== pk.length)
      throw new HttpError(
        400,
        "bad_keys",
        "Each key must list the primary key values.",
      );
    return k;
  });
}

/** 主キーで行を引く（突き合わせで違った行だけを読み直す）。 */
export async function rowsByKeys(
  env: Env,
  name: string,
  pk: string[],
  keys: unknown,
): Promise<Record<string, unknown>[]> {
  const list = checkKeys(pk, keys);
  if (!list.length) return [];
  const res = await env.DB.prepare(
    `SELECT * FROM ${name} WHERE ${keyWhere(pk, list.length)}`,
  )
    .bind(...(list.flat() as (string | number | null)[]))
    .all<Record<string, unknown>>();
  return res.results ?? [];
}

/** 主キーで行を消す（移す元で消えた行を、移す先からも消す）。 */
export async function deleteByKeys(
  env: Env,
  name: string,
  pk: string[],
  keys: unknown,
): Promise<number> {
  const list = checkKeys(pk, keys);
  if (!list.length) return 0;
  const res = await env.DB.prepare(
    `DELETE FROM ${name} WHERE ${keyWhere(pk, list.length)}`,
  )
    .bind(...(list.flat() as (string | number | null)[]))
    .run();
  return Number(res.meta?.changes ?? 0);
}

/** R2 のキーとして写してよい形か（restoreMedia と同じ縛り）。 */
export function mediaKey(publicPath: string): string {
  const key = publicPath.replace(/^\//, "");
  if (!/^(images|videos|audios)\/[A-Za-z0-9._-]+$/.test(key))
    throw new HttpError(400, "bad_media_path", `Unexpected media key: ${key}`);
  return key;
}

/** 移す元の鍵の期限（顧客導入 → 委託運用）。ログインと入力の間も切らさず、導入口が写している間は延ばす。 */
export const MOVE_OUT_TTL_MS = 24 * 60 * 60 * 1000;

function moveToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  return (
    "kmove_" +
    btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  );
}

/**
 * 引っ越しの移す元の鍵を置く（管理者が設定の「運用の形」から押す・site-move.ts）。押すたびに鍵を作り直す
 * （前の鍵は効かなくなる）。委託運用の導入でも置く —— 導入口は、記録のアドレスでこの鍵を読めたかで頼み手を確かめる。
 * 移す先として引っ越しを受けている途中・もう引き渡した導入では作らない。
 */
export async function startMoveOut(
  env: Env,
  now = Date.now(),
): Promise<{ token: string; expiresAt: number }> {
  const state = await readMoveState(env);
  if (state?.role === "target" && !state.finished_at)
    throw new HttpError(
      409,
      "move_target_pending",
      "This site is receiving a move.",
    );
  if (state?.moved_to)
    throw new HttpError(409, "move_finished", "This site has already moved.");
  const token = moveToken();
  const expiresAt = now + MOVE_OUT_TTL_MS;
  await env.DB.prepare(
    `INSERT INTO move_state (id, role, token_hash, expires_at, frozen, created_at, finished_at) VALUES (1, 'source', ?, ?, 0, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET role = 'source', token_hash = excluded.token_hash, expires_at = excluded.expires_at,
         frozen = 0, created_at = excluded.created_at, finished_at = NULL`,
  )
    .bind(await sha256Hex(token), expiresAt, now)
    .run();
  return { token, expiresAt };
}

/**
 * 導入口が受けなかった引っ越しの鍵を消す（使われない鍵を 24 時間残さない）。止めている・引き渡した・
 * 移す先として受けている行には触れない。
 */
export async function cancelMoveOut(env: Env): Promise<void> {
  await env.DB.prepare(
    "UPDATE move_state SET token_hash = '' WHERE id = 1 AND role = 'source' AND frozen = 0 AND finished_at IS NULL",
  ).run();
}

/** 引き渡しの後の行き先。1 つの isolate で 1 分だけ覚える（どの要求でも引くので D1 を毎回は読まない）。 */
let movedCache: { at: number; to: string | null } | null = null;
export async function movedTo(
  env: Env,
  now = Date.now(),
): Promise<string | null> {
  if (movedCache && now - movedCache.at < 60_000) return movedCache.to;
  const state = await readMoveState(env);
  const to =
    state?.role === "source" &&
    typeof state.moved_to === "string" &&
    /^https:\/\//.test(state.moved_to)
      ? state.moved_to
      : null;
  movedCache = { at: now, to };
  return to;
}
export function forgetMovedCache(): void {
  movedCache = null;
}

const MOVED_TEXT: Record<string, [string, string]> = {
  ja: [
    "このサイトは引っ越しました",
    "新しいアドレスはこちらです。3 秒後に移動します。",
  ],
  en: [
    "This site has moved",
    "Here is the new address. You will be taken there in 3 seconds.",
  ],
  de: [
    "Diese Website ist umgezogen",
    "Hier ist die neue Adresse. Sie werden in 3 Sekunden weitergeleitet.",
  ],
  fr: [
    "Ce site a déménagé",
    "Voici la nouvelle adresse. Vous y serez redirigé dans 3 secondes.",
  ],
  es: [
    "Este sitio se ha mudado",
    "Esta es la nueva dirección. Te llevaremos allí en 3 segundos.",
  ],
  pt: [
    "Este site mudou de endereço",
    "Este é o novo endereço. Você será levado até lá em 3 segundos.",
  ],
  it: [
    "Questo sito si è trasferito",
    "Ecco il nuovo indirizzo. Verrai reindirizzato tra 3 secondi.",
  ],
  uk: [
    "Цей сайт переїхав",
    "Ось нова адреса. Вас буде перенаправлено через 3 секунди.",
  ],
  ko: [
    "이 사이트는 이전했습니다",
    "새 주소는 다음과 같습니다. 3초 후에 이동합니다.",
  ],
  zh: ["本网站已迁移", "新地址如下。3 秒后将自动跳转。"],
  ar: [
    "انتقل هذا الموقع",
    "هذا هو العنوان الجديد. سيتم نقلك إليه خلال 3 ثوانٍ.",
  ],
};

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

/**
 * 「引っ越しました」の案内（委託運用の案内の Worker・導入口 move.ts と同じ文面）。11 言語で出し、
 * 3 秒後に同じ道で新しいアドレスへ移る。検索エンジン向けに canonical を付ける。
 */
export function movedPage(to: string, request: Request): Response {
  const url = new URL(request.url);
  const target = new URL(url.pathname + url.search, to).toString();
  let lang = "en";
  for (const part of (request.headers.get("accept-language") ?? "").split(
    ",",
  )) {
    const code = part.trim().slice(0, 2).toLowerCase();
    if (MOVED_TEXT[code]) {
      lang = code;
      break;
    }
  }
  const [title, lead] = MOVED_TEXT[lang]!;
  const html =
    `<!doctype html><html lang="${lang}"${lang === "ar" ? ' dir="rtl"' : ""}><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
    `<link rel="canonical" href="${esc(target)}"><meta http-equiv="refresh" content="3;url=${esc(target)}">` +
    `<style>body{font-family:system-ui,sans-serif;background:#f8fafc;color:#1e293b;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}` +
    `main{max-width:560px;background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:28px}h1{font-size:22px;margin:0 0 12px}a{color:#0e7490;word-break:break-all}</style>` +
    `</head><body><main><h1>${esc(title)}</h1><p>${esc(lead)}</p><p><a href="${esc(target)}">${esc(target)}</a></p></main></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
