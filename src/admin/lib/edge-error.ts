// Cloudflare 自身が返した誤りの頁を見分ける。scripts/build-admin.js が束ねる(import/export なし)。
//
// 管理画面の API は、Worker が答えれば必ず JSON を返す。JSON でない失敗は、Worker に届く前か
// Worker が止められた所で Cloudflare が返した頁で、本文に番号が載る(522・1027・1102 など)。
// 前は「5xx か本文に timeout / limit が入っていたら Cloudflare の制限の可能性」と出していたので、
// 削除したサイトの 522(Connection timed out)にも「KV の書き込み上限など」と出て、原因を
// 取り違えさせた(2026-11-10)。番号で決まるものだけを言い換え、当て推量の文は出さない。

type EdgeErrorKind =
  | "unreachable"
  | "daily_limit"
  | "resource_limit"
  | "worker_crashed";

/**
 * JSON でなかった失敗の応答(status と本文)から、Cloudflare の誤りの種類と番号を返す。当たらなければ null。
 *   unreachable     520〜527・530: Cloudflare がサイトの Worker に繋げなかった(消えた・アドレスが外れた・
 *                   引っ越した・Cloudflare の不調)
 *   daily_limit     1027: 無料の 1 日の要求数を使い切った
 *   resource_limit  1102: CPU 時間かメモリの上限を超えた
 *   worker_crashed  1101: Worker が例外で止まった
 */
function edgeError(
  status: number,
  body: string,
): { kind: EdgeErrorKind; code: number } | null {
  const text = body || "";
  const numbered = (n: number) =>
    new RegExp("(?:error|code)[^0-9]{0,12}" + n + "(?![0-9])", "i").test(text);
  if (numbered(1027)) return { kind: "daily_limit", code: 1027 };
  if (numbered(1102)) return { kind: "resource_limit", code: 1102 };
  if (numbered(1101)) return { kind: "worker_crashed", code: 1101 };
  if ((status >= 520 && status <= 527) || status === 530)
    return { kind: "unreachable", code: status };
  return null;
}
