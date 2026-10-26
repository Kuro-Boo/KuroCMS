// 契約テスト (node で直接実行: `npm run test:entamyport`)。
//
// 固定したいのは1つだけ ——「**install_id は必ず同じ値に戻る**」。
// 値が変わると `/v1/accounts/anonymous` が新しい匿名口座を作り、導入が
// 二重に数え直される。増えた口座は後から統合できないので、これは
// 「壊れたら直せない」たぐいの失敗である。
//
// 特に守りたいのは、実際に起きていた壊れ方:
//   ・KV を prefix なしで全消しする経路が 2 つある
//     (siteUnpublish / restoreWipePages)。押せば消えるボタンが管理画面にある
//   ・バックアップ復元でも同じことが起きる
// どちらの後でも同じ値に戻ることを、ここで固定する。

import {
  entamyPort,
  hardenInstallId,
  resolveInstallId,
  __resetEntamyPortCacheForTest,
} from "./entamy-port.ts";

/** 試験用のアクセストークン(署名は見ない。公開ミラーに出すので entamy-connect の testing.ts は読まない)。 */
const b64 = (o: unknown): string =>
  btoa(JSON.stringify(o))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const fakeAccessToken = (claims: Record<string, unknown>): string =>
  `${b64({ alg: "EdDSA" })}.${b64({ exp: Math.floor(Date.now() / 1000) + 600, ...claims })}.signature`;
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
const ok = (name: string, cond: boolean) => eq(name, !!cond, true);

/** D1 と KV の代役。`install_identity` の 1 行だけを持つ。 */
function fakeEnv(
  options: {
    row?: string | null;
    kv?: Record<string, string>;
    dbThrows?: boolean;
    secret?: string;
    storeKey?: string;
  } = {},
): Env & { _row: () => string | null; _kv: Map<string, string> } {
  let row: string | null = options.row ?? null;
  const kv = new Map(Object.entries(options.kv ?? {}));
  const DB = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              if (options.dbThrows) throw new Error("D1_ERROR: overloaded");
              // UPDATE … WHERE install_id = ?2: 今の値のときだけ替える
              if (/^\s*UPDATE/i.test(sql)) {
                if (row === String(args[1])) row = String(args[0]);
                return {};
              }
              // INSERT OR IGNORE: 既に入っていれば何もしない
              if (row === null) row = String(args[0]);
              return {};
            },
            async first() {
              if (options.dbThrows) throw new Error("D1_ERROR: overloaded");
              return row ? { install_id: row } : null;
            },
          };
        },
        async first() {
          if (options.dbThrows) throw new Error("D1_ERROR: overloaded");
          return row ? { install_id: row } : null;
        },
        async run() {
          if (options.dbThrows) throw new Error("D1_ERROR: overloaded");
          return {};
        },
      };
    },
  };
  const PUBLIC_PAGES = {
    async get(k: string) {
      return kv.get(k) ?? null;
    },
    async put(k: string, v: string) {
      kv.set(k, v);
    },
    async delete(k: string) {
      kv.delete(k);
    },
  };
  return {
    DB,
    PUBLIC_PAGES,
    CF_ACCOUNT_ID: "910d074700fab497c381eb0321e292d0",
    CF_WORKER_NAME: "kurocms-app-4bcbcd",
    ...(options.secret ? { ENTAMY_INSTALL_SECRET: options.secret } : {}),
    ...(options.storeKey ? { ENTAMY_STORE_KEY: options.storeKey } : {}),
    _row: () => row,
    _kv: kv,
  } as unknown as Env & { _row: () => string | null; _kv: Map<string, string> };
}

const run = async () => {
  // ── 1. D1 に入っていればそれを使う ──────────────────────────────────
  __resetEntamyPortCacheForTest();
  const stored = "s".repeat(64);
  eq("D1 の値を使う", await resolveInstallId(fakeEnv({ row: stored })), stored);

  // ── 2. D1 が空なら旧 KV 値を種にする（既存導入の継続性）─────────────
  __resetEntamyPortCacheForTest();
  const legacy = "l".repeat(40);
  const env2 = fakeEnv({ kv: { "system:entamy_install_id": legacy } });
  eq("旧 KV 値を引き継ぐ", await resolveInstallId(env2), legacy);
  eq("D1 に固定される", env2._row(), legacy);

  // ── 3. どちらも無ければ導出値 ────────────────────────────────────────
  __resetEntamyPortCacheForTest();
  const env3 = fakeEnv();
  const derived = await resolveInstallId(env3);
  ok("導出値は 64 hex", /^[0-9a-f]{64}$/.test(derived));
  eq("導出値が D1 に固定される", env3._row(), derived);

  // ── 4. 導出は決定的（別インスタンスでも同じ値）─────────────────────
  __resetEntamyPortCacheForTest();
  eq("同じ材料なら同じ値", await resolveInstallId(fakeEnv()), derived);

  // ⚠ ここが本題。KV を全消しされても、D1 が空にされても、同じ値に戻る。
  __resetEntamyPortCacheForTest();
  const wiped = fakeEnv(); // KV も D1 も空 ＝ 全消し直後
  eq("KV 全消しのあとも同じ値に戻る", await resolveInstallId(wiped), derived);

  // ── 5. 材料が違えば別の導入（別 Worker は別インストール）──────────
  __resetEntamyPortCacheForTest();
  const other = fakeEnv();
  (other as unknown as { CF_WORKER_NAME: string }).CF_WORKER_NAME =
    "other-worker";
  const otherId = await resolveInstallId(other);
  ok("Worker が違えば別の値", otherId !== derived);

  // ── 6. D1 が読めなくても止まらない（今日の D1 過負荷で実際に起きた）──
  __resetEntamyPortCacheForTest();
  const broken = await resolveInstallId(fakeEnv({ dbThrows: true }));
  eq("D1 が落ちていても導出値で進む", broken, derived);

  // ── 7. 旧 KV 値が短すぎるときは採用しない ───────────────────────────
  __resetEntamyPortCacheForTest();
  const shortLegacy = await resolveInstallId(
    fakeEnv({ kv: { "system:entamy_install_id": "short" } }),
  );
  eq("短い旧値は使わず導出値へ", shortLegacy, derived);

  // ── 8. 名乗りの秘密があれば、床は秘密入り(推測できない・課題 5be5b80e)──
  const SECRET = Buffer.alloc(32, 9).toString("base64");
  __resetEntamyPortCacheForTest();
  const hardened = await resolveInstallId(fakeEnv({ secret: SECRET }));
  ok("秘密入りの床は 64 hex", /^[0-9a-f]{64}$/.test(hardened));
  ok("秘密入りの床は導出値と違う", hardened !== derived);
  __resetEntamyPortCacheForTest();
  eq(
    "秘密入りの床も決定的",
    await resolveInstallId(fakeEnv({ secret: SECRET })),
    hardened,
  );

  // ── 9. D1 が読めなかった時の値は控えない(秘密入りの床と D1 の値が食い違うことがある)──
  __resetEntamyPortCacheForTest();
  await resolveInstallId(fakeEnv({ dbThrows: true, secret: SECRET }));
  eq(
    "D1 が戻れば D1 の値を使う",
    await resolveInstallId(fakeEnv({ row: derived, secret: SECRET })),
    derived,
  );

  // ── 10. 導出値のままの導入は、口座を変えずに秘密入りへ付け替える ─────────
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ path: url.pathname, body });
    const reply = (v: unknown) =>
      new Response(JSON.stringify(v), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (url.pathname === "/v1/installs/rekey") return reply({ rekeyed: true });
    if (url.pathname === "/v1/accounts/anonymous")
      return reply({
        account_id: "acc_site",
        access_token: fakeAccessToken({}),
        refresh_token: "r_site",
        expires_in: 600,
      });
    return reply({});
  }) as typeof fetch;
  try {
    __resetEntamyPortCacheForTest();
    const STORE_KEY = Buffer.alloc(32, 3).toString("base64");
    const env10 = fakeEnv({
      row: derived,
      secret: SECRET,
      storeKey: STORE_KEY,
    });
    eq("付け替えた", await hardenInstallId(env10), "done");
    const rekey = calls.find((c) => c.path === "/v1/installs/rekey");
    eq("今の名乗りと秘密入りの名乗りを送る", rekey?.body, {
      product_id: "cms",
      install_id: derived,
      new_install_id: hardened,
    });
    eq("D1 の名乗りも替わる", env10._row(), hardened);
    eq("以後は秘密入りで名乗る", await resolveInstallId(env10), hardened);
    eq("付け替え済みなら何もしない", await hardenInstallId(env10), "skipped");
    // 保管庫は封じて置く: KV のリフレッシュトークンは平文で残らない。
    const stored = env10._kv.get("entamy.cms.refresh_token") ?? "";
    ok(
      "リフレッシュトークンは封じてある",
      stored.startsWith("es1.") && !stored.includes("r_site"),
    );
    const port = await entamyPort(env10);
    eq("封じたまま読める", await port.session.refreshToken(), "r_site");

    // 旧 KV から引き継いだ乱数の名乗りは推測できないので、付け替えない。
    __resetEntamyPortCacheForTest();
    calls.length = 0;
    eq(
      "乱数の名乗りはそのまま",
      await hardenInstallId(fakeEnv({ row: legacy, secret: SECRET })),
      "skipped",
    );
    eq("ID を呼ばない", calls.length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log("");
  if (failed) {
    console.log(`${failed} 件 FAIL`);
    process.exit(1);
  }
  console.log("すべて OK");
};

await run();
