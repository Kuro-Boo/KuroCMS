/**
 * このサイトが要求を受けたアドレス(origin)を覚えておく(security-what 10.1節「台帳に無い古い導入」・2026-11-24)。
 *
 * 導入口より前に立てた顧客運用のサイトは、導入口の台帳に行が無い。鍵を頼むときに自分のアドレスを名乗り、導入口は
 * そのアドレスでサイトの証を読めたら台帳に載せる。毎分の処理は要求を持たないので、管理画面のセッションの確認
 * (GET /api/auth/session)で届いた要求の origin をここに覚える。この Worker に届いた要求の origin なので、
 * 名乗っても他人のサイトにはならない(証はそのアドレスで読み直される)。
 */
import type { Env } from "./types.ts";

const KEY = "system:self_origin";
/** 同じ isolate で同じ値を書き直さない。 */
let remembered: string | null = null;

export async function rememberSelfOrigin(
  env: Env,
  request: Request,
): Promise<void> {
  let origin: string;
  try {
    origin = new URL(request.url).origin;
  } catch {
    return;
  }
  if (!origin.startsWith("https://") || origin === remembered) return;
  const cur = await env.PUBLIC_PAGES.get(KEY).catch(() => null);
  if (cur !== origin) await env.PUBLIC_PAGES.put(KEY, origin);
  remembered = origin;
}

export async function readSelfOrigin(env: Env): Promise<string | null> {
  const v = await env.PUBLIC_PAGES.get(KEY).catch(() => null);
  return v && v.startsWith("https://") ? v : null;
}

/** 試験専用。 */
export function __resetSelfOriginForTest(): void {
  remembered = null;
}
