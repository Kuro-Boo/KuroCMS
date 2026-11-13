/**
 * 登録した頁だけを配るか(旗 static-only・cms-cms-build「登録した頁だけを配る」・2026-11-12)。
 *
 * 旗が一般(audience 'all')なら ID に訊かずに true。開発アカウントだけの間は、持ち主が開発アカウントかを
 * この isolate で 10 分控える —— 公開の道の入口から毎回 ID へ問い合わせない(入口は D1 にも KV にも触れない)。
 */
import { lastRegisteredStatic } from "./assets-publish";
import { cmsFlagOn } from "./feature-flags";
import { ownerIsDeveloper } from "./release-token";
import type { Env } from "./types";

const HOLD_MS = 10 * 60_000;
let held: { on: boolean; until: number } | null = null;

export async function staticOnlyOn(
  env: Env,
  now = Date.now(),
): Promise<boolean> {
  if (cmsFlagOn("static-only", false)) return true;
  if (held && now < held.until) return held.on;
  const on = cmsFlagOn("static-only", await ownerIsDeveloper(env));
  held = { on, until: now + HOLD_MS };
  return on;
}

export { staticDynamicPath } from "./static-paths";

let registered: { on: boolean; until: number } | null = null;

/**
 * 入口で公開の道を弾いてよいか。旗が効き、かつ sitemap などを載せた一覧の登録が一度済んでいること。
 * 済む前に弾くと、今まで Worker が作っていたカテゴリの頁・sitemap が、最初のビルドが登録し終えるまで欠ける
 * (2026-11-12 に kuro.boo で 30 分欠けた)。登録の印は D1 の 1 行で、この isolate で 1 分控える。
 */
export async function staticServing(
  env: Env,
  now = Date.now(),
): Promise<boolean> {
  if (!(await staticOnlyOn(env, now))) return false;
  if (registered && now < registered.until) return registered.on;
  const row = await env.DB.prepare(
    "SELECT result FROM asset_publish WHERE id = 1",
  )
    .first<{ result: string }>()
    .catch(() => null);
  const on = lastRegisteredStatic(row?.result ?? "");
  registered = { on, until: now + 60_000 };
  return on;
}

/** 試験専用。控えを捨てる。 */
export function __resetStaticOnlyForTest(): void {
  held = null;
  registered = null;
}
