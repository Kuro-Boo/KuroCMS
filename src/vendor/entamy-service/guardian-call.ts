/**
 * 番人(WorkerOps)からの呼び出しか(app と番人の約束の口・core-offering 課題 6867ba62)。
 *
 * 番人(顧客導入の番人の Worker・委託の連絡係の中の番人)は、app の HEALTH_PATH・MIGRATE_PATH を
 * Service Binding で、宛先 https://app.internal の新しい要求として叩く(WorkerOps の health.ts)。
 * 外から来た要求は、Cloudflare の入口が必ず cf-connecting-ip を付け、宛先は公開のホスト名になる。
 * 番人が公開の要求を app へ渡すとき(顧客導入で番人が入口に立つ形)も、元の見出しと宛先のまま渡る。
 *
 * 前は製品ごとに片方だけを見ていた(KuroCMS は cf-connecting-ip が無いこと、MushManager は宛先が
 * app.internal であること)。両方を満たすときだけ番人とみなす —— どちらか一方の前提が崩れても通らない。
 *
 * 守るもの: migration を当てる口(重い処理を何度でも起こさせない)と、health のうち番人にだけ渡す欄。
 * これは鍵ではない。同じアカウントの別の Worker が束縛を持てば同じ形で呼べる(アカウントの中は信じる)。
 */
export const GUARDIAN_HOST = "app.internal";

export function fromGuardian(request: Request): boolean {
  if (request.headers.get("cf-connecting-ip") !== null) return false;
  try {
    return new URL(request.url).hostname === GUARDIAN_HOST;
  } catch {
    return false;
  }
}
