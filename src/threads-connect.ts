/**
 * 「Threads と接続」—— Meta の許可画面を通して、Threads の長期トークンを自動で受け取る(仕様 cms-cms-sns・旗 threads-connect・2026-11-06)。
 *
 * トークンが失効したとき、Meta for Developers でトークンを作って貼り直す手作業を、ボタン 1 つにする。
 *
 *   1. 画面 → POST /api/settings/threads/connect/start { redirectUri, returnUrl }
 *        署名した state を作り、Meta の許可画面の URL を返す。
 *   2. 利用者が Meta で許可 → Meta が GET {redirectUri}?code=…&state=… へ戻す。
 *        ログインの cookie は SameSite=Strict なので、外のサイトから戻ったこの要求には付かない。
 *        ここでは何も書かず、code と state を URL の # に載せて設定の画面(returnUrl)へ送るだけ。
 *   3. 画面 → POST /api/settings/threads/connect/complete { code, state }(ログインしたまま)
 *        state を確かめ、code を短期トークン → 長期トークンへ替えて保存する。
 *
 * state はアプリのシークレットで HMAC 署名する(保存しない)。誰が始めたか(uid)・戻り先・期限(10 分)を持ち、
 * 完了の口は「始めた本人」かつ「戻り先が同じ」ときだけ受け付ける。code は Meta 側で 1 回きり。
 */

export const THREADS_AUTHORIZE_URL = "https://threads.net/oauth/authorize";
const THREADS_GRAPH = "https://graph.threads.net";
export const THREADS_SCOPES = ["threads_basic", "threads_content_publish"];
/** Meta から戻ってくる口(管理画面の API の前置きの後ろ)。 */
export const THREADS_CALLBACK_PATH = "/api/sns/threads/callback";
export const THREADS_STATE_TTL_MS = 10 * 60 * 1000;

export interface ThreadsConnectState {
  /** 始めた人。 */
  uid: string;
  /** Meta に渡した戻り先(交換でも同じ値が要る)。 */
  redirectUri: string;
  /** 終わった後に開く設定の画面。 */
  returnUrl: string;
  /** 期限(ms)。 */
  exp: number;
  nonce: string;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text: string): Uint8Array {
  const s = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)),
  );
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function signThreadsState(
  secret: string,
  state: ThreadsConnectState,
): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify(state)));
  return `${body}.${b64url(await hmac(`threads-connect:${secret}`, body))}`;
}

/** 署名と期限を確かめて中身を返す。どこかが違えば null。 */
export async function verifyThreadsState(
  secret: string,
  token: string,
  nowMs: number,
): Promise<ThreadsConnectState | null> {
  const [body, sig, extra] = String(token || "").split(".");
  if (!body || !sig || extra !== undefined) return null;
  let given: Uint8Array;
  try {
    given = fromB64url(sig);
  } catch {
    return null;
  }
  if (!sameBytes(given, await hmac(`threads-connect:${secret}`, body)))
    return null;
  let state: ThreadsConnectState;
  try {
    state = JSON.parse(new TextDecoder().decode(fromB64url(body)));
  } catch {
    return null;
  }
  if (
    typeof state?.uid !== "string" ||
    typeof state.redirectUri !== "string" ||
    typeof state.returnUrl !== "string" ||
    typeof state.exp !== "number" ||
    state.exp < nowMs
  )
    return null;
  return state;
}

/**
 * 戻り先と設定の画面の URL を確かめる。どちらも、この要求と同じ origin でなければ断る
 * (外のサイトへ code を流さない・外のサイトを戻り先にさせない)。
 */
export function checkThreadsConnectUrls(
  requestUrl: string,
  redirectUri: string,
  returnUrl: string,
): { redirectUri: string; returnUrl: string } | null {
  let origin: string;
  let redirect: URL;
  let back: URL;
  try {
    origin = new URL(requestUrl).origin;
    redirect = new URL(redirectUri);
    back = new URL(returnUrl);
  } catch {
    return null;
  }
  if (redirect.origin !== origin || back.origin !== origin) return null;
  if (redirect.protocol !== "https:") return null;
  if (!redirect.pathname.endsWith(THREADS_CALLBACK_PATH)) return null;
  if (redirect.search || redirect.hash) return null;
  back.hash = "";
  return { redirectUri: redirect.toString(), returnUrl: back.toString() };
}

export function threadsAuthorizeUrl(
  appId: string,
  redirectUri: string,
  state: string,
): string {
  const url = new URL(THREADS_AUTHORIZE_URL);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", THREADS_SCOPES.join(","));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return url.toString();
}

/** Meta から戻った口の行き先: 設定の画面の # に、結果を載せる(サーバーのログにも Referer にも出ない)。 */
export function threadsCallbackRedirect(
  returnUrl: string,
  params: URLSearchParams,
): string {
  const out = new URLSearchParams();
  const code = params.get("code");
  if (code) {
    // Meta は code の末尾に "#_" を付けて返すことがある。
    out.set("threads-code", code.replace(/#_$/, ""));
    out.set("threads-state", params.get("state") ?? "");
  } else {
    out.set(
      "threads-error",
      (params.get("error_reason") || params.get("error") || "denied").slice(
        0,
        60,
      ),
    );
  }
  const url = new URL(returnUrl);
  url.hash = out.toString();
  return url.toString();
}

export class ThreadsConnectError extends Error {
  readonly step: "code" | "exchange";
  readonly status: number;
  readonly code: number | null;
  constructor(
    step: "code" | "exchange",
    status: number,
    code: number | null,
    message: string,
  ) {
    super(message);
    this.step = step;
    this.status = status;
    this.code = code;
  }
}

function metaCode(body: unknown): number | null {
  const error = (body as { error?: { code?: unknown } } | null)?.error;
  return typeof error?.code === "number" ? error.code : null;
}

/**
 * code を長期トークンへ替える(短期 → 長期の 2 段)。返すトークンは保存にだけ使い、ログに出さない。
 */
export async function exchangeThreadsCode(
  input: {
    appId: string;
    appSecret: string;
    redirectUri: string;
    code: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<{ accessToken: string; expiresIn: number }> {
  const form = new URLSearchParams({
    client_id: input.appId,
    client_secret: input.appSecret,
    grant_type: "authorization_code",
    redirect_uri: input.redirectUri,
    code: input.code,
  });
  const shortRes = await fetcher(`${THREADS_GRAPH}/oauth/access_token`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(15_000),
  });
  // 応答の user_id は使わない: 17 桁の数値で届き、JSON.parse で末尾が丸まって別の ID になる
  // (2026-11-06・kuro.boo で投稿が code 100/33 で断られた)。投稿先の ID は投稿の時に /me から文字列で引く。
  const shortBody = (await shortRes.json().catch(() => null)) as {
    access_token?: unknown;
  } | null;
  const shortToken =
    typeof shortBody?.access_token === "string" ? shortBody.access_token : "";
  if (!shortRes.ok || !shortToken)
    throw new ThreadsConnectError(
      "code",
      shortRes.status,
      metaCode(shortBody),
      `threads code exchange failed: ${shortRes.status}`,
    );
  const longUrl = new URL(`${THREADS_GRAPH}/access_token`);
  longUrl.searchParams.set("grant_type", "th_exchange_token");
  longUrl.searchParams.set("client_secret", input.appSecret);
  longUrl.searchParams.set("access_token", shortToken);
  const longRes = await fetcher(longUrl, {
    signal: AbortSignal.timeout(15_000),
  });
  const longBody = (await longRes.json().catch(() => null)) as {
    access_token?: unknown;
    expires_in?: unknown;
  } | null;
  const accessToken =
    typeof longBody?.access_token === "string" ? longBody.access_token : "";
  const expiresIn = Number(longBody?.expires_in);
  if (!longRes.ok || !accessToken || !Number.isFinite(expiresIn))
    throw new ThreadsConnectError(
      "exchange",
      longRes.status,
      metaCode(longBody),
      `threads long-lived exchange failed: ${longRes.status}`,
    );
  return { accessToken, expiresIn };
}
