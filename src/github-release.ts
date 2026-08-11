// GitHub の「API ではない」エンドポイントからリリースタグを読み取る純関数。
//
// なぜ API を使わない経路が必要か: 未認証の GitHub API 上限は【IP あたり 60 req/時】
// で、Worker の送信元は Cloudflare の共有 egress IP。自分が 1 回も叩いていなくても
// 相乗りしている他テナントの分で枯れ、403 rate limit exceeded が返る（新規
// インストールで頻発 — KV キャッシュが空なので初回から素通しで当たる）。
//
// 代わりに使う経路（いずれも実測でレート制限の対象外）:
//   stable … GET /{repo}/releases/latest の 302 Location
//            → https://github.com/{repo}/releases/tag/v1.9.15
//            API の /releases/latest と同じ意味（prerelease/draft を除いた最新）
//   latest … GET /{repo}/releases.atom の先頭 entry（prerelease も含む＝rolling）
//
// 通信は呼び手（api.ts）が持ち、ここには**文字列の解釈だけ**を置く。壊れやすいのは
// 解釈側なので、契約テスト（github-release.test.ts）で実物の応答を固定する。

/** リリースタグの形（KuroCMS のリリースは必ず vX.Y.Z）。 */
export const RELEASE_TAG_RE = /^v\d+\.\d+\.\d+$/;

/**
 * `/releases/latest` の 302 Location から stable のタグを取り出す。
 * 取れない/形が違うときは "" を返す（呼び手がエラーにする）。
 */
export function parseStableTagFromLocation(location: string): string {
  const tag = String(location || "").split("/releases/tag/")[1] || "";
  // Location にクエリやフラグメントが付いても拾えるように切る
  const clean = tag.split(/[?#]/)[0].trim();
  return RELEASE_TAG_RE.test(clean) ? clean : "";
}

/**
 * `releases.atom` の先頭 entry から rolling（prerelease 含む）のタグを取り出す。
 *
 * ⚠ `<title>` は自由文（例 "KuroCMS v1.9.18"）なので使わない。
 *   `<id>tag:github.com,2008:Repository/{repoId}/{tag}</id>` の id 側から拾う。
 *   フィード自身の id（…:Repository ではなく …/releases）は数値 ID を持たないので
 *   このパターンには一致しない＝先頭 entry が最初のマッチになる。
 */
export function parseLatestTagFromAtom(xml: string): string {
  const m = String(xml || "").match(
    new RegExp("<id>tag:github\\.com,2008:Repository/\\d+/([^<]+)</id>"),
  );
  const tag = (m?.[1] || "").trim();
  return RELEASE_TAG_RE.test(tag) ? tag : "";
}

/** リリース資産の版固定 URL。不変なので CDN の stale を心配しなくてよい。 */
export function releaseAssetUrl(
  repo: string,
  tag: string,
  name: string,
): string {
  return `https://github.com/${repo}/releases/download/${tag}/${name}`;
}
