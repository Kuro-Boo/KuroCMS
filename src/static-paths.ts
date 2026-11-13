import { CSP_REPORT_PATH } from "./site-csp.ts";

/**
 * 登録した頁だけを配るサイトで、公開の側でも Worker が答える口(cms-cms-build「登録した頁だけを配る」)。
 * CSP の報告・リンクカード(署名つきの URL だけ・KV の控え)・反応・favicon(設定の画像へ送る)。
 */
export function staticDynamicPath(publicPath: string): boolean {
  return (
    publicPath === CSP_REPORT_PATH ||
    publicPath === "/_unfurl" ||
    publicPath === "/favicon.ico" ||
    publicPath === "/favicon.svg" ||
    new RegExp("^/_reactions/[a-zA-Z0-9_-]+$").test(publicPath)
  );
}
