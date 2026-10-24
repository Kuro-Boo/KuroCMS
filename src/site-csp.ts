/**
 * 公開サイトの CSP(cms-cms-security「CSP」・core-csp)。
 *
 * 公開ページは番人が静的資産として返し、Worker を通らない。Worker が返す時も組み上がった
 * 同じ HTML を使い回す。だから応答ごとの nonce は作れず、**固定の CSP** にする:
 *
 * - CMS の部品のスクリプトは外部の JS(`kuro-head` / `kuro-site`)に置き、ページに書かない
 * - テンプレートの作者のスクリプトは CMS がサイトのファイル(`/_tjs/`)へ移す(template-scripts.ts)
 * - だから script-src は `'self'` と、設定から組み立てた出どころだけ。`'unsafe-inline'` は入れない
 *
 * 同じ組み立てを 2 か所が使う: 静的資産の `_headers`(番人が版に入れる)と、Worker が返す応答。
 *
 * ⚠ ここは cloudflare:workers を読まない(node で直接試験する)。
 */
import { cspHeaders } from "./vendor/entamy-client/index.ts";

/**
 * 報告だけ(試験の段階)か、強制か。**版の違いとして配る**(core-csp §6): 顧客の CF に強制が
 * 入るのは、委託運用で漏れが無いことを確かめた版を顧客が上げた時だけ。
 */
export const SITE_CSP_MODE: "report" | "enforce" = "report";

/** 報告を受けるサイト自身の口(`{publicBase}/_csp`)。 */
export const CSP_REPORT_PATH = "/_csp";

/** CSP を組み立てるのに要る設定。 */
export interface SiteCspInput {
  /** 公開の基点(`site_settings.base_path`)。報告の口の前に付く。 */
  publicBase: string;
  /** GA4 の測定 ID があるか。 */
  ga: boolean;
  /** サイト文字 `ad-adsense` があるか。 */
  adsense: boolean;
  /** Bluesky の投稿を出すか。 */
  bluesky: boolean;
}

// GA4(Google の「Content Security Policy での Google タグ」の一覧)。
const GA_SCRIPT = ["https://*.googletagmanager.com"];
const GA_CONNECT = [
  "https://*.google-analytics.com",
  "https://*.analytics.google.com",
  "https://*.googletagmanager.com",
];
// AdSense。広告は配信のたびに読む先が変わるので、Google の広告の出どころをまとめて許す。
// 漏れは報告だけの期間に Defects へ上がる(core-csp §4)。
const ADSENSE_SCRIPT = [
  "https://pagead2.googlesyndication.com",
  "https://*.googlesyndication.com",
  "https://*.googleadservices.com",
  "https://adservice.google.com",
  "https://fundingchoicesmessages.google.com",
  "https://*.adtrafficquality.google",
];
const ADSENSE_FRAME = [
  "https://*.googlesyndication.com",
  "https://*.doubleclick.net",
  "https://www.google.com",
  "https://*.adtrafficquality.google",
];
const ADSENSE_CONNECT = [
  "https://*.googlesyndication.com",
  "https://*.doubleclick.net",
  "https://*.google.com",
  "https://*.adtrafficquality.google",
];
// 本文の埋め込み。R0(KuroEditor の isAllowedEmbedSrc)が残す行き先と同じ。
const EMBED_FRAME = [
  "https://www.youtube.com",
  "https://youtube.com",
  "https://www.youtube-nocookie.com",
  "https://player.vimeo.com",
  "https://www.google.com",
  "https://maps.google.com",
];
const BLUESKY_CONNECT = ["https://public.api.bsky.app"];
// Google Fonts。CMS のフォント設定は Google の配信から直接読む(fonts.ts の buildFontHead)。
// テンプレートが直接読むこともある。スタイルと書体はスクリプトを動かさないので、いつも許す。
const FONTS_STYLE = ["https://fonts.googleapis.com"];
const FONTS_FILE = ["https://fonts.gstatic.com"];

/** 応答に付ける見出し(CSP と報告先)。 */
export function siteCspHeaders(input: SiteCspInput): Record<string, string> {
  const base = (input.publicBase || "").replace(/\/+$/, "");
  return cspHeaders({
    mode: SITE_CSP_MODE,
    productId: "cms",
    reportUri: `${base}${CSP_REPORT_PATH}`,
    scriptSrc: [
      ...(input.ga ? GA_SCRIPT : []),
      ...(input.adsense ? ADSENSE_SCRIPT : []),
    ],
    connectSrc: [
      ...(input.ga ? GA_CONNECT : []),
      ...(input.adsense ? ADSENSE_CONNECT : []),
      ...(input.bluesky ? BLUESKY_CONNECT : []),
    ],
    styleSrc: FONTS_STYLE,
    fontSrc: FONTS_FILE,
    // 取り込んだ記事は外の画像を持つ。画像はスクリプトを動かさない。
    imgSrc: ["https:"],
    frameSrc: [...EMBED_FRAME, ...(input.adsense ? ADSENSE_FRAME : [])],
    // 管理画面のプレビューは同じ出どころの枠で開く。
    frameAncestors: ["'self'"],
  });
}

/**
 * 静的資産の `_headers` の中身(番人が版の `assets.config._headers` に入れる)。
 * `_headers` は静的資産の応答にだけ効く(Worker の応答には付かない)ので、`/*` の 1 規則で足りる。
 */
export function siteHeadersFile(headers: Record<string, string>): string {
  const lines = Object.entries(headers).map(
    ([name, value]) => `  ${name}: ${value}`,
  );
  return `/*\n${lines.join("\n")}\n`;
}
