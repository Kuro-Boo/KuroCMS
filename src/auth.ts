import { makeId, nowIso, randomToken, sha256Hex } from "./crypto";
import { HttpError } from "./http";
import type { AuthUser, Env } from "./types";

async function nextUserId(env: Env): Promise<string> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM users").first<{
    cnt: number;
  }>();
  const n = (row?.cnt ?? 0) + 1;
  return `usr_${String(n).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// Internal row types
// ---------------------------------------------------------------------------

interface UserRow {
  uid: string;
  email: string;
  is_admin: number;
  is_author: number;
  disabled_at: string | null;
}

interface TokenUserRow {
  token_id: string;
  uid: string;
  email: string;
  is_admin: number;
  is_author: number;
  disabled_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
}

interface SessionUserRow {
  session_id: string;
  uid: string;
  email: string;
  is_admin: number;
  is_author: number;
  disabled_at: string | null;
  expires_at: string;
}

// ---------------------------------------------------------------------------
// Session constants
// ---------------------------------------------------------------------------

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days sliding

export const SESSION_COOKIE = "kurocms_session";

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

export function sessionCookieHeader(
  sessionId: string,
  secure: boolean,
): string {
  const maxAge = Math.floor(SESSION_DURATION_MS / 1000);
  const secureFlag = secure ? "; Secure" : "";
  return `${SESSION_COOKIE}=${sessionId}; HttpOnly${secureFlag}; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

export function clearSessionCookieHeader(secure: boolean): string {
  const secureFlag = secure ? "; Secure" : "";
  return `${SESSION_COOKIE}=; HttpOnly${secureFlag}; SameSite=Strict; Path=/; Max-Age=0`;
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

export async function createSession(env: Env, uid: string): Promise<string> {
  const sessionId = "sess_" + randomToken();
  const now = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, uid, expires_at, created_at, last_active_at) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(sessionId, uid, expiresAt, now, now)
    .run();
  return sessionId;
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

export async function tryLocalDevUser(
  env: Env,
  _request: Request,
): Promise<AuthUser | null> {
  if (!env.LOCAL_DEV_ADMIN_EMAIL) return null;
  const email = env.LOCAL_DEV_ADMIN_EMAIL.trim().toLowerCase();
  if (!email) return null;

  const existing = await env.DB.prepare(
    `SELECT uid, email, is_admin, is_author, disabled_at FROM users WHERE email = ?`,
  )
    .bind(email)
    .first<UserRow>();

  if (existing?.disabled_at) {
    throw new HttpError(403, "user_disabled", "User is disabled.");
  }

  let uid = existing?.uid ?? "";
  if (!uid) {
    uid = await nextUserId(env);
    const now = nowIso();
    await env.DB.prepare(
      `INSERT INTO users (uid, email, display_name, author_id, is_admin, is_author, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 1, ?, ?)`,
    )
      .bind(uid, email, null, makeId("author"), now, now)
      .run();
  }

  return {
    uid,
    email: email,
    isAdmin: true,
    isAuthor: true,
    authSource: "local",
  };
}

async function tryPatUser(
  env: Env,
  request: Request,
): Promise<AuthUser | null> {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const token = match[1];
  // Only handle PAT tokens (prefixed with "kuro_")
  if (!token.startsWith("kuro_")) return null;

  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT
      pat.token_id,
      pat.revoked_at,
      pat.expires_at,
      users.uid,
      users.email,
      users.is_admin,
      users.is_author,
      users.disabled_at
    FROM personal_access_tokens pat
    INNER JOIN users ON users.uid = pat.uid
    WHERE pat.token_hash = ?`,
  )
    .bind(tokenHash)
    .first<TokenUserRow>();

  if (!row) return null;

  if (row.revoked_at || row.disabled_at) {
    throw new HttpError(401, "invalid_token", "Token is invalid.");
  }
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
    throw new HttpError(401, "expired_token", "Token has expired.");
  }

  await env.DB.prepare(
    "UPDATE personal_access_tokens SET last_used_at = ? WHERE token_id = ?",
  )
    .bind(nowIso(), row.token_id)
    .run();

  return {
    uid: row.uid,
    email: row.email,
    isAdmin: row.is_admin === 1,
    isAuthor: row.is_author === 1,
    tokenId: row.token_id,
    authSource: "pat",
  };
}

async function trySessionUser(
  env: Env,
  request: Request,
): Promise<AuthUser | null> {
  // Accept session id from cookie or Bearer header (sess_ prefix)
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

  if (!sessionId) return null;

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
    .first<SessionUserRow>();

  if (!row) return null;

  // Check expiry
  if (Date.parse(row.expires_at) <= Date.now()) {
    await env.DB.prepare("DELETE FROM sessions WHERE session_id = ?")
      .bind(sessionId)
      .run();
    return null;
  }

  if (row.disabled_at) {
    throw new HttpError(403, "user_disabled", "User is disabled.");
  }

  // Sliding window: extend session
  const newExpiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
  const now = nowIso();
  await env.DB.prepare(
    "UPDATE sessions SET expires_at = ?, last_active_at = ? WHERE session_id = ?",
  )
    .bind(newExpiresAt, now, sessionId)
    .run();

  return {
    uid: row.uid,
    email: row.email,
    isAdmin: row.is_admin === 1,
    isAuthor: row.is_author === 1,
    sessionId,
    authSource: "session",
  };
}

// ---------------------------------------------------------------------------
// Public auth API
// ---------------------------------------------------------------------------

export async function requireAuth(
  env: Env,
  request: Request,
): Promise<AuthUser> {
  const localUser = await tryLocalDevUser(env, request);
  if (localUser) return localUser;

  const patUser = await tryPatUser(env, request);
  if (patUser) return patUser;

  const sessionUser = await trySessionUser(env, request);
  if (sessionUser) return sessionUser;

  throw new HttpError(401, "missing_auth", "Authentication is required.");
}

export function requireAdmin(user: AuthUser): void {
  if (!user.isAdmin) {
    throw new HttpError(403, "admin_required", "Admin permission is required.");
  }
}

export function requireAuthor(user: AuthUser): void {
  if (!user.isAuthor) {
    throw new HttpError(
      403,
      "author_required",
      "Author permission is required.",
    );
  }
}

export async function bootstrapAdmin(
  env: Env,
  input: { email: string },
): Promise<{ uid: string }> {
  const existing = await env.DB.prepare("SELECT uid FROM users WHERE email = ?")
    .bind(input.email.toLowerCase())
    .first<{ uid: string }>();
  if (existing?.uid) return { uid: existing.uid };

  const uid = await nextUserId(env);
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO users
      (uid, email, display_name, author_id, is_admin, is_author, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, 1, ?, ?)`,
  )
    .bind(uid, input.email.toLowerCase(), null, makeId("author"), now, now)
    .run();
  return { uid };
}

export async function createPersonalAccessToken(
  env: Env,
  uid: string,
  name: string,
  scopes: string[],
): Promise<string> {
  const token = `kuro_${randomToken()}`;
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare(
    `INSERT INTO personal_access_tokens
      (token_id, uid, token_hash, name, scopes_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(makeId("pat"), uid, tokenHash, name, JSON.stringify(scopes), nowIso())
    .run();
  return token;
}
