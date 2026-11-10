// 公開の検索(`{publicBase}/_search`・課題 6b09e1b0)。匿名で呼べるので、1 回の要求で D1 に掛かる量を縛る —
// 1 回の検索は 1 回の走査(件数は同じ問い合わせで数える)・続きの深さに上限・同じ問い合わせはエッジの控えから。
//
// public.ts は拡張子の無い import で書かれているので、esbuild で 1 つに束ねてから読む。D1 は本物の SQLite に
// 全部の migration を当てる。
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const out = join(mkdtempSync(join(tmpdir(), "kurocms-search-")), "public.mjs");
await build({
  entryPoints: [new URL("./public.ts", import.meta.url).pathname],
  bundle: true,
  format: "esm",
  platform: "neutral",
  external: ["cloudflare:workers"],
  outfile: out,
  logLevel: "warning",
});
const { searchEndpoint, SEARCH_MAX_OFFSET } = (await import(
  pathToFileURL(out).href
)) as {
  searchEndpoint: (r: Request, env: unknown) => Promise<Response>;
  SEARCH_MAX_OFFSET: number;
};

const raw = new DatabaseSync(":memory:");
const dir = new URL("../migrations/", import.meta.url);
for (const f of readdirSync(dir)
  .filter((x) => x.endsWith(".sql"))
  .sort())
  raw.exec(readFileSync(new URL(f, dir), "utf8"));

// D1 の形。走った問い合わせを数える(1 回の検索で何回なめたか)。
const seen: string[] = [];
const stmt = (sql: string, args: unknown[] = []) => ({
  bind: (...a: unknown[]) => stmt(sql, a),
  first: async () => {
    seen.push(sql);
    return raw.prepare(sql).get(...(args as never[])) ?? null;
  },
  all: async () => {
    seen.push(sql);
    return { results: raw.prepare(sql).all(...(args as never[])) };
  },
  run: async () => {
    seen.push(sql);
    const r = raw.prepare(sql).run(...(args as never[]));
    return { meta: { changes: Number(r.changes) } };
  },
});
const kv = new Map<string, string>();
const env = {
  DB: {
    prepare: (sql: string) => stmt(sql),
    batch: async (list: { run: () => Promise<unknown> }[]) =>
      Promise.all(list.map((x) => x.run())),
  },
  PUBLIC_PAGES: {
    get: async (k: string) => kv.get(k) ?? null,
    put: async (k: string, v: string) => void kv.set(k, v),
    delete: async (k: string) => void kv.delete(k),
    list: async () => ({ keys: [], list_complete: true }),
  },
};

// 公開済みの記事を 250 本(どれも「猫」を含む)。
const now = new Date(Date.now() - 86_400_000).toISOString();
const cols = (t: string) =>
  (raw.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(
    (c) => c.name,
  );
const docCols = cols("documents");
for (let i = 0; i < 250; i++) {
  const did = `doc_${String(i).padStart(3, "0")}`;
  const row: Record<string, unknown> = {
    did,
    slug: `post-${i}`,
    tid: "blog",
    initial_lang: "ja",
    fallback_lang: "ja",
    mode: 1,
    live: 1,
    created_at: now,
    updated_at: now,
    publish_at: now,
  };
  const names = Object.keys(row).filter((k) => docCols.includes(k));
  raw
    .prepare(
      `INSERT INTO documents (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`,
    )
    .run(...(names.map((k) => row[k]) as never[]));
  raw
    .prepare(
      "INSERT INTO search_entries (id, did, lang, tid, title, body_text, category_text, hashtag_text, updated_at) VALUES (?, ?, 'ja', 'blog', ?, ?, '', '', ?)",
    )
    .run(`se_${i}`, did, `記事 ${i}`, `猫の話 ${i}`, now);
}

const search = async (qs: string) => {
  seen.length = 0;
  const res = await searchEndpoint(
    new Request(`https://site.example/_search?${qs}`),
    env,
  );
  return {
    status: res.status,
    body: (await res.json()) as {
      results: unknown[];
      total?: number;
      next_offset?: number | null;
    },
    queries: seen.filter((s) => s.includes("search_entries")).length,
  };
};

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed++;
    console.log(
      `    got : ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`,
    );
  }
};

const first = await search("q=猫&lang=ja");
eq(
  "最初の窓: 10 件・件数・続き",
  [
    first.status,
    first.body.results.length,
    first.body.total,
    first.body.next_offset,
  ],
  [200, 10, 250, 10],
);
eq("検索 1 回で search_entries をなめるのは 1 回だけ", first.queries, 1);

const deep = await search(`q=猫&lang=ja&offset=${SEARCH_MAX_OFFSET - 10}`);
eq(
  "上限の手前の窓は読めるが、その先へ続かない",
  [deep.body.results.length, deep.body.next_offset],
  [10, null],
);
const beyond = await search(`q=猫&lang=ja&offset=${SEARCH_MAX_OFFSET}`);
eq(
  "上限より深い続きは D1 に触れずに空で返す",
  [
    beyond.status,
    beyond.body.results.length,
    beyond.body.next_offset,
    beyond.queries,
  ],
  [200, 0, null, 0],
);
const huge = await search("q=猫&lang=ja&offset=99999999");
eq("極端な offset も同じ", [huge.body.results.length, huge.queries], [0, 0]);

const none = await search("q=犬&lang=ja");
eq(
  "当たらない語: 0 件・続き無し",
  [none.body.results.length, none.body.total, none.body.next_offset],
  [0, 0, null],
);

if (failed) {
  console.log(`\n${failed} 件 失敗`);
  process.exit(1);
}
console.log("\nsearch-endpoint: すべて OK");
