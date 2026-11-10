// 契約テスト (node で直接実行)。管理画面が Cloudflare の誤りの頁を番号で見分けること(src/admin/lib/edge-error.ts)。
//
// 固定したいのは ——「**番号で決まらないものに、制限の当て推量を出さない**」。
// 削除したサイトの 522(本文に "Connection timed out")に「KV 書き込み上限など」と出て、
// 原因を取り違えさせた(2026-11-10)。
//
// 管理画面の部品は束ねる前提(import/export なし)なので、型を落として読み込む。
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const src = readFileSync(
  new URL("./admin/lib/edge-error.ts", import.meta.url),
  "utf8",
);
const box: Record<string, unknown> = {};
vm.runInNewContext(stripTypeScriptTypes(src) + "\nbox.edgeError = edgeError;", {
  box,
});
const edgeError = box.edgeError as (
  status: number,
  body: string,
) => { kind: string; code: number } | null;

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

const page522 =
  "kurocms.com | 522: Connection timed out Connection timed out Error code 522 Visit cloudflare.com for more information.";
eq("522 は繋がらない(制限ではない)", edgeError(522, page522), {
  kind: "unreachable",
  code: 522,
});
eq("素の 'error code: 530' も繋がらない", edgeError(530, "error code: 530"), {
  kind: "unreachable",
  code: 530,
});
eq(
  "1027 は 1 日の要求数",
  edgeError(429, "Error 1027 This website has been temporarily rate limited"),
  { kind: "daily_limit", code: 1027 },
);
eq(
  "1102 は CPU・メモリ",
  edgeError(503, "Error 1102 Worker exceeded resource limits"),
  { kind: "resource_limit", code: 1102 },
);
eq(
  "1101 は Worker の例外",
  edgeError(500, "Error 1101 Worker threw exception"),
  { kind: "worker_crashed", code: 1101 },
);
eq("番号の無い 500 は当てない", edgeError(500, "Internal Server Error"), null);
eq(
  "timeout の語だけでは当てない",
  edgeError(504, "upstream request timeout"),
  null,
);
eq(
  "ほかの数字に 1027 が混じっても当てない",
  edgeError(500, "Error code 10270"),
  null,
);
eq("4xx の頁は当てない", edgeError(403, "error code: 1020"), null);

console.log(failed ? `\n${failed} failed` : "\nall ok");
if (failed) process.exit(1);
