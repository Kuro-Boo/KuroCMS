import {
  isThreadsTokenDailyCheckTime,
  isThreadsTokenRefreshDue,
  isThreadsTokenRejected,
  nextThreadsTokenRefreshAt,
  parseMetaError,
  parseThreadsTokenRefreshPayload,
  redactThreadsToken,
  runScheduledThreadsTokenRefresh,
  threadsTokenRefreshUrl,
} from "./threads-token.ts";

let failed = 0;
function check(name: string, got: unknown, want: unknown): void {
  const actual = JSON.stringify(got);
  const expected = JSON.stringify(want);
  if (actual === expected) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}\n    got : ${actual}\n    want: ${expected}`);
  }
}

const updatedAt = "2026-09-06T06:13:37.000Z";
const nextAt = "2026-10-06T06:13:37.000Z";

console.log("nextThreadsTokenRefreshAt");
check("成功日時から30日後", nextThreadsTokenRefreshAt(updatedAt), nextAt);
check("未記録は予定なし", nextThreadsTokenRefreshAt(null), null);
check("壊れた日時は予定なし", nextThreadsTokenRefreshAt("invalid"), null);

console.log("isThreadsTokenRefreshDue");
check(
  "30日直前は未到来",
  isThreadsTokenRefreshDue(updatedAt, Date.parse(nextAt) - 1),
  false,
);
check(
  "30日の境界で更新対象",
  isThreadsTokenRefreshDue(updatedAt, Date.parse(nextAt)),
  true,
);
check(
  "既存の未記録トークンは更新対象",
  isThreadsTokenRefreshDue(null, Date.now()),
  true,
);

console.log("isThreadsTokenDailyCheckTime");
check(
  "UTC 00:17だけ日次確認",
  isThreadsTokenDailyCheckTime(Date.parse("2026-09-07T00:17:00Z")),
  true,
);
check(
  "隣の分では確認しない",
  isThreadsTokenDailyCheckTime(Date.parse("2026-09-07T00:18:00Z")),
  false,
);

console.log("parseThreadsTokenRefreshPayload");
check(
  "Meta成功応答を読む",
  parseThreadsTokenRefreshPayload({
    access_token: "next-token",
    expires_in: 5_184_000,
  }),
  { accessToken: "next-token", expiresIn: 5_184_000 },
);
check(
  "トークン欠落を拒否",
  parseThreadsTokenRefreshPayload({ expires_in: 5_184_000 }),
  null,
);
check(
  "期限欠落を拒否",
  parseThreadsTokenRefreshPayload({ access_token: "next-token" }),
  null,
);

console.log("threadsTokenRefreshUrl");
{
  const url = threadsTokenRefreshUrl("tok+/=");
  check(
    "呼び先",
    `${url.origin}${url.pathname}`,
    "https://graph.threads.net/refresh_access_token",
  );
  check("grant_type", url.searchParams.get("grant_type"), "th_refresh_token");
  // 2026-11-06: Bearer の見出しで渡した 60 日間、1 度も更新できなかった。説明書どおり引数で渡す。
  check(
    "トークンは access_token の引数",
    url.searchParams.get("access_token"),
    "tok+/=",
  );
}

console.log("redactThreadsToken");
check(
  "生と符号化の両方を伏せる",
  redactThreadsToken("a tok+/= b tok%2B%2F%3D c", "tok+/="),
  "a [redacted] b [redacted] c",
);

console.log("parseMetaError / isThreadsTokenRejected");
const expiredBody = {
  error: {
    message: "Error validating access token: Session has expired",
    type: "OAuthException",
    code: 190,
    error_subcode: 463,
  },
};
check("番号を読む", parseMetaError(expiredBody), {
  code: 190,
  subcode: 463,
  type: "OAuthException",
});
check(
  "文字列の応答も読む",
  parseMetaError(JSON.stringify(expiredBody)).code,
  190,
);
check("壊れた応答は番号なし", parseMetaError("<html>"), {
  code: null,
  subcode: null,
  type: "",
});
check("190 は登録し直し", isThreadsTokenRejected(190), true);
check("ほかの番号は翌日また試す", isThreadsTokenRejected(4), false);

// ── 日次の更新を通しで(D1 と fetch の代役) ──
type Call = { sql: string; args: unknown[] };
function fakeEnv(row: Record<string, unknown>) {
  const calls: Call[] = [];
  const DB = {
    prepare(sql: string) {
      const stmt = {
        args: [] as unknown[],
        bind(...args: unknown[]) {
          stmt.args = args;
          return stmt;
        },
        async first() {
          calls.push({ sql, args: stmt.args });
          return row;
        },
        async run() {
          calls.push({ sql, args: stmt.args });
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return { env: { DB } as never, calls };
}

async function runWith(response: { status: number; body: unknown }): Promise<{
  calls: Call[];
  reports: Array<[string, Record<string, unknown>]>;
  requests: Array<{ url: string; headers: Headers }>;
}> {
  const { env, calls } = fakeEnv({
    threads_token: "old-token",
    threads_token_updated_at: null,
    threads_token_refresh_attempted_at: null,
  });
  const reports: Array<[string, Record<string, unknown>]> = [];
  const requests: Array<{ url: string; headers: Headers }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify(response.body), {
      status: response.status,
    });
  }) as typeof fetch;
  const realError = console.error;
  const realLog = console.log;
  console.error = () => {};
  try {
    console.log = () => {};
    await runScheduledThreadsTokenRefresh(
      env,
      Date.parse("2026-11-07T00:17:00Z"),
      async (code, detail) => {
        reports.push([code, detail]);
      },
    );
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
    console.log = realLog;
  }
  return { calls, reports, requests };
}

console.log("runScheduledThreadsTokenRefresh");
{
  const ok = await runWith({
    status: 200,
    body: { access_token: "new-token", expires_in: 5_184_000 },
  });
  check("Meta を 1 回呼ぶ", ok.requests.length, 1);
  check(
    "引数でトークンを渡す",
    new URL(ok.requests[0].url).searchParams.get("access_token"),
    "old-token",
  );
  check(
    "見出しでは渡さない",
    ok.requests[0].headers.has("authorization"),
    false,
  );
  const save = ok.calls.find((c) =>
    c.sql.includes("threads_token_updated_at = ?"),
  );
  check(
    "新しいトークンを保存し、誤りを消す",
    save?.sql.includes("threads_token_error = NULL"),
    true,
  );
  check("保存の値", save?.args, ["new-token", save?.args[1], "old-token"]);
  check(
    "成功を記録する",
    ok.reports.map((r) => r[0]),
    ["threads_token_refreshed"],
  );

  const expired = await runWith({ status: 400, body: expiredBody });
  const mark = expired.calls.find((c) =>
    c.sql.includes("SET threads_token_error"),
  );
  check("失効は token_invalid を残す", mark?.args, [
    "token_invalid",
    "old-token",
  ]);
  check(
    "失効を Defects へ",
    expired.reports.map((r) => r[0]),
    ["threads_token_refresh_failed"],
  );
  check("Defects は番号だけ", expired.reports[0][1], {
    kind: "meta",
    status: 400,
    code: 190,
    subcode: 463,
    type: "OAuthException",
  });
  check(
    "失敗ではトークンを書き換えない",
    expired.calls.some((c) => c.sql.includes("threads_token_updated_at = ?")),
    false,
  );

  const other = await runWith({
    status: 500,
    body: { error: { code: 2, message: "Service temporarily unavailable" } },
  });
  const mark2 = other.calls.find((c) =>
    c.sql.includes("SET threads_token_error"),
  );
  check("一時の失敗は refresh_failed", mark2?.args, [
    "refresh_failed",
    "old-token",
  ]);
}

if (failed) {
  console.error(`\n${failed} 件失敗しました。`);
  process.exit(1);
}
console.log("\nすべて通りました。");
