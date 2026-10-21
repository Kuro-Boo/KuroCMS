/**
 * 持ち主の連絡先(古い導入。cms-admin-integration「連絡先の登録」・2026-10-19)。
 *
 * 受付より前の仕組みで入れた導入には、持ち主へ連絡する手段が無い。管理画面から持ち主に
 * 確かめたメールアドレスを登録してもらい、Entamy ID の「導入の持ち主」に結ぶ。結んだ持ち主は、
 * 委託運用へ引っ越すときの契約の持ち主にもなる(cms-move-to-self「入口は CMS の画面」・2026-10-21)。
 *
 * 導入口で入れた導入(v2)は、入れたときに Entamy ID でログインした人が持ち主として導入口の記録に
 * 残っている。改めて登録を求めない(cms-unified-update)—— ID に結び付きが無くても、導入口に
 * 持ち主が分かるかを訊いて installer と読む。
 *
 * **ここに書くのは製品の判断だけ。** ID との通信・証・セッションは entamy-connect が持つ
 * (`EntamySession` の持ち主の口)。メールアドレスは KuroCMS に写さない —— 画面に出すときは、
 * そのつど ID に訊く。
 */
import { entamyPort } from "./entamy-port.ts";
import { optedOut } from "./entamy.ts";
import { clearSiteProof, makeSiteProof } from "./site-proof.ts";
import type { Env } from "./types.ts";

/** 了承の文面の版。**文面(ダイアログの説明・メール)を変えたら上げる。** */
export const CONTACT_CONSENT_VERSION = "2026-10-21";
/**
 * 確認の頁。製品の場所(宣伝ページ)に置く —— 利用者に基盤を見せない(ID の原則)。
 * 導入ごとの管理画面へは戻さない(戻り先の一覧が導入の数だけ広がる)。
 */
const OWNER_PAGE = "https://kurocms.entamy.com/owner/";
/** 「登録しない」を選んだ印。設定画面から登録すれば外す。 */
const K_DECLINED = "system:contact_declined";

export type ContactState =
  | { state: "opted_out" }
  | { state: "unavailable" }
  /** 導入口で入れた導入。持ち主は導入口の記録にある(登録を求めない)。 */
  | { state: "installer" }
  | {
      state: "linked";
      email: string;
      consentVersion: string;
      linkedAt: string;
      pending: { email: string; expiresAt: string } | null;
    }
  | {
      state: "none";
      declined: boolean;
      pending: { email: string; expiresAt: string } | null;
    };

/** いまの状態。**訊けないこと(圏外)を「未登録」と読まない**(ダイアログを出さない)。 */
export async function contactState(env: Env): Promise<ContactState> {
  if (await optedOut(env)) return { state: "opted_out" };
  let declined = false;
  try {
    declined = (await env.PUBLIC_PAGES.get(K_DECLINED)) === "1";
  } catch {
    /* 読めなければ出す側に倒す(「後で」で閉じられる) */
  }
  try {
    const port = await entamyPort(env);
    const res = await port.session.ownerLink();
    if (!res.ok) return { state: "unavailable" };
    const { owner, pending } = res.value;
    if (owner) {
      return {
        state: "linked",
        email: owner.email,
        consentVersion: owner.consentVersion,
        linkedAt: owner.linkedAt,
        pending,
      };
    }
    // ID に結び付きが無くても、導入口で入れた導入なら持ち主は分かっている。訊けなければ未登録と読まない。
    // 短い証を添えて訊く —— 導入口はそれを記録のアドレスで確かめ、ID にも持ち主を結ぶ(持ち主宛ての
    // お知らせがこのサイトにも出るように・ID 第7章)。次に開いたときは ID の結び付きで linked と読む。
    const proof = await makeSiteProof(env).catch(() => undefined);
    const site = await port.session.siteOwner(
      (env.CF_WORKER_NAME ?? "").trim(),
      proof,
    );
    if (proof) await clearSiteProof(env).catch(() => {});
    if (!site.ok) return { state: "unavailable" };
    if (site.value.owner === "record") return { state: "installer" };
    return { state: "none", declined, pending };
  } catch {
    return { state: "unavailable" };
  }
}

const WORDING = {
  ja: {
    subject: "KuroCMS 連絡先メールアドレスの確認",
    text: (site: string) =>
      `KuroCMS（${site}）の管理画面から、このアドレスを連絡先として登録する申し込みがありました。\n\n` +
      "登録すると、このアドレスの Entamy ID がこの CMS の持ち主になります。重要なお知らせ（セキュリティ・更新・バックアップのお願いなど）がこのアドレスに届き、Entamy の委託運用へ引っ越すときは、この Entamy ID が契約の持ち主になります。それ以外には使いません。\n\n" +
      "次のリンクを開き、「確認する」を押すと登録が完了します（有効期限は30分・一度だけ使用できます）。\n\n" +
      "{{link}}\n\n" +
      "心当たりが無い場合は、このメールを破棄してください。何も変わりません。",
  },
  en: {
    subject: "KuroCMS: confirm your contact email address",
    text: (site: string) =>
      `Someone asked, from the KuroCMS admin of ${site}, to register this address as its contact.\n\n` +
      "Once registered, the Entamy ID for this address becomes the owner of this CMS. Important notices about this CMS (security, updates, backup reminders) will be sent to this address, and if the site moves to Entamy managed hosting, this Entamy ID holds the contract. It is not used for anything else.\n\n" +
      'Open the link below and press "Confirm" to finish (valid for 30 minutes, usable once).\n\n' +
      "{{link}}\n\n" +
      "If you did not expect this, please ignore this email. Nothing will change.",
  },
} as const;

export type ContactStartResult =
  | { ok: true }
  | { ok: false; error: string; status: number };

/**
 * 確認のメールを送る。**押されるまで何も変わらない**(前の持ち主も、そのまま)。
 *
 * `site` はメールの本文に出す「どのサイトの登録か」(管理画面の origin)。
 */
export async function startContact(
  env: Env,
  input: { email: string; consent: boolean; lang: string; site: string },
): Promise<ContactStartResult> {
  if (input.consent !== true)
    return { ok: false, error: "consent_required", status: 400 };
  if (await optedOut(env))
    return { ok: false, error: "opted_out", status: 409 };
  const lang = input.lang === "ja" ? "ja" : "en";
  const w = WORDING[lang];
  const port = await entamyPort(env);
  const res = await port.session.beginOwnerLink(
    input.email.trim(),
    `${OWNER_PAGE}?lang=${lang}`,
    {
      consentVersion: CONTACT_CONSENT_VERSION,
      subject: w.subject,
      text: w.text(input.site),
    },
  );
  if (!res.ok) {
    const f = res.failure;
    if (f.kind === "rate_limited")
      return { ok: false, error: "rate_limited", status: 429 };
    if (f.kind === "invalid")
      return { ok: false, error: "invalid_email", status: 400 };
    return { ok: false, error: "unavailable", status: 503 };
  }
  // 登録を選んだので、「登録しない」の印は外す。
  try {
    await env.PUBLIC_PAGES.delete(K_DECLINED);
  } catch {
    /* 残っても、結ばれればダイアログは出ない */
  }
  return { ok: true };
}

export async function removeContact(
  env: Env,
): Promise<{ ok: boolean; removed: boolean }> {
  const port = await entamyPort(env);
  const res = await port.session.removeOwnerLink();
  return res.ok
    ? { ok: true, removed: res.value.removed }
    : { ok: false, removed: false };
}

/** 「登録しない」。ダイアログを出さなくなる(設定画面からはいつでも登録できる)。 */
export async function declineContact(env: Env): Promise<void> {
  await env.PUBLIC_PAGES.put(K_DECLINED, "1");
}
