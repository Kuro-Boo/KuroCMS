// 契約テスト (node で直接実行)。登録した頁だけを配るサイトで、公開の側でも Worker が答える口
// (cms-cms-build「登録した頁だけを配る」・課題 b9eee0f8)。
//
// 固定したいのは ——「**決めた動的な口のほかは、公開の道を Worker で組み立てない**」。
// 存在しない道を叩かれるたびに D1 を読み、2 時間に 220 万行を読んだ(2026-11-11)。
import { strict as assert } from "node:assert";
import { staticDynamicPath } from "./static-paths.ts";

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
