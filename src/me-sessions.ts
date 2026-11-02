/**
 * ログイン中の端末(2026-11-02・利用者の指示「プロフィールのデバイスのタブに、ログイン中の端末の一覧」)。
 *
 *   GET  /api/me/sessions                 自分のログイン中の端末(期限の切れていないセッション)
 *   POST /api/me/sessions/{id}/revoke     その端末をログアウトさせる(今の端末は除く・ログアウトで行う)
 *
 * ⚠ セッションの ID はログインの鍵そのもの。画面にも応答にも出さず、ID のハッシュの頭から作った目印で扱う。
 * 端末の名前は、ログインに使ったパスキーのデバイス名(passkey_credentials.display_name)。
 */
import type { AuthUser, Env } from "./types.ts";
import { nowIso, sha256Hex } from "./crypto.ts";
import { HttpError } from "./http.ts";

interface SessionRow {
  session_id: string;
  created_at: string | null;
  last_active_at: string | null;
  expires_at: string | null;
  device_name: string | null;
}

export interface MeSession {
  /** 目印(セッションの ID のハッシュの頭 32 字)。ID そのものではない。 */
  id: string;
  /** ログインに使ったパスキーのデバイス名。分からなければ null。 */
  device: string | null;
  /** いまこの画面を開いている端末か。 */
  current: boolean;
  created_at: string | null;
  last_active_at: string | null;
  expires_at: string | null;
}

const handleOf = async (sessionId: string) =>
  (await sha256Hex(`kurocms-session:${sessionId}`)).slice(0, 32);

async function mySessions(env: Env, user: AuthUser): Promise<SessionRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT s.session_id, s.created_at, s.last_active_at, s.expires_at, p.display_name AS device_name
       FROM sessions s LEFT JOIN passkey_credentials p ON p.credential_id = s.credential_id
      WHERE s.uid = ? AND (s.expires_at IS NULL OR s.expires_at > ?)
      ORDER BY s.last_active_at DESC`,
  )
    .bind(user.uid, nowIso())
    .all<SessionRow>();
  return results ?? [];
}

export async function listMeSessions(
  env: Env,
  user: AuthUser,
): Promise<MeSession[]> {
  const rows = await mySessions(env, user);
  return Promise.all(
    rows.map(async (r) => ({
      id: await handleOf(r.session_id),
      device: r.device_name ?? null,
      current: user.sessionId === r.session_id,
      created_at: r.created_at,
      last_active_at: r.last_active_at,
      expires_at: r.expires_at,
    })),
  );
}

/** その端末をログアウトさせる。自分のセッションの中からだけ探す。今の端末は断る(ログアウトで行う)。 */
export async function revokeMeSession(
  env: Env,
  user: AuthUser,
  id: string,
): Promise<{ ok: true }> {
  for (const r of await mySessions(env, user)) {
    if ((await handleOf(r.session_id)) !== id) continue;
    if (r.session_id === user.sessionId) {
      throw new HttpError(
        400,
        "current_session",
        "Use sign out to end the session on this device.",
      );
    }
    await env.DB.prepare(
      "DELETE FROM sessions WHERE session_id = ? AND uid = ?",
    )
      .bind(r.session_id, user.uid)
      .run();
    return { ok: true };
  }
  throw new HttpError(404, "not_found", "No such session.");
}
