/**
 * 無料期間が終わり、契約の無い委託は読み取りだけ(cms-pricing「無料期間が切れたとき」・課題 8396f3b7)。
 *
 * 受付が毎時書く contract_info の 1 行で決める: 委託で、契約(subscription)が none で、最後の無料期間の終わり
 * (trial_final_at)を過ぎていれば止める。記事・メディア・設定の追加と変更、ビルドを止め、読む・書き出す
 * (バックアップ)・自分の Cloudflare へ引っ越す・ログインまわりは通す。公開済みのページは出し続ける。
 * 行が無い(受付がまだ書いていない・顧客導入)なら止めない —— 分からない時に利用者の作業を止めない。
 */
import { isManagedHosting } from "./media-quota.ts";
import type { Env } from "./types";

/** 止めている間も通す変更の口(ログイン・自分のこと・引っ越し・お知らせ・書き出し・回線の登録)。 */
const ALLOWED = new RegExp(
  "^/api/(auth/|me(/|$)|system/(site-move|notices/|backup|ip-gate|networks|contract))",
);

export function lockAllows(method: string, path: string): boolean {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS" || ALLOWED.test(path);
}

export async function contractLocked(
  env: Pick<Env, "DB" | "MEDIA_QUOTA_BYTES">,
  now = Date.now(),
): Promise<boolean> {
  if (!isManagedHosting(env)) return false;
  const row = await env.DB.prepare(
    "SELECT subscription, trial_final_at FROM contract_info WHERE id = 1",
  )
    .first<{ subscription: string | null; trial_final_at: number | null }>()
    .catch(() => null);
  if (!row || row.trial_final_at == null) return false;
  return (row.subscription ?? "none") === "none" && now > row.trial_final_at;
}
