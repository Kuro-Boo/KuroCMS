// 契約テスト (node で直接実行: `node src/body-sanitize.test.ts`)。
//
// 記事本文とサイト文字の守り（R0 = KuroEditor の sanitizeContentHtml）。書き込み側
// （保存・PUT のマージ後・保守の掃除・サイト文字の保存・テンプレートの既定値）と
// 出す側（公開ページ・公開の読み取り API・サイト文字の読み出し）の両方で通す。
//
// ① エディタが書く正規の本文は【1 文字も変えない】 —— 守りが本文を書き換えると、
//    後でエディタで開いたときに形が化ける（＝トラブルの元）。
// ② 守りを通す場所が抜けていないこと（ソースを読んで縛る。経路を足したら足す）。
import { readFileSync } from "node:fs";
import { sanitizeContentHtml } from "./kuroeditor/normalize.js";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
  }
};

console.log("① エディタが書く本文は変えない");
const canonical: [string, string][] = [
  [
    "段落・装飾",
    '<p data-bid="b1">あ<strong>い</strong><em>う</em><span style="font-size: 20px">え</span></p>',
  ],
  ["リンク記法", "<p>[[https://example.com|例]] [[mid-001]] [[[card]]]</p>"],
  [
    "コールアウト",
    '<div class="kuro-callout kuro-callout--tip" data-bid="b2"><p>注意</p></div>',
  ],
  [
    "角丸ボックス",
    '<div class="kuro-roundbox" style="width: 60%; margin-left: auto"><p>箱</p></div>',
  ],
  [
    "コードブロック",
    '<pre data-gutter="1\n2" data-language="js"><code>if (a &lt; b) {\n}</code></pre>',
  ],
  [
    "チェックリスト",
    '<ul class="kuro-ul-check"><li data-checked="1">済</li><li>未</li></ul>',
  ],
  ["番号リスト", '<ol start="3" class="kuro-ol-paren"><li>三</li></ol>'],
  [
    "表",
    '<table class="kuro-table"><tbody><tr><td contenteditable="true" data-cbid="c1">1</td></tr></tbody></table>',
  ],
  ["ルビ", '<p><ruby class="kuro-ruby--lg">漢字<rt>かんじ</rt></ruby></p>'],
  [
    "画像",
    '<figure class="kuro-media-wrap" data-kuro-media="mid-1%7C50%25"><img src="/media/mid-1.png" alt="" loading="lazy"></figure>',
  ],
  [
    "YouTube の埋め込み",
    '<figure data-kuro-media="x"><div class="kuro-iframe-wrap"><iframe src="https://www.youtube.com/embed/abc" class="kuro-media kuro-media--iframe" allowfullscreen frameborder="0" loading="lazy" allow="autoplay" title="v"></iframe></div></figure>',
  ],
  [
    "レシピカード",
    '<div data-kuro-block="recipe-card" data-recipe-version="1" data-recipe="%7B%22name%22%3A%22a%22%7D" contenteditable="false"><div class="kuro-recipe"><h3>a</h3></div></div>',
  ],
  ["文中の不等号", "<p>1 < 2 &amp;&amp; 3 > 2</p>"],
  ["空行", "<p><br></p>"],
];
for (const [name, html] of canonical) {
  const out = sanitizeContentHtml(html);
  check(name, out === html, out === html ? "" : `→ ${out}`);
}

console.log(
  "①' サイト文字の平文は変えない（サイト名・広告や計測の ID・参照・JSON）",
);
for (const v of [
  "My Site",
  "AT&T <3 a < b > c",
  "ca-pub-1234567890, 1234567890",
  "G-ABC123XYZ",
  "[[mid-12]]",
  '{"a":"<b>"}',
  "&amp; &lt;b&gt;",
  "<h2>この記事はいかがでしたか？</h2>",
]) {
  const out = sanitizeContentHtml(v);
  check(JSON.stringify(v), out === v, `→ ${out}`);
}

console.log("② 危ないものは落ちる（CMS の経路で使う形）");
for (const [name, html] of [
  ["script", "<p>a</p><script>alert(1)</script>"],
  ["onerror", '<p><img src="x" onerror="alert(1)"></p>'],
  ["javascript:", '<p><a href="javascript:alert(1)">a</a></p>'],
  ["style 要素", "<style>body{display:none}</style><p>a</p>"],
  ["外部の iframe", '<iframe src="https://evil.example/"></iframe>'],
] as const) {
  const out = sanitizeContentHtml(html);
  check(
    name,
    !/<script|onerror|javascript:|<style|evil\.example/i.test(out),
    `→ ${out}`,
  );
}

console.log("③ 守りを通す場所");
const pub = readFileSync(new URL("./public.ts", import.meta.url), "utf8");
const api = readFileSync(new URL("./api.ts", import.meta.url), "utf8");
check(
  "公開ページ: 記事本文は展開の前に守りを通す",
  /expandContentRefs\(\s*env,\s*\{\s*body:\s*sanitizeContentHtml\(\s*r\.body_html/.test(
    pub,
  ),
  "public.ts の記事本文の expandContentRefs に sanitizeContentHtml(r.body_html …) を渡すこと",
);
check(
  "公開ページ: 記事の data ref（JSON）も守りを通す",
  /bodyHtml:\s*sanitizeContentHtml\(\s*stripInternalIds\(\s*r\.body_html/.test(
    pub,
  ),
);
check(
  "⚠ 展開した後（wrapKuroContentWithHeadings）では掛けない（CMS の svg アイコンを消す）",
  !/const stripped\s*=\s*sanitizeContentHtml\(/.test(pub),
);
check(
  "公開の読み取り API（getSingle）",
  /bodyHtml:\s*sanitizeContentHtml\(\s*row\.body_html/.test(api),
);
check(
  "保存: normalizeBody:false（マージ後・メタだけ）でも守りは掛かる",
  /normalizeBody === false\s*\?\s*sanitizeContentHtml\(\s*args\.bodyHtml\s*\)/.test(
    api,
  ),
);

check(
  "サイト文字の保存（PUT /api/v1/content/:id/translations/:lang・MCP も同じ口）",
  /const name = sanitizeContentHtml\(\s*requireString\(body, "name"/.test(api),
);
check(
  "テンプレートを有効にしたときの既定値（Community は他人が作る）",
  /\.bind\(ck\.key, lang, sanitizeContentHtml\(ck\.defaultValue\)/.test(api),
);
{
  // 出口: fetchTemplateContent の返す前に、すべての値へ掛ける。
  const fn =
    /async function fetchTemplateContent\([\s\S]*?\n}\n/.exec(pub)?.[0] ?? "";
  check(
    "公開ページ: サイト文字の読み出し（fetchTemplateContent）で全部の値に掛ける",
    /result\[key\] = sanitizeContentHtml\(result\[key\]/.test(fn) &&
      fn.lastIndexOf("sanitizeContentHtml") < fn.lastIndexOf("return result"),
  );
}

if (failures) {
  console.error(`\n${failures} 件失敗`);
  process.exit(1);
}
console.log("\nすべて通りました");
