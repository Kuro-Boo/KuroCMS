/**
 * 開発版を取るためのトークン(仕様 core-feature-flags 2節・2026-11-05)。
 *
 * このサイト(導入の口座)のトークンを、持ち主が開発アカウントのときだけ渡す。一般のサイトは null で、
 * 配布基盤にトークンを送らない。分からない時も null(開発版を渡す側に倒さない)。
 */
import { entamyPort } from "./entamy-port";
import type { ReleaseToken } from "./release-source";
import type { Env } from "./types";

export function releaseToken(env: Env): ReleaseToken {
  return async () => {
    try {
      const port = await entamyPort(env);
      if ((await port.session.claims())?.developer !== true) return null;
      const token = await port.session.accessToken();
      return token.ok ? token.value : null;
    } catch {
      return null;
    }
  };
}
