// 契約テスト (node で直接実行: `node src/assets-publish.test.ts`)。
// 公開ページを番人へ渡す: 一覧の作り方・1 分に 1 回・読み出しの上限・非公開。
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  assetHash,
  assetsPending,
  buildManifest,
  forgetPages,
  loadRecordedBuildCache,
  markMediaGateReady,
  mediaIsPublic,
  mediaKeysOf,
  pageAssetPath,
  publishAssets,
  manifestFingerprint,
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
  for (const m of [
    "0018_page_build_cache.sql",
    "0073_asset_pages.sql",
    "0083_page_media.sql",
  ])
    db.exec(
      readFileSync(new URL(`../migrations/${m}`, import.meta.url), "utf8"),
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
{
  // 組み込みの toBase64 が無い所の形でも、同じ出力(大きなページ・区切り 0x8000 をまたぐ)。
  const big = "日本語のページ<p>é😀</p>".repeat(20000);
  eq(
    "base64 は大きなページでも同じ",
    toBase(big),
    Buffer.from(big).toString("base64"),
  );
  const proto = Uint8Array.prototype as Uint8Array & { toBase64?: unknown };
  const saved = Object.getOwnPropertyDescriptor(proto, "toBase64");
  if (saved) delete proto.toBase64;
  try {
    eq(
      "base64 は組み込みが無くても同じ",
      toBase(big),
      Buffer.from(big).toString("base64"),
    );
  } finally {
    if (saved) Object.defineProperty(proto, "toBase64", saved);
  }
}
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
      uploaded: 0,
      remaining: 0,
    },
  );
  eq("頼まれたファイルを全部返す(ページと CSS)", env.got[0]!.length, 4);
  eq("ページは 1 つにつき 1 回だけ読む(全言語入りのバンドル)", reads(), 2);
  eq("渡し終えたら、残りは無い", await assetsPending(env), false);
  eq(
    "一覧が前回と同じビルドは番人を呼ばずに済ませる(同じ版を出さない)",
    [(await publishAssets(env, deps, { request: true })).status, env.calls],
    ["unchanged", 1],
  );
  await recordPages(env, "/news/a", { ja: "<p>中身が変わった</p>" });
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
    {
      done: false,
      status: "busy",
      error: "update_in_progress",
      uploaded: 0,
      remaining: null,
    },
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
  const { env, deps } = harness({
    result: {
      ok: false,
      status: "partial",
      error: "uploaded 3, 2 file(s) still to send",
      uploaded: 3,
      remaining: 2,
    } as never,
  });
  eq(
    "途中(partial)は件数を返し、登録は済んでいない(管理画面は上げた件数で進んだと見る)",
    await publishAssets(env, deps, { request: true }),
    {
      done: false,
      status: "partial",
      error: "uploaded 3, 2 file(s) still to send",
      uploaded: 3,
      remaining: 2,
    },
  );
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

// ── CSP の見出しとテンプレートのスクリプト(cms-cms-security「CSP」) ──────────
{
  const env = { DB: d1() } as unknown as Env;
  for (const [p, b] of Object.entries(pages)) await recordPages(env, p, b);
  const withJs = {
    ...site,
    scripts: [{ path: "/_tjs/t.0123456789abcdef.js", body: "var a=1;" }],
  };
  const m = await buildManifest(env, withJs);
  eq(
    "テンプレートのスクリプトも資産に置く(JS の型で)",
    m.files["/_tjs/t.0123456789abcdef.js"]?.type,
    "text/javascript; charset=utf-8",
  );
  const given: Array<unknown> = [];
  env.WORKEROPS = {
    publish: async (_m, _read, options) => {
      given.push(options);
      return { ok: true, status: "published" };
    },
  };
  let headers =
    "/*\n  content-security-policy-report-only: default-src 'self'\n";
  const deps = {
    site: async () => ({ ...withJs, headers }),
    readPage: async (p: string) => pages[p] ?? {},
  };
  await publishAssets(env, deps, { request: true });
  eq("見出しは番人の資産の設定(_headers)で渡す", given[0], {
    config: { _headers: headers },
  });
  eq(
    "一覧も見出しも同じなら渡さない",
    (await publishAssets(env, deps, { request: true })).status,
    "unchanged",
  );
  headers =
    "/*\n  content-security-policy-report-only: default-src 'self'; x\n";
  eq(
    "見出しが変わったビルドは版を出し直す",
    (await publishAssets(env, deps, { request: true })).status,
    "published",
  );
  eq(
    "見出しの無かった頃の指紋とは同じ(見出しが空なら指紋は変わらない)",
    await manifestFingerprint(m.files, ""),
    await manifestFingerprint(m.files),
  );
}

if (f) {
  console.log(`\n${f} failed`);
  process.exit(1);
}
// 公開の頁が参照するメディアだけを配る(課題 d9968d85)。
{
  eq(
    "頁が参照するメディアを拾う(src・srcset・data 属性・url())",
    mediaKeysOf(
      '<img src="/blog/images/img-1.jpg?v=2" srcset="/images/img-2.webp 2x"><div data-src="videos/v-1.mp4" style="background:url(/audios/a-1.mp3)"></div><a href="/imagesx/no.jpg">',
    ).sort(),
    [
      "audios/a-1.mp3",
      "images/img-1.jpg",
      "images/img-2.webp",
      "videos/v-1.mp4",
    ],
  );
  const DB = d1();
  const env = { DB } as unknown as Env;
  eq(
    "切り替えの前は、どのメディアも配る",
    await mediaIsPublic(env, "images/img-9.jpg"),
    true,
  );
  await recordPages(env, "/a/", { ja: '<img src="/images/img-1.jpg">' });
  await markMediaGateReady(env);
  eq(
    "公開の頁が参照するメディアは配る",
    await mediaIsPublic(env, "images/img-1.jpg"),
    true,
  );
  eq(
    "参照されていない(下書きだけの)メディアは配らない",
    await mediaIsPublic(env, "images/img-9.jpg"),
    false,
  );
  await forgetPages(env, ["/a/"]);
  eq(
    "頁を消したら、そのメディアも配らない",
    await mediaIsPublic(env, "images/img-1.jpg"),
    false,
  );
}
{
  // 記録の無い頁が残っていれば切り替えない(上げた直後・全体ビルドの前)。
  const DB = d1();
  const env = { DB } as unknown as Env;
  await recordPages(env, "/a/", { ja: "<p>x</p>" });
  await DB.prepare("DELETE FROM page_media_scan").run();
  await markMediaGateReady(env);
  eq(
    "記録の無い頁があれば、まだ全部配る",
    await mediaIsPublic(env, "images/img-9.jpg"),
    true,
  );
}

{
  // 全体ビルドの続きの回は、前の回に作った頁を飛ばす(2026-10-26 に回のたびに頭から作り直していた)。
  // ビルドの記録は末尾 / あり、メディアの記録は末尾 / なし(kvPutBundle が normPath して渡す)。
  const DB = d1();
  const env = { DB } as unknown as Env;
  const put = (path: string) =>
    DB.prepare(
      "INSERT INTO page_build_cache (path, lang, source_hash, built_at) VALUES (?, '*', 'h', 'now')",
    )
      .bind(path)
      .run();
  for (const p of ["/", "/blog/", "/blog/monthly/2026/04/", "/news/a/"])
    await put(p);
  await recordPages(env, "/", { ja: "<p>x</p>" });
  await recordPages(env, "/blog", { ja: "<p>x</p>" });
  await recordPages(env, "/blog/monthly/2026/04", { ja: "<p>x</p>" });
  eq(
    "メディアを記録した頁の記録は、末尾 / の違いを越えて読む",
    (await loadRecordedBuildCache(env)).map((r) => r.path).sort(),
    ["/", "/blog/", "/blog/monthly/2026/04/"],
  );
}

console.log("\nall ok");
