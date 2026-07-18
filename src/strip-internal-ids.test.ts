// 契約テスト (node で直接実行: `npm run test:strip`)。
// F0-2 の敵対的ケースを固定する。実装 (strip-internal-ids.ts) を import するので
// 実装と乖離しない (テストが本体を守る)。
import { stripInternalIds } from "./strip-internal-ids.ts";

const cases: [name: string, input: string, want: string][] = [
  ["普通", '<p data-bid="blk-1">x</p>', "<p>x</p>"],
  [
    "前属性に > (F0-2 の核)",
    '<p title="1 > 0" data-bid="blk-1">x</p>',
    '<p title="1 > 0">x</p>',
  ],
  [
    "前属性に < と >",
    '<a data-x="a<b>c" data-bid="k">t</a>',
    '<a data-x="a<b>c">t</a>',
  ],
  ["単引用符の bid", "<p data-bid='k'>x</p>", "<p>x</p>"],
  [
    "属性順 (bid が先頭)",
    '<div data-bid="k" class="kuro-roundbox">y</div>',
    '<div class="kuro-roundbox">y</div>',
  ],
  [
    "data-cbid も除去 (テーブルセル)",
    '<td data-cbid="c1">v</td>',
    "<td>v</td>",
  ],
  [
    "入れ子 bid",
    '<div data-bid="a"><p data-bid="b">x</p></div>',
    "<div><p>x</p></div>",
  ],
  [
    "コード内のエスケープ済みは保持",
    '<pre><code>&lt;p data-bid="keep"&gt;</code></pre>',
    '<pre><code>&lt;p data-bid="keep"&gt;</code></pre>',
  ],
  [
    "別属性値の data-bid= 文字列は消さない",
    '<p alt="data-bid=fake" data-bid="real">x</p>',
    '<p alt="data-bid=fake">x</p>',
  ],
  ["bid なしは素通し", "<p>no bids</p>", "<p>no bids</p>"],
  [
    "複数ブロック",
    '<p data-bid="1">x</p><h2 data-bid="2">y</h2>',
    "<p>x</p><h2>y</h2>",
  ],
  [
    "コメント内の > と bid は保持",
    '<!-- a > b data-bid="x" --><p data-bid="k">t</p>',
    '<!-- a > b data-bid="x" --><p>t</p>',
  ],
  [
    "属性前後の空白ごと消える (有効 HTML)",
    '<p   data-bid = "k"  class="c">x</p>',
    '<p  class="c">x</p>',
  ],
];

let failed = 0;
for (const [name, input, want] of cases) {
  const got = stripInternalIds(input);
  if (got === want) {
    console.log("OK   " + name);
  } else {
    failed++;
    console.log("FAIL " + name);
    console.log("      got :", JSON.stringify(got));
    console.log("      want:", JSON.stringify(want));
  }
}
if (failed) {
  console.error(`\n${failed} case(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} cases passed`);
