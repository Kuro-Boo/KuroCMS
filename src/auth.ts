import { makeId, nowIso, randomToken, sha256Hex } from "./crypto.ts";
import { HttpError } from "./http.ts";
import { enforceNetwork } from "./ip-gate.ts";
import type { AuthUser, Env } from "./types.ts";

/**
 * 新しい利用者の番号。最初の 1 人だけ usr_001、その後は乱数にする。
 * 人数から数えると、消した人の番号が次に招いた人へ回り、その番号で残した記録
 * (許した回線・操作の記録)を別の人が引き継いでしまう(課題 4ace3c76)。
 */
export async function nextUserId(env: Env): Promise<string> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM users").first<{
    cnt: number;
  }>();
  return (row?.cnt ?? 0) === 0 ? "usr_001" : makeId("usr");
}

// ---------------------------------------------------------------------------
// Internal row types
// ---------------------------------------------------------------------------

interface TokenUserRow {
  token_id: string;
  uid: string;
  email: string;
  is_admin: number;
  is_author: number;
  disabled_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
  scopes_json: string | null;
}

interface SessionUserRow {
  session_id: string;
  uid: string;
  email: string;
  is_admin: number;
  is_author: number;
  disabled_at: string | null;
  expires_at: string;
  created_at: string;
  credential_id: string | null;
}

// ---------------------------------------------------------------------------
// Session constants
// ---------------------------------------------------------------------------

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days sliding
/**
 * ログインの上限の寿命。使い続けても、作ってからこれを過ぎたら入り直す(課題 2da5d0d3)。
 * 滑る期限だけだと、盗まれた cookie も使い続ける限りいつまでも効く(core-security-checklist 3節)。
 */
export const SESSION_MAX_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

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

/**
 * セッションの表の鍵。**cookie の値そのものは持たず、その SHA-256 を持つ**(課題 cc941872)。D1 を読めた者が
 * 値を写して利用者になりすませないように(PAT・回復・招待の鍵と同じ)。AuthUser.sessionId もこの鍵。
 */
export const sessionKey = (raw: string): Promise<string> => sha256Hex(raw);

/** 要求の cookie に載ったセッションの ID。無ければ null(期限・持ち主は見ない)。 */
function cookieSessionId(request: Request): string | null {
  const m = (request.headers.get("cookie") ?? "").match(
    new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`),
  );
  return m ? m[1] : null;
}

/**
 * ログインでセッションを作る。**そのブラウザが持っていたセッションは消して置き換える**(1 つのブラウザに 1 つ)。
 * 置き換えないと、IP 制限で止められてパスキーで入り直すたびに、前のセッションが cookie を失ったまま
 * 30 日生きて「ログイン中の端末」に並んだ(2026-11-04・同じ端末が 4 つ並んだ)。前の持ち主が別の利用者でも消す
 * (そのブラウザはもう前のセッションを名乗れない)。
 */
export async function createSession(
  env: Env,
  request: Request,
  uid: string,
  credentialId: string | null = null,
): Promise<string> {
  const previous = cookieSessionId(request);
  if (previous) {
    await env.DB.prepare("DELETE FROM sessions WHERE session_id = ?")
      .bind(await sessionKey(previous))
      .run();
  }
  const sessionId = "sess_" + randomToken();
  const now = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, uid, expires_at, created_at, last_active_at, credential_id) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(await sessionKey(sessionId), uid, expiresAt, now, now, credentialId)
    .run();
  return sessionId;
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

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
      pat.scopes_json,
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

  // 鍵の範囲(発行の時に選んだ役割)と、利用者のいまの役割の重なった分だけを持つ(課題 ddfefa78)。
  // 前は範囲を読まず、利用者のいまの役割をそのまま渡していた —— 執筆者だけの鍵が、あとで管理者になった
  // 人の鍵として管理の口を通った。範囲が読めない鍵は何の役割も持たない(開ける側に倒さない)。
  let scopes: string[] = [];
  try {
    const parsed = JSON.parse(row.scopes_json ?? "[]");
    if (Array.isArray(parsed))
      scopes = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    scopes = [];
  }
  return {
    uid: row.uid,
    email: row.email,
    isAdmin: row.is_admin === 1 && scopes.includes("admin"),
    isAuthor:
      row.is_author === 1 &&
      (scopes.includes("author") || scopes.includes("admin")),
    tokenId: row.token_id,
    authSource: "pat",
  };
}

/**
 * cookie で名乗る変更の要求(GET・HEAD・OPTIONS 以外)は、Origin がこの要求の宛先と同じであること。
 * Origin が無ければ Sec-Fetch-Site を見る(same-origin・none だけ通す)。どちらも無い要求はブラウザの
 * 外からのもの(cookie を自分で付けた)なので、通す(CSRF はブラウザに cookie を付けさせる攻撃)。
 */
export function requireSameOrigin(request: Request): void {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
  const origin = request.headers.get("origin");
  if (origin !== null) {
    if (origin === new URL(request.url).origin) return;
  } else {
    const site = request.headers.get("sec-fetch-site");
    if (site === null || site === "same-origin" || site === "none") return;
  }
  throw new HttpError(
    403,
    "cross_origin_request",
    "This request did not come from this admin panel.",
  );
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
    // cookie はブラウザが自動で付けるので、変更の要求はこの管理画面自身からのものに限る
    // (課題 b936bf55)。SameSite=Strict だけでは、同じ登録ドメインの別の origin(委託の別のサイトなど)
    // からの単純な POST に cookie が付きうる。
    requireSameOrigin(request);
  }

  if (!sessionId) {
    const authorization = request.headers.get("authorization") ?? "";
    const bearerMatch = authorization.match(/^Bearer\s+(sess_\S+)$/i);
    if (bearerMatch) {
      sessionId = bearerMatch[1];
    }
  }

  if (!sessionId) return null;
  sessionId = await sessionKey(sessionId);

  const row = await env.DB.prepare(
    `SELECT
      sessions.session_id,
      sessions.uid,
      sessions.expires_at,
      sessions.created_at,
      sessions.credential_id,
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

  // Check expiry(滑る期限か、上限の寿命のどちらかを過ぎたら切る)
  if (
    Date.parse(row.expires_at) <= Date.now() ||
    Date.parse(row.created_at) + SESSION_MAX_LIFETIME_MS <= Date.now()
  ) {
    await env.DB.prepare("DELETE FROM sessions WHERE session_id = ?")
      .bind(sessionId)
      .run();
    return null;
  }

  if (row.disabled_at) {
    throw new HttpError(403, "user_disabled", "User is disabled.");
  }

  // Sliding window: extend session —— ただし作ってから上限の寿命を越えては延ばさない。
  const hardEnd = Date.parse(row.created_at) + SESSION_MAX_LIFETIME_MS;
  const newExpiresAt = new Date(
    Math.min(
      Date.now() + SESSION_DURATION_MS,
      Number.isFinite(hardEnd) ? hardEnd : Date.now(),
    ),
  ).toISOString();
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
    currentCredentialId: row.credential_id,
    authSource: "session",
  };
}

// ---------------------------------------------------------------------------
// Public auth API
// ---------------------------------------------------------------------------

/**
 * Resolve the authenticated user if present, else null (does not throw).
 * Used where an endpoint must behave differently for authenticated vs
 * anonymous callers — e.g. passkey registration distinguishing "add a device
 * to my account" (session) from bootstrap/invitation flows.
 */
export async function tryAuth(
  env: Env,
  request: Request,
): Promise<AuthUser | null> {
  // 接続元の登録(IP 制限)。名乗れた要求だけを、その人の登録した回線か確かめる(ip-gate.ts)。
  const patUser = await tryPatUser(env, request);
  if (patUser) {
    await enforceNetwork(env, request, patUser);
    return patUser;
  }

  const sessionUser = await trySessionUser(env, request);
  if (sessionUser) {
    await enforceNetwork(env, request, sessionUser);
    return sessionUser;
  }

  return null;
}

export async function requireAuth(
  env: Env,
  request: Request,
): Promise<AuthUser> {
  const user = await tryAuth(env, request);
  if (user) return user;

  throw new HttpError(401, "missing_auth", "Authentication is required.");
}

export function requireAdmin(user: AuthUser): void {
  if (!user.isAdmin) {
    throw new HttpError(403, "admin_required", "Admin permission is required.");
  }
}

/**
 * Reject machine credentials: the caller must be a signed-in human in the admin
 * UI (session cookie), not a PAT. For operations whose blast radius makes a
 * stray script token unacceptable — today the bulk importers, which overwrite
 * many articles at once. A PAT that leaks (or an old automation nobody
 * remembers) must not be able to mass-overwrite content.
 *
 * NOT a substitute for keeping history: the admin UI can still overwrite, so
 * the importers snapshot every translation they replace. This only narrows WHO
 * can start such an operation.
 */
export function requireInteractiveUser(user: AuthUser): void {
  if (user.authSource !== "session") {
    throw new HttpError(
      403,
      "session_required",
      "This operation is only available from the admin UI (a signed-in session). Machine tokens (PAT) cannot run it.",
    );
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

/** PAT の期限として選べる日数(既定は 90 日・課題 fbcf9bd6)。 */
export const PAT_EXPIRY_DAYS: readonly number[] = [30, 90, 365];

export async function createPersonalAccessToken(
  env: Env,
  uid: string,
  name: string,
  scopes: string[],
  expiresInDays: number,
): Promise<string> {
  // 期限の無い鍵は作らない(作って忘れた鍵が永久に効く・課題 fbcf9bd6)。
  if (!PAT_EXPIRY_DAYS.includes(expiresInDays)) {
    throw new HttpError(400, "invalid_expiry", "Choose 30, 90 or 365 days.");
  }
  const token = `kuro_${randomToken()}`;
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(
    Date.now() + expiresInDays * 86_400_000,
  ).toISOString();
  await env.DB.prepare(
    `INSERT INTO personal_access_tokens
      (token_id, uid, token_hash, name, scopes_json, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      makeId("pat"),
      uid,
      tokenHash,
      name,
      JSON.stringify(scopes),
      nowIso(),
      expiresAt,
    )
    .run();
  return token;
}
