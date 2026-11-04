/**
 * サイトの削除の確認(cms-pricing「サイトを消す」・2026-10-30・利用者の指示)。
 *
 * 入口は 2 つ —— 無料期間が終わった知らせ(Notice)の「このサイトを削除する」と、プロフィールの「サイトの削除」。
 * どちらも同じ確認の窓を開き、**消えるものを件数で見せる**(空のサイトと運用中のサイトを取り違えないため)。
 *
 * ここは見せるだけ。消すのは導入口で、Entamy ID でログインした持ち主が契約の頁で識別名を入れたときに、
 * 持ち主であることと契約が無いことを確かめてから消す(KuroCMS の管理者だけでは消せない —— 管理者は
 * 持ち主とは限らない)。契約があるサイトは消せない(先に解約する)。顧客運用は自分の Cloudflare で片付ける。
 */
import { isManagedHosting } from "./media-quota.ts";
import type { Env } from "./types";

export interface SiteDeletePreview {
  managed: boolean;
  /** 契約の状態(contract_info・委託だけ)。none なら消せる。 */
  subscription: string | null;
  /** 契約の頁へ渡す、このサイトの管理番号とサイト名(entamySite)。 */
  site: { id: string | null; name: string | null };
  counts: {
    documents: number;
    media: number;
    mediaBytes: number;
    users: number;
    categories: number;
  };
}

const count = async (env: Env, sql: string): Promise<number> =>
  Number((await env.DB.prepare(sql).first<{ n: number }>())?.n ?? 0);

/**
 * Entamy の契約の頁へ自動で渡す、このサイトの見分け(2026-11-05・利用者)。持ち主は英数字の番号ではサイトを
 * 見分けられないので、番号(導入 ID の 12 桁・委託の Worker 名 kurocms-app-<12 桁> から)は製品が渡し、
 * 契約の頁はサイト名とアドレスで見せる。番号が分からない(委託でない・古い導入)ときは null。
 */
export async function entamySite(
  env: Env,
): Promise<{ id: string | null; name: string | null }> {
  const id =
    /^kurocms-app-([0-9a-f]{12})$/.exec(
      (env.CF_WORKER_NAME ?? "").trim(),
    )?.[1] ?? null;
  const row = await env.DB.prepare(
    "SELECT site_name FROM site_settings WHERE id = 1",
  )
    .first<{ site_name: string | null }>()
    .catch(() => null);
  return { id, name: (row?.site_name ?? "").trim() || null };
}

export async function siteDeletePreview(env: Env): Promise<SiteDeletePreview> {
  const managed = isManagedHosting(env);
  const contract = managed
    ? await env.DB.prepare(
        "SELECT subscription FROM contract_info WHERE id = 1",
      )
        .first<{ subscription: string | null }>()
        .catch(() => null)
    : null;
  return {
    managed,
    subscription: contract?.subscription ?? null,
    site: await entamySite(env),
    counts: {
      documents: await count(env, "SELECT COUNT(*) AS n FROM documents"),
      media: await count(env, "SELECT COUNT(*) AS n FROM media_assets"),
      mediaBytes: await count(
        env,
        "SELECT COALESCE(SUM(size_bytes), 0) AS n FROM media_assets",
      ),
      users: await count(env, "SELECT COUNT(*) AS n FROM users"),
      categories: await count(env, "SELECT COUNT(*) AS n FROM categories"),
    },
  };
}
