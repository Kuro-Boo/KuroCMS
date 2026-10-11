// Contract test: 利用者のプライバシーポリシーの [[entamy.subprocessors]] は、同梱した Entamy の委託先の表になる
// (基盤の仕様 admin §10.2.11)。未公開なら準備中と出し、名前は文字として出し、https 以外の URL は繋がない。
import {
  expandEntamySubprocessors,
  renderEntamySubprocessors,
} from "./entamy-subprocessors.ts";

let failed = 0;
const check = (name: string, ok: boolean) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failed++;
};

const unpublished = {
  status: "unpublished" as const,
  updated_at: null,
  items: [],
};
const published = {
  status: "published" as const,
  updated_at: "2026-10-11T00:00:00Z",
  items: [
    {
      name: "Cloudflare, Inc.",
      purpose: "基盤の実行",
      data: "業務データ",
      location: "米国",
      url: "https://www.cloudflare.com/privacypolicy/",
    },
    {
      name: "<b>x</b>",
      purpose: "p",
      data: "d",
      location: "l",
      url: "javascript:alert(1)",
    },
  ],
};

check(
  "未公開なら準備中と出す",
  renderEntamySubprocessors("ja", unpublished).includes("準備中"),
);
const table = renderEntamySubprocessors("ja", published);
check(
  "https の委託先は名前がリンクになる",
  table.includes(
    '<a href="https://www.cloudflare.com/privacypolicy/" rel="noopener noreferrer">Cloudflare, Inc.</a>',
  ),
);
check("名前は文字として出す", table.includes("&lt;b&gt;x&lt;/b&gt;"));
check("https 以外の URL は繋がない", !table.includes("javascript:"));
const html = expandEntamySubprocessors(
  "<p>前文</p><p>[[entamy.subprocessors]]</p>",
  "ja",
  published,
);
check(
  "段落に1つだけの記号は段落ごと表にする(<p> の中に表を入れない)",
  html === "<p>前文</p>" + table,
);
check(
  "記号が無ければそのまま",
  expandEntamySubprocessors("<p>本文</p>", "ja", published) === "<p>本文</p>",
);
check(
  "英語のサイトは英語の見出し",
  renderEntamySubprocessors("en", published).includes("<th>Subprocessor</th>"),
);

if (failed) {
  console.error(`${failed} 件失敗`);
  process.exit(1);
}
