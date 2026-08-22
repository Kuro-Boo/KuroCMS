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
import { entamyPort } from "./entamy-port";
import { needsAgreement } from "./vendor/entamy-client/index.ts";
import { KUROCMS_VERSION } from "./version.ts";

const K_LAST = "system:entamy_last_report";
const K_OPTOUT = "system:entamy_optout";
const K_TERMS_VER = "system:terms_accepted_version";

// 版が変わらない限り1日1回で足りる。**毎回送っても分かることは増えない。**
const REPORT_INTERVAL_MS = 24 * 3600 * 1000;

async function optedOut(env: Env): Promise<boolean> {
  return (await env.PUBLIC_PAGES.get(K_OPTOUT)) === "1";
}

// ⚠ 口座の確保・トークンの回転・install_id の生成は **entamy-connect が持つ**
//    （API 仕様 §0.3）。かつてここに自前実装があり、**refresh token を単一飛行
//    の保護なしに回転させて KV へ書き戻して**いた。失敗はすべて `null` に潰れ、
//    401 なのか通信なのかも残らなかった。
//    入口は `src/entamy-port.ts` の `entamyPort(env).session`。
//    ⚠ install_id は KV ではなく **D1 の install_identity** が正本になった
//      （KV には全消しされる経路があり、消えると導入が二重に数え直される）。

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
  // 版を確認できているか。**「どの版か」だけでは取り残しに気づけない** ——
  // 2026-08 に v1.9.9 のまま固まった個体は、更新の意思も接続も正常に見えて、
  // 実際には版の確認自体が 11 日間ずっと失敗していた。ここに載せておくと
  // 「確認できていない導入が何件あるか」が中央から見える。
  // 送るのは【最後に確認できた日付】だけで、失敗の内容もホスト名も送らない。
  const lastGood = await env.PUBLIC_PAGES.get(
    "system:release_channels_last_good",
  );
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
  const checkedAt = (() => {
    if (!lastGood) return "";
    try {
      const at = (JSON.parse(lastGood) as { at?: string }).at;
      return typeof at === "string" ? at.slice(0, 32) : "";
    } catch {
      return "";
    }
  })();
  if (checkedAt) stats.version_checked_at = checkedAt;
  if (acceptedAt) stats.terms_accepted_at = acceptedAt.slice(0, 32);
  const acceptedVer = await env.PUBLIC_PAGES.get(K_TERMS_VER);
  if (acceptedVer) stats.terms_version = acceptedVer.slice(0, 32);
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

    // 送信は entamy-connect（口座の確保・トークンの回転・単一飛行を持つ）。
    // 何を数えるか（collect）と、送るかどうか（optout / 24h）はこの製品の
    // 判断なので、ここに残す。
    const port = await entamyPort(env);
    const sent = await port.session.reportInstall(await collect(env));
    if (!sent.ok) return; // 次の機会に送る。**観測のために操作を止めない。**

    // ⚠ 基盤が宣言していないキーは保存されずに捨てられる。捨てられた分は
    //   応答の `ignored` に返るので、気づけるように残す（自前実装の頃は
    //   応答を読まず、「送っているのに入らない」に気づけなかった）。
    if (sent.value.ignored.length > 0) {
      console.warn(
        "entamy: install report keys ignored:",
        sent.value.ignored.join(","),
      );
    }

    await env.PUBLIC_PAGES.put(
      K_LAST,
      JSON.stringify({ at: Date.now(), version }),
    );
  } catch {
    // 握りつぶす。**観測できないことは、動かないことより軽い。**
  }
}

/**
 * この導入の匿名アカウント ID。**install_id は返さない。**
 *
 * install_id は「その導入である」ことを名乗るための鍵で、
 * これを知られると他人がこの導入になりすまして観測を送れてしまう
 * （/v1/accounts/anonymous は install_id だけでトークンを返す）。
 * 画面に出してよいのは、鍵ではない方の acc_... だけ。
 */
export async function installIdentity(env: Env): Promise<{
  accountId: string | null;
  reportedAt: string | null;
  optedOut: boolean;
}> {
  // 口座番号は entamy-connect の保管庫が持つ（**通信しない**）。
  const port = await entamyPort(env);
  const [accountId, last, optout] = await Promise.all([
    port.session.accountId(),
    env.PUBLIC_PAGES.get(K_LAST),
    env.PUBLIC_PAGES.get(K_OPTOUT),
  ]);
  let reportedAt: string | null = null;
  try {
    if (last)
      reportedAt = new Date(
        (JSON.parse(last) as { at: number }).at,
      ).toISOString();
  } catch {
    /* 同上 */
  }
  return { accountId, reportedAt, optedOut: optout === "1" };
}

export interface LegalState {
  /** いま有効な版。取得できなければ null（**その場合は何も求めない**）。 */
  currentVersion: string | null;
  acceptedVersion: string | null;
  acceptedAt: string | null;
  /** 再同意が要るか。取得できていないときは false。 */
  needsConsent: boolean;
  termsUrl: string;
  privacyUrl: string;
  summary: string | null;
}

/**
 * 規約の版を問い合わせ、同意済みの版と突き合わせる。
 *
 * **問い合わせは entamy-connect が持つ**（API 仕様 §0.3）。ここに残すのは
 * 「この画面に何を出すか」の組み立てだけ。
 *
 * ⚠ **これは運営者が KuroCMS 側の規約に同意したか**であって、利用者が作る
 *   サイトの規約ページとは別物である（経路も `/api/system/legal` で admin 限定）。
 *
 * **取得できないときは求めない。** 版が分からない状態で同意を迫ると、
 * 何に同意したのかが記録できず、同意そのものが無意味になる。
 * 管理画面の障害で CMS が使えなくなるのも困る。
 */
export async function legalState(env: Env): Promise<LegalState> {
  const port = await entamyPort(env);
  // 試験対象に指定された導入先だけが同意を求められるよう、口座番号を添える
  // （全体が停止中でも、指定した先では確認できるようにするため）。
  const accountId = (await port.session.accountId()) ?? undefined;
  const status = await port.legal.fetchStatus(
    "terms",
    "ja",
    accountId ? { accountId } : {},
  );
  const [acceptedVersion, acceptedAt] = await Promise.all([
    port.legal.agreedVersion(),
    port.legal.agreedAt(),
  ]);
  return {
    currentVersion: status.version ?? null,
    acceptedVersion,
    acceptedAt: acceptedAt ? acceptedAt.toISOString() : null,
    // `requires_reconsent` が立っていない改定（誤字修正など）では聞かない。
    // 版の一致だけで判定していた頃は、直しのたびに全員へ聞いていた。
    needsConsent: needsAgreement(status, acceptedVersion),
    termsUrl: status.termsUrl ?? "https://kuro.boo/terms/",
    privacyUrl: status.privacyUrl ?? "https://kuro.boo/privacy/",
    summary: status.summary ?? null,
  };
}

/** 同意を記録する。**版と時刻を必ず対で残す。** */
export async function recordConsent(env: Env, version: string): Promise<void> {
  const port = await entamyPort(env);
  // 版と日時を対で残す。どちらか欠けると「何にいつ同意したか」を示せない。
  await port.legal.record(version);
  // **ここで Entamy へ報告しない。**
  //
  // 報告は口座の取得・トークンの更新・送信で外部へ3往復する。同意の記録に
  // 巻き込むと、利用者は数秒待たされ、押せていないと思って何度も押す（実際起きた）。
  // 報告は毎分の cron が拾うので、遅れても最大1分。
}
