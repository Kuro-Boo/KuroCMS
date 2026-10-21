// 契約テスト (node で直接実行: `node src/owner-contact.test.ts`)。
//
// 持ち主の連絡先(cms-admin-integration「連絡先の登録」)で固定したいこと:
//   ・了承が無ければ、ID へ何も送らない
//   ・観測を止めている導入は、訊きもしない・送りもしない
//   ・訊けないとき(圏外)を「未登録」と読まない(ダイアログを出さない)
//   ・確認の頁は製品の場所(kurocms.entamy.com/owner)で、本文にどのサイトの登録かが載る
//   ・導入口で入れた導入(持ち主が導入口の記録にある)は installer と読み、登録を求めない

import { __resetEntamyPortCacheForTest } from "./entamy-port.ts";
import { contactState, startContact } from "./owner-contact.ts";
import type { Env } from "./types.ts";

/** 署名を見ない形だけのアクセストークン(期限だけ読まれる)。公開の写しに Libraries への参照を残さない。 */
function fakeAccessToken(): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64({ alg: "EdDSA" })}.${b64({ exp: Math.floor(Date.now() / 1000) + 600 })}.signature`;
}

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.log(`  FAIL ${name}\n    got : ${g}\n    want: ${w}`);
  }
};

function fakeEnv(kv: Record<string, string> = {}): Env {
  const store = new Map(Object.entries(kv));
  const DB = {
    prepare() {
      const row = { install_id: "i".repeat(32) };
      return {
        bind() {
          return {
            async run() {
              return {};
            },
            async first() {
              return row;
            },
          };
        },
        async first() {
          return row;
        },
      };
    },
  };
  return {
    DB,
    PUBLIC_PAGES: {
      async get(k: string) {
        return store.get(k) ?? null;
      },
      async put(k: string, v: string) {
        store.set(k, v);
      },
      async delete(k: string) {
        store.delete(k);
      },
    },
  } as unknown as Env;
}

type Call = { path: string; body: Record<string, unknown> | null };
function stubId(answer: (path: string) => Response | null): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ path: url.pathname, body });
    if (url.pathname === "/v1/accounts/anonymous") {
      return Response.json({
        account_id: "acc_site",
        access_token: fakeAccessToken(),
        refresh_token: "r1",
        expires_in: 600,
      });
    }
    return answer(url.pathname) ?? Response.json({}, { status: 404 });
  }) as typeof fetch;
  return calls;
}

console.log("owner-contact");

{
  __resetEntamyPortCacheForTest();
  const calls = stubId(() => null);
  const env = fakeEnv({ "system:entamy_optout": "1" });
  eq("観測を止めた導入は opted_out", await contactState(env), {
    state: "opted_out",
  });
  eq(
    "観測を止めた導入は送らない",
    await startContact(env, {
      email: "o@example.com",
      consent: true,
      lang: "ja",
      site: "https://example.com",
    }),
    { ok: false, error: "opted_out", status: 409 },
  );
  eq("ID へは何も行かない", calls.length, 0);
}

{
  __resetEntamyPortCacheForTest();
  const calls = stubId(() => null);
  eq(
    "了承が無ければ断る",
    await startContact(fakeEnv(), {
      email: "o@example.com",
      consent: false,
      lang: "ja",
      site: "https://example.com",
    }),
    { ok: false, error: "consent_required", status: 400 },
  );
  eq("了承が無ければ ID へ何も行かない", calls.length, 0);
}

{
  __resetEntamyPortCacheForTest();
  globalThis.fetch = (async () => {
    throw new TypeError("network down");
  }) as typeof fetch;
  eq(
    "訊けないときは unavailable(未登録と読まない)",
    await contactState(fakeEnv()),
    { state: "unavailable" },
  );
}

{
  __resetEntamyPortCacheForTest();
  stubId((path) =>
    path === "/v1/owner"
      ? Response.json({
          owner: {
            email: "o@example.com",
            consent_version: "2026-10-19",
            consented_at: "a",
            linked_at: "b",
          },
          pending: null,
        })
      : null,
  );
  eq("結ばれていれば linked", await contactState(fakeEnv()), {
    state: "linked",
    email: "o@example.com",
    consentVersion: "2026-10-19",
    linkedAt: "b",
    pending: null,
  });
}

{
  __resetEntamyPortCacheForTest();
  stubId((path) =>
    path === "/v1/owner"
      ? Response.json({ owner: null, pending: null })
      : path === "/installer/api/cms/site-owner"
        ? Response.json({ owner: null })
        : null,
  );
  eq(
    "「登録しない」を選んだ導入は declined",
    await contactState(fakeEnv({ "system:contact_declined": "1" })),
    {
      state: "none",
      declined: true,
      pending: null,
    },
  );
}

{
  __resetEntamyPortCacheForTest();
  const calls = stubId((path) =>
    path === "/v1/owner/start"
      ? Response.json({ ok: true }, { status: 202 })
      : null,
  );
  const env = fakeEnv({ "system:contact_declined": "1" });
  const r = await startContact(env, {
    email: " Owner@Example.com ",
    consent: true,
    lang: "ja",
    site: "https://site.example",
  });
  eq("送れた", r, { ok: true });
  const sent = calls.find((c) => c.path === "/v1/owner/start")?.body ?? {};
  eq(
    "確認の頁は製品の場所(言語つき)",
    sent.continue_url,
    "https://kurocms.entamy.com/owner/?lang=ja",
  );
  eq("了承の版を載せる", sent.consent_version, "2026-10-21");
  eq("アドレスは前後の空白を落とす", sent.email, "Owner@Example.com");
  eq(
    "本文にサイトとリンクの差し込み口がある",
    String(sent.text).includes("https://site.example") &&
      String(sent.text).includes("{{link}}"),
    true,
  );
  eq(
    "登録を選んだら「登録しない」の印を外す",
    await env.PUBLIC_PAGES.get("system:contact_declined"),
    null,
  );
}

{
  __resetEntamyPortCacheForTest();
  stubId((path) =>
    path === "/v1/owner/start"
      ? Response.json(
          { error: { code: "rate_limited", message: "too many" } },
          { status: 429 },
        )
      : null,
  );
  const r = await startContact(fakeEnv(), {
    email: "o@example.com",
    consent: true,
    lang: "en",
    site: "https://s",
  });
  eq("送り過ぎは rate_limited", r, {
    ok: false,
    error: "rate_limited",
    status: 429,
  });
}

{
  __resetEntamyPortCacheForTest();
  stubId((path) =>
    path === "/v1/owner"
      ? Response.json({ owner: null, pending: null })
      : path === "/installer/api/cms/site-owner"
        ? Response.json({ owner: "record" })
        : null,
  );
  eq(
    "導入口で入れた導入は installer(登録を求めない)",
    await contactState(fakeEnv()),
    { state: "installer" },
  );
}

{
  __resetEntamyPortCacheForTest();
  stubId((path) =>
    path === "/v1/owner" ? Response.json({ owner: null, pending: null }) : null,
  );
  eq(
    "導入口に訊けなければ unavailable(未登録と読まない)",
    await contactState(fakeEnv()),
    { state: "unavailable" },
  );
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall ok");
