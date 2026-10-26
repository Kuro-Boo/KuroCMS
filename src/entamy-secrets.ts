/**
 * Entamy 基盤への接続に使う2つの秘密(2026-10-26・課題 5be5b80e・仕様 cms-cms-auth)。
 *
 *   ENTAMY_STORE_KEY       保管庫(KV)の控え —— 送信鍵・SAT・リフレッシュトークン —— を封じる鍵
 *   ENTAMY_INSTALL_SECRET  導入の名乗り(install_id)に混ぜる秘密
 *
 * どちらも 32 byte の乱数(base64)で、**Worker の Secret** に置く(KV・D1 とは別の境界)。
 *
 * ## 誰が置くか
 *
 * - 新しい導入: 導入口が app を立てたときに置く(Install の products.ts `appSecrets`)。
 * - 既にある導入(この版より前に立てたもの): 顧客導入なら、app が自分のアカウントの鍵(CF_API_TOKEN)で
 *   自分の Secret に置く(下の ensureEntamySecrets)。委託の app は鍵を持たないので置けない ——
 *   無いままなら、封じずに動き続ける(メールを止めない)。
 *
 * ⚠ **一度置いたら作り直さない。** 名乗りの秘密が変わると、D1 の名乗りを失ったときに
 *   別の導入として数え直される。保管庫の鍵が変わると封じた控えが開かなくなる(取り直せるので壊れはしない)。
 * ⚠ Secrets API は呼ぶたびに新しい版を作る。**並べて呼ぶと片方が消える**(cms-20260730-pitfalls)ので、
 *   1本ずつ順に置く。
 */
import type { Env } from "./types.ts";

export const SECRET_NAMES = [
  "ENTAMY_STORE_KEY",
  "ENTAMY_INSTALL_SECRET",
] as const;
export type EntamySecretName = (typeof SECRET_NAMES)[number];

/**
 * 置いている最中・置き終えた印(KV)。別の isolate が別の値を置かないように。
 * **置き終えても印は残す** —— 古い版の isolate はしばらく Secret の無い env のまま動くので、
 * 消すとそちらが作り直して上書きしてしまう。
 */
const PROVISION_KEY = "system:entamy_secret_provision";
/** 置いている途中で落ちたとみなすまで。 */
const RUNNING_STALE_MS = 10 * 60_000;
/** 置き終えたのに env に現れないとみなすまで(古い版の isolate が入れ替わるのを待つ)。 */
const DONE_STALE_MS = 60 * 60_000;
/** 断られたら、次に試すまで空ける(毎分 Cloudflare を叩かず、知らせも毎分にしない)。 */
const FAILED_RETRY_MS = 60 * 60_000;

/**
 * この isolate で置いた値。Secret を置いても、**動いている isolate の env は変わらない**
 * (新しい版の isolate から入る)ので、置いた値はここで使う。
 */
const provided: Partial<Record<EntamySecretName, string>> = {};

export function entamySecret(
  env: Env,
  name: EntamySecretName,
): string | undefined {
  return env[name]?.trim() || provided[name];
}

/**
 * ready 揃っている / provisioned 置いた / unavailable 鍵の無い導入(委託) / busy 置いている最中か、
 * 置き終えて env に現れるのを待っている / failed Cloudflare に断られた(`failed` に名前と HTTP の状態)。
 */
export type ProvisionOutcome =
  | "ready"
  | "provisioned"
  | "unavailable"
  | "busy"
  | "failed";

export interface ProvisionResult {
  outcome: ProvisionOutcome;
  failed?: { name: EntamySecretName; status: number };
}

export interface ProvisionDeps {
  fetch: typeof fetch;
  now: () => number;
}

/** 試験専用。isolate の控えを捨てる。 */
export function __resetEntamySecretsForTest(): void {
  for (const n of SECRET_NAMES) delete provided[n];
}

/**
 * 無い秘密を作って、自分の Secret に置く。**失敗しても投げない**(毎分また試す)。
 */
export async function ensureEntamySecrets(
  env: Env,
  deps: ProvisionDeps = {
    fetch: (i, init) => fetch(i, init),
    now: () => Date.now(),
  },
): Promise<ProvisionResult> {
  const missing = SECRET_NAMES.filter((n) => !entamySecret(env, n));
  if (!missing.length) return { outcome: "ready" };
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID || !env.CF_WORKER_NAME)
    return { outcome: "unavailable" };

  const mark = await readMark(env);
  if (mark) {
    const age = deps.now() - mark.at;
    const wait =
      mark.state === "running"
        ? RUNNING_STALE_MS
        : mark.state === "done"
          ? DONE_STALE_MS
          : FAILED_RETRY_MS;
    if (age < wait) return { outcome: "busy" };
  }
  await env.PUBLIC_PAGES.put(
    PROVISION_KEY,
    JSON.stringify({ state: "running", at: deps.now() }),
  );

  let failed: ProvisionResult["failed"];
  try {
    for (const name of missing) {
      const value = btoa(
        String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
      );
      const res = await deps.fetch(
        `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/${env.CF_WORKER_NAME}/secrets`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${env.CF_API_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name, text: value, type: "secret_text" }),
        },
      );
      const data = (await res.json().catch(() => null)) as {
        success?: boolean;
      } | null;
      if (!res.ok || !data?.success) {
        console.warn("entamy secret provision failed:", name, res.status);
        failed = { name, status: res.status };
        return { outcome: "failed", failed };
      }
      provided[name] = value;
    }
    return { outcome: "provisioned" };
  } finally {
    // 途中で落ちたとき(投げた)は印を消し、次の回にすぐ試す。
    await (
      failed
        ? env.PUBLIC_PAGES.put(
            PROVISION_KEY,
            JSON.stringify({ state: "failed", at: deps.now() }),
          )
        : missing.every((n) => provided[n])
          ? env.PUBLIC_PAGES.put(
              PROVISION_KEY,
              JSON.stringify({ state: "done", at: deps.now() }),
            )
          : env.PUBLIC_PAGES.delete(PROVISION_KEY)
    ).catch(() => {});
  }
}

async function readMark(
  env: Env,
): Promise<{ state: "running" | "done" | "failed"; at: number } | null> {
  try {
    const raw = await env.PUBLIC_PAGES.get(PROVISION_KEY);
    if (!raw) return null;
    const m = JSON.parse(raw) as { state?: string; at?: number };
    return (m.state === "running" ||
      m.state === "done" ||
      m.state === "failed") &&
      typeof m.at === "number"
      ? { state: m.state, at: m.at }
      : null;
  } catch {
    return null;
  }
}
