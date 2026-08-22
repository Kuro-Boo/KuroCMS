/**
 * KuroCMS から Entamy 基盤へ繋ぐ組み立て。
 *
 * **接続そのものは書かない。** 通信・トークン管理・鍵の回転は
 * `vendor/entamy-client`（EntamyCom/entamy-connect）が持つ（API 仕様 §0.3 MUST）。
 * ここにあるのは「この製品が何者か」と「保管庫をどこに置くか」だけである。
 *
 * ⚠ ここに基盤の HTTP を書き始めた時点で §0.3 は破られている。足りない経路は
 *   entamy-connect へ足して、こちらはそれを呼ぶ。
 */

import {
  EntamyLegal,
  EntamyMailer,
  EntamySat,
  EntamySession,
  EntamyStore,
  type EntamySecrets,
} from "./vendor/entamy-client/index.ts";
import { KUROCMS_VERSION } from "./version.ts";
import type { Env } from "./types.ts";

const PRODUCT_ID = "cms";
/** 保管庫の接頭辞。旧実装の `system:entamy_*` とは別空間に置く。 */
const NAMESPACE = "entamy.cms";

/** 旧実装（自前の entamy.ts）が使っていた KV キー。移行のあいだだけ読む。 */
const LEGACY_INSTALL_KEY = "system:entamy_install_id";
const LEGACY_ACCOUNT_KEY = "system:entamy_account";

/**
 * 保管庫。**KV に置く**。
 *
 * ここに入るのは `account_id` / `refresh_token` / SAT / 送信鍵で、
 * どれも失っても `install_id` から取り直せる（`/v1/accounts/anonymous` は
 * `install_id` で冪等）。だから KV が消えても復旧する。
 *
 * ⚠ `install_id` だけはここに置かない。KV は
 *   `siteUnpublish()` / `restoreWipePages()` に全消しされるので、
 *   **消えると別の導入として数え直される**（→ `resolveInstallId`）。
 */
function kvSecrets(env: Env): EntamySecrets {
  return {
    async read(key) {
      try {
        return await env.PUBLIC_PAGES.get(key);
      } catch {
        // KV が読めないことと「値が無い」ことは違うが、呼び出し側から見れば
        // どちらも「取り直す」で正しく回る（取り直しは冪等）。
        return null;
      }
    },
    async write(key, value) {
      try {
        await env.PUBLIC_PAGES.put(key, value);
      } catch {
        /* 書けなければ次回また取り直す。落とすほどのことではない。 */
      }
    },
    async delete(key) {
      try {
        await env.PUBLIC_PAGES.delete(key);
      } catch {
        /* 同上 */
      }
    },
  };
}

/**
 * この導入を表す識別子。**必ず同じ値に戻ること**が唯一かつ最大の要件である
 * （API 仕様 §0.3.1）。値が変わると匿名口座が増え、増えた口座は統合できない。
 *
 * 決め方は 3 段。上から順に、強いものを優先する。
 *
 *   1. D1 `install_identity` に入っている値
 *   2. 旧実装の KV 値（移行期。あれば種として採用し、以後は D1 が正）
 *   3. 導出値 —— `SHA-256(product:CF_ACCOUNT_ID:CF_WORKER_NAME)`
 *
 * 3 が「床」として効くのが要点である。KV が全消しされても、D1 が空でも、
 * バックアップから戻しても、**行き着く先は必ず同じ 1 つの値**になる。
 * 単独案はどれも、自分の弱点を踏むと黙って新しい乱数を作ってしまう ——
 * それが最悪の壊れ方で、後から直せない。
 *
 * ⚠ 導出は決定的なので、D1 の読み取りが失敗しても代替できる。
 *   ここを乱数の種に変えるなら、読み取り失敗時は代替せず再試行に変えること
 *   （保存値と食い違う値で名乗ってしまう）。
 */
async function derivedInstallId(env: Env): Promise<string> {
  const material = [
    PRODUCT_ID,
    (env.CF_ACCOUNT_ID ?? "").trim(),
    (env.CF_WORKER_NAME ?? "").trim(),
  ].join(":");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** isolate 内の控え。決定的な値なので、一度決まれば引き直す理由が無い。 */
let cachedInstallId: string | null = null;

/**
 * 控えを捨てる。**契約テスト専用**（isolate ごとに 1 回しか解決しない作りなので、
 * 1 プロセスで複数の状況を試すには捨てる口が要る）。製品コードから呼ばない。
 */
export function __resetEntamyPortCacheForTest(): void {
  cachedInstallId = null;
  cachedPort = null;
}

export async function resolveInstallId(env: Env): Promise<string> {
  if (cachedInstallId) return cachedInstallId;

  try {
    const row = await env.DB.prepare(
      "SELECT install_id FROM install_identity WHERE id = 1",
    ).first<{ install_id: string }>();
    if (row?.install_id && row.install_id.length >= 16) {
      cachedInstallId = row.install_id;
      return cachedInstallId;
    }
  } catch {
    // 表がまだ無い（migration 前）か、D1 が詰まっている。どちらでも導出値に
    // 落ちる —— 決定的なので、後から D1 が読めるようになっても同じ値である。
  }

  // 種を決める。旧 KV 値があればそれ（既存導入の継続性）、無ければ導出値。
  let seed = "";
  try {
    seed = (await env.PUBLIC_PAGES.get(LEGACY_INSTALL_KEY)) ?? "";
  } catch {
    /* 読めなければ導出値でよい */
  }
  if (seed.length < 16) seed = await derivedInstallId(env);

  try {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO install_identity (id, install_id, created_at) VALUES (1, ?, ?)",
    )
      .bind(seed, Date.now())
      .run();
    // 競合で他方が先に入れていることがある。**入れた値ではなく、入っている
    // 値を読み直す** —— でないと isolate ごとに違う値を使ってしまう。
    const row = await env.DB.prepare(
      "SELECT install_id FROM install_identity WHERE id = 1",
    ).first<{ install_id: string }>();
    if (row?.install_id && row.install_id.length >= 16) {
      cachedInstallId = row.install_id;
      return cachedInstallId;
    }
  } catch {
    /* 書けなければ導出値で進む。次の機会に入る。 */
  }
  cachedInstallId = seed;
  return seed;
}

export interface EntamyPort {
  session: EntamySession;
  sat: EntamySat;
  mailer: EntamyMailer;
  legal: EntamyLegal;
}

/**
 * この isolate 用の窓口。**isolate ごとに 1 組**にする ——
 * session と mailer は単一飛行と控えを持っているので、要求ごとに作り直すと
 * 同時要求の集約が効かず、鍵を二重に発行してしまう。
 */
let cachedPort: EntamyPort | null = null;

export async function entamyPort(env: Env): Promise<EntamyPort> {
  if (cachedPort) return cachedPort;
  const installId = await resolveInstallId(env);
  const config = {
    productId: PRODUCT_ID,
    appVersion: KUROCMS_VERSION,
    storageNamespace: NAMESPACE,
  };
  const store = new EntamyStore(NAMESPACE, kvSecrets(env));
  const session = new EntamySession(config, {
    store,
    // Worker 自身が導入の主体なので、保管庫ではなく外から与える（§0.3.1）。
    installId,
    // 基盤の語彙は ios / android / web。Worker は web に含める。
    platform: "web",
  });
  const sat = new EntamySat(config, session, store);
  const mailer = new EntamyMailer(config, session, sat, store);
  const legal = new EntamyLegal(config, { store });
  cachedPort = { session, sat, mailer, legal };
  return cachedPort;
}

/** 移行の見届け用。旧 KV に口座が残っているか（消してよいかの判断材料）。 */
export async function legacyAccountPresent(env: Env): Promise<boolean> {
  try {
    return !!(await env.PUBLIC_PAGES.get(LEGACY_ACCOUNT_KEY));
  } catch {
    return false;
  }
}
