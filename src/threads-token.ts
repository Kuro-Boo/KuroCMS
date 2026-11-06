import type { Env } from "./types";

const THREADS_TOKEN_API = "https://graph.threads.net";
const THREADS_TOKEN_REFRESH_DAYS = 30;
const THREADS_TOKEN_REFRESH_INTERVAL_MS =
  THREADS_TOKEN_REFRESH_DAYS * 24 * 60 * 60 * 1000;
const THREADS_TOKEN_CHECK_HOUR_UTC = 0;
const THREADS_TOKEN_CHECK_MINUTE_UTC = 17;

type ThreadsTokenRefreshPayload = {
  accessToken: string;
  expiresIn: number;
};

type ThreadsTokenRow = {
  threads_token: string | null;
  threads_token_updated_at: string | null;
  threads_token_refresh_attempted_at: string | null;
};

/** 画面に出す、最後に断られた理由(migration 0087 の threads_token_error)。 */
export type ThreadsTokenError = "token_invalid" | "refresh_failed";

/**
 * Defects へ送る口(release-report.ts の reportThreads)。呼ぶ側から渡す。
 * この部品を node の試験から読めるよう、基盤へのつなぎをここで import しない。
 */
export type ThreadsReport = (
  code:
    | "threads_token_refreshed"
    | "threads_token_refresh_failed"
    | "threads_post_failed",
  detail: Record<string, string | number>,
) => Promise<void>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Meta の成功応答だけを受理する。生トークンをログへ渡さないための境界でもある。 */
export function parseThreadsTokenRefreshPayload(
  value: unknown,
): ThreadsTokenRefreshPayload | null {
  const body = record(value);
  if (!body) return null;
  const accessToken =
    typeof body.access_token === "string" ? body.access_token.trim() : "";
  const expiresIn = Number(body.expires_in);
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0)
    return null;
  return { accessToken, expiresIn };
}

/** 表示用の次回予定日時。DB には保存せず、最後の成功から常に算出する。 */
export function nextThreadsTokenRefreshAt(
  updatedAt: string | null | undefined,
): string | null {
  if (!updatedAt) return null;
  const updatedMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedMs)) return null;
  return new Date(updatedMs + THREADS_TOKEN_REFRESH_INTERVAL_MS).toISOString();
}

export function isThreadsTokenRefreshDue(
  updatedAt: string | null | undefined,
  nowMs: number,
): boolean {
  const next = nextThreadsTokenRefreshAt(updatedAt);
  return next === null || Date.parse(next) <= nowMs;
}

/** 毎分 cron のうち1日1回だけ D1 と Meta を確認する。 */
export function isThreadsTokenDailyCheckTime(scheduledTime: number): boolean {
  const at = new Date(scheduledTime);
  return (
    Number.isFinite(at.getTime()) &&
    at.getUTCHours() === THREADS_TOKEN_CHECK_HOUR_UTC &&
    at.getUTCMinutes() === THREADS_TOKEN_CHECK_MINUTE_UTC
  );
}

/**
 * 更新の呼び先。トークンは説明書どおり access_token の引数で渡す
 * (2026-11-06: Authorization: Bearer の見出しで渡していた間、60 日間 1 度も更新できず、kuro.boo のトークンが失効した)。
 * URL にトークンが載るので、この URL・応答・例外の文字列はログや Defects へ出さない(redact を通す)。
 */
export function threadsTokenRefreshUrl(token: string): URL {
  const url = new URL(`${THREADS_TOKEN_API}/refresh_access_token`);
  url.searchParams.set("grant_type", "th_refresh_token");
  url.searchParams.set("access_token", token);
  return url;
}

/** 文字列からトークンを伏せる(URL に符号化された形も)。 */
export function redactThreadsToken(text: string, token: string): string {
  if (!token) return text;
  return text
    .replaceAll(token, "[redacted]")
    .replaceAll(encodeURIComponent(token), "[redacted]");
}

/** Meta(Graph API)のエラー応答から、番号だけを読む。 */
export function parseMetaError(value: unknown): {
  code: number | null;
  subcode: number | null;
  type: string;
} {
  let body: unknown = value;
  if (typeof value === "string") {
    try {
      body = JSON.parse(value);
    } catch {
      body = null;
    }
  }
  const error = record(record(body)?.error);
  return {
    code: typeof error?.code === "number" ? error.code : null,
    subcode:
      typeof error?.error_subcode === "number" ? error.error_subcode : null,
    type: typeof error?.type === "string" ? error.type.slice(0, 60) : "",
  };
}

/**
 * トークンそのものが断られたか。code 190 は OAuthException の「トークンが無効」
 * (失効・取り消し・パスワード変更など)で、更新でも投稿でも、登録し直すまで直らない。
 */
export function isThreadsTokenRejected(code: number | null): boolean {
  return code === 190;
}

function metaError(
  value: unknown,
  status: number,
  secret: string,
): Record<string, unknown> {
  const body = record(value);
  const error = record(body?.error);
  return {
    status,
    ...parseMetaError(value),
    message:
      typeof error?.message === "string"
        ? redactThreadsToken(error.message, secret).slice(0, 300)
        : "Threads token refresh failed",
  };
}

/** 投稿が通った時: このトークンへの「受け付けません」の印を外す(登録し直さずに直った場合)。 */
export async function clearThreadsTokenRejected(
  env: Env,
  token: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE site_settings SET threads_token_error = NULL
      WHERE id = 1 AND threads_token = ? AND threads_token_error = 'token_invalid'`,
  )
    .bind(token)
    .run()
    .catch(() => {});
}

/**
 * 断られた理由を残す(画面の赤い 1 行)。保存の最中に登録し直されたトークンには書かない。
 */
export async function recordThreadsTokenError(
  env: Env,
  token: string,
  error: ThreadsTokenError,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE site_settings SET threads_token_error = ?
      WHERE id = 1 AND threads_token = ?`,
  )
    .bind(error, token)
    .run()
    .catch(() => {});
}

/**
 * 長期トークンを30日ごとに更新する。
 *
 * - attempted_at の条件付き UPDATE が日次ロック。Cron の重複配信でも1回だけ呼ぶ。
 * - 保存時にも古いトークンを WHERE に含め、途中の手動登録を上書きしない。
 * - Meta の失敗では現行トークンを一切変更せず、翌日の日次確認で再試行する。
 * - 失敗は理由を threads_token_error に残し(画面)、Defects へ送る(cron の中はほかから読めない)。
 */
export async function runScheduledThreadsTokenRefresh(
  env: Env,
  scheduledTime: number,
  report: ThreadsReport,
): Promise<void> {
  if (!isThreadsTokenDailyCheckTime(scheduledTime)) return;

  const row = await env.DB.prepare(
    `SELECT threads_token, threads_token_updated_at,
            threads_token_refresh_attempted_at
       FROM site_settings WHERE id = 1`,
  ).first<ThreadsTokenRow>();
  const currentToken = (row?.threads_token ?? "").trim();
  if (!currentToken) return;
  if (!isThreadsTokenRefreshDue(row?.threads_token_updated_at, scheduledTime))
    return;

  const attemptedAt = new Date(scheduledTime).toISOString();
  const attemptDay = attemptedAt.slice(0, 10);
  const claim = await env.DB.prepare(
    `UPDATE site_settings
        SET threads_token_refresh_attempted_at = ?
      WHERE id = 1
        AND threads_token = ?
        AND (threads_token_refresh_attempted_at IS NULL
          OR substr(threads_token_refresh_attempted_at, 1, 10) <> ?)`,
  )
    .bind(attemptedAt, currentToken, attemptDay)
    .run();
  if ((claim.meta?.changes ?? 0) === 0) return;

  const failed = async (
    detail: Record<string, string | number>,
    error: ThreadsTokenError,
  ): Promise<void> => {
    console.error(
      JSON.stringify({ event: "threads_token_refresh_failed", ...detail }),
    );
    await recordThreadsTokenError(env, currentToken, error);
    // Defects へは符号と番号だけ(Meta の文は載せない)。
    const numbers = { ...detail };
    delete numbers.message;
    await report("threads_token_refresh_failed", numbers);
  };

  let response: Response;
  let responseBody: unknown;
  try {
    response = await fetch(threadsTokenRefreshUrl(currentToken), {
      signal: AbortSignal.timeout(15_000),
    });
    responseBody = await response.json().catch(() => null);
  } catch (error) {
    await failed(
      {
        kind: "network",
        message: redactThreadsToken(
          error instanceof Error ? error.message : "unknown",
          currentToken,
        ).slice(0, 300),
      },
      "refresh_failed",
    );
    return;
  }

  if (!response.ok) {
    const meta = metaError(responseBody, response.status, currentToken);
    const detail: Record<string, string | number> = {
      kind: "meta",
      status: response.status,
      message: String(meta.message),
    };
    if (typeof meta.code === "number") detail.code = meta.code;
    if (typeof meta.subcode === "number") detail.subcode = meta.subcode;
    if (meta.type) detail.type = String(meta.type);
    await failed(
      detail,
      isThreadsTokenRejected(typeof meta.code === "number" ? meta.code : null)
        ? "token_invalid"
        : "refresh_failed",
    );
    return;
  }

  const refreshed = parseThreadsTokenRefreshPayload(responseBody);
  if (!refreshed) {
    await failed(
      { kind: "invalid_response", status: response.status },
      "refresh_failed",
    );
    return;
  }

  const completedAt = new Date().toISOString();
  const saved = await env.DB.prepare(
    `UPDATE site_settings
        SET threads_token = ?, threads_token_updated_at = ?,
            threads_token_error = NULL
      WHERE id = 1 AND threads_token = ?`,
  )
    .bind(refreshed.accessToken, completedAt, currentToken)
    .run();
  if ((saved.meta?.changes ?? 0) === 0) {
    console.warn(
      JSON.stringify({
        event: "threads_token_refresh_discarded",
        reason: "token_changed_during_refresh",
      }),
    );
    return;
  }

  console.log(
    JSON.stringify({
      event: "threads_token_refreshed",
      completedAt,
      nextRefreshAt: nextThreadsTokenRefreshAt(completedAt),
      expiresIn: refreshed.expiresIn,
    }),
  );
  await report("threads_token_refreshed", { expiresIn: refreshed.expiresIn });
}
