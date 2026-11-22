// 契約テスト (node で直接実行)。問い合わせフォーム(cms-contact)。
//
// 固定したいのは ——「送り先はフォームが ID(mail-001…)で選び、アドレスは設定で登録した表から・外のアドレスは確認が済むまで送らない・
// 送り先ごとに 1 通で、冒頭にどこへ届いたかを書く・形は署名で確かめる・課題は 1 回だけ・回数に上限・内容は残さない」。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  buildContactCardHtml,
  normalizeContactForm,
} from "../../KuroEditor/src/contact.js";
import {
  CONTACT_PER_NETWORK_HOUR,
  contactEndpoint,
  contactRecipientList,
  contactVerifyEndpoint,
  contactVerifyLink,
  expandContactForms,
  saveContactRecipient,
  deleteContactRecipient,
  ContactRecipientError,
  recipientsNotice,
} from "./contact-form.ts";
import type { Env } from "./types.ts";

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(
  "CREATE TABLE site_settings (id INTEGER PRIMARY KEY, site_name TEXT, updated_at TEXT, public_domain TEXT, default_lang TEXT)",
);
sqlite.exec(
  "CREATE TABLE taxonomy_items (id TEXT, kind TEXT, lang TEXT, name TEXT, PRIMARY KEY (id, kind, lang))",
);
for (const f of [
  "0091_reaction_rate.sql",
  "0093_contact_form.sql",
  "0094_contact_verified.sql",
  "0095_contact_recipients.sql",
]) {
  sqlite.exec(
    readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"),
  );
}
sqlite.exec(
  "INSERT INTO site_settings (id, site_name, public_domain, default_lang) VALUES (1, 'はなみずき', 'https://hanamizuki.example', 'ja')",
);

const db = {
  prepare(sql: string) {
    const make = (args: unknown[]) => {
      const stmt = sqlite.prepare(sql);
      return {
        async first() {
          return stmt.get(...(args as never[])) || null;
        },
        async all() {
          return { results: stmt.all(...(args as never[])) };
        },
        async run() {
          const r = stmt.run(...(args as never[]));
          return { meta: { changes: Number(r.changes) } };
        },
      };
    };
    return { bind: (...args: unknown[]) => make(args), ...make([]) };
  },
  async batch(stmts: { run: () => Promise<unknown> }[]) {
    for (const st of stmts) await st.run();
  },
};
const kv = new Map<string, string>();
const env = {
  DB: db,
  PUBLIC_PAGES: {
    get: async (k: string) => kv.get(k) ?? null,
    put: async (k: string, v: string) => void kv.set(k, v),
  },
} as unknown as Env;

const sent: {
  to: string[];
  subject: string;
  text: string;
  replyTo?: string;
  idempotencyKey?: string;
}[] = [];
const deps = (now = Date.now()) => ({
  now,
  flagOn: true,
  sendMail: async (
    _e: Env,
    m: {
      to: string[];
      subject: string;
      text: string;
      replyTo?: string;
      idempotencyKey?: string;
    },
  ) => {
    sent.push(m);
    return { path: "mailer" };
  },
});

const form = normalizeContactForm({
  subject: "A型のお申し込み",
  to: ["mail-002", "mail-001"],
  fields: [
    { kind: "name", label: "お名前", required: true },
    { kind: "email", label: "メールアドレス", required: true },
    { kind: "textarea", label: "内容" },
  ],
});
const page = `<main><div class="kuro-content">${buildContactCardHtml(form)}</div></main>`;

// 送り先が登録されていなければ、フォームの代わりに受け付けていないと出す
let html = await expandContactForms(page, env, "", "/syurou_a/", true);
assert.match(html, /受け付けていません/);
assert.doesNotMatch(html, /<form/);
// 受け付けていない間も、項目は押せない見本として見せる(頁で確かめられる・送れない)
assert.match(html, /kuro-contact--closed/);
assert.match(html, /お名前/);
assert.match(
  html,
  /<button type="button" class="kuro-contact__submit" disabled/,
);
assert.doesNotMatch(html, /name="f0"|data-sig=/);

// 送り先の登録: 表示名とアドレスの誤りは欄ごとに断る
for (const [input, field] of [
  [{ label: "", email: "a@example.com" }, "label"],
  [{ label: "x".repeat(41), email: "a@example.com" }, "label"],
  [{ label: "本部", email: "not-mail" }, "email"],
] as const) {
  await assert.rejects(
    saveContactRecipient(env, input),
    (e: unknown) => e instanceof ContactRecipientError && e.field === field,
  );
}

// 外のアドレス(Gmail など)だけでは、確認が済むまで受け付けない。ID は登録した順に mail-001…
{
  const a = await saveContactRecipient(env, {
    label: "A型事業所はなみずき",
    email: "Agata@gmail.example",
  });
  assert.equal(a.recipient.name, "mail-001");
  assert.equal(a.recipient.email, "agata@gmail.example");
  assert.equal(a.emailChanged, true, "新しい送り先には確認のメールを送る");
}
html = await expandContactForms(page, env, "", "/syurou_a/", true);
assert.match(html, /受け付けていません/);

// サイトのドメインのアドレスは確認が要らない
assert.equal(
  (
    await saveContactRecipient(env, {
      label: "本部",
      email: "headoffice@hanamizuki.example",
    })
  ).recipient.name,
  "mail-002",
);
assert.deepEqual(
  (await contactRecipientList(env)).map((r) => [
    r.name,
    r.label,
    r.own,
    r.verified,
  ]),
  [
    ["mail-001", "A型事業所はなみずき", false, false],
    ["mail-002", "本部", true, false],
  ],
);
// 直すのは表示名とアドレスだけ(ID は変わらない)。アドレスを変えないなら確認のメールは送らない
{
  const e = await saveContactRecipient(env, {
    name: "mail-002",
    label: "本部(代表)",
    email: "headoffice@hanamizuki.example",
  });
  assert.equal(e.recipient.name, "mail-002");
  assert.equal(e.emailChanged, false);
  await saveContactRecipient(env, {
    name: "mail-002",
    label: "本部",
    email: "headoffice@hanamizuki.example",
  });
}
// 消した番号は使い回さない(古いフォームが別の送り先を指さない)
{
  const t = await saveContactRecipient(env, {
    label: "消す",
    email: "x@example.com",
  });
  assert.equal(t.recipient.name, "mail-003");
  assert.equal(await deleteContactRecipient(env, "mail-003"), true);
  const u = await saveContactRecipient(env, {
    label: "次",
    email: "y@example.com",
  });
  assert.equal(u.recipient.name, "mail-004");
  await deleteContactRecipient(env, "mail-004");
  await assert.rejects(
    saveContactRecipient(env, {
      name: "mail-003",
      label: "x",
      email: "x@example.com",
    }),
    (e: unknown) => e instanceof ContactRecipientError && e.field === "name",
  );
}

// 旗が効かないサイトでは何もしない
assert.equal(
  await expandContactForms(page, env, "", "/syurou_a/", false),
  page,
);

// 登録に無い名前だけを選んだフォームは受け付けない
assert.match(
  await expandContactForms(
    `<div>${buildContactCardHtml(normalizeContactForm({ ...form, to: ["nowhere"] }))}</div>`,
    env,
    "",
    "/x/",
    true,
  ),
  /受け付けていません/,
);

html = await expandContactForms(page, env, "", "/syurou_a/", true);
assert.match(html, /<form class="kuro-contact kuro-contact--live"/);
assert.doesNotMatch(
  html,
  /data-kuro-block="contact-form"/,
  "見本のブロックは残さない",
);
assert.match(
  html,
  /^<main><div class="kuro-content"><form/,
  "前後の HTML はそのまま",
);
const payload = /data-form="([^"]+)"/.exec(html)![1];
const sig = /data-sig="([^"]+)"/.exec(html)![1];

const ORIGIN = "https://hanamizuki.example";
let ip = 0;
const post = (
  action: string,
  body: unknown,
  init: { origin?: string; ip?: string } = {},
) =>
  new Request(`${ORIGIN}/_contact/${action}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Origin: init.origin ?? ORIGIN,
      "CF-Connecting-IP": init.ip ?? `192.0.2.${++ip}`,
    },
    body: JSON.stringify(body),
  });
const call = async (
  action: string,
  body: unknown,
  init?: { origin?: string; ip?: string },
  now?: number,
) => {
  const r = await contactEndpoint(
    post(action, body, init),
    env,
    action,
    deps(now),
  );
  return { status: r.status, data: (await r.json()) as Record<string, any> };
};
const solve = (salt: string, bits: number) => {
  for (let n = 0; ; n++) {
    const d = createHash("sha256")
      .update(`${salt}:${n.toString(36)}`)
      .digest();
    let left = bits;
    let ok = true;
    for (const b of d) {
      if (left <= 0) break;
      if (left >= 8) {
        if (b !== 0) {
          ok = false;
          break;
        }
        left -= 8;
      } else {
        ok = b >> (8 - left) === 0;
        break;
      }
    }
    if (ok) return n.toString(36);
  }
};
const challengeAndSend = async (
  values: Record<string, string>,
  extra: Record<string, unknown> = {},
  init?: { origin?: string; ip?: string },
) => {
  const ch = await call("challenge", { form: payload, sig }, init);
  assert.equal(ch.status, 200);
  const nonce = solve(ch.data.salt, ch.data.bits);
  return {
    ch: ch.data,
    nonce,
    res: await call(
      "send",
      { form: payload, sig, challenge: ch.data, nonce, values, ...extra },
      init,
    ),
  };
};

// 確認の済んでいない送り先には送らず、届いた側のメールにそのことを書く
{
  const { res } = await challengeAndSend({
    f0: "山田 太郎",
    f1: "taro@example.com",
    f2: "見学したい",
  });
  assert.equal(res.status, 200);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ["headoffice@hanamizuki.example"]);
  assert.equal(sent[0].replyTo, "taro@example.com");
  assert.match(sent[0].subject, /^\[はなみずき\] A型のお申し込み$/);
  assert.match(sent[0].text, /見学したい/);
  assert.match(sent[0].text, /\/syurou_a\//);
  assert.match(
    sent[0].text,
    /agata@gmail\.example\(アドレスの確認が済んでいないため、送っていません\)/,
  );
}

// 確認のリンク: GET はボタンだけ(先に開かれても確認にしない)・別のサイトからの POST・書き換え・期限切れは断る
{
  const link = await contactVerifyLink(env, ORIGIN, "Agata@gmail.example");
  const req = (method: string, url = link, origin = ORIGIN) =>
    new Request(url, { method, headers: { Origin: origin } });
  const get = await contactVerifyEndpoint(req("GET"), env, { flagOn: true });
  assert.equal(get.status, 200);
  assert.match(await get.text(), /確認する/);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM contact_verified").get()!.n,
    0,
  );
  assert.equal(
    (
      await contactVerifyEndpoint(
        req("POST", link, "https://evil.example"),
        env,
        { flagOn: true },
      )
    ).status,
    403,
  );
  const forged = link.replace(
    /e=[^&]+/,
    "e=" + Buffer.from("x@evil.example").toString("base64url"),
  );
  assert.equal(
    (await contactVerifyEndpoint(req("POST", forged), env, { flagOn: true }))
      .status,
    400,
  );
  assert.equal(
    (
      await contactVerifyEndpoint(req("POST"), env, {
        flagOn: true,
        now: Date.now() + 8 * 24 * 3600_000,
      })
    ).status,
    400,
  );
  assert.equal(
    (await contactVerifyEndpoint(req("POST"), env, { flagOn: false })).status,
    404,
  );
  const ok = await contactVerifyEndpoint(req("POST"), env, { flagOn: true });
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /確認しました/);
  assert.equal(
    (await contactRecipientList(env)).find((r) => r.name === "mail-001")!
      .verified,
    true,
  );
}

// 確認が済めば、送り先ごとに 1 通(宛先は 1 つずつ)。冒頭に 2 か所のアドレスと説明
{
  sent.length = 0;
  const { res } = await challengeAndSend({
    f0: "山田 花子",
    f1: "hanako@example.com",
    f2: "見学したい",
  });
  assert.equal(res.status, 200);
  assert.deepEqual(
    sent.map((m) => m.to),
    [["headoffice@hanamizuki.example"], ["agata@gmail.example"]],
  );
  assert.notEqual(sent[0].idempotencyKey, sent[1].idempotencyKey);
  for (const m of sent) {
    assert.match(m.text, /次の 2 か所へ同じ内容で届いています/);
    assert.match(m.text, /・本部 {2}headoffice@hanamizuki\.example/);
    assert.match(m.text, /・A型事業所はなみずき {2}agata@gmail\.example/);
    assert.match(m.text, /どこから返事をするかを確かめてから/);
    assert.doesNotMatch(m.text, /送っていません/);
  }
}
assert.match(
  recipientsNotice([
    {
      name: "a",
      label: "本部",
      email: "a@x.example",
      own: true,
      verified: false,
    },
  ]),
  /^このお問い合わせは、次の送り先へ届いています。/,
);

// 内容をどこにも残さない(D1 の表に送った値が無い)
for (const t of [
  "contact_spent",
  "contact_verified",
  "reaction_rate",
  "site_settings",
  "contact_recipients",
]) {
  const dump = JSON.stringify(sqlite.prepare(`SELECT * FROM ${t}`).all());
  assert.doesNotMatch(
    dump,
    /見学したい|taro@example\.com|hanako@example\.com/,
    `${t} に内容が残っている`,
  );
}

// 同じ課題の答えでは 2 度送れない
{
  const { ch, nonce } = await challengeAndSend({
    f0: "a",
    f1: "a@example.com",
  });
  const again = await call("send", {
    form: payload,
    sig,
    challenge: ch,
    nonce,
    values: { f0: "a", f1: "a@example.com" },
  });
  assert.equal(again.status, 403);
}
// 解いていない(nonce が合わない)・期限切れ・別の頁の Origin・書き換えた形は断る
{
  const ch = (await call("challenge", { form: payload, sig })).data;
  assert.equal(
    (
      await call("send", {
        form: payload,
        sig,
        challenge: ch,
        nonce: "zzzz",
        values: {},
      })
    ).status,
    403,
  );
  const late = await call(
    "send",
    {
      form: payload,
      sig,
      challenge: ch,
      nonce: solve(ch.salt, ch.bits),
      values: {},
    },
    undefined,
    ch.exp + 1,
  );
  assert.equal(late.status, 403);
  assert.equal(
    (
      await call(
        "challenge",
        { form: payload, sig },
        { origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  const tampered = payload.slice(0, -2) + (payload.endsWith("A") ? "BB" : "AA");
  assert.equal((await call("challenge", { form: tampered, sig })).status, 403);
  // 弱い課題(bits を下げた)は署名が合わない
  assert.equal(
    (
      await call("send", {
        form: payload,
        sig,
        challenge: { ...ch, bits: 1 },
        nonce: "0",
        values: {},
      })
    ).status,
    403,
  );
}
// 値の誤りは欄ごとに返し、メールは送らない
{
  const before = sent.length;
  const { res } = await challengeAndSend({ f0: "", f1: "not-mail" });
  assert.equal(res.status, 400);
  assert.deepEqual(Object.keys(res.data.fields).sort(), ["f0", "f1"]);
  assert.equal(sent.length, before);
}
// 罠の欄に値があれば、送ったふりをして捨てる
{
  const before = sent.length;
  const { res } = await challengeAndSend(
    { f0: "bot", f1: "bot@example.com" },
    { website: "http://spam.example" },
  );
  assert.equal(res.status, 200);
  assert.equal(sent.length, before);
}
// 回線ごとの回数の上限
{
  let last = 0;
  for (let i = 0; i <= CONTACT_PER_NETWORK_HOUR; i++) {
    const { res } = await challengeAndSend(
      { f0: "x", f1: "x@example.com" },
      {},
      { ip: "198.51.100.7" },
    );
    last = res.status;
  }
  assert.equal(last, 429);
}
// 旗が効かないサイトの口は 404
{
  const r = await contactEndpoint(
    post("challenge", { form: payload, sig }),
    env,
    "challenge",
    { ...deps(), flagOn: false },
  );
  assert.equal(r.status, 404);
}

console.log("contact-form: OK");
