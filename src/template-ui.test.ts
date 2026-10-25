// 当社の組み込み部品(template-ui.ts)と、Community で JS を外す網(template-sanitize.ts)の試験(cms-cms-template 9.11)。
// 確かめるのは —— 一覧(説明の正本)のどの例も展開される、形の違う名前は展開しない、Community の網は
// 他人の JS を外し、当社の部品の script はサイト文字へ戻す、URL の書き換えで危ない頭を見抜く。
import { expandTemplateParts, TEMPLATE_PARTS } from "./template-ui.ts";
import { stripTemplateJs } from "./template-sanitize.ts";

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

console.log("template-ui");
for (const p of TEMPLATE_PARTS) {
  const out = expandTemplateParts(p.example);
  eq(
    `一覧の例が展開される: ${p.code}`,
    out !== p.example &&
      !/\[\[(toggle|panel|tab|tabitem|linkfrom|counts|tailwind)\b/.test(out),
    true,
  );
}
eq(
  "開け閉め",
  expandTemplateParts("<button [[toggle:nav]]>"),
  '<button data-kuro-toggle="nav" aria-expanded="false">',
);
eq(
  "タブ(値は属性で渡す)",
  expandTemplateParts('<button [[tab:works]] data-tab-value="[[slug]]">'),
  '<button data-kuro-tab="works" data-tab-value="[[slug]]">',
);
eq(
  "形の違う名前は展開しない",
  expandTemplateParts('<b [[toggle:Nav"x]]>'),
  '<b [[toggle:Nav"x]]>',
);
eq(
  "[[counts]] は前の書き方に戻す",
  expandTemplateParts("[[counts]]"),
  '<script src="[[site.basePath]]/_counts.js"></script>',
);
eq(
  "[[tailwind]]",
  expandTemplateParts("[[tailwind]]"),
  '<script src="https://cdn.tailwindcss.com"></script>',
);

console.log("template-sanitize");
{
  const r = stripTemplateJs(
    '<head><script src="https://cdn.tailwindcss.com?plugins=typography,forms"></script><script src="[[site.basePath]]/_counts.js"></script><script>alert(1)</script><script src="https://evil.example/x.js"></script></head>',
  );
  eq(
    "当社の script はサイト文字へ、他は外す",
    r.html,
    "<head>[[tailwind:typography,forms]][[counts]]</head>",
  );
  eq("外したものを返す", r.removed.length, 2);
}
eq(
  "版付きの Tailwind も戻す",
  stripTemplateJs('<script src="https://cdn.tailwindcss.com/3.4.16"></script>')
    .html,
  "[[tailwind]]",
);
eq(
  "イベント属性と srcdoc を外す",
  stripTemplateJs(
    `<button class="a" onclick="x()" ONLOAD='y'>b</button><iframe srcdoc="<script>1</script>"></iframe>`,
  ).html,
  '<button class="a">b</button><iframe></iframe>',
);
eq(
  "javascript: の URL は # に(文字参照・空白を挟んでも)",
  stripTemplateJs(
    '<a href="jav&#x61;script:alert(1)">x</a><a href=" java\nscript:1">y</a><a href="https://ok.example/">z</a>',
  ).html,
  '<a href="#">x</a><a href="#">y</a><a href="https://ok.example/">z</a>',
);
eq(
  "閉じていない script も外す",
  stripTemplateJs("<div><script>evil").html,
  "<div>evil",
);
eq(
  "部品のサイト文字と data 属性はそのまま",
  stripTemplateJs('<button [[toggle:nav]] data-tab-values="a">').html,
  '<button [[toggle:nav]] data-tab-values="a">',
);

if (failed) {
  console.log(`\n${failed} 件 失敗`);
  process.exit(1);
}
console.log("\ntemplate-ui: すべて OK");
