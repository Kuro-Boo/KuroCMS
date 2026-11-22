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
    new RegExp("^/_reactions/[a-zA-Z0-9_-]+$").test(publicPath) ||
    // 問い合わせフォームの口と、送り先の確認のリンクの先(cms-contact)
    new RegExp("^/_contact/(challenge|send|verify)$").test(publicPath)
  );
}

/**
 * 人が開くことの無い、探りの形の道(`.php`・WordPress の道・`/.env` などの隠しファイル)。登録した頁だけを配るサイトは、
 * これに 20 秒待ってから 404 を返す(旗 static-404・cms-cms-build「登録した頁だけを配る」・2026-11-16 利用者
 * 「時間をかせげます」)。1 本ずつ順に叩く探りの道具は、待った分だけ叩ける数が減る。タイムアウト(5xx)にはしない ——
 * 障害と読まれて取り直しが増える。`/.well-known/` は正規の置き場なので外す。委託運用では同じ形を WAF が前で断る。
 */
export function probePath(path: string): boolean {
  const p = path.toLowerCase();
  if (p.endsWith(".php")) return true;
  if (
    ["/wp-admin", "/wp-login", "/wp-content", "/wp-includes", "/xmlrpc"].some(
      (x) => p.includes(x),
    )
  )
    return true;
  return p.includes("/.") && !p.startsWith("/.well-known/");
}

/** 探りの形の道に待たせる長さ。 */
export const PROBE_HOLD_MS = 20_000;

/**
 * 資産の配り方(旗 static-404)。登録に無い道は Worker を呼ばずに `/404.html` で返す。
 *
 * ⚠ Cloudflare は `not_found_handling: "404-page"` のとき、画面の遷移だけでなく**画像の読み込みなども**
 * Worker を呼ばずに 404 の頁で返す(2026-11-16 に harmo-life で画像が全部切れた)。だから Worker が答える道は
 * **すべて** `run_worker_first` に載せる: 管理画面と API(`reserved`)・初期設定・CDN に置けないメディア(`/_media/`
 * —— R2 から Worker が返す・media-cdn.ts)・反応・CSP の報告・リンクカード・favicon。公開の基点があれば、基点の下にも。
 * 公開のメディア(`/images/` など)は CDN の資産なので載せない(載せると資産より先に Worker が動く)。
 */
export function assetRouting(
  reserved: string[],
  publicBase = "",
): {
  not_found_handling: "404-page";
  run_worker_first: string[];
} {
  const first = new Set<string>(["/initialize", "/initialize/*"]);
  for (const r of reserved) {
    first.add(r);
    first.add(`${r}/*`);
  }
  for (const b of publicBase ? ["", publicBase] : [""]) {
    // メディアは CDN の資産(media-cdn.ts)。置けない大きいファイル・SVG だけが /_media/ を指す。
    for (const m of ["_media", "_reactions", "_contact"])
      first.add(`${b}/${m}/*`);
    for (const f of ["/_csp", "/_unfurl", "/favicon.ico", "/favicon.svg"])
      first.add(`${b}${f}`);
  }
  return { not_found_handling: "404-page", run_worker_first: [...first] };
}
