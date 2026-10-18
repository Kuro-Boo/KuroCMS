// 素材の一覧(media-list.ts)の試験。
// 確かめるのは —— ?page= で全件をページに分けて取れる(201 件目より古い素材も見える)、
// 全件数 total が返る、per_page は 1〜100 に収める、同じ時刻の素材がページをまたいで
// 重複も欠落もしない、?page= の無い呼び出しは従来どおり 200 件。
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { listMediaPage } from "./media-list.ts";
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

function world() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(
    readFileSync(
      new URL("../migrations/0001_initial.sql", import.meta.url),
      "utf8",
    ),
  );
  // D1 と同じく、SQL の ?N と bind の数が合わないものは落とす。
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => raw.prepare(sql).get(...(args as never[])) ?? null,
    all: async () => ({ results: raw.prepare(sql).all(...(args as never[])) }),
  });
  const env = {
    DB: { prepare: (sql: string) => stmt(sql) },
  } as unknown as Env;
  return { raw, env };
}

const { raw, env } = world();
const ins = raw.prepare(
  "INSERT INTO media_assets (mid, kind, filename, mime, ext, size_bytes, public_path, cache_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'v1', ?, ?)",
);
// 画像 250 件。時刻は 10 件ずつ同じにする(並びの決め手が時刻だけだとページがずれる)。
for (let i = 0; i < 250; i++) {
  const mid = "img-" + String(i).padStart(4, "0");
  const at =
    "2026-10-" + String(1 + Math.floor(i / 10)).padStart(2, "0") + "T00:00:00Z";
  ins.run(
    mid,
    "image",
    mid + ".png",
    "image/png",
    "png",
    1,
    "/images/" + mid + ".png",
    at,
    at,
  );
}
ins.run(
  "vid-0001",
  "video",
  "a.mp4",
  "video/mp4",
  "mp4",
  1,
  "/videos/vid-0001.mp4",
  "2026-10-01T00:00:00Z",
  "2026-10-01T00:00:00Z",
);

const ids = (r: Record<string, unknown>) =>
  (r.items as Array<{ id: string }>).map((x) => x.id);

console.log("ページで取る");
{
  const seen: string[] = [];
  for (let p = 1; p <= 3; p++) {
    const r = await listMediaPage(
      env,
      "image",
      new URLSearchParams({ page: String(p), per_page: "100" }),
    );
    if (p === 1) {
      eq("total は全件", r.total, 250);
      eq("page と perPage を返す", [r.page, r.perPage], [1, 100]);
    }
    seen.push(...ids(r));
  }
  eq("3 ページで 250 件すべて見える", seen.length, 250);
  eq("重複が無い", new Set(seen).size, 250);
  eq("新しい順(先頭は最後に登録したもの)", seen[0], "img-0249");
  eq("末尾は最も古いもの", seen[249], "img-0000");
}

console.log("per_page の範囲");
{
  const big = await listMediaPage(
    env,
    "image",
    new URLSearchParams({ page: "1", per_page: "5000" }),
  );
  eq("上限 100", [big.perPage, ids(big).length], [100, 100]);
  const none = await listMediaPage(
    env,
    "image",
    new URLSearchParams({ page: "1" }),
  );
  eq("既定 50", [none.perPage, ids(none).length], [50, 50]);
  const bad = await listMediaPage(
    env,
    "image",
    new URLSearchParams({ page: "x", per_page: "-3" }),
  );
  eq("壊れた値は 1 ページ目・既定の件数", [bad.page, bad.perPage], [1, 50]);
  const past = await listMediaPage(
    env,
    "image",
    new URLSearchParams({ page: "99", per_page: "100" }),
  );
  eq(
    "範囲外のページは空(total は返す)",
    [ids(past).length, past.total],
    [0, 250],
  );
}

console.log("種類で分ける");
{
  const v = await listMediaPage(
    env,
    "video",
    new URLSearchParams({ page: "1" }),
  );
  eq("動画だけ", [ids(v), v.total], [["vid-0001"], 1]);
}

console.log("?page= の無い呼び出し(選択欄)");
{
  const r = await listMediaPage(env, "image", new URLSearchParams());
  eq("従来どおり 200 件・total も返す", [ids(r).length, r.total], [200, 250]);
}

if (failed) {
  console.log(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log("\nすべて通過");
