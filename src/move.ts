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
    return await env.DB.prepare(
      "SELECT role, token_hash, expires_at, frozen, created_at, finished_at FROM move_state WHERE id = 1",
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
