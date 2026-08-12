// 契約テスト (node で直接実行: `npm run test:staticpages`)。
// 固定ページ宣言の任意キー（summaryKey / coverKey）と後方互換を固定する。
// ⚠ これが無かった頃、テンプレートは about のキーを直書きしており、
//    recruit のような別 slug の固定ページに About の要約と表紙が出ていた。
import { parseStaticPages } from "./templates/static-pages.ts";
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
const decl = (j: string) =>
  `<!-- kurocms-template-api:1 --><!-- kurocms-pages: ${j} -->`;
const p1 = parseStaticPages(
  decl('[{"slug":"about","titleKey":"about-title","bodyKey":"about-body"}]'),
)[0];
eq(
  "summaryKey/coverKey 省略時は undefined",
  [p1.summaryKey, p1.coverKey],
  [undefined, undefined],
);
const p2 = parseStaticPages(
  decl(
    '[{"slug":"about","titleKey":"about-title","bodyKey":"about-body","summaryKey":"about-summary","coverKey":"about-cover"}]',
  ),
)[0];
eq(
  "指定すれば入る",
  [p2.summaryKey, p2.coverKey],
  ["about-summary", "about-cover"],
);
const p3 = parseStaticPages(
  decl(
    '[{"slug":"about","titleKey":"about-title","bodyKey":"about-body","summaryKey":""}]',
  ),
)[0];
eq("空文字は未指定扱い", p3.summaryKey, undefined);
try {
  parseStaticPages(
    decl(
      '[{"slug":"about","titleKey":"t","bodyKey":"b","coverKey":"BAD KEY"}]',
    ),
  );
  f++;
  console.log("  FAIL 不正キーで例外が出ない");
} catch {
  console.log("  ok   不正なキー名は例外");
}
eq(
  "既存宣言は壊れない（後方互換）",
  parseStaticPages(
    decl(
      '[{"slug":"about","titleKey":"t","bodyKey":"b","nav":false,"redirectFrom":["/x/"]}]',
    ),
  )[0].redirectFrom,
  ["/x/"],
);
if (f) {
  console.error(`\n${f} 件失敗`);
  process.exit(1);
}
console.log("\nすべて OK");
