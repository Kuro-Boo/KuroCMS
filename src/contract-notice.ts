/**
 * 無料期間が終わり契約の無い委託へ、データを消す前に知らせる(cms-pricing「無料期間が切れたとき」・課題 8396f3b7)。
 *
 * 消す日(contract_info.delete_at = 最後の無料期間の終わり + 30 日)の 7 日前と前日に、このサイトの管理者全員へ
 * メールで知らせる。消すのは受付と Admin(人が押す)で、ここは知らせるだけ。送った印は KV に残し(段・消す日ごと)、
 * 同じ知らせを 2 度送らない。契約すれば(subscription が none でなくなれば)送らない。
 */
import { isManagedHosting } from "./media-quota.ts";
import type { Env } from "./types";

const DAY = 86_400_000;

export type DeletionStage = "7d" | "1d";

/** いま送る段(送らないなら null)。 */
export function deletionStage(
  deleteAt: number,
  now: number,
): DeletionStage | null {
  if (now >= deleteAt) return null;
  if (now >= deleteAt - DAY) return "1d";
  if (now >= deleteAt - 7 * DAY) return "7d";
  return null;
}

export async function remindDataDeletion(
  env: Env,
  send: (msg: {
    to: string[];
    subject: string;
    text: string;
    idempotencyKey: string;
  }) => Promise<unknown>,
  now = Date.now(),
): Promise<DeletionStage | null> {
  if (!isManagedHosting(env)) return null;
  const c = await env.DB.prepare(
    "SELECT subscription, delete_at FROM contract_info WHERE id = 1",
  )
    .first<{ subscription: string | null; delete_at: number | null }>()
    .catch(() => null);
  if (!c || c.delete_at == null || (c.subscription ?? "none") !== "none")
    return null;
  const stage = deletionStage(c.delete_at, now);
  if (!stage) return null;
  const mark = `system:delete-notice:${stage}:${c.delete_at}`;
  if (await env.PUBLIC_PAGES.get(mark)) return null;
  const admins = await env.DB.prepare(
    "SELECT email FROM users WHERE is_admin = 1 AND disabled_at IS NULL",
  ).all<{ email: string }>();
  const to = (admins.results ?? []).map((r) => r.email).filter(Boolean);
  if (!to.length) return null;
  const site = await env.DB.prepare(
    "SELECT site_name, default_lang FROM site_settings WHERE id = 1",
  )
    .first<{ site_name: string | null; default_lang: string | null }>()
    .catch(() => null);
  const name = (site?.site_name ?? "KuroCMS").trim() || "KuroCMS";
  const day = new Date(c.delete_at).toISOString().slice(0, 10);
  const ja = site?.default_lang === "ja";
  const when = ja
    ? stage === "1d"
      ? "明日"
      : "7 日後"
    : stage === "1d"
      ? "tomorrow"
      : "in 7 days";
  await send({
    to,
    idempotencyKey: `delete-notice-${stage}-${c.delete_at}`,
    subject: ja
      ? `[${name}] ${when}（${day}）にサイトのデータが消えます`
      : `[${name}] Your site's data will be deleted ${when} (${day})`,
    text: ja
      ? `${name} の無料期間が終わり、委託の契約がありません。このままでは ${day}（UTC）にサイトのデータ（記事・メディア・設定）が消え、取り戻せません。\n\n` +
        `続けるには、管理画面の「設定 → 契約形式」から委託契約を申し込むか、ご自身の Cloudflare アカウントへ引っ越してください（引っ越しは無料です）。\n` +
        `データを手元に残すには、管理画面の「バックアップ」から ZIP を書き出してください。\n`
      : `The free period of ${name} has ended and there is no managed hosting contract. On ${day} (UTC) the site's data (articles, media and settings) will be deleted and cannot be recovered.\n\n` +
        `To keep the site, subscribe from Settings → Contract in the admin panel, or move it to your own Cloudflare account (free).\n` +
        `To keep a copy, export a ZIP from Backup in the admin panel.\n`,
  });
  await env.PUBLIC_PAGES.put(mark, String(now), {
    expirationTtl: 60 * 60 * 24 * 60,
  });
  return stage;
}
