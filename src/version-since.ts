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
