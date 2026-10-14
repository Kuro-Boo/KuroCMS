/**
 * Entamy 委託の導入だけが持つメディア(R2)の保存上限。
 *
 * 委託はホスティング用アカウントの R2 を全顧客で分け合うので、受付が 1 導入あたりの上限を
 * app の変数 MEDIA_QUOTA_BYTES に置く(100 MB・2026-10-14 運用者の決定)。お客様自身の
 * Cloudflare に入れた導入には置かれず、上限は掛からない。
 *
 * 判定はここだけに置く —— 書き込みの口(アップロード・復元・取り込み)ごとに書くと、
 * 一部の口だけ上限が抜ける。
 */

/** 変数の値を上限に。未設定・0・数でないものは「上限なし」(null)。 */
export function parseMediaQuota(value: string | undefined): number | null {
  const n = Number((value ?? "").trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** 書き足すと上限を超えるか。上限なし(null)なら決して超えない。 */
export function exceedsMediaQuota(
  usedBytes: number,
  incomingBytes: number,
  quotaBytes: number | null,
): boolean {
  return quotaBytes !== null && usedBytes + incomingBytes > quotaBytes;
}

/** 断るときのコード。管理画面はこれを見て画面の言語で言い換える(err_media_quota_exceeded)。 */
export const MEDIA_QUOTA_ERROR = "media_quota_exceeded";
