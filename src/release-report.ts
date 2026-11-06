/**
 * update から版を取った結果を Entamy Defects へ送る(cms-release・2026-10-12)。
 *
 * 版の画面を見に行かなくても、配布基盤の経路の不具合に気づくため。起きた回数だけ積まれ、管理画面の一覧で読める。
 *
 *   release_update_ok      update から取れて、署名と sha256 が通った(記録 —— 不具合ではない)
 *   release_update_failed  update から取れなかった、または確かめが通らなかった
 *
 * detail は符号と数値だけ(what・version・asset・reason)。報告が通らなくても更新は止めない。
 */
import { entamyPort } from "./entamy-port";
import type { Env } from "./types";

export type ReleaseEvent = "release_update_ok" | "release_update_failed";

export interface ReleaseEventDetail {
  /** 何を取ったか。 */
  what: "worker" | "migrations" | "asset";
  /** 取ろうとした版(X.Y.Z)。 */
  version: string;
  /** 管理画面のアセットのときのファイル名。 */
  asset?: string;
  /** 取れなかった理由(release-source の reasonOf)。 */
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

/**
 * ビルドの失敗(cms-cms-build・2026-11-03)。ビルドの口は進み具合を NDJSON で流し、応答は 200 のまま終わるので、
 * Worker の失敗にも debug の記録にも残らず、**画面のログを見た人にしか分からなかった**。
 *
 *   build_failed       ビルドが途中で投げて止まった(手動の口・毎分の自動ビルド)
 *   build_page_failed  ビルドは回り切ったが、作れなかったページがあった(数と最初の 1 件)
 *
 * detail は数・道・理由だけ(本文は載せない)。理由は 500 文字で切る。
 */
export async function reportBuild(
  env: Env,
  code: "build_failed" | "build_page_failed",
  detail: Record<string, string | number>,
): Promise<void> {
  try {
    const { defects } = await entamyPort(env);
    await defects.report(code, { detail });
  } catch {
    /* 報告が通らないことは、報告したかった事実より軽い */
  }
}

/** 例外を Defects に載せる長さの文にする。 */
export function buildReason(err: unknown): string {
  const s = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return s.slice(0, 500);
}

/**
 * Threads の長期トークンの自動更新と、記事の投稿(cms-cms-sns・2026-11-06)。どちらも cron か waitUntil の中で起き、
 * console にしか残らなかったので、自動更新が 60 日失敗し続けてトークンが失効するまで誰も気づけなかった。
 *
 *   threads_token_refreshed       自動更新が通った(記録 —— 不具合ではない)
 *   threads_token_refresh_failed  自動更新が通らなかった(kind: network / meta / invalid_response。code 190 は失効)
 *   threads_post_failed           記事の投稿が通らなかった(step・status・code)
 *   threads_connected             「Threads と接続」で長期トークンを受け取った(記録)
 *   threads_connect_failed        「Threads と接続」で Meta がトークンを出さなかった(step・status・code)
 *
 * detail は符号と番号だけ。トークン・本文・Meta の文は載せない。
 */
export async function reportThreads(
  env: Env,
  code:
    | "threads_token_refreshed"
    | "threads_token_refresh_failed"
    | "threads_post_failed"
    | "threads_connected"
    | "threads_connect_failed",
  detail: Record<string, string | number>,
): Promise<void> {
  try {
    const { defects } = await entamyPort(env);
    await defects.report(code, {
      detail: { ...detail, source: "threads" },
      record:
        code === "threads_token_refreshed" || code === "threads_connected",
    });
  } catch {
    /* 報告が通らないことは、報告したかった事実より軽い */
  }
}
