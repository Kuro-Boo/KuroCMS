/**
 * KuroCMS から Entamy 基盤へ繋ぐ組み立て。
 *
 * **接続そのものは書かない。** 通信・トークン管理・鍵の回転は
 * entamy-connect の web クライアント（モノレポの正本を直接参照）が持つ（API 仕様 §0.3 MUST）。
 * ここにあるのは「この製品が何者か」と「保管庫をどこに置くか」だけである。
 *
 * ⚠ ここに基盤の HTTP を書き始めた時点で §0.3 は破られている。足りない経路は
 *   entamy-connect へ足して、こちらはそれを呼ぶ。
 */

import {
  EntamyDefects,
  EntamyLegal,
  EntamyMailer,
  EntamyNotice,
  EntamySat,
  EntamySession,
  EntamyStore,
  type EntamySecrets,
} from "./vendor/entamy-client/index.ts";
import { sealedSecrets } from "./vendor/entamy-client/index.ts";
import { entamySecret } from "./entamy-secrets.ts";
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
 *
 * **封じて置く**(課題 5be5b80e)。KV を読めるだけで送れる資格の組が手に入らないように、
 * Worker の Secret `ENTAMY_STORE_KEY` で封じる(entamy-secrets.ts)。鍵がまだ無い導入
 * (委託で導入口が置く前の版に立てたもの)は、封じずに動き続ける —— メールを止めない。
 */
function storeSecrets(env: Env): EntamySecrets {
  const key = entamySecret(env, "ENTAMY_STORE_KEY");
  return key ? sealedSecrets(kvSecrets(env), key) : kvSecrets(env);
}

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
 *   3. 導出値 —— `HMAC-SHA256(ENTAMY_INSTALL_SECRET, product:CF_ACCOUNT_ID:CF_WORKER_NAME)`
 *      (秘密がまだ無い導入だけ、旧来の `SHA-256(product:CF_ACCOUNT_ID:CF_WORKER_NAME)`)
 *
 * 3 が「床」として効くのが要点である。KV が全消しされても、D1 が空でも、
 * バックアップから戻しても、**行き着く先は必ず同じ 1 つの値**になる。
 * 単独案はどれも、自分の弱点を踏むと黙って新しい乱数を作ってしまう ——
 * それが最悪の壊れ方で、後から直せない。
 *
 * ⚠ **D1 が読めないときの値は控えない**(次の呼び出しで D1 を読み直す)。導出の材料に秘密を
 *   足したので、D1 に入っている値(秘密を足す前の導出値・旧 KV 値)と床が食い違うことがある ——
 *   食い違う値を isolate に残すと、セッションを取り直すたびに知らない導入として名乗ってしまう。
 *   止めはしない(D1 の過負荷で実際に止まりかけた)。
 *
 * ⚠ 秘密の無い導出値は**推測できる**(アカウント ID と Worker 名を知れば作れる・課題 5be5b80e)。
 *   それで名乗れば導入の口座へ入り、送信鍵を取り直せた。秘密が置かれた導入は
 *   `hardenInstallId` で、口座を変えずに秘密入りの名乗りへ付け替える。
 */
async function floorInstallId(env: Env): Promise<string> {
  // 名乗りの秘密は **Secret に置かれたものだけ**を使う(この isolate で置いたばかりの値は使わない) ——
  // 置いた値が別の isolate に上書きされると、床が D1 の値と食い違う。
  const secret = env.ENTAMY_INSTALL_SECRET?.trim();
  return secret ? secretInstallId(env, secret) : derivedInstallId(env);
}

function material(env: Env): string {
  return [
    PRODUCT_ID,
    (env.CF_ACCOUNT_ID ?? "").trim(),
    (env.CF_WORKER_NAME ?? "").trim(),
  ].join(":");
}

const hex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function secretInstallId(env: Env, secret: string): Promise<string> {
  const raw = Uint8Array.from(atob(secret), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(material(env)),
    ),
  );
}

async function derivedInstallId(env: Env): Promise<string> {
  return hex(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(material(env)),
    ),
  );
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
  notices.clear();
  hardenRetryAt = 0;
}

export async function resolveInstallId(env: Env): Promise<string> {
  if (cachedInstallId) return cachedInstallId;

  let dbReadable = true;
  try {
    const row = await env.DB.prepare(
      "SELECT install_id FROM install_identity WHERE id = 1",
    ).first<{ install_id: string }>();
    if (row?.install_id && row.install_id.length >= 16) {
      cachedInstallId = row.install_id;
      return cachedInstallId;
    }
  } catch {
    // 表がまだ無い（migration 前）か、D1 が詰まっている。床の値で進むが、控えない(上の ⚠)。
    dbReadable = false;
  }

  // 種を決める。旧 KV 値があればそれ（既存導入の継続性）、無ければ導出値。
  let seed = "";
  try {
    seed = (await env.PUBLIC_PAGES.get(LEGACY_INSTALL_KEY)) ?? "";
  } catch {
    /* 読めなければ導出値でよい */
  }
  if (seed.length < 16) seed = await floorInstallId(env);
  if (!dbReadable) return seed;

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
  defects: EntamyDefects;
}

/**
 * この isolate 用の窓口。**isolate ごとに 1 組**にする ——
 * session と mailer は単一飛行と控えを持っているので、要求ごとに作り直すと
 * 同時要求の集約が効かず、鍵を二重に発行してしまう。
 */
let cachedPort: EntamyPort | null = null;

export async function entamyPort(env: Env): Promise<EntamyPort> {
  if (cachedPort) return cachedPort;
  const config = {
    productId: PRODUCT_ID,
    appVersion: KUROCMS_VERSION,
    storageNamespace: NAMESPACE,
    // 送信先の差し替え口。**顧客の環境ごとに変えられる余地を残す** ——
    // 既定は基盤の本番(mailer.entamy.com)。
    // ⚠ 旧名 `KUROMAILER_URL` も読む。**設定済みの環境を止めない**ため
    //   (2026-09-18 に改名。送り先は 2026-08-23 から Entamy Mailer)。
    ...((env.ENTAMY_MAILER_URL ?? env.KUROMAILER_URL)
      ? {
          mailerBaseUrl: (env.ENTAMY_MAILER_URL ?? env.KUROMAILER_URL)!.replace(
            /\/+$/,
            "",
          ),
        }
      : {}),
  };
  const store = new EntamyStore(NAMESPACE, storeSecrets(env));
  const session = new EntamySession(config, {
    store,
    // Worker 自身が導入の主体なので、保管庫ではなく外から与える（§0.3.1）。
    // **関数で渡す** —— D1 が読めなかった時の値を窓口に固定しない(resolveInstallId の ⚠)。
    installId: () => resolveInstallId(env),
    // 基盤の語彙は ios / android / web。Worker は web に含める。
    platform: "web",
  });
  const sat = new EntamySat(config, session, store);
  const mailer = new EntamyMailer(config, session, sat, store);
  const legal = new EntamyLegal(config, { store });
  // 段は既定(符号だけ)のまま。配布する束なので素の言い分は送らない —— 理由は符号で detail に載せる。
  const defects = new EntamyDefects(config, session);
  cachedPort = { session, sat, mailer, legal, defects };
  return cachedPort;
}

/**
 * 窓口を作り直させる(保管庫の鍵をこの isolate で置いたとき —— 次からは封じて置く)。
 */
export function resetEntamyPort(): void {
  cachedPort = null;
  notices.clear();
}

/** 付け替えに失敗したら、次に試すまで空ける(毎分 ID を叩かない)。 */
const HARDEN_RETRY_MS = 60 * 60_000;
let hardenRetryAt = 0;

/**
 * 推測できる名乗り(秘密の無い導出値)を、秘密入りの名乗りへ付け替える(課題 5be5b80e)。
 * **口座は変えない**(ID `POST /v1/installs/rekey`)。付け替えたら D1 の名乗りも替える。
 *
 * 旧 KV から引き継いだ名乗り(旧実装の乱数)は推測できないので、そのままにする。
 * ID で付け替えたのに D1 を書けなかったときは、次の回にもう一度送る —— ID は送り直しを成功で返す。
 */
export async function hardenInstallId(
  env: Env,
  now = Date.now(),
): Promise<"done" | "skipped" | "failed"> {
  const secret = env.ENTAMY_INSTALL_SECRET?.trim();
  if (!secret || now < hardenRetryAt) return "skipped";
  const current = await resolveInstallId(env);
  if (current !== (await derivedInstallId(env))) return "skipped";
  const next = await secretInstallId(env, secret);
  const port = await entamyPort(env);
  const r = await port.session.rekeyInstall(next);
  if (!r.ok) {
    hardenRetryAt = now + HARDEN_RETRY_MS;
    console.warn(
      "entamy install rekey failed:",
      r.failure.kind,
      r.failure.status ?? "",
      r.failure.message ?? "",
    );
    return "failed";
  }
  await env.DB.prepare(
    "UPDATE install_identity SET install_id = ?1 WHERE id = 1 AND install_id = ?2",
  )
    .bind(next, current)
    .run();
  cachedInstallId = next;
  resetEntamyPort();
  return "done";
}

/** 移行の見届け用。旧 KV に口座が残っているか（消してよいかの判断材料）。 */
export async function legacyAccountPresent(env: Env): Promise<boolean> {
  try {
    return !!(await env.PUBLIC_PAGES.get(LEGACY_ACCOUNT_KEY));
  } catch {
    return false;
  }
}

/**
 * お知らせ(Entamy Notice・notice-api)。**この導入の口座で引く** —— 管理画面のブラウザは基盤と
 * 直接つながらない(公開ミラーで差し替えるのは `src/` 直下からの参照だけなので、画面から
 * entamy-connect を取り込めない)。既読と「ほかの製品」の設定は、導入ごと(管理者全員で共通)になる。
 *
 * 言語ごとに1つ作って控える。何を窓で出すか・未読の数・既読の送り直しはライブラリーが決める。
 */
const notices = new Map<string, EntamyNotice>();
export async function entamyNoticeFor(
  env: Env,
  lang: string,
): Promise<EntamyNotice> {
  const key = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(lang) ? lang : "ja";
  const hit = notices.get(key);
  if (hit) return hit;
  const port = await entamyPort(env);
  const n = new EntamyNotice(
    port.session.config,
    port.session,
    new EntamyStore(NAMESPACE, storeSecrets(env)),
    {
      version: KUROCMS_VERSION,
      platform: "web",
      lang: key,
    },
  );
  notices.set(key, n);
  return n;
}
