// 契約テスト (node で直接実行)。登録した頁だけを配るサイトで、公開の側でも Worker が答える口
// (cms-cms-build「登録した頁だけを配る」・課題 b9eee0f8)。
//
// 固定したいのは ——「**決めた動的な口のほかは、公開の道を Worker で組み立てない**」。
// 存在しない道を叩かれるたびに D1 を読み、2 時間に 220 万行を読んだ(2026-11-11)。
import { strict as assert } from "node:assert";
import { assetRouting, probePath, staticDynamicPath } from "./static-paths.ts";

for (const p of [
  "/_csp",
  "/_unfurl",
  "/favicon.ico",
  "/favicon.svg",
  "/_reactions/abc_1-2",
]) {
  assert.equal(staticDynamicPath(p), true, `${p} は Worker が答える`);
}
for (const p of [
  "/",
  "/blog/post/",
  "/wp-login.php",
  "/_search",
  "/category/x/",
  "/sitemap.xml",
  "/_counts.js",
  "/_reactions/",
  "/_reactions/a/b",
  "/_reactions/../x",
]) {
  assert.equal(staticDynamicPath(p), false, `${p} は資産だけ(Worker は 404)`);
}
console.log("  ok   static-only の動的な口");

// 探りの形だけを待たせる(旗 static-404)。人の頁が読みに行く道(画像・CSS・apple-touch-icon・記事)は待たせない。
for (const p of [
  "/wp-login.php",
  "/index.php",
  "/blog/wp-admin/x",
  "/WP-CONTENT/a",
  "/.env",
  "/a/.git/config",
  "/xmlrpc.php",
]) {
  assert.equal(probePath(p), true, `${p} は探り`);
}
for (const p of [
  "/",
  "/blog/post/",
  "/images/a.png",
  "/_tw/t.abc.css",
  "/apple-touch-icon.png",
  "/.well-known/security.txt",
  "/wp-guide/",
]) {
  assert.equal(probePath(p), false, `${p} は待たせない`);
}
console.log("  ok   探りの形");

// Worker が答える道はすべて Worker が先に受ける(404-page は画像の読み込みも 404 の頁で返す・2026-11-16 harmo-life)。
const r = assetRouting(["/kurocms"]);
assert.equal(r.not_found_handling, "404-page");
for (const p of [
  "/kurocms",
  "/kurocms/*",
  "/initialize/*",
  "/_media/*",
  "/_reactions/*",
  "/_csp",
  "/_unfurl",
  "/favicon.ico",
]) {
  assert.ok(r.run_worker_first.includes(p), `${p} は Worker が先に受ける`);
}
const based = assetRouting(["/test/kurocms"], "/test").run_worker_first;
assert.ok(
  !r.run_worker_first.includes("/images/*"),
  "公開のメディアは資産(Worker を先にしない)",
);
for (const p of ["/test/_media/*", "/_media/*", "/test/_csp"]) {
  assert.ok(based.includes(p), `基点つき ${p}`);
}
assert.ok(r.run_worker_first.length <= 100, "Cloudflare の上限は 100");
console.log("  ok   資産の配り方");
