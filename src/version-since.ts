/**
 * いまの版がいつ入ったか(ダッシュボードの KuroCMS の枠の一番下・cms-cms-selfupdate)。
 *
 * 版を入れるのは番人のことも、管理画面の「今すぐ更新」のこともあるので、入れた側では記録しない。
 * **動いている版が、前に記録した版と違うことに app 自身が気づいた時**に {前の版・今の版・時刻} を残す。
 * 毎分の cron が見るので、どの経路で入っても 1 分以内の時刻になる。
 *
 * 記録がまだ無い導入(この部品より前に入った版)は、いつ入ったか分からないので時刻を null にする
 * —— 気づいた時刻を「更新した日」として出すと、作り話になる。次の更新から出る。
 */
import { nowIso } from "./crypto.ts";
import type { Env } from "./types";
import { KUROCMS_VERSION } from "./version.ts";

const KEY = "system:version_since";

export interface VersionSince {
  version: string;
  from: string | null;
  at: string | null;
}

async function read(env: Env): Promise<VersionSince | null> {
  const raw = await env.PUBLIC_PAGES.get(KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<VersionSince>;
    return typeof v.version === "string"
      ? { version: v.version, from: v.from ?? null, at: v.at ?? null }
      : null;
  } catch {
    return null;
  }
}

/** いまの版の記録。版が変わっていれば書き直す(版が同じ間は KV を 1 回読むだけ)。 */
export async function noteRunningVersion(
  env: Env,
  version = KUROCMS_VERSION,
  now = nowIso,
): Promise<VersionSince> {
  const prev = await read(env);
  if (prev && prev.version === version) return prev;
  const next: VersionSince = {
    version,
    from: prev?.version ?? null,
    at: prev ? now() : null,
  };
  await env.PUBLIC_PAGES.put(KEY, JSON.stringify(next));
  return next;
}

const PAGES_KEY = "system:pages_for_version";

/**
 * 版が変わったら、公開の頁を作り直す(課題 ad495461・2026-11-07)。
 *
 * 公開の頁の HTML は、その版のコードで描く(テンプレートの属性のハンドラーを外のファイルへ移す・
 * CSP の見出し `_headers` を付ける、など)。版を上げただけでビルドを待つと、新しい CSP と古い HTML が
 * 混ざる —— 強制の CSP が、まだ移していないハンドラーを止める。だから版が変わったら毎分の自動ビルドの
 * 仕組みで頁を作り直し、**最後の回で頁と見出しを一緒に**番人へ渡す(見出しだけを先に渡さない)。
 *
 * 作り直しは、公開の状態を変えない:
 * - 自動の方式(auto)のサイトは、もともと公開の切り替えを毎分反映するので、いつもの全体ビルド("window")
 * - 手動の方式(manual)のサイトは、いま公開している状態(`documents.live`)のまま描き直すだけ("live")。
 *   持ち主がまだビルドしていない公開・非公開の切り替えは出さない
 */
export type MinuteBuild = "window" | "live" | null;

export function minuteBuildPlan(input: {
  mode: "auto" | "manual";
  /** 自動の方式で、公開の切り替えか資産の登録が残っている。 */
  windowPending: boolean;
  /** 頁がまだこの版で作り直されていない。 */
  versionPending: boolean;
}): MinuteBuild {
  if (input.mode === "auto" && (input.windowPending || input.versionPending))
    return "window";
  if (input.versionPending) return "live";
  return null;
}

/** 頁を作り直し終えた版(無ければ null)。 */
export async function pagesBuiltFor(
  env: Pick<Env, "PUBLIC_PAGES">,
): Promise<string | null> {
  return env.PUBLIC_PAGES.get(PAGES_KEY);
}

export async function markPagesBuilt(
  env: Pick<Env, "PUBLIC_PAGES">,
  version = KUROCMS_VERSION,
): Promise<void> {
  await env.PUBLIC_PAGES.put(PAGES_KEY, version);
}
