// 契約テスト (node で直接実行)。サーバーが送るメールの文(mail-text.ts・cms-cms-i18n「管理画面と公開の部品の言語」)。
import assert from "node:assert/strict";
import { MAIL_TEXT, mailText, recipientLang } from "./mail-text.ts";
import { ADMIN_UI_LANGS } from "./ui-lang.ts";
import type { Env } from "./types.ts";

// 全言語が同じ鍵と同じ差し込みを持つ
{
  const names = (s: string) =>
    [...s.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1]).sort();
  const keys = Object.keys(MAIL_TEXT.ja).sort();
  for (const lang of ADMIN_UI_LANGS) {
    assert.deepEqual(Object.keys(MAIL_TEXT[lang]).sort(), keys, lang + " の鍵");
    for (const k of keys)
      assert.deepEqual(
        names(MAIL_TEXT[lang][k]!),
        names(MAIL_TEXT.ja[k]!),
        `${lang}.${k} の差し込み`,
      );
  }
  assert.ok(
    !/[぀-ヿ一-鿿]/.test(Object.values(MAIL_TEXT.en).join("")),
    "英語の表に日本語を残さない",
  );
  assert.equal(
    mailText("en", "networkAddedSubject", { site: "S" }),
    "[S] New network registered",
  );
}

// 言語の決め方: 宛先の利用者の言語 → 画面から届いた言語 → サイトの基本言語 → 英語
{
  const env = (uiLang: string | null, siteLang: string | null) =>
    ({
      DB: {
        prepare: (sql: string) => ({
          bind: () => ({
            first: async () =>
              /FROM users/.test(sql) ? { ui_lang: uiLang } : null,
          }),
          first: async () =>
            /site_settings/.test(sql) ? { default_lang: siteLang } : null,
        }),
      },
    }) as unknown as Env;
  assert.equal(
    await recipientLang(env("ja", "en"), "a@example.com", "en"),
    "ja",
  );
  assert.equal(
    await recipientLang(env(null, "en"), "a@example.com", "ja"),
    "ja",
  );
  assert.equal(await recipientLang(env(null, "ja"), "a@example.com"), "ja");
  assert.equal(
    await recipientLang(env("xx", "fr"), "a@example.com", "de"),
    "en",
  );
  // 読めなくても投げない
  assert.equal(
    await recipientLang(
      {
        DB: {
          prepare: () => {
            throw new Error("down");
          },
        },
      } as unknown as Env,
      "a@example.com",
    ),
    "en",
  );
}

console.log("mail-text: ok");
