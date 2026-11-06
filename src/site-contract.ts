/**
 * CMS の中の契約と委託のサイトの削除(cms-pricing「CMS からの申し込みと本人」2 節・2026-11-06・課題 474d7514)。
 *
 * 押せるのは持ち主の管理者だけ(アドレスが持ち主の Entamy ID と同じ人)で、お金と削除の操作は、押す直前に CMS の
 * パスキーで確かめ直した人だけ(ログインのやり直しで新しいセッションができるので、その新しさで決める)。
 * サーバーがサイトの口座で導入口へ頼み、導入口が名簿で持ち主を引く。持ち主の口座を CMS は持たない。
 */
import { entamyPort } from "./entamy-port.ts";
import { clearSiteProof, makeSiteProof } from "./site-proof.ts";
import type { Env } from "./types.ts";

/** 確かめ直してから操作できる時間。 */
export const REAUTH_WINDOW_MS = 5 * 60 * 1000;

export const SITE_CONTRACT_ACTIONS = [
  "catalog",
  "list",
  "start",
  "confirm",
  "cancel-quote",
  "cancel",
  "delete",
  "sync",
] as const;
export type SiteContractAction = (typeof SITE_CONTRACT_ACTIONS)[number];

/** パスキーで確かめ直してからでないと動かさない操作。 */
export const NEEDS_REAUTH: ReadonlySet<SiteContractAction> = new Set([
  "start",
  "confirm",
  "cancel",
  "delete",
]);

/** そのセッションが、確かめ直したばかりか(新しいログインか)。 */
export function sessionIsFresh(
  createdAt: string | null | undefined,
  now = Date.now(),
): boolean {
  const at = createdAt ? Date.parse(createdAt) : NaN;
  return Number.isFinite(at) && now - at <= REAUTH_WINDOW_MS;
}

export async function callSiteContract(
  env: Env,
  action: SiteContractAction,
  body: Record<string, unknown>,
): Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; status: number; code: string }
> {
  const worker = (env.CF_WORKER_NAME ?? "").trim();
  const port = await entamyPort(env);
  const proof = await makeSiteProof(env);
  try {
    const res = await port.session.siteContract(worker, proof, {
      ...body,
      action,
    });
    if (res.ok) return { ok: true, value: res.value };
    const f = res.failure;
    return {
      ok: false,
      status: f.status ?? 502,
      code: f.message ?? f.kind ?? "contract_failed",
    };
  } finally {
    await clearSiteProof(env).catch(() => {});
  }
}
