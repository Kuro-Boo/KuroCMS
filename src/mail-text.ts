/**
 * サーバーが送るメールの文(仕様 cms-cms-i18n「管理画面と公開の部品の言語」・段 3・2026-11-25)。
 *
 * 文は言語ごとの表に置き(KuroEditor の job.js と同じ形)、宛先の人の言語で送る。言語の決め方は recipientLang:
 * 宛先の利用者が選んだ管理画面の言語(users.ui_lang) → 画面から届いた言語 → サイトの基本言語 → 英語。
 * 表に無い言語・鍵は英語で補う(読めない言語で届くより英語の方がよい)。
 * ⚠ 鍵を足したら全言語に足す(mail-text.test.ts が抜け・差し込みの食い違いを落とす)。
 */
import { normalizeUiLang, type AdminUiLang } from "./ui-lang.ts";
import type { Env } from "./types.ts";

type Table = Record<string, string>;

export const MAIL_TEXT: Record<AdminUiLang, Table> = {
  ja: {
    recoveryUsedSubject: "[{site}] 新しいパスキーが登録されました",
    recoveryUsedBody:
      "{site} の管理画面に、メールのリンクから新しいパスキーが登録されました({at})。\nほかの端末のログインは切りました。\n心当たりが無い場合は、メールのアカウントを守ったうえで、管理画面のプロフィール → デバイスで知らないパスキーを消してください:\n{admin}\n",
    networkAddedSubject: "[{site}] 新しい回線を登録しました",
    networkAddedLead:
      "{site} の管理画面に、新しい回線からパスキーでログインしたので、その回線を登録しました。",
    networkLabel: "回線",
    networkAddedNote:
      "心当たりがなければ、管理画面のプロフィールの「登録した回線」から外し、パスキーを見直してください。",
    networkConfirmSubject: "[{site}] 新しい回線の確認",
    networkConfirmLead:
      "{site} の管理画面が、登録していない回線から使われようとしたので止めました。",
    networkConfirmAsk:
      "あなたなら、その回線（同じ端末・同じネットワーク）で次のリンクを開き、ボタンを押してください（{minutes} 分間有効）。",
    networkConfirmButton: "この回線を登録する",
    linkFallback:
      "リンクが開けないときは、次のアドレスをブラウザに貼り付けてください:",
    networkConfirmNote:
      "パスキーでログインし直しても登録されます。心当たりがなければ、何もしないでください（登録されません）。",
    contactTestSubject: "[問い合わせフォーム] 試しの送信",
    contactTestBody:
      "問い合わせフォームの送り先({label})の試しです。このメールが届けば、この送り先を選んだフォームの内容もこのアドレスへ届きます。\n",
    contactSiteFallback: "お問い合わせ",
    contactHomepage: "ホームページ",
    contactNoticeMany:
      "このお問い合わせは、次の {n} か所へ同じ内容で届いています。",
    contactNoticeOne: "このお問い合わせは、次の送り先へ届いています。",
    contactNotSent: "(アドレスの確認が済んでいないため、送っていません)",
    contactReplyMany:
      "このメールに返信すると、お問い合わせをくださった方へ直接届きます(ほかの送り先には届きません)。\n返事が重ならないよう、どこから返事をするかを確かめてから返信してください。",
    contactReplyOne:
      "このメールに返信すると、お問い合わせをくださった方へ直接届きます。",
    contactPage: "頁",
    contactAt: "日時",
    contactEmpty: "(未記入)",
    contactVerifySubject: "[{site}] 問い合わせフォームの送り先の確認",
    contactVerifyBody:
      "{site} の問い合わせフォームの送り先に、このアドレス({email})が登録されました(送り先の名前: {label})。\n\n心当たりがあれば、次のリンクを開いて「確認する」を押してください。押すまでは、このアドレスへ問い合わせを届けません。\n{link}\n(7 日のあいだ使えます)\n\n心当たりが無ければ、このメールは捨ててください。何も届きません。\n",
    verifyBadTitle: "リンクが使えません",
    verifyBadBody:
      "このリンクは期限が過ぎたか、正しくありません。サイトの管理者に、確認のメールを送り直してもらってください。",
    verifyTitle: "問い合わせフォームの送り先の確認",
    verifyLead: "{email} を、このサイトの問い合わせフォームの送り先にします。",
    verifyButton: "確認する",
    verifyDoneTitle: "確認しました",
    verifyDoneBody:
      "これから、このアドレスへ問い合わせフォームの内容が届きます。この頁は閉じてかまいません。",
  },
  en: {
    recoveryUsedSubject: "[{site}] A new passkey was registered",
    recoveryUsedBody:
      "A new passkey was registered for {site} using a link sent by email ({at}).\nOther devices have been signed out.\nIf this was not you, secure your email account and remove unknown passkeys in Profile → Devices:\n{admin}\n",
    networkAddedSubject: "[{site}] New network registered",
    networkAddedLead:
      "You signed in to {site} with your passkey from a new network, so it was registered.",
    networkLabel: "Network",
    networkAddedNote:
      "If this wasn't you, remove it under Profile → Registered networks and review your passkeys.",
    networkConfirmSubject: "[{site}] Confirm a new network",
    networkConfirmLead:
      "{site}'s admin was used from a network that isn't registered, so it was blocked.",
    networkConfirmAsk:
      "If it was you, open this link on that network (same device, same connection) and press the button (valid for {minutes} minutes).",
    networkConfirmButton: "Register this network",
    linkFallback:
      "If the button does not open, paste this address into your browser:",
    networkConfirmNote:
      "Signing in again with your passkey also registers it. If it wasn't you, do nothing — it won't be registered.",
    contactTestSubject: "[Contact form] Test message",
    contactTestBody:
      "This is a test of the contact form recipient ({label}). If you receive it, forms that use this recipient will also deliver here.\n",
    contactSiteFallback: "Contact",
    contactHomepage: "Website",
    contactNoticeMany:
      "This inquiry was delivered with the same content to the following {n} recipients.",
    contactNoticeOne: "This inquiry was delivered to the following recipient.",
    contactNotSent:
      " (not sent because the address has not been confirmed yet)",
    contactReplyMany:
      "Replying to this email goes directly to the person who sent the inquiry (not to the other recipients).\nTo avoid duplicate replies, agree on who will reply before replying.",
    contactReplyOne:
      "Replying to this email goes directly to the person who sent the inquiry.",
    contactPage: "Page",
    contactAt: "Date",
    contactEmpty: "(empty)",
    contactVerifySubject: "[{site}] Confirm a contact form recipient",
    contactVerifyBody:
      "This address ({email}) was added as a recipient of the contact form on {site} (recipient name: {label}).\n\nIf you expected this, open the link below and press \u201cConfirm\u201d. Until you do, no inquiries will be delivered to this address.\n{link}\n(valid for 7 days)\n\nIf you did not expect this, ignore this email. Nothing will be delivered.\n",
    verifyBadTitle: "This link cannot be used",
    verifyBadBody:
      "This link has expired or is not valid. Ask the site administrator to send the confirmation email again.",
    verifyTitle: "Confirm a contact form recipient",
    verifyLead: "{email} will receive this site's contact form messages.",
    verifyButton: "Confirm",
    verifyDoneTitle: "Confirmed",
    verifyDoneBody:
      "Contact form messages will now be delivered to this address. You can close this page.",
  },
};

/** 表の文。{名前} に値を入れる。無い言語・鍵は英語。 */
export function mailText(
  lang: AdminUiLang,
  key: string,
  values: Record<string, string | number> = {},
): string {
  const s = MAIL_TEXT[lang]?.[key] ?? MAIL_TEXT.en[key] ?? key;
  return s.replace(/\{([a-zA-Z]+)\}/g, (_, k: string) =>
    values[k] !== undefined ? String(values[k]) : "",
  );
}

/**
 * 宛先の言語。宛先の利用者が選んだ管理画面の言語(users.ui_lang) → 画面から届いた言語(hint) → サイトの
 * 基本言語 → 英語。読めなくても投げない(メールは送る)。
 */
export async function recipientLang(
  env: Env,
  email: string | null | undefined,
  hint?: unknown,
): Promise<AdminUiLang> {
  try {
    if (email) {
      const row = await env.DB.prepare(
        "SELECT ui_lang FROM users WHERE lower(email) = lower(?) LIMIT 1",
      )
        .bind(email)
        .first<{ ui_lang: string | null }>();
      const chosen = normalizeUiLang(row?.ui_lang);
      if (chosen) return chosen;
    }
  } catch {
    /* 読めなければ次へ */
  }
  const fromHint = normalizeUiLang(hint);
  if (fromHint) return fromHint;
  try {
    const s = await env.DB.prepare(
      "SELECT default_lang FROM site_settings WHERE id = 1",
    ).first<{ default_lang: string | null }>();
    const site = normalizeUiLang(s?.default_lang);
    if (site) return site;
  } catch {
    /* 読めなければ英語 */
  }
  return "en";
}
