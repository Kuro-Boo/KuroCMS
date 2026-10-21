/**
 * このサイトの短い証(導入口が「頼み手はこのサイトか」を確かめる・ID 第7章「導入の持ち主」・2026-10-21)。
 *
 * 導入口で入れた導入(v2)の持ち主を ID にも結ぶとき、導入口は名乗った Worker の名前から導入の記録を引き、
 * **記録に残したアドレス**でこの証を読めたら結ぶ。名前だけでは、他人の導入の持ち主を自分のサイトに結べて
 * しまう(持ち主宛てのお知らせが他人のサイトに出る)。証は 10 分・使ったら消す。KV にはハッシュだけを置く。
 */
import { sha256Hex } from "./crypto.ts";
import type { Env } from "./types.ts";

const K_PROOF = "system:site_proof";
const TTL_MS = 10 * 60 * 1000;
const TOKEN = /^Bearer\s+(kproof_[A-Za-z0-9_-]{32,128})$/i;

function randomProof(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  return (
    "kproof_" +
    btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  );
}

export async function makeSiteProof(
  env: Env,
  now = Date.now(),
): Promise<string> {
  const proof = randomProof();
  await env.PUBLIC_PAGES.put(
    K_PROOF,
    JSON.stringify({ hash: await sha256Hex(proof), exp: now + TTL_MS }),
  );
  return proof;
}

export async function clearSiteProof(env: Env): Promise<void> {
  await env.PUBLIC_PAGES.delete(K_PROOF);
}

/** 証を確かめる(GET /api/system/site-proof・認証の仕組みを通さない)。 */
export async function checkSiteProof(
  request: Request,
  env: Env,
  now = Date.now(),
): Promise<boolean> {
  const m = TOKEN.exec(request.headers.get("authorization")?.trim() ?? "");
  if (!m) return false;
  try {
    const raw = await env.PUBLIC_PAGES.get(K_PROOF);
    if (!raw) return false;
    const { hash, exp } = JSON.parse(raw) as { hash?: string; exp?: number };
    if (typeof hash !== "string" || typeof exp !== "number" || exp < now)
      return false;
    return hash === (await sha256Hex(m[1]!));
  } catch {
    return false;
  }
}
