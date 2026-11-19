// 契約テスト (node で直接実行)。記事の訳の seo に表紙を残す決まり(seo-cover.ts)。
import { keepSeoCover } from "./seo-cover.ts";

let failed = 0;
function check(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.log(`  FAIL ${name}\n    got : ${g}\n    want: ${w}`);
  }
}

const STORED = JSON.stringify({
  coverMid: "img-1",
  coverPath: "/images/img-1.webp",
  ogp: { title: "old" },
});
const parse = (s: string) => JSON.parse(s);

check(
  "表紙の欄が無い seo → 保存済みの表紙を引き継ぎ、ほかの欄は送られたもの",
  parse(
    keepSeoCover(
      STORED,
      JSON.stringify({ keywords: [], ogp: { title: "new" } }),
    ),
  ),
  {
    keywords: [],
    ogp: { title: "new" },
    coverMid: "img-1",
    coverPath: "/images/img-1.webp",
  },
);
check(
  "空の表紙を明示 → 外す",
  parse(keepSeoCover(STORED, JSON.stringify({ coverMid: "", coverPath: "" }))),
  { coverMid: "", coverPath: "" },
);
check(
  "新しい表紙 → 置き換える",
  parse(
    keepSeoCover(
      STORED,
      JSON.stringify({ coverMid: "img-2", coverPath: "/images/img-2.jpg" }),
    ),
  ),
  { coverMid: "img-2", coverPath: "/images/img-2.jpg" },
);
check("{} → 表紙だけ残る", parse(keepSeoCover(STORED, "{}")), {
  coverMid: "img-1",
  coverPath: "/images/img-1.webp",
});
check(
  "保存済みに表紙が無い → そのまま",
  keepSeoCover('{"ogp":{}}', '{"keywords":[]}'),
  '{"keywords":[]}',
);
check(
  "保存済みが無い(新しい訳) → そのまま",
  keepSeoCover(null, '{"keywords":[]}'),
  '{"keywords":[]}',
);
check("オブジェクトでない seo → そのまま", keepSeoCover(STORED, '"x"'), '"x"');

if (failed) {
  console.error(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log("\nすべて OK");
