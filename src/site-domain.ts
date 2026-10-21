/**
 * 委託の独自ドメイン（core-offering 14 節・2026-10-22）。
 *
 * 委託のサイトは Entamy の Cloudflare で動き、鍵を持たない。お客様のドメインは、委託用ゾーン（kurocms.site）の
 * Cloudflare for SaaS で付ける —— 頼むのはこのサーバーで、導入口へは引っ越しと同じ Entamy ID のセッション
 * （この導入の口座）で名乗る。導入口はこの導入が置いた短い証（site-proof.ts）を導入の記録のアドレスで読んで、
 * 頼み手がこの導入だと確かめる。
 *
 * 流れ（画面は設定 → ドメイン）:
 *   prepare  ホスト名を渡す → 導入口が Custom Hostname を作り、足すレコード（TXT と CNAME）を返す
 *   status   お客様が TXT を足したかを見る（証明書が active になれば確かめが済んだ）
 *   switch   お客様が押す → 導入口が Worker ルート {host}/* をこの app へ向ける（kurocms.site 側の切り替え）
 *   remove   取り消す（ルートと Custom Hostname を消す）
 * 公開ページのリンクは公開ドメインの設定から作るので、付いたら設定の一番上を変えて全ページをビルドする。
 */
import { entamyPort } from "./entamy-port.ts";
import { HttpError } from "./http.ts";
import { isManagedHosting } from "./media-quota.ts";
import { clearSiteProof, makeSiteProof } from "./site-proof.ts";
import type { Env } from "./types.ts";

/**
 * 委託の番人に「今すぐ新しい版を確かめて」と頼む(持ち主が更新のチャンネルを切り替えたとき・cms-workerops)。
 * 番人は 1 日 1 回しか取得口を見ないので、頼まなければ切り替えても最大 24 時間入らない。頼めたら true。
 * 頼めなくても(圏外・古い導入口)切り替えは効いている —— 次の 1 日 1 回の確認で入る。
 */
export async function askManagedUpdateCheck(
  env: Env,
  session?: Pick<
    Awaited<ReturnType<typeof entamyPort>>["session"],
    "siteCheckUpdate"
  >,
): Promise<boolean> {
  if (!isManagedHosting(env)) return false;
  try {
    const port = session ?? (await entamyPort(env)).session;
    const proof = await makeSiteProof(env);
    try {
      const res = await port.siteCheckUpdate({
        worker: (env.CF_WORKER_NAME ?? "").trim(),
        proof,
      });
      return res.ok && res.value.outcome !== "error";
    } finally {
      await clearSiteProof(env).catch(() => {});
    }
  } catch {
    return false;
  }
}

export type SiteDomainAction = "status" | "prepare" | "switch" | "remove";
const ACTIONS: ReadonlySet<string> = new Set([
  "status",
  "prepare",
  "switch",
  "remove",
]);

/** 導入口へ頼む口(entamy-connect のセッション)。試験では差し替える。 */
export type SiteDomainSession = Pick<
  Awaited<ReturnType<typeof entamyPort>>["session"],
  "siteDomain"
>;

const CODE = /^[a-z][a-z0-9_]{1,47}$/;

export async function siteDomain(
  env: Env,
  action: string,
  hostname?: string,
  session?: SiteDomainSession,
): Promise<{ domain: unknown }> {
  if (!isManagedHosting(env))
    throw new HttpError(409, "not_managed", "Only for managed hosting.");
  if (!ACTIONS.has(action))
    throw new HttpError(400, "invalid_request", "Unknown action.");
  const port = session ?? (await entamyPort(env)).session;
  const proof = await makeSiteProof(env);
  try {
    const res = await port.siteDomain({
      worker: (env.CF_WORKER_NAME ?? "").trim(),
      proof,
      action,
      ...(hostname ? { hostname: hostname.slice(0, 260) } : {}),
    });
    if (!res.ok) {
      const code =
        res.failure.message && CODE.test(res.failure.message)
          ? res.failure.message
          : "";
      if (!code)
        throw new HttpError(
          503,
          "entamy_unavailable",
          "Could not reach the Entamy installer.",
        );
      const status =
        res.failure.status &&
        res.failure.status >= 400 &&
        res.failure.status < 600
          ? res.failure.status
          : 502;
      throw new HttpError(status, code, code);
    }
    return { domain: res.value.domain ?? null };
  } finally {
    await clearSiteProof(env).catch(() => {});
  }
}
