// 契約テスト (node で直接実行)。公開の頁のメディアの URL(media-cdn.ts・旗 static-404・2026-11-16)。
//
// 固定したいのは ——「CDN に置けるものは /images/… のまま ?v= にビルドの版、置けないものは /_media/…」
// 「?v= の無いもの(テンプレートに直に書いた画像)にも付ける」「ほかの基点・ほかの道には触れない」。
import { strict as assert } from "node:assert";
import { rewriteMediaRefs } from "./media-cdn.ts";

const cdn = new Set(["images/img-1.png", "images/img-2.png", "videos/v-1.mp4"]);
const r = (html: string, publicBase = "") =>
  rewriteMediaRefs(html, { version: "2.0.41", cdn, publicBase });

assert.equal(
  r('<img src="/images/img-1.png">'),
  '<img src="/images/img-1.png?v=2.0.41">',
);
assert.equal(
  r('<img src="/images/img-2.png?v=20260731">'),
  '<img src="/images/img-2.png?v=20260731-2.0.41">',
);
assert.equal(
  r('<video src="/videos/big.mp4"></video>'),
  '<video src="/_media/videos/big.mp4?v=2.0.41"></video>',
  "置けない(台帳に無い・大きい)ものは /_media/",
);
assert.equal(
  r(
    '<meta property="og:image" content="https://a.example/images/img-1.png?v=7">',
  ),
  '<meta property="og:image" content="https://a.example/images/img-1.png?v=7-2.0.41">',
);
assert.equal(
  r('srcset="/images/img-1.png 1x, /images/img-2.png 2x"'),
  'srcset="/images/img-1.png?v=2.0.41 1x, /images/img-2.png?v=2.0.41 2x"',
);
assert.equal(
  r("background:url(/images/img-1.png)"),
  "background:url(/images/img-1.png?v=2.0.41)",
);
assert.equal(
  r('<img src="/blog/images/img-1.png">', "/blog"),
  '<img src="/blog/images/img-1.png?v=2.0.41">',
  "公開の基点の下",
);
assert.equal(
  r('<img src="/other/images/img-1.png">', "/blog"),
  '<img src="/other/images/img-1.png">',
  "ほかの基点には触れない",
);
assert.equal(
  r('<a href="/blog/my-images/x">'),
  '<a href="/blog/my-images/x">',
  "似た道には触れない",
);
assert.equal(
  r(r('<img src="/images/img-1.png">')),
  '<img src="/images/img-1.png?v=2.0.41">',
  "2 回かけても同じ",
);
console.log("  ok   公開の頁のメディアの URL");
