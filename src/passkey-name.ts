/**
 * 管理画面のパスキーに付けるサービス名(cms-cms-auth「パスキーの名前」・2026-10-29)。
 *
 * 持ち主は、契約の手続きに使う Entamy ID のパスキー(「Entamy ID(KuroCMS 契約)」)と、管理画面の
 * パスキーの 2 つを持つ。どちらも「KuroCMS」だと、パスワード管理の一覧と OS の窓に同じ名前が
 * 2 つ並び、同じものを 2 回作らされたように見える。サイト名を入れ、サイトを 2 つ持つ人にも
 * どちらのサイトのものかが分かるようにする。
 *
 * ⚠ ここは cloudflare:workers を読まない(node で直接試験する)。
 */

/** サイト名が未設定(空・既定の「KuroCMS」)なら「KuroCMS 管理者」だけ。 */
export function adminPasskeyRpName(
  siteName: string | null | undefined,
): string {
  const name = (siteName ?? "").trim();
  return name && name !== "KuroCMS"
    ? `KuroCMS 管理者（${name}）`
    : "KuroCMS 管理者";
}
