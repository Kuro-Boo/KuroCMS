// 契約テスト (node で直接実行: `npm run test:github`)。
// 未認証 GitHub API のレート制限（IP あたり 60 req/時・Worker は Cloudflare の
// 共有 egress IP）を回避する「非 API 経路」の解釈を固定する。fixture は実物の応答。
import {
  parseStableTagFromLocation,
  parseLatestTagFromAtom,
  releaseAssetUrl,
} from "./github-release.ts";

let failed = 0;
function check(name: string, got: unknown, want: unknown): void {
  const g = String(got);
  const w = String(want);
  if (g === w) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}\n    got : ${g}\n    want: ${w}`);
  }
}

console.log("parseStableTagFromLocation");

// 実物: curl -sI https://github.com/Kuro-Boo/KuroCMS/releases/latest
check(
  "302 Location から stable のタグを取る",
  parseStableTagFromLocation(
    "https://github.com/Kuro-Boo/KuroCMS/releases/tag/v1.9.15",
  ),
  "v1.9.15",
);
check(
  "クエリ・フラグメントが付いても取れる",
  parseStableTagFromLocation(
    "https://github.com/Kuro-Boo/KuroCMS/releases/tag/v1.9.15?foo=1",
  ),
  "v1.9.15",
);
check("Location が空なら空文字", parseStableTagFromLocation(""), "");
check(
  "リリース一覧へのリダイレクト（=リリースが無い）は空文字",
  parseStableTagFromLocation("https://github.com/Kuro-Boo/KuroCMS/releases"),
  "",
);
check(
  "タグの形が違えば拾わない",
  parseStableTagFromLocation(
    "https://github.com/Kuro-Boo/KuroCMS/releases/tag/nightly",
  ),
  "",
);

console.log("parseLatestTagFromAtom");

// 実物の releases.atom の構造（先頭にフィード自身の <id> が来る点が要）
const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>tag:github.com,2008:https://github.com/Kuro-Boo/KuroCMS/releases</id>
  <title>Release notes from KuroCMS</title>
  <entry>
    <id>tag:github.com,2008:Repository/1247442300/v1.9.18</id>
    <title>KuroCMS v1.9.18</title>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/1247442300/v1.9.17</id>
    <title>KuroCMS v1.9.17</title>
  </entry>
</feed>`;

check("先頭 entry のタグを取る", parseLatestTagFromAtom(atom), "v1.9.18");
check(
  "フィード自身の id（数値 ID を持たない）に引っかからない",
  parseLatestTagFromAtom(atom),
  "v1.9.18",
);
check(
  "title の自由文には依存しない",
  parseLatestTagFromAtom(atom.replace("KuroCMS v1.9.18", "なんでもよい表示名")),
  "v1.9.18",
);
check("entry が無ければ空文字", parseLatestTagFromAtom("<feed></feed>"), "");
check("空入力は空文字", parseLatestTagFromAtom(""), "");

console.log("releaseAssetUrl");

check(
  "版固定の資産 URL を組む",
  releaseAssetUrl("Kuro-Boo/KuroCMS", "v1.9.18", "worker.js"),
  "https://github.com/Kuro-Boo/KuroCMS/releases/download/v1.9.18/worker.js",
);
check(
  "latest/download ではない（CDN の stale とチャンネル取り違えを避けるため）",
  releaseAssetUrl(
    "Kuro-Boo/KuroCMS",
    "v1.9.18",
    "migrations-manifest.json",
  ).includes("/latest/download/"),
  false,
);

if (failed) {
  console.error(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log("\nすべて OK");
