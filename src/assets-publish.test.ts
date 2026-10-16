// 契約テスト (node で直接実行: `node src/assets-publish.test.ts`)。
// 公開ページを番人へ渡す: 一覧の作り方・1 分に 1 回・読み出しの上限・非公開。
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  assetHash,
  assetsPending,
  buildManifest,
  forgetPages,
  pageAssetPath,
  publishAssets,
  recordPages,
  toBase64,
} from "./assets-publish.ts";
import type { Env } from "./types";

let f = 0;
const eq = (n: string, g: unknown, w: unknown) => {
  const a = JSON.stringify(g),
    b = JSON.stringify(w);
  if (a === b) console.log("  ok   " + n);
  else {
    f++;
    console.log(`  FAIL ${n}\n   got ${a}\n   want ${b}`);
  }
};

/** D1 の口を node:sqlite で(この試験で使う分だけ)。 */
function d1(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec(
    readFileSync(
      new URL("../migrations/0073_asset_pages.sql", import.meta.url),
      "utf8",
    ),
  );
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () =>
      (db.prepare(sql).get(...(args as never[])) as unknown) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(args as never[])) }),
    run: async () => ({
      meta: {
        changes: Number(db.prepare(sql).run(...(args as never[])).changes),
      },
    }),
  });
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (list: Array<{ run: () => Promise<unknown> }>) => {
      for (const s of list) await s.run();
      return [];
    },
  } as unknown as D1Database;
}

const toBase = (s: string) => toBase64(s);
eq("base64 は UTF-8 で", toBase("あ"), Buffer.from("あ").toString("base64"));
eq("資産のパス: トップ", pageAssetPath("/", "ja", "ja", ""), "/index.html");
eq(
  "資産のパス: 他の言語",
  pageAssetPath("/news/a", "en", "ja", ""),
  "/en/news/a/index.html",
);
eq(
  "資産のパス: 公開サイトの根の下",
  pageAssetPath("/", "en", "ja", "/blog"),
  "/blog/en/index.html",
);

const pages: Record<string, Record<string, string>> = {
  "/": { ja: "<p>トップ</p>", en: "<p>top</p>" },
  "/news/a": { ja: "<p>記事</p>" },
};
const site = {
  published: true,
  defaultLang: "ja",
  publicBase: "",
  css: { path: "/_tw/t.abc.css", body: "a{}" },
};

{
  const env = { DB: d1() } as unknown as Env;
  for (const [p, b] of Object.entries(pages)) await recordPages(env, p, b);
  const m = await buildManifest(env, site);
  eq("一覧は KV に書いたページの全言語と CSS", Object.keys(m.files).sort(), [
    "/_tw/t.abc.css",
    "/en/index.html",
    "/index.html",
    "/news/a/index.html",
  ]);
  eq(
    "ハッシュは UTF-8 のバイト列の SHA-256 の先頭 32 桁",
    m.files["/index.html"]!.hash,
    await assetHash("<p>トップ</p>"),
  );
  eq(
    "大きさは UTF-8 のバイト数",
    m.files["/index.html"]!.size,
    Buffer.byteLength("<p>トップ</p>"),
  );
  eq("HTML の型", m.files["/en/index.html"]!.type, "text/html; charset=utf-8");
  await recordPages(env, "/", { ja: "<p>トップ2</p>" });
  eq(
    "書き直しで消えた言語は一覧から外れる",
    Object.keys((await buildManifest(env, site)).files).includes(
      "/en/index.html",
    ),
    false,
  );
  await forgetPages(env, ["/news/a"]);
  eq(
    "消したページは一覧から外れる",
    Object.keys((await buildManifest(env, site)).files).includes(
      "/news/a/index.html",
    ),
    false,
  );
  eq(
    "非公開なら空(番人が資産を全部外す)",
    Object.keys(
      (await buildManifest(env, { ...site, published: false })).files,
    ),
    [],
  );
}

// ── 渡す ──
function harness(
  opts: {
    result?: { ok: boolean; status: string; error?: string };
    ask?: "all" | "none";
  } = {},
) {
  const env = { DB: d1() } as unknown as Env & {
    calls: number;
    got: Array<{ hash: string }>[];
  };
  env.calls = 0;
  env.got = [];
  let kvReads = 0;
  env.WORKEROPS = {
    publish: async (manifest, read) => {
      env.calls++;
      if (opts.ask !== "none")
        env.got.push(await read(Object.values(manifest).map((x) => x.hash)));
      return opts.result ?? { ok: true, status: "published" };
    },
  };
  const deps = {
    site: async () => site,
    readPage: async (p: string) => {
      kvReads++;
      return pages[p] ?? {};
    },
  };
  return { env, deps, reads: () => kvReads };
}
{
  const { env, deps, reads } = harness();
  for (const [p, b] of Object.entries(pages)) await recordPages(env, p, b);
  eq(
    "ビルドが終わっていなければ渡さない(保存のときの作り直しは渡さない)",
    [await publishAssets(env, deps), env.calls],
    [{ done: true, status: "current" }, 0],
  );
  eq(
    "ビルドが終わったら渡す",
    await publishAssets(env, deps, { request: true }),
    {
      done: true,
      status: "published",
    },
  );
  eq("頼まれたファイルを全部返す(ページと CSS)", env.got[0]!.length, 4);
  eq("ページは 1 つにつき 1 回だけ読む(全言語入りのバンドル)", reads(), 2);
  eq("渡し終えたら、残りは無い", await assetsPending(env), false);
  await recordPages(env, "/news/a", { ja: "<p>保存で作り直した</p>" });
  eq(
    "渡したあとは、KV が作り直されても次のビルドまで渡さない",
    (await publishAssets(env, deps)).status,
    "current",
  );
  eq(
    "続けてのビルドも待たずに渡す(時間で待たない)",
    (await publishAssets(env, deps, { request: true })).status,
    "published",
  );
  eq(
    "force はビルドが無くても渡す(非公開にしたとき)",
    (await publishAssets(env, deps, { force: true })).status,
    "published",
  );
}
{
  const { env, deps, reads } = harness();
  for (const [p, b] of Object.entries(pages)) await recordPages(env, p, b);
  await publishAssets(env, deps, { maxReads: 1, request: true });
  eq(
    "読み出しの上限を超えて読まない(残りは次の回)",
    [reads(), env.got[0]!.length],
    [1, 3],
  );
}
{
  const { env, deps } = harness({
    result: { ok: false, status: "busy", error: "update_in_progress" },
  });
  eq(
    "番人が受けられなければ、登録は済んでいない(ビルドは続きありで返す)",
    await publishAssets(env, deps, { request: true }),
    { done: false, status: "busy", error: "update_in_progress" },
  );
  eq(
    "済んでいないビルドが残る(予定公開の自動ビルドが見る)",
    await assetsPending(env),
    true,
  );
  eq(
    "次の回はそのまま渡し直す",
    (await publishAssets(env, deps, { request: true })).status,
    "busy",
  );
  eq("2 回とも番人に聞いた", env.calls, 2);
}
{
  const { env, deps } = harness();
  delete env.WORKEROPS;
  eq(
    "番人の口が無い導入は渡さず、ビルドは終われる(KV から返す)",
    await publishAssets(env, deps, { request: true }),
    { done: true, status: "no_binding" },
  );
  eq("口が無ければ残りも無い", await assetsPending(env), false);
}
{
  const { env, deps } = harness();
  env.WORKEROPS = {
    publish: async () => {
      throw new Error("rpc down");
    },
  };
  eq("投げない", await publishAssets(env, deps, { request: true }), {
    done: false,
    status: "error",
    error: "rpc down",
  });
}

if (f) {
  console.log(`\n${f} failed`);
  process.exit(1);
}
console.log("\nall ok");
