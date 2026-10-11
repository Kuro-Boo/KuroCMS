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
