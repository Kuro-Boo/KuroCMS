import {
  checkThreadsConnectUrls,
  exchangeThreadsCode,
  signThreadsState,
  threadsAuthorizeUrl,
  threadsCallbackRedirect,
  verifyThreadsState,
} from "./threads-connect.ts";
import { cmsFlagOn } from "./feature-flags.ts";

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

const origin = "https://site.example";
const redirectUri = `${origin}/kurocms/api/sns/threads/callback`;
const returnUrl = `${origin}/kurocms/admin/settings`;
const now = Date.parse("2026-11-06T12:00:00Z");
const state = {
  uid: "u_1",
  redirectUri,
  returnUrl,
  exp: now + 600_000,
  nonce: "n1",
};

console.log("state の署名");
{
  const token = await signThreadsState("secret-a", state);
  check(
    "同じ秘密で読める",
    await verifyThreadsState("secret-a", token, now),
    state,
  );
  check(
    "別の秘密では読めない",
    await verifyThreadsState("secret-b", token, now),
    null,
  );
  check(
    "期限を過ぎたら読めない",
    await verifyThreadsState("secret-a", token, now + 600_001),
    null,
  );
  const [body, sig] = token.split(".");
  const forged = Buffer.from(
    JSON.stringify({ ...state, returnUrl: "https://evil.example/" }),
  ).toString("base64url");
  check(
    "中身を差し替えると読めない",
    await verifyThreadsState("secret-a", `${forged}.${sig}`, now),
    null,
  );
  check(
    "壊れた形は読めない",
    await verifyThreadsState("secret-a", body, now),
    null,
  );
  check(
    "余分な区切りは読めない",
    await verifyThreadsState("secret-a", `${token}.x`, now),
    null,
  );
}

console.log("戻り先の確かめ");
check(
  "同じ origin の https は通す",
  checkThreadsConnectUrls(
    `${origin}/kurocms/api/settings/threads/connect/start`,
    redirectUri,
    `${returnUrl}#x`,
  ),
  { redirectUri, returnUrl },
);
check(
  "外の origin の戻り先は断る",
  checkThreadsConnectUrls(
    `${origin}/x`,
    "https://evil.example/kurocms/api/sns/threads/callback",
    returnUrl,
  ),
  null,
);
check(
  "外の origin の画面は断る",
  checkThreadsConnectUrls(
    `${origin}/x`,
    redirectUri,
    "https://evil.example/settings",
  ),
  null,
);
check(
  "http は断る",
  checkThreadsConnectUrls(
    "http://site.example/x",
    "http://site.example/kurocms/api/sns/threads/callback",
    "http://site.example/s",
  ),
  null,
);
check(
  "戻る口ではない道は断る",
  checkThreadsConnectUrls(
    `${origin}/x`,
    `${origin}/kurocms/api/other`,
    returnUrl,
  ),
  null,
);
check(
  "引数付きの戻り先は断る",
  checkThreadsConnectUrls(`${origin}/x`, `${redirectUri}?a=1`, returnUrl),
  null,
);

console.log("許可画面の URL");
{
  const url = new URL(threadsAuthorizeUrl("123", redirectUri, "st"));
  check(
    "呼び先",
    `${url.origin}${url.pathname}`,
    "https://threads.net/oauth/authorize",
  );
  check("引数", Object.fromEntries(url.searchParams), {
    client_id: "123",
    redirect_uri: redirectUri,
    scope: "threads_basic,threads_content_publish",
    response_type: "code",
    state: "st",
  });
}

console.log("Meta から戻った口の行き先");
{
  const ok = new URL(
    threadsCallbackRedirect(
      returnUrl,
      new URLSearchParams("code=abc#_&state=st"),
    ),
  );
  check("画面へ戻す", `${ok.origin}${ok.pathname}`, returnUrl);
  check(
    "code は # に載せ、末尾の #_ を外す",
    Object.fromEntries(new URLSearchParams(ok.hash.slice(1))),
    {
      "threads-code": "abc",
      "threads-state": "st",
    },
  );
  check("問い合わせ文字列には載せない", ok.search, "");
  const denied = new URL(
    threadsCallbackRedirect(
      returnUrl,
      new URLSearchParams("error=access_denied&error_reason=user_denied"),
    ),
  );
  check(
    "断られたら理由を返す",
    new URLSearchParams(denied.hash.slice(1)).get("threads-error"),
    "user_denied",
  );
}

console.log("code を長期トークンへ替える");
{
  const calls: Array<{ url: string; method: string; body: string }> = [];
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? String(init.body) : "",
    });
    if (calls.length === 1)
      return new Response(
        // 本物の応答と同じく、user_id は 2^53 を超える数値(JSON.parse で丸まる)。
        '{"access_token":"short","user_id":27308171085518283}',
        { status: 200 },
      );
    return new Response(
      JSON.stringify({
        access_token: "long",
        token_type: "bearer",
        expires_in: 5_183_944,
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const got = await exchangeThreadsCode(
    { appId: "123", appSecret: "sec", redirectUri, code: "abc" },
    fake,
  );
  check("長期トークンを返し、丸まる user_id は返さない", got, {
    accessToken: "long",
    expiresIn: 5_183_944,
  });
  check(
    "1 段目は POST oauth/access_token",
    [calls[0].method, calls[0].url],
    ["POST", "https://graph.threads.net/oauth/access_token"],
  );
  check(
    "1 段目の中身",
    Object.fromEntries(new URLSearchParams(calls[0].body)),
    {
      client_id: "123",
      client_secret: "sec",
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code: "abc",
    },
  );
  const second = new URL(calls[1].url);
  check(
    "2 段目は th_exchange_token",
    [
      second.pathname,
      second.searchParams.get("grant_type"),
      second.searchParams.get("access_token"),
    ],
    ["/access_token", "th_exchange_token", "short"],
  );

  const bad = (async () =>
    new Response(
      JSON.stringify({ error: { code: 100, message: "Invalid redirect_uri" } }),
      { status: 400 },
    )) as typeof fetch;
  let err: unknown = null;
  try {
    await exchangeThreadsCode(
      { appId: "123", appSecret: "sec", redirectUri, code: "abc" },
      bad,
    );
  } catch (e) {
    err = e;
  }
  const e = err as {
    step?: string;
    status?: number;
    code?: number;
    message?: string;
  } | null;
  check(
    "断られたら段と番号を持って投げる",
    [e?.step, e?.status, e?.code],
    ["code", 400, 100],
  );
  check("投げる文に秘密を載せない", String(e?.message).includes("sec"), false);
}

console.log("旗");
check(
  "開発アカウントのサイトでは効く",
  cmsFlagOn("threads-connect", true),
  true,
);
check("一般のサイトでも効く", cmsFlagOn("threads-connect", false), true);

if (failed) {
  console.error(`\n${failed} 件失敗しました。`);
  process.exit(1);
}
console.log("\nすべて通りました。");
