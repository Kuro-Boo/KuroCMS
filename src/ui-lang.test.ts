// 契約テスト (node で直接実行)。管理画面の辞書と言語(cms-cms-i18n「管理画面と公開の部品の言語」・旗 cms-i18n)。
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { ADMIN_UI_LANGS, normalizeUiLang } from "./ui-lang.ts";

const dir = new URL("./admin/locales/", import.meta.url);
const load = (lang: string): Record<string, string> => {
  const src = readFileSync(new URL(lang + ".ts", dir), "utf8");
  const name = "LOCALE_" + lang.toUpperCase();
  assert.ok(
    src.includes("const " + name + ": Record<string, string> = {"),
    lang + ".ts は " + name + " を 1 つ置く",
  );
  return new Function(
    src.replace(": Record<string, string>", "") + "\nreturn " + name + ";",
  )();
};

// 辞書のファイルとサーバーの並びが揃っている(足し忘れると、その言語を保存できない・選べない)
{
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.slice(0, -3))
    .sort();
  assert.deepEqual(files, [...ADMIN_UI_LANGS].sort());
  const build = readFileSync(
    new URL("../scripts/build-admin.js", import.meta.url),
    "utf8",
  );
  for (const lang of ADMIN_UI_LANGS)
    assert.ok(
      build.includes(`"src/admin/locales/${lang}.ts"`),
      lang + " の辞書を管理画面に焼く",
    );
  const main = readFileSync(
    new URL("./admin.main.ts", import.meta.url),
    "utf8",
  );
  for (const lang of ADMIN_UI_LANGS)
    assert.ok(
      main.includes(`  ${lang}: LOCALE_${lang.toUpperCase()},`),
      lang + " を i18n に載せる",
    );
}

// 鍵は正本(ja)と同じ —— 抜け・余りが無い。差し込み({n} など)も同じ
{
  const ja = load("ja");
  const holes = (s: string) => (s.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  assert.ok(Object.keys(ja).length > 1000);
  for (const lang of ADMIN_UI_LANGS) {
    if (lang === "ja") continue;
    const d = load(lang);
    const missing = Object.keys(ja).filter((k) => !(k in d));
    const extra = Object.keys(d).filter((k) => !(k in ja));
    assert.deepEqual(missing, [], lang + " に無い鍵");
    assert.deepEqual(extra, [], lang + " にだけある鍵");
    const mismatch = Object.keys(ja).filter(
      (k) => holes(ja[k]).join() !== holes(d[k]).join(),
    );
    assert.deepEqual(mismatch, [], lang + " の差し込みが ja と違う");
  }
}

// 英語の画面に日本語を残さない(かな・漢字)。字形の見本のように、わざと書く値だけを外す
{
  const en = load("en");
  // fontPreviewText: 字形の見本(日本語の字を見せるための値)
  const allowed = new Set(["fontPreviewText"]);
  const left = Object.entries(en)
    .filter(([k, v]) => !allowed.has(k) && /[぀-ヿ一-鿿]/.test(v))
    .map(([k]) => k);
  assert.deepEqual(left, [], "en に日本語が残っている");
}

// 保存できるのは辞書のある言語だけ
assert.equal(normalizeUiLang("JA "), "ja");
assert.equal(normalizeUiLang("en"), "en");
assert.equal(normalizeUiLang("xx"), null);
assert.equal(normalizeUiLang(null), null);

// 保存の口はサーバーで旗を見る。セッションは保存した言語を返す。列は migration で足す
{
  const api = readFileSync(new URL("./api.ts", import.meta.url), "utf8");
  const put = api.slice(api.indexOf('path === "/api/me/ui-lang"'));
  assert.ok(put.slice(0, 300).includes('cmsFlagOn("cms-i18n"'));
  assert.ok(api.includes("uiLang: normalizeUiLang(row.ui_lang)"));
  const mig = readFileSync(
    new URL("../migrations/0096_user_ui_lang.sql", import.meta.url),
    "utf8",
  );
  assert.ok(mig.includes("ALTER TABLE users ADD COLUMN ui_lang TEXT"));
}

console.log("ui-lang: ok");
