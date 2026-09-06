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

function metaError(
  value: unknown,
  status: number,
  secret: string,
): Record<string, unknown> {
  const body = record(value);
  const error = record(body?.error);
  return {
    status,
    code: typeof error?.code === "number" ? error.code : null,
    subcode:
      typeof error?.error_subcode === "number" ? error.error_subcode : null,
    message:
      typeof error?.message === "string"
        ? error.message.replaceAll(secret, "[redacted]").slice(0, 300)
        : "Threads token refresh failed",
  };
}

/**
 * 長期トークンを30日ごとに更新する。
 *
 * - attempted_at の条件付き UPDATE が日次ロック。Cron の重複配信でも1回だけ呼ぶ。
 * - 保存時にも古いトークンを WHERE に含め、途中の手動登録を上書きしない。
 * - Meta の失敗では現行トークンを一切変更せず、翌日の日次確認で再試行する。
 */
export async function runScheduledThreadsTokenRefresh(
  env: Env,
  scheduledTime: number,
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

  let response: Response;
  let responseBody: unknown;
  try {
    const url = new URL(`${THREADS_TOKEN_API}/refresh_access_token`);
    url.searchParams.set("grant_type", "th_refresh_token");
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${currentToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    responseBody = await response.json().catch(() => null);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "threads_token_refresh_failed",
        kind: "network",
        error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
      }),
    );
    return;
  }

  if (!response.ok) {
    console.error(
      JSON.stringify({
        event: "threads_token_refresh_failed",
        kind: "meta",
        ...metaError(responseBody, response.status, currentToken),
      }),
    );
    return;
  }

  const refreshed = parseThreadsTokenRefreshPayload(responseBody);
  if (!refreshed) {
    console.error(
      JSON.stringify({
        event: "threads_token_refresh_failed",
        kind: "invalid_response",
        status: response.status,
      }),
    );
    return;
  }

  const completedAt = new Date().toISOString();
  const saved = await env.DB.prepare(
    `UPDATE site_settings
        SET threads_token = ?, threads_token_updated_at = ?
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
}
