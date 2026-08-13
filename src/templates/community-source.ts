// Community テンプレートの「HTML 原本をどこから得るか」を決める層。
//
// ── なぜ要るか ──────────────────────────────────────────────────
// 取り込み (POST /api/v1/templates) は sourceUrl を worker 内 fetch() で
// 取りに行く。ところが【CMS 自身が Community と同じゾーンに載っている】場合、
// 自ゾーン宛のサブリクエストがオリジンへ回されて 522 になり、取り込めない。
// 2026-08 の kuro.boo 本番移行で顕在化した — kuro.boo が CMS worker の
// Custom Domain になり、kuro.boo/kurocms/* (Community) はもちろん自分自身の
// /about/ すら worker からは到達不可になった（外部 curl は 200）。
//
// ⚠ これは kuro.boo のような【同一ゾーン運用】に固有の問題で、他ユーザーの
//   インスタンスは別ゾーンにあるため素の fetch で普通に通る。したがって
//   既存経路は一切変えず、同一ゾーンのときだけ「ブラウザが取得した HTML を
//   受け取る」逃げ道を開ける。Community API は Access-Control-Allow-Origin: *
//   を返すので、管理画面から直接取得できる（PAT 不要の公開 GET）。
//
// Service Binding (env.COMMUNITY_API) でも回避できるが、それは
// kurocms-promotion と同一アカウントでしか張れない＝当方専用の運用設定で、
// 配布コードの一般解にはならない。

/** テンプレート HTML の上限。fetch 経路・inline 経路で共通。 */
export const TEMPLATE_SOURCE_MAX_BYTES = 2_000_000;

/**
 * CMS 自身が Community API と同じゾーンに載っているか。
 *
 * 判定はホスト名の一致か、その直下のサブドメインか。kuro.boo 本番は管理画面が
 * `kurocms.kuro.boo`、公開サイトが `kuro.boo` で、どちらも kuro.boo ゾーン。
 * ⚠ `evilkuro.boo` のような接尾辞一致を通さないよう、ドット付きで比較する。
 */
export function isSameZoneAsCommunity(
  requestUrl: string,
  communityBaseUrl: string,
): boolean {
  let host: string;
  let communityHost: string;
  try {
    host = new URL(requestUrl).hostname.toLowerCase();
    communityHost = new URL(communityBaseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host || !communityHost) return false;
  return host === communityHost || host.endsWith(`.${communityHost}`);
}

/**
 * 取り込む HTML の妥当性。⚠ fetch 経路と inline 経路で【同じ関数】を通すこと。
 * 別々に書くと、片方だけ緩いという事故になる。
 */
export function isAcceptableTemplateSource(
  html: string,
  isTemplate: (html: string) => boolean,
): boolean {
  return !!html && html.length <= TEMPLATE_SOURCE_MAX_BYTES && isTemplate(html);
}

export interface TemplateSourceInput {
  /** body.sourceUrl（従来どおり。空なら「ソース無しで登録」） */
  sourceUrl: string;
  /** body.sourceHtml（同一ゾーンのときだけ意味を持つ） */
  sourceHtml: string;
  /** isSameZoneAsCommunity() の結果 */
  sameZone: boolean;
}

export type TemplateSourceOrigin = "inline" | "fetch" | "none";

/**
 * どの経路で HTML を得るかだけを決める純関数（fetch はしない）。
 *
 * ⚠ 既存挙動の保護がこの関数の主目的。sameZone が false のときは sourceHtml が
 *   何であろうと必ず fetch 経路へ倒す — 他ユーザーの取り込みが、クライアントの
 *   バージョン差で別経路に化けることが無いようにする。
 */
export function chooseTemplateSourceOrigin(
  input: TemplateSourceInput,
): TemplateSourceOrigin {
  if (input.sameZone && input.sourceHtml) return "inline";
  if (input.sourceUrl) return "fetch";
  return "none";
}
