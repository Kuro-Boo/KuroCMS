// [[...]] の URL を公開ページの属性へ入れる前に確かめる(2026-10-11)。
// 判定は KuroEditor の isSafeUrl(エディタと同じ1つ)。javascript: などの押すと動く URL は
// 空にし、" は文字参照にする。公開ページ(public.ts)が [[...]] の URL を出す箇所は
// すべて urlAttr を通すことも、ここで見張る。
import { readFileSync } from "node:fs";
import { urlAttr } from "./link-attr.ts";

let failed = 0;
const check = (name: string, ok: boolean, got: unknown) => {
  if (ok) return console.log("✓", name);
  failed++;
  console.error("✗", name, "\n  got:", got);
};

check(
  "javascript: は空にする",
  urlAttr("javascript:alert(1)") === "",
  urlAttr("javascript:alert(1)"),
);
check(
  "文字参照で隠した javascript: も空にする",
  urlAttr("&#106;avascript:alert(1)") === "",
  urlAttr("&#106;avascript:alert(1)"),
);
check(
  '" は文字参照にする',
  urlAttr('https://x/" onmouseover="a') ===
    "https://x/&quot; onmouseover=&quot;a",
  urlAttr('https://x/" onmouseover="a'),
);
check(
  "普通の URL はそのまま(& は文字参照)",
  urlAttr("https://x/?a=1&b=2") === "https://x/?a=1&amp;b=2",
  urlAttr("https://x/?a=1&b=2"),
);
check(
  "src に data:image は通す",
  urlAttr("data:image/png;base64,AA", "src") === "data:image/png;base64,AA",
  "",
);

const src = readFileSync(new URL("./public.ts", import.meta.url), "utf8");
const body = src.slice(
  src.indexOf("function expandSpecialLinks("),
  src.indexOf("function expandSpecialLinks(") + 4000,
);
for (const pat of [
  'href="${escHtml(d.url)}"',
  'href="${escHtml(link)}"',
  'href="${escHtml(href)}" ',
  'src="${escHtml(embedUrl)}"',
]) {
  check(`公開ページが ${pat} を使っていない`, !src.includes(pat), pat);
}
check(
  "[[...]] の展開が urlAttr を通す",
  body.includes('href="${urlAttr(d.url)}"'),
  "",
);
check(
  "メディアの飛び先も urlAttr を通す",
  src.includes('href="${urlAttr(link)}"'),
  "",
);

if (failed) process.exit(1);
