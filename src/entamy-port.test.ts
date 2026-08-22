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
  resolveInstallId,
  __resetEntamyPortCacheForTest,
} from "./entamy-port.ts";
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
      void sql;
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

  console.log("");
  if (failed) {
    console.log(`${failed} 件 FAIL`);
    process.exit(1);
  }
  console.log("すべて OK");
};

await run();
