/**
 * 管理画面の言語(仕様 cms-cms-i18n「管理画面と公開の部品の言語」・旗 cms-i18n)。
 *
 * 管理画面の辞書は src/admin/locales/<lang>.ts にある(画面の側は import できないので、ここに同じ並びを持つ)。
 * ⚠ 辞書のファイルを足したら、ここにも足す(ui-lang.test.ts が食い違いを落とす)。
 */
export const ADMIN_UI_LANGS = ["ja", "en"] as const;
export type AdminUiLang = (typeof ADMIN_UI_LANGS)[number];

/** 利用者が選んだ言語を確かめる。辞書の無い言語は null(保存しない)。 */
export function normalizeUiLang(value: unknown): AdminUiLang | null {
  if (typeof value !== "string") return null;
  const lang = value.trim().toLowerCase();
  return (ADMIN_UI_LANGS as readonly string[]).includes(lang)
    ? (lang as AdminUiLang)
    : null;
}
