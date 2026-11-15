/**
 * このサイトの短い証(導入口が「頼み手はこのサイトか」を確かめる・ID 第7章「導入の持ち主」・2026-10-21)。
 *
 * 導入口で入れた導入(v2)の持ち主を ID にも結ぶとき、導入口は名乗った Worker の名前から導入の記録を引き、
 * **記録に残したアドレス**でこの証を読めたら結ぶ。名前だけでは、他人の導入の持ち主を自分のサイトに結べて
 * しまう(持ち主宛てのお知らせが他人のサイトに出る)。証は 10 分・使ったら消す。KV にはハッシュだけを置く。
 *
 * 証は 1 つずつ別の鍵(ハッシュの名前)に置く(2026-11-16・利用者「申し込みでエラー。[HTTP 403] forbidden」)。
 * 前は鍵が 1 つだけで、同時に走る頼み(契約の窓の申し込みと、裏で読み直した契約の表示・請求の一覧)が互いの証を
 * 上書きし、先に終わった方が消していたため、導入口が確かめに来たときには別の証か空になっていた。
 */
import { sha256Hex } from "./crypto.ts";
import type { Env } from "./types.ts";

const K_PROOF = "system:site_proof:";
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
  const hash = await sha256Hex(proof);
  await env.PUBLIC_PAGES.put(
    K_PROOF + hash,
    JSON.stringify({ hash, exp: now + TTL_MS }),
    { expirationTtl: TTL_MS / 1000 },
  );
  return proof;
}

/** 使い終えた証を消す。消すのは自分の証だけ(同時に走る別の頼みの証は残す)。 */
export async function clearSiteProof(env: Env, proof: string): Promise<void> {
  await env.PUBLIC_PAGES.delete(K_PROOF + (await sha256Hex(proof)));
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
    const want = await sha256Hex(m[1]!);
    const raw = await env.PUBLIC_PAGES.get(K_PROOF + want);
    if (!raw) return false;
    const { hash, exp } = JSON.parse(raw) as { hash?: string; exp?: number };
    if (typeof hash !== "string" || typeof exp !== "number" || exp < now)
      return false;
    return hash === want;
  } catch {
    return false;
  }
}
