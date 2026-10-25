// URL カードの取得(unfurl.ts)の転送の試験(課題 11fc50b0)。確かめるのは —— 転送は 1 回ずつ辿り、
// 行き先が内部の番地なら断る、転送の数に上限がある、最後の URL を基にして相対の画像を読む。
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// unfurl.ts は拡張子の無い import で書かれているので、esbuild で束ねてから読む。
const out = join(mkdtempSync(join(tmpdir(), "kurocms-unfurl-")), "unfurl.mjs");
await build({
  entryPoints: [new URL("./unfurl.ts", import.meta.url).pathname],
  bundle: true,
  format: "esm",
  platform: "neutral",
  outfile: out,
  logLevel: "warning",
});
const { fetchUnfurl } = (await import(
  pathToFileURL(out).href
)) as typeof import("./unfurl.ts");

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

const routes = new Map<string, () => Response>();
const asked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  asked.push(url);
  const r = routes.get(url);
  if (!r) throw new Error(`unexpected ${url}`);
  return r();
}) as typeof fetch;
const redirect = (to: string) => () =>
  new Response(null, { status: 302, headers: { location: to } });
const page = (html: string) => () =>
  new Response(html, { headers: { "content-type": "text/html" } });

console.log("unfurl");
routes.set("https://a.example/", redirect("http://127.0.0.1/admin"));
eq(
  "公開のホストから内部の番地への転送は断る",
  await fetchUnfurl("https://a.example/"),
  { ok: false, reason: "invalid_url" },
);
eq(
  "内部の番地へは要求を送っていない",
  asked.includes("http://127.0.0.1/admin"),
  false,
);

routes.set("https://b.example/", redirect("/next"));
routes.set(
  "https://b.example/next",
  page('<title>B</title><meta property="og:image" content="/img.png">'),
);
const ok = await fetchUnfurl("https://b.example/");
eq(
  "相対の転送を辿り、最後の URL を基に画像を読む",
  ok.ok && ok.meta.image,
  "https://b.example/img.png",
);

for (let i = 0; i < 7; i++)
  routes.set(`https://c.example/${i}`, redirect(`https://c.example/${i + 1}`));
eq("転送の数には上限がある", await fetchUnfurl("https://c.example/0"), {
  ok: false,
  reason: "target_unreachable",
});

if (failed) {
  console.log(`\n${failed} 件 失敗`);
  process.exit(1);
}
console.log("\nunfurl: すべて OK");
