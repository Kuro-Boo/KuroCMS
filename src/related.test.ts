// 関連記事の帯(related.ts)の試験。
// 確かめるのは —— カテゴリーの何件目の記事でも、自分の前後の記事で帯が出る(以前は新しい順に
// 500 件だけを候補にしていて、それより古い記事は帯が丸ごと消えた)、端の記事は反対の端から
// 埋める(本当の最古・最新から)、同じ公開日時でも並びが決まる。
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fetchCategoryPool, pickCategoryNeighbours } from "./related.ts";
import type { Env } from "./types";

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  console.log(`  ${g === w ? "ok  " : "FAIL"} ${name}`);
  if (g !== w) {
    failed++;
    console.log(`    got : ${g}\n    want: ${w}`);
  }
};

const raw = new DatabaseSync(":memory:");
const migrations = new URL("../migrations/", import.meta.url);
for (const f of readdirSync(migrations)
  .filter((x) => x.endsWith(".sql"))
  .sort())
  raw.exec(readFileSync(new URL(f, migrations), "utf8"));
const stmt = (sql: string, args: unknown[] = []) => ({
  bind: (...a: unknown[]) => stmt(sql, a),
  first: async () => raw.prepare(sql).get(...(args as never[])) ?? null,
  all: async () => ({ results: raw.prepare(sql).all(...(args as never[])) }),
});
const env = { DB: { prepare: (sql: string) => stmt(sql) } } as unknown as Env;

const T = "2026-01-01T00:00:00Z";
raw.exec(
  `INSERT INTO categories (id, name, slug, created_at, updated_at) VALUES ('c1', 'Cat', 'cat', '${T}', '${T}')`,
);
const doc = raw.prepare(
  "INSERT INTO documents (did, slug, tid, mode, live, initial_lang, fallback_lang, publish_at, created_at, updated_at) VALUES (?, ?, 'blog', 1, 1, 'ja', 'ja', ?, ?, ?)",
);
const tr = raw.prepare(
  "INSERT INTO document_translations (did, lang, title, body_html, created_at, updated_at) VALUES (?, 'ja', ?, '', ?, ?)",
);
const cat = raw.prepare(
  "INSERT INTO document_categories (did, cid) VALUES (?, 'c1')",
);
// 記事 1200 件。a0000 が最古、a1199 が最新。2 件ずつ同じ公開日時にする(並びは did で決める)。
const N = 1200;
for (let i = 0; i < N; i++) {
  const slug = "a" + String(i).padStart(4, "0");
  const did = "doc_" + String(i).padStart(4, "0");
  const at = new Date(Date.UTC(2020, 0, 1) + Math.floor(i / 2) * 3600_000)
    .toISOString()
    .replace(".000", "");
  doc.run(did, slug, at, at, at);
  tr.run(did, "題 " + slug, at, at);
  cat.run(did);
}

const strip = async (slug: string, n: number) => {
  const pool = await fetchCategoryPool(env, "cat", slug, "ja", "ja", "live");
  const { left, right } = pickCategoryNeighbours(pool, slug, n);
  return [left.map((a) => a.slug), right.map((a) => a.slug)];
};

console.log("真ん中の記事");
eq(
  "新しい順で 501 件目より古い記事も、自分の前後で帯が出る",
  await strip("a0100", 4),
  [
    ["a0098", "a0099"],
    ["a0101", "a0102"],
  ],
);
eq("最新の近く", await strip("a1150", 6), [
  ["a1147", "a1148", "a1149"],
  ["a1151", "a1152", "a1153"],
]);
eq(
  "最大の 20 枚でも足りる",
  (await strip("a0600", 20)).map((x) => x.length),
  [10, 10],
);

console.log("端の記事は反対の端から埋める");
eq("最古の記事: 古い側は最新から", await strip("a0000", 4), [
  ["a1198", "a1199"],
  ["a0001", "a0002"],
]);
eq("最新の記事: 新しい側は本当の最古から", await strip("a1199", 4), [
  ["a1197", "a1198"],
  ["a0000", "a0001"],
]);

console.log("候補に入らない記事");
eq("無い slug は帯を出さない", await strip("nope", 4), [[], []]);

if (failed) {
  console.log(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log("\nすべて通過");
