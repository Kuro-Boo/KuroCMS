/**
 * 登録した頁だけを配るか(旗 static-only・cms-cms-build「登録した頁だけを配る」・2026-11-12)。
 *
 * 旗が一般(audience 'all')なら ID に訊かずに true。開発アカウントだけの間は、持ち主が開発アカウントかを
 * この isolate で 10 分控える —— 公開の道の入口から毎回 ID へ問い合わせない(入口は D1 にも KV にも触れない)。
 */
import { lastRegisteredStatic } from "./assets-publish";
import { cmsFlagOn, type CmsFlag } from "./feature-flags";
import { ownerIsDeveloper } from "./release-token";
import type { Env } from "./types";

const HOLD_MS = 10 * 60_000;
const held = new Map<CmsFlag, { on: boolean; until: number }>();

async function heldFlag(env: Env, id: CmsFlag, now: number): Promise<boolean> {
  if (cmsFlagOn(id, false)) return true;
  const h = held.get(id);
  if (h && now < h.until) return h.on;
  const on = cmsFlagOn(id, await ownerIsDeveloper(env));
  held.set(id, { on, until: now + HOLD_MS });
  return on;
}

/** 旗が効くか(この isolate で 10 分控える)。公開の頁の組み立て・公開の口から使う。 */
export async function cmsFlagHeld(
  env: Env,
  id: CmsFlag,
  now = Date.now(),
): Promise<boolean> {
  return heldFlag(env, id, now);
}

export async function staticOnlyOn(
  env: Env,
  now = Date.now(),
): Promise<boolean> {
  return heldFlag(env, "static-only", now);
}

/** 登録に無い道で Worker を呼ばない設定・探りを待たせる(旗 static-404)。static-only が効くサイトだけ。 */
export async function static404On(
  env: Env,
  now = Date.now(),
): Promise<boolean> {
  return (await staticOnlyOn(env, now)) && heldFlag(env, "static-404", now);
}

export {
  staticDynamicPath,
  probePath,
  PROBE_HOLD_MS,
  assetRouting,
} from "./static-paths";

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
  held.clear();
  registered = null;
}
