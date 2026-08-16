/**
 * Entamy ID への導入報告。
 *
 * ## 何のために
 *
 * 「KuroCMS が何件動いていて、どの版か」を知る手立てが今まで無かった。
 * 導入は顧客の Cloudflare アカウント上にあり、こちらから覗く方法が無いので、
 * **導入側から名乗ってもらう**しかない。
 *
 * ## 何を送るか（送らないか）
 *
 * 送るのは導入そのものの形だけ —— 版・選んだテンプレート・件数。
 * **記事の題名も本文も利用者の情報も送らない。**
 * 受け側(Entamy ID)も製品ごとに受け取ってよいキーを持っていて、
 * 宣言外のキーは保存せずに捨てる。送信側と受信側の両方で線を引いている。
 *
 * ## 誰が送っているか
 *
 * 導入時に匿名アカウント(acc_...)を1つ受け取り、以後それで名乗る。
 * **こちらが持つのは端末が作った install_id のハッシュだけ**で、
 * 顧客の名前もメールアドレスも Entamy ID には渡らない。
 *
 * ## 止め方
 *
 * KV の system:entamy_optout を "1" にすると、以後1件も送らない。
 */

import type { Env } from "./types";
import { KUROCMS_VERSION } from "./api";

const ID_BASE = "https://id.entamy.com";
const PRODUCT_ID = "cms";

const K_INSTALL = "system:entamy_install_id";
const K_ACCOUNT = "system:entamy_account";
const K_LAST = "system:entamy_last_report";
const K_OPTOUT = "system:entamy_optout";

// 版が変わらない限り1日1回で足りる。**毎回送っても分かることは増えない。**
const REPORT_INTERVAL_MS = 24 * 3600 * 1000;

type Stored = { account_id: string; refresh_token: string };

async function optedOut(env: Env): Promise<boolean> {
  return (await env.PUBLIC_PAGES.get(K_OPTOUT)) === "1";
}

/** 導入の識別子。**一度作ったら変えない** —— 変えると導入が二重に数えられる。 */
async function installId(env: Env): Promise<string> {
  const existing = await env.PUBLIC_PAGES.get(K_INSTALL);
  if (existing) return existing;
  const id = `${crypto.randomUUID()}-${crypto.randomUUID()}`.replace(/-/g, "");
  await env.PUBLIC_PAGES.put(K_INSTALL, id);
  return id;
}

/** 匿名アカウントを取る（既にあれば使い回す）。 */
async function ensureAccount(env: Env): Promise<Stored | null> {
  const cached = await env.PUBLIC_PAGES.get(K_ACCOUNT);
  if (cached) {
    try {
      return JSON.parse(cached) as Stored;
    } catch {
      /* 壊れていたら取り直す */
    }
  }
  const res = await fetch(`${ID_BASE}/v1/accounts/anonymous`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      product_id: PRODUCT_ID,
      install_id: await installId(env),
      platform: "cloudflare",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as Stored;
  const stored: Stored = {
    account_id: body.account_id,
    refresh_token: body.refresh_token,
  };
  await env.PUBLIC_PAGES.put(K_ACCOUNT, JSON.stringify(stored));
  return stored;
}

/**
 * アクセストークンを取る。**保存しない**（10分で切れるので持つ意味が無い）。
 * リフレッシュは回転するので、新しい方を必ず書き戻す —— 書き戻しに失敗すると
 * 次回から名乗れなくなる。
 */
async function accessToken(env: Env, stored: Stored): Promise<string | null> {
  const res = await fetch(`${ID_BASE}/v1/token/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      product_id: PRODUCT_ID,
      refresh_token: stored.refresh_token,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    // 失効していたら口座から作り直す。**同じ install_id なので導入は増えない。**
    if (res.status === 401) await env.PUBLIC_PAGES.delete(K_ACCOUNT);
    return null;
  }
  const body = (await res.json()) as {
    access_token: string;
    refresh_token: string;
  };
  await env.PUBLIC_PAGES.put(
    K_ACCOUNT,
    JSON.stringify({
      account_id: stored.account_id,
      refresh_token: body.refresh_token,
    }),
  );
  return body.access_token;
}

/** 送る数字を集める。**ここに無いものは送らない。** */
async function collect(env: Env): Promise<Record<string, string | number>> {
  const [docs, media, langs, site, channel] = await Promise.all([
    // mode が公開フラグ（1 = 公開）。**列名は schema に合わせる**
    // ——「published」という列は無い。
    env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN mode = 1 THEN 1 ELSE 0 END) AS published
         FROM documents`,
    ).first<{ total: number; published: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS cnt FROM media_assets").first<{
      cnt: number;
    }>(),
    // 言語は翻訳が1つでもある言語の数。設定上の一覧ではなく**実際に使われている数**。
    env.DB.prepare(
      "SELECT COUNT(DISTINCT lang) AS cnt FROM document_translations",
    ).first<{ cnt: number }>(),
    env.DB.prepare("SELECT template_id FROM site_settings WHERE id = 1").first<{
      template_id: string | null;
    }>(),
    env.PUBLIC_PAGES.get("system:update_channel"),
  ]);
  // 同意した日時。**導入時に書き込まれた値をそのまま運ぶ** ——
  // ここで現在時刻を入れてしまうと「同意した記録」ではなくなる。
  const acceptedAt = await env.PUBLIC_PAGES.get("system:terms_accepted_at");
  const stats: Record<string, string | number> = {
    articles: Number(docs?.total ?? 0),
    published: Number(docs?.published ?? 0),
    media: Number(media?.cnt ?? 0),
    languages: Number(langs?.cnt ?? 0),
    update_channel: channel === "latest" ? "latest" : "stable",
  };
  if (site?.template_id) stats.template_id = String(site.template_id);
  if (acceptedAt) stats.terms_accepted_at = acceptedAt.slice(0, 32);
  return stats;
}

/**
 * 報告する。**失敗しても呼び出し元に影響させない** ——
 * 観測のために CMS の操作が止まるのは本末転倒。
 *
 * force=true は更新の直後に使う。版が変わった瞬間は間隔を待たずに知らせる。
 */
export async function reportInstall(env: Env, force = false): Promise<void> {
  try {
    if (await optedOut(env)) return;

    const version = KUROCMS_VERSION;
    const last = await env.PUBLIC_PAGES.get(K_LAST);
    if (!force && last) {
      try {
        const l = JSON.parse(last) as { at: number; version: string };
        if (l.version === version && Date.now() - l.at < REPORT_INTERVAL_MS)
          return;
      } catch {
        /* 壊れていたら送る */
      }
    }

    const stored = await ensureAccount(env);
    if (!stored) return;
    const token = await accessToken(env, stored);
    if (!token) return;

    await fetch(`${ID_BASE}/v1/installs/report`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        product_id: PRODUCT_ID,
        install_id: await installId(env),
        app_version: version,
        stats: await collect(env),
      }),
      signal: AbortSignal.timeout(10_000),
    });

    await env.PUBLIC_PAGES.put(
      K_LAST,
      JSON.stringify({ at: Date.now(), version }),
    );
  } catch {
    // 握りつぶす。**観測できないことは、動かないことより軽い。**
  }
}
