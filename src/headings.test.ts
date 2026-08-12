// 契約テスト (node で直接実行: `npm run test:headings`)。
// 公開見出しの id / アンカー / 目次の規則を固定する。実装 (headings.ts) を
// import するので、実装と乖離しない。
import {
  annotateHeadings,
  htmlToPlainText,
  renderTocHtml,
  slugifyHeading,
} from "./headings.ts";

let failed = 0;
function check(name: string, got: unknown, want: unknown): void {
  const g = typeof got === "string" ? got : JSON.stringify(got);
  const w = typeof want === "string" ? want : JSON.stringify(want);
  if (g === w) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}\n    got : ${g}\n    want: ${w}`);
  }
}

const A = (label: string) => ({ anchorLabel: label });
const anchor = (id: string, label = "L") =>
  `<a class="kuro-anchor" href="#${id}" aria-label="${label}">#</a>`;

console.log("annotateHeadings");

check(
  "英語の見出し → スラッグ id + アンカー",
  annotateHeadings("<h2>Getting Started</h2>", A("L")).html,
  `<h2 id="getting-started">Getting Started${anchor("getting-started")}</h2>`,
);

check(
  "日本語はそのまま残す (percent-encode はブラウザ任せ)",
  annotateHeadings("<h2>材料と道具</h2>", A("L")).html,
  `<h2 id="材料と道具">材料と道具${anchor("材料と道具")}</h2>`,
);

check(
  "旧 kuro-h-<連番> は安定 id に置き換える",
  annotateHeadings('<h2 id="kuro-h-3">Setup</h2>', A("L")).html,
  `<h2 id="setup">Setup${anchor("setup")}</h2>`,
);

check(
  "著者が付けた id は尊重する",
  annotateHeadings('<h2 id="my-own">Setup</h2>', A("L")).html,
  `<h2 id="my-own">Setup${anchor("my-own")}</h2>`,
);

check(
  "同じ見出しが複数 → -2 を足す",
  annotateHeadings("<h3>まとめ</h3><h3>まとめ</h3>", A("L")).html,
  `<h3 id="まとめ">まとめ${anchor("まとめ")}</h3>` +
    `<h3 id="まとめ-2">まとめ${anchor("まとめ-2")}</h3>`,
);

check(
  "属性値の中の '>' で切り間違えない",
  annotateHeadings('<h2 title="1 > 0">Math</h2>', A("L")).html,
  `<h2 id="math" title="1 > 0">Math${anchor("math")}</h2>`,
);

check(
  "見出し内のタグはテキスト抽出だけに使い、中身は保つ",
  annotateHeadings("<h2>API の<strong>使い方</strong></h2>", A("L")).html,
  `<h2 id="api-の使い方">API の<strong>使い方</strong>${anchor("api-の使い方")}</h2>`,
);

{
  // 冪等性: 2 回通しても '#' が増えない（再ビルドで壊れない）
  const once = annotateHeadings("<h2>Repeat</h2>", A("L")).html;
  check("冪等 (2 回適用しても同じ)", annotateHeadings(once, A("L")).html, once);
}

check(
  "閉じタグが無い壊れた見出しは触らない",
  annotateHeadings("<h2>broken", A("L")).html,
  "<h2>broken",
);

check(
  "h6 と hr は対象外",
  annotateHeadings("<hr><h6>six</h6>", A("L")).html,
  "<hr><h6>six</h6>",
);

check(
  "コメント内の見出しらしき文字列は無視",
  annotateHeadings("<!-- <h2>x</h2> --><p>y</p>", A("L")).html,
  "<!-- <h2>x</h2> --><p>y</p>",
);

check(
  "見出しテキストが記号だけ → section-N にフォールバック",
  annotateHeadings("<h2>???</h2>", A("L")).html,
  `<h2 id="section-1">???${anchor("section-1")}</h2>`,
);

check(
  "見出しが無ければ入力をそのまま返す",
  annotateHeadings("<p>text</p>", A("L")).html,
  "<p>text</p>",
);

check(
  "headings に id / level / text が入る",
  annotateHeadings("<h2>A</h2><h3>B</h3>", A("L")).headings,
  [
    { id: "a", level: 2, text: "A" },
    { id: "b", level: 3, text: "B" },
  ],
);

check(
  "アンカーラベルは呼び手の言語のものを使う",
  annotateHeadings("<h2>A</h2>", A("この見出しへのリンク")).html,
  `<h2 id="a">A${anchor("a", "この見出しへのリンク")}</h2>`,
);

console.log("slugifyHeading");

check("空白は - に畳む", slugifyHeading("a  b   c"), "a-b-c");
check("全角空白も畳む", slugifyHeading("あ　い"), "あ-い");
check("記号は落とす", slugifyHeading("Q&A: 何？"), "q-a-何");
check("前後の - は削る", slugifyHeading("--x--"), "x");
check("大文字は小文字化", slugifyHeading("KuroCMS"), "kurocms");

console.log("htmlToPlainText");

// ⚠ サイトテキストは KuroEditor 由来の HTML。<title> やナビのリンク文字など
//   平文が要る場所へ流す前に必ず通す（/about/ の <title> に &lt;h1&gt; が出た件）。
check(
  "見出しタグを剥がす",
  htmlToPlainText('<h1 id="kuro-h-0">黒兎の人物紹介</h1>'),
  "黒兎の人物紹介",
);
check(
  "入れ子と実体参照",
  htmlToPlainText("<p>A &amp; <strong>B</strong></p>"),
  "A & B",
);
check("空白は畳む", htmlToPlainText("<p>a</p>\n<p>  b </p>"), "a b");
check(
  "タグが無ければそのまま",
  htmlToPlainText("素のタイトル"),
  "素のタイトル",
);
check("空入力", htmlToPlainText(""), "");

console.log("renderTocHtml");

check(
  "見出し 1 本なら目次を作らない",
  renderTocHtml([{ id: "a", level: 2, text: "A" }], { label: "目次" }),
  "",
);

check(
  "最小レベルを基準に depth を付ける",
  renderTocHtml(
    [
      { id: "a", level: 2, text: "A" },
      { id: "b", level: 3, text: "B" },
    ],
    { label: "目次" },
  ),
  '<nav class="kuro-toc" aria-label="目次"><p class="kuro-toc__title">目次</p>' +
    '<ol class="kuro-toc__list">' +
    '<li class="kuro-toc__item" data-depth="0"><a href="#a">A</a></li>' +
    '<li class="kuro-toc__item" data-depth="1"><a href="#b">B</a></li>' +
    "</ol></nav>",
);

check(
  "目次ラベルの HTML はエスケープする",
  renderTocHtml(
    [
      { id: "a", level: 2, text: "<script>" },
      { id: "b", level: 2, text: "B" },
    ],
    { label: "目次" },
  ).includes("&lt;script&gt;"),
  true,
);

if (failed) {
  console.error(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log("\nすべて OK");
