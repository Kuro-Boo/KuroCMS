// 契約テスト (node で直接実行)。いまの版がいつ入ったか(cms-cms-selfupdate)。
//
// 固定したいのは2つ —— 版が変わった時だけ {前の版・今の版・時刻} を書くこと、
// 記録より前に入った版に「気づいた時刻」を更新日として付けないこと。

import { noteRunningVersion } from "./version-since.ts";

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

if (failed) process.exit(1);
