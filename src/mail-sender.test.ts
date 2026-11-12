// 契約テスト (node で直接実行: `node src/mail-sender.test.ts`)。
// メールの差出人は「サイト名(KuroCMS)」、末尾に KuroCMS が代わって送っている 1 行を付ける。
// サインインの画面からのメールは、パスキーの有無で「登録」と「新しいデバイスの登録」を分ける(2026-11-12)。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// api.ts は拡張子の無い import で書かれているので、esbuild で 1 つに束ねてから読む(setup-gate.test.ts と同じ)。
const out = join(
  mkdtempSync(join(tmpdir(), "kurocms-mail-sender-")),
  "api.mjs",
);
await build({
  entryPoints: [new URL("./api.ts", import.meta.url).pathname],
  bundle: true,
  format: "esm",
  platform: "neutral",
  external: ["cloudflare:workers"],
  outfile: out,
  logLevel: "warning",
});
const { deviceLinkMail, mailFooter, mailSenderName } = (await import(
  pathToFileURL(out).href
)) as typeof import("./api.ts");

// 差出人: 日本語のサイトは全角のかっこで詰め、それ以外は半角と空白。KuroCMS 自身は重ねない。
assert.equal(
  mailSenderName("サンプルサイト", true),
  "サンプルサイト（KuroCMS）",
);
assert.equal(mailSenderName("Sample Site", false), "Sample Site (KuroCMS)");
assert.equal(mailSenderName("KuroCMS", true), "KuroCMS");

// 末尾の 1 行: 言語ごとに出し分け、言語の無いメールは両方。
const ja = mailFooter("サンプルサイト", "ja");
assert.match(
  ja.text,
  /サンプルサイト が使っている KuroCMS（kuro\.boo）の管理システムが/,
);
assert.doesNotMatch(ja.text, /on behalf of/);
const both = mailFooter("Sample <b>", "both");
assert.match(both.text, /KuroCMS（kuro\.boo）/);
assert.match(both.text, /on behalf of Sample <b>/);
assert.match(both.html, /Sample &lt;b&gt;/); // HTML では名前を逃がす
assert.doesNotMatch(both.html, /Sample <b>/);

// サインインの画面からのメール: 「再設定」とは書かず、理由と URL の文字を載せる。
const link = "https://example.invalid/kurocms/admin/?recover=abc&x=1";
const first = deviceLinkMail("サンプルサイト", link, "ja", false);
assert.equal(first.subject, "[サンプルサイト] パスキーの登録のご案内");
assert.match(first.text, /「新しくデバイスを登録する場合」から/);
assert.ok(first.text.includes(link));
assert.ok(first.html.includes("recover=abc&amp;x=1")); // URL の文字も載せる
assert.doesNotMatch(first.subject + first.text, /再設定/);

const more = deviceLinkMail("サンプルサイト", link, "ja", true);
assert.equal(more.subject, "[サンプルサイト] 新しいデバイスの登録のご案内");
assert.match(more.text, /いまお使いのパスキーはそのまま使えます/);

const en = deviceLinkMail("Sample Site", link, "en", false);
assert.equal(en.subject, "[Sample Site] Register your passkey");
assert.match(en.text, /“Register a new device” on the sign-in screen/);
assert.equal(
  deviceLinkMail("Sample Site", link, "en", true).subject,
  "[Sample Site] Register a new device",
);

console.log("mail-sender: ok");
