// 契約テスト (node で直接実行: `node src/entamy-secrets.test.ts`)。
//
// 固定したいこと: 無い秘密だけを 1 本ずつ順に置く(並べて置くと片方が消える)・置いた値はこの isolate で
// すぐ使える・置き終えた印を残し、古い env の isolate が作り直さない・鍵の無い導入は置かない。

import {
  __resetEntamySecretsForTest,
  ensureEntamySecrets,
  entamySecret,
} from "./entamy-secrets.ts";
import type { Env } from "./types.ts";

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

function fakeEnv(extra: Partial<Env> = {}): Env & { _kv: Map<string, string> } {
  const kv = new Map<string, string>();
  return {
    PUBLIC_PAGES: {
      async get(k: string) {
        return kv.get(k) ?? null;
      },
      async put(k: string, v: string) {
        kv.set(k, v);
      },
      async delete(k: string) {
        kv.delete(k);
      },
    },
    CF_API_TOKEN: "token",
    CF_ACCOUNT_ID: "acc",
    CF_WORKER_NAME: "kurocms-app",
    _kv: kv,
    ...extra,
  } as unknown as Env & { _kv: Map<string, string> };
}

function fakeCf(ok = true) {
  const puts: string[] = [];
  let inFlight = 0;
  let overlapped = false;
  const fetch = (async (_url: string, init: RequestInit) => {
    inFlight++;
    if (inFlight > 1) overlapped = true;
    await new Promise((r) => setTimeout(r, 2));
    puts.push(JSON.parse(String(init.body)).name);
    inFlight--;
    return new Response(JSON.stringify({ success: ok }), {
      status: ok ? 200 : 403,
    });
  }) as unknown as typeof fetch;
  return { fetch, puts, overlapped: () => overlapped };
}

const NOW = 1_777_000_000_000;
const run = async () => {
  __resetEntamySecretsForTest();
  const env = fakeEnv({ ENTAMY_STORE_KEY: "already" } as Partial<Env>);
  const cf = fakeCf();
  eq(
    "無いものだけ置く",
    (await ensureEntamySecrets(env, { fetch: cf.fetch, now: () => NOW }))
      .outcome,
    "provisioned",
  );
  eq("置いたのは名乗りの秘密だけ", cf.puts, ["ENTAMY_INSTALL_SECRET"]);
  eq(
    "置いた値はこの isolate ですぐ使える",
    (entamySecret(env, "ENTAMY_INSTALL_SECRET") ?? "").length,
    44,
  );

  // 古い版の isolate(env に Secret が無い・置いた控えも無い)は、印を見て作り直さない。
  __resetEntamySecretsForTest();
  const cf2 = fakeCf();
  eq(
    "置き終えた印があれば待つ",
    (
      await ensureEntamySecrets(env, {
        fetch: cf2.fetch,
        now: () => NOW + 60_000,
      })
    ).outcome,
    "busy",
  );
  eq("作り直さない", cf2.puts, []);

  __resetEntamySecretsForTest();
  const both = fakeEnv();
  const cf3 = fakeCf();
  await ensureEntamySecrets(both, { fetch: cf3.fetch, now: () => NOW });
  eq(
    "2本とも、1本ずつ順に置く",
    [cf3.puts, cf3.overlapped()],
    [["ENTAMY_STORE_KEY", "ENTAMY_INSTALL_SECRET"], false],
  );

  __resetEntamySecretsForTest();
  const managed = fakeEnv({ CF_API_TOKEN: undefined } as Partial<Env>);
  eq(
    "鍵の無い導入(委託)は置かない",
    (
      await ensureEntamySecrets(managed, {
        fetch: fakeCf().fetch,
        now: () => NOW,
      })
    ).outcome,
    "unavailable",
  );

  __resetEntamySecretsForTest();
  const refused = fakeEnv();
  eq(
    "断られたら、どれが何で断られたかを返す",
    await ensureEntamySecrets(refused, {
      fetch: fakeCf(false).fetch,
      now: () => NOW,
    }),
    { outcome: "failed", failed: { name: "ENTAMY_STORE_KEY", status: 403 } },
  );
  const cf5 = fakeCf();
  eq(
    "断られたら 1 時間は試さない(毎分 Cloudflare を叩かない)",
    [
      (
        await ensureEntamySecrets(refused, {
          fetch: cf5.fetch,
          now: () => NOW + 30 * 60_000,
        })
      ).outcome,
      cf5.puts,
    ],
    ["busy", []],
  );
  eq(
    "1 時間たてば試し直す",
    (
      await ensureEntamySecrets(refused, {
        fetch: cf5.fetch,
        now: () => NOW + 61 * 60_000,
      })
    ).outcome,
    "provisioned",
  );

  __resetEntamySecretsForTest();
  const ready = fakeEnv({
    ENTAMY_STORE_KEY: "a",
    ENTAMY_INSTALL_SECRET: "b",
  } as Partial<Env>);
  const cf4 = fakeCf();
  eq(
    "揃っていれば何もしない",
    [
      (await ensureEntamySecrets(ready, { fetch: cf4.fetch, now: () => NOW }))
        .outcome,
      cf4.puts,
      ready._kv.size,
    ],
    ["ready", [], 0],
  );

  console.log("");
  if (failed) {
    console.log(`${failed} 件 FAIL`);
    process.exit(1);
  }
  console.log("すべて OK");
};

await run();
