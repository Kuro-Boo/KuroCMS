/**
 * 開発版を取るためのトークン(仕様 core-feature-flags 2節・2026-11-05)。
 *
 * このサイト(導入の口座)のトークンを、持ち主が開発アカウントのときだけ渡す。一般のサイトは null で、
 * 配布基盤にトークンを送らない。分からない時も null(開発版を渡す側に倒さない)。
 */
import { entamyPort } from "./entamy-port";
import type { ReleaseToken } from "./release-source";
import type { Env } from "./types";

/** 持ち主が開発アカウントか。このサイト(導入の口座)のトークンの dev で決め、分からない時は一般として扱う。 */
export async function ownerIsDeveloper(env: Env): Promise<boolean> {
  try {
    const port = await entamyPort(env);
    return (await port.session.claims())?.developer === true;
  } catch {
    return false;
  }
}

export function releaseToken(env: Env): ReleaseToken {
  return async () => {
    try {
      if (!(await ownerIsDeveloper(env))) return null;
      const port = await entamyPort(env);
      const token = await port.session.accessToken();
      return token.ok ? token.value : null;
    } catch {
      return null;
    }
  };
}
