// 契約テスト (node で直接実行)。いまの版がいつ入ったか(cms-cms-selfupdate)。
//
// 固定したいのは2つ —— 版が変わった時だけ {前の版・今の版・時刻} を書くこと、
// 記録より前に入った版に「気づいた時刻」を更新日として付けないこと。

import {
  markPagesBuilt,
  minuteBuildPlan,
  noteRunningVersion,
  pagesBuiltFor,
} from "./version-since.ts";

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.log(`  FAIL ${name}\n       got  ${g}\n       want ${w}`);
  }
};

const store = new Map<string, string>();
let puts = 0;
const env = {
  PUBLIC_PAGES: {
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async put(k: string, v: string) {
      puts++;
      store.set(k, v);
    },
  },
} as never;
const at = (iso: string) => () => iso;

eq(
  "記録が無ければ、時刻は分からないまま",
  await noteRunningVersion(env, "1.0.0", at("2026-01-01T00:00:00Z")),
  { version: "1.0.0", from: null, at: null },
);
eq(
  "版が同じ間は書かない",
  [await noteRunningVersion(env, "1.0.0", at("2026-01-02T00:00:00Z")), puts],
  [{ version: "1.0.0", from: null, at: null }, 1],
);
eq(
  "版が変わったら、前の版と時刻を残す",
  await noteRunningVersion(env, "1.0.1", at("2026-01-03T00:00:00Z")),
  { version: "1.0.1", from: "1.0.0", at: "2026-01-03T00:00:00Z" },
);
store.set("system:version_since", "not json");
eq(
  "壊れた記録は無いものとして扱う",
  await noteRunningVersion(env, "1.0.2", at("2026-01-04T00:00:00Z")),
  { version: "1.0.2", from: null, at: null },
);

{
  // 版が変わったら頁を作り直す。手動の方式では公開の状態を変えない("live")。
  const plan = (
    mode: "auto" | "manual",
    windowPending: boolean,
    versionPending: boolean,
  ) => minuteBuildPlan({ mode, windowPending, versionPending });
  eq("手動・版が同じなら作らない", plan("manual", false, false), null);
  eq(
    "手動・版が変わったら公開の状態のまま作り直す",
    plan("manual", false, true),
    "live",
  );
  eq(
    "手動では公開の切り替えが残っていても出さない",
    plan("manual", true, false),
    null,
  );
  eq(
    "自動・切り替えが残っていればいつものビルド",
    plan("auto", true, false),
    "window",
  );
  eq(
    "自動・版が変わったらいつものビルドで作り直す",
    plan("auto", false, true),
    "window",
  );
  eq("自動・何も無ければ作らない", plan("auto", false, false), null);

  const kv = new Map<string, string>();
  const e = {
    PUBLIC_PAGES: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
    },
  } as never;
  eq("作り直した版の記録が無ければ null", await pagesBuiltFor(e), null);
  await markPagesBuilt(e, "1.0.1");
  eq("作り直した版を残す", await pagesBuiltFor(e), "1.0.1");
}

if (failed) process.exit(1);
