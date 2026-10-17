/**
 * update から版を取った結果を Entamy Defects へ送る(cms-release・2026-10-12)。
 *
 * 取り先が update の導入(既定)が送る。github だけを選んだ導入は送らない。カナリアの目的は update の経路の不具合を見つけることで、
 * 版の画面(/api/system/version)の「最後に落ちた記録」だけでは、**見に行かなければ気づかない**
 * うえに最後の1件しか残らない。Defects なら起きた回数だけ積まれ、管理画面の一覧で読める。
 *
 *   release_update_ok               update から取れて、署名と sha256 が通った(記録 —— 不具合ではない)
 *   release_fallback_github_ok      update から取れず(確かめが通らないものも)、同じ版を GitHub から取れた
 *   release_fallback_github_failed  update からも GitHub からも取れなかった
 *
 * detail は符号と数値だけ(what・version・asset・reason)。報告が通らなくても更新は止めない。
 */
import { entamyPort } from "./entamy-port";
import type { Env } from "./types";

export type ReleaseEvent =
  | "release_update_ok"
  | "release_fallback_github_ok"
  | "release_fallback_github_failed";

export interface ReleaseEventDetail {
  /** 何を取ったか。 */
  what: "worker" | "migrations" | "asset";
  /** 取ろうとした版(X.Y.Z)。 */
  version: string;
  /** 管理画面のアセットのときのファイル名。 */
  asset?: string;
  /** update で落ちた理由(release-source の reasonOf)。 */
  reason?: string;
}

export async function reportRelease(
  env: Env,
  code: ReleaseEvent,
  detail: ReleaseEventDetail,
): Promise<void> {
  try {
    const { defects } = await entamyPort(env);
    await defects.report(code, {
      detail: { ...detail, source: "update" },
      record: code === "release_update_ok",
    });
  } catch {
    /* 報告が通らないことは、報告したかった事実より軽い */
  }
}

/**
 * 番人(WorkerOps)を app が上げた結果(cms-workerops「番人の更新は app が行う」・guardian-update.ts)。
 *
 *   guardian_update_ok           上げて、新しい版が名乗った(記録 —— 不具合ではない)
 *   guardian_update_rolled_back  新しい版が名乗らなかったので、前の版へ戻した
 *   guardian_update_failed       上げる前に止まった(取り先・署名・設定の読み出し・上げ)
 *   guardian_rollback_failed     戻せなかった(番人が新しい版のまま。管理画面にも出す)
 *
 * detail は符号と版だけ(from・to・reason)。
 */
export async function reportGuardian(
  env: Env,
  code:
    | "guardian_update_ok"
    | "guardian_update_rolled_back"
    | "guardian_update_failed"
    | "guardian_rollback_failed",
  detail: Record<string, string>,
): Promise<void> {
  try {
    const { defects } = await entamyPort(env);
    await defects.report(code, {
      detail: { ...detail, source: "update" },
      record: code === "guardian_update_ok",
    });
  } catch {
    /* 報告が通らないことは、報告したかった事実より軽い */
  }
}
