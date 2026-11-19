/**
 * 記事の訳の seo_json に、表紙(coverMid・coverPath)を残す決まり(2026-11-19・利用者)。
 *
 * seo は外の道具(AI・MCP・REST)も画面も書く。送られた seo で丸ごと置き換えると、
 * 表紙を知らない道具が ogp や keywords だけを送った時に表紙が消え、基準言語の表紙が
 * 消えれば全言語の公開の頁から表紙が消えた(kuro.boo・2026-11-17)。
 *
 * - 送られた seo に coverMid も coverPath も無ければ、保存済みの表紙を引き継ぐ。
 * - 表紙を外すときは coverMid: "" / coverPath: "" を明示して送る。
 * - 表紙の外の欄(ogp・keywords ほか)は、これまでどおり送られたものに置き換える。
 */
export function keepSeoCover(
  storedJson: string | null,
  inputJson: string,
): string {
  let input: unknown;
  try {
    input = JSON.parse(inputJson);
  } catch {
    return inputJson;
  }
  if (!input || typeof input !== "object" || Array.isArray(input))
    return inputJson;
  const obj = input as Record<string, unknown>;
  if ("coverMid" in obj || "coverPath" in obj) return inputJson;
  let stored: Record<string, unknown> = {};
  try {
    const s = storedJson ? JSON.parse(storedJson) : {};
    if (s && typeof s === "object" && !Array.isArray(s))
      stored = s as Record<string, unknown>;
  } catch {
    return inputJson;
  }
  const mid = typeof stored.coverMid === "string" ? stored.coverMid : "";
  const path = typeof stored.coverPath === "string" ? stored.coverPath : "";
  if (!mid && !path) return inputJson;
  return JSON.stringify({ ...obj, coverMid: mid, coverPath: path });
}
