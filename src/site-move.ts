/**
 * 運用の形の引っ越し（仕様 cms-move-to-self「CMS の画面から」・2026-10-21）。
 *
 * 委託運用で動いていれば顧客導入へ、顧客導入で動いていれば委託運用へ —— どちらへ移るかは、いま
 * どちらで動いているかで決まる（設定の「運用の形」はトグルのように片方だけを出す）。LP と導入口の頁は、
 * まだ CMS を持っていない人のためのもので、運用中の人はこの画面の中で済ませる。
 *
 * 頼むのはこのサーバー。導入口へは、通知などと同じ Entamy ID のセッション（この導入の口座）で名乗る。
 * 持ち主は導入口が導入の記録から引き、この導入が置いた引っ越しの鍵を記録のアドレスで読めたかで、
 * 頼み手がこの導入だと確かめる。管理画面のブラウザは基盤と直接つながらない（entamy-port.ts）。
 *
 * 進み具合は画面が導入口から直に読む（statusUrl）—— 委託のアドレスは最後に案内へ替わるので、
 * このサーバーを通すと結果を見届けられない。
 */
import { entamyPort } from "./entamy-port.ts";
import { HttpError } from "./http.ts";
import { isManagedHosting } from "./media-quota.ts";
import { cancelMoveOut, startMoveOut } from "./move.ts";
import type { Env } from "./types.ts";
import { KUROCMS_VERSION } from "./version.ts";

/** 版 a が b より古いか(major.minor.patch。読めない版は古いと見る)。 */
export function olderThan(a: string, b: string): boolean {
  const p = (v: string) =>
    /^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : null;
  const x = p(a);
  const y = p(b);
  if (!y) return false;
  if (!x) return true;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]!;
  return false;
}

/** 始めた引っ越し（ほかの管理者・ほかの端末でも進み具合へ戻れるように）。 */
const K_JOB = "system:site_move_job";

export type SiteMoveTo = "self" | "managed";

/** 導入口へ頼む口(entamy-connect のセッション)。試験では差し替える。 */
export type SiteMoveSession = Pick<
  Awaited<ReturnType<typeof entamyPort>>["session"],
  "startSiteMove" | "siteMoveStatus" | "resumeSiteMove" | "siteOwner"
>;

async function sessionOf(env: Env): Promise<SiteMoveSession> {
  return (await entamyPort(env)).session;
}

export interface SiteMoveJob {
  id: string;
  statusUrl: string;
  to: SiteMoveTo;
  at: number;
}

/** いまの形から、移れる先。 */
export function siteMoveDirection(env: Env): SiteMoveTo {
  return isManagedHosting(env) ? "self" : "managed";
}

export async function readSiteMoveJob(env: Env): Promise<SiteMoveJob | null> {
  try {
    const raw = await env.PUBLIC_PAGES.get(K_JOB);
    const job = raw ? (JSON.parse(raw) as SiteMoveJob) : null;
    return job &&
      typeof job.id === "string" &&
      typeof job.statusUrl === "string"
      ? job
      : null;
  } catch {
    return null;
  }
}

/**
 * この導入の持ち主が分かるか(導入口に訊く)。導入口で入れた導入(v2)は記録から(record)、導入口より前の
 * 導入(v1)は連絡先の登録で結んだ持ち主から(id)。どちらも無ければ null —— 画面は先に持ち主の登録を出す。
 * 訊けなければ unknown(持ち主がいないとは読まない)。
 */
export async function siteMoveOwner(
  env: Env,
  session?: SiteMoveSession,
): Promise<{
  owner: "record" | "id" | null | "unknown";
  minVersion: string | null;
}> {
  try {
    const res = await (session ?? (await sessionOf(env))).siteOwner(
      (env.CF_WORKER_NAME ?? "").trim(),
    );
    return res.ok ? res.value : { owner: "unknown", minVersion: null };
  } catch {
    return { owner: "unknown", minVersion: null };
  }
}

export async function forgetSiteMoveJob(env: Env): Promise<void> {
  await env.PUBLIC_PAGES.delete(K_JOB);
}

const CODE = /^[a-z][a-z0-9_]{1,47}$/;

/** 基盤の失敗を画面が言い換えられる符号にする。符号の無い失敗（圏外・基盤が無い）は entamy_unavailable。 */
function failureToError(failure: {
  kind: string;
  status?: number;
  message?: string;
}): HttpError {
  const code =
    failure.message && CODE.test(failure.message) ? failure.message : "";
  if (!code)
    return new HttpError(
      503,
      "entamy_unavailable",
      "Could not reach the Entamy installer.",
    );
  const status =
    failure.status && failure.status >= 400 && failure.status < 600
      ? failure.status
      : 502;
  return new HttpError(status, code, code);
}

function text(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  return typeof v === "string" ? v.trim().slice(0, 600) : "";
}

/**
 * 引っ越しを始める。この導入に移す元の鍵を置き（24 時間・押し直すと前の鍵は効かない）、導入口へ頼む。
 * 顧客導入へ移るときは、お客様の Cloudflare の Account ID とトークンを受けて導入口へ渡す（ここには残さない）。
 */
export async function startSiteMove(
  env: Env,
  body: Record<string, unknown>,
  lang: string,
  session?: SiteMoveSession,
): Promise<SiteMoveJob> {
  const to = siteMoveDirection(env);
  // 導入口で入れた導入は、自分の Worker の名前（kurocms-app-{導入ID}）を持つ。導入口より前の導入（v1）は
  // 無いことがあり、持ち主は連絡先の登録で結んだもの（導入口が ID から引く）。自分の引っ越しの口も渡す
  // （画面が開いているアドレスの口。v1 は導入口の記録にアドレスが無い）。
  const payload: Record<string, unknown> = {
    to,
    worker: (env.CF_WORKER_NAME ?? "").trim(),
    api: text(body, "api"),
    timeZone: text(body, "timeZone"),
  };
  if (to === "self") {
    payload.accountId = text(body, "accountId");
    payload.token = text(body, "token");
    payload.workerOpsToken = text(body, "workerOpsToken");
  }
  const port = { session: session ?? (await sessionOf(env)) };
  // 引っ越しを受ける版の下限(導入口が持つ)。足りなければ鍵を置く前に断る —— 先に更新してもらう。
  // 導入口も頼まれた時点で確かめるので、ここで分からなくても(圏外)そのまま頼む。
  const owner = await siteMoveOwner(env, port.session);
  if (owner.minVersion && olderThan(KUROCMS_VERSION, owner.minVersion))
    throw new HttpError(
      409,
      "source_too_old",
      `Update KuroCMS to ${owner.minVersion} or later first.`,
    );
  // 走っている（止まって再開を待つ）引っ越しがあれば始めない —— 鍵を置き替えると、その引っ越しが読めなくなる。
  const current = await readSiteMoveJob(env);
  if (current) {
    const status = await port.session.siteMoveStatus(current.id);
    const v = status.ok ? status.value : null;
    const move = v?.move as { resumable?: boolean } | undefined;
    if (
      v &&
      (v.status === "running" || (v.status === "error" && move?.resumable))
    )
      throw new HttpError(
        409,
        "move_in_progress",
        "A move is already in progress.",
      );
  }
  const { token } = await startMoveOut(env);
  payload.moveToken = token;
  const res = await port.session.startSiteMove(payload, lang);
  if (!res.ok) {
    // 始まらなかった鍵は残さない（導入口が受けていなければ、誰も使わない）。
    await cancelMoveOut(env).catch(() => {});
    throw failureToError(res.failure);
  }
  const job: SiteMoveJob = {
    id: res.value.jobId,
    statusUrl: res.value.statusUrl,
    to,
    at: Date.now(),
  };
  await env.PUBLIC_PAGES.put(K_JOB, JSON.stringify(job));
  return job;
}

/** 止まった引っ越しを続きから再開する（頼めるのは始めたこの導入だけ）。 */
export async function resumeSiteMove(
  env: Env,
  session?: SiteMoveSession,
): Promise<void> {
  const job = await readSiteMoveJob(env);
  if (!job)
    throw new HttpError(404, "not_found", "No move has been started here.");
  const res = await (session ?? (await sessionOf(env))).resumeSiteMove(job.id);
  if (!res.ok) throw failureToError(res.failure);
}
