// 契約テスト (node で直接実行: `node src/site-preparing.test.ts`)。
// 初期化の後、テンプレートを選ぶまでは「準備中」(課題 ae0d3248)。
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { templateNotChosen } from "./site-preparing.ts";
import { preparingPage } from "./http.ts";

const raw = new DatabaseSync(":memory:");
raw.exec(`CREATE TABLE site_settings (id INTEGER PRIMARY KEY, template_id TEXT NOT NULL DEFAULT 'kuro-boo');
CREATE TABLE page_templates (id TEXT PRIMARY KEY, source_html TEXT);`);
const env = {
  DB: {
    prepare: (sql: string) => ({
      first: async () => raw.prepare(sql).get() ?? null,
    }),
  },
} as never;

assert.equal(await templateNotChosen(env), true, "設定の行が無い(初期化の前)");
raw.exec("INSERT INTO site_settings (id) VALUES (1)");
assert.equal(
  await templateNotChosen(env),
  true,
  "既定の template_id を指していても、テンプレートの行が無い",
);
raw.exec(
  "INSERT INTO page_templates (id, source_html) VALUES ('kuro-boo', NULL)",
);
assert.equal(await templateNotChosen(env), true, "原本の無いテンプレート");
raw.exec(
  "UPDATE page_templates SET source_html = '<!-- kurocms-template-api:1 --><html><body></body></html>'",
);
assert.equal(
  await templateNotChosen(env),
  false,
  "使えるテンプレートを選んだら準備中ではない",
);

const page = preparingPage(
  new Request("https://x/", { headers: { accept: "text/html" } }),
  {
    adminHref: "/kurocms/admin",
  },
);
assert.equal(page.status, 503, "壊れた頁(500)ではなく一時的な状態(503)");
assert.ok(page.headers.get("retry-after"));
assert.match(await page.text(), /準備中/);
const api = preparingPage(new Request("https://x/"), { adminHref: "/a" });
assert.equal(api.status, 503);

console.log("site preparing contract OK");
