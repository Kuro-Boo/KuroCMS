/**
 * ビルドの方式(manual / auto / always・cms-cms-build「ビルドモード」)の保存と、毎分の自動ビルドが
 * 見る控え。KV に 1 つの値で置く(スキーマの移行が要らず、毎分の確認が安い)。
 *
 * ## 毎分は KV を読まない(2026-11-03)
 *
 * KV の読み出しは口座で 1 日 10 万回で、委託ではサイトがそれを分け合う。毎分の自動ビルドの確認は、
 * 読んでから 5 分はこの isolate の控えを使う。この isolate で変えたとき・画面が読んだときは、控えも
 * その場で替わる。**別の isolate で auto に変えたときは、予定公開が始まるまで最長 5 分遅れる**
 * (build-mode.test.ts で確かめる)。
 *
 * ⚠ ここは cloudflare:workers を読まない(node で直接試験する)。
 */
import type { Env } from "./types";

export type BuildMode = "manual" | "auto" | "always";
export const BUILD_MODE_KEY = "_cfg/build_schedule_mode";
export const BUILD_MODE_TTL_MS = 5 * 60_000;

let seen: { mode: BuildMode; at: number } | null = null;

/** 試験専用。isolate の控えを捨てる(別の isolate の始まりにあたる)。 */
export function __resetBuildModeForTest(): void {
  seen = null;
}

/** Read the persisted build mode (defaults to "manual"). */
export async function getBuildMode(
  env: Pick<Env, "PUBLIC_PAGES">,
  now = Date.now(),
): Promise<BuildMode> {
  if (!env.PUBLIC_PAGES) return "manual";
  const v = await env.PUBLIC_PAGES.get(BUILD_MODE_KEY);
  const mode: BuildMode = v === "auto" || v === "always" ? v : "manual";
  seen = { mode, at: now };
  return mode;
}

/** Persist the build mode. */
export async function setBuildMode(
  env: Pick<Env, "PUBLIC_PAGES">,
  mode: BuildMode,
  now = Date.now(),
): Promise<void> {
  if (!env.PUBLIC_PAGES) return;
  await env.PUBLIC_PAGES.put(BUILD_MODE_KEY, mode);
  seen = { mode, at: now };
}

/** 毎分の自動ビルドが見る方式。読んでから BUILD_MODE_TTL_MS の間は KV を読まない。 */
export async function buildModeForMinute(
  env: Pick<Env, "PUBLIC_PAGES">,
  now = Date.now(),
): Promise<BuildMode> {
  if (seen && now - seen.at < BUILD_MODE_TTL_MS) return seen.mode;
  return getBuildMode(env, now);
}
