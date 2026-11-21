// 契約テスト (node で直接実行)。問い合わせフォーム(cms-contact)。
//
// 固定したいのは ——「送り先は設定の管理者だけ・形は署名で確かめる・課題は 1 回だけ・回数に上限・内容は残さない」。
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
  expandContactForms,
  setContactRecipients,
} from "./contact-form.ts";
import type { Env } from "./types.ts";

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(
  "CREATE TABLE site_settings (id INTEGER PRIMARY KEY, site_name TEXT, updated_at TEXT)",
);
sqlite.exec(
  "CREATE TABLE users (uid TEXT PRIMARY KEY, email TEXT, display_name TEXT, is_admin INTEGER, disabled_at TEXT, email_verified_at TEXT, created_at TEXT)",
);
for (const f of ["0091_reaction_rate.sql", "0093_contact_form.sql"]) {
  sqlite.exec(
    readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"),
  );
}
sqlite.exec(
  "INSERT INTO site_settings (id, site_name) VALUES (1, 'はなみずき')",
);
sqlite.exec(`INSERT INTO users VALUES
  ('u1', 'staff@example.com', '担当', 1, NULL, '2026-01-01', '2026-01-01'),
  ('u2', 'unverified@example.com', '', 1, NULL, NULL, '2026-01-02'),
  ('u3', 'author@example.com', '', 0, NULL, '2026-01-01', '2026-01-03')`);

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
}[] = [];
const deps = (now = Date.now()) => ({
  now,
  flagOn: true,
  sendMail: async (
    _e: Env,
    m: { to: string[]; subject: string; text: string; replyTo?: string },
  ) => {
    sent.push(m);
    return { path: "mailer" };
  },
});

const form = normalizeContactForm({
  subject: "A型のお申し込み",
  fields: [
    { kind: "name", label: "お名前", required: true },
    { kind: "email", label: "メールアドレス", required: true },
    { kind: "textarea", label: "内容" },
  ],
});
const page = `<main><div class="kuro-content">${buildContactCardHtml(form)}</div></main>`;

// 送り先が選ばれていなければ、フォームの代わりに受け付けていないと出す
let html = await expandContactForms(page, env, "", "/syurou_a/", true);
assert.match(html, /受け付けていません/);
assert.doesNotMatch(html, /<form/);

// 届け先に選べるのは、メールを確かめ済みの管理者だけ(他人のアドレス・筆者・未確認は入らない)
assert.deepEqual(
  await setContactRecipients(env, ["u1", "u2", "u3", "x@example.com"]),
  ["u1"],
);

// 旗が効かないサイトでは何もしない
assert.equal(
  await expandContactForms(page, env, "", "/syurou_a/", false),
  page,
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

// 正しい送信はメール 1 通。宛先は設定の管理者だけ。Reply-To は送った人。
{
  const { res } = await challengeAndSend({
    f0: "山田 太郎",
    f1: "taro@example.com",
    f2: "見学したい",
  });
  assert.equal(res.status, 200);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ["staff@example.com"]);
  assert.equal(sent[0].replyTo, "taro@example.com");
  assert.match(sent[0].subject, /^\[はなみずき\] A型のお申し込み$/);
  assert.match(sent[0].text, /見学したい/);
  assert.match(sent[0].text, /\/syurou_a\//);
}
// 内容をどこにも残さない(D1 の表に送った値が無い)
for (const t of ["contact_spent", "reaction_rate", "site_settings", "users"]) {
  const dump = JSON.stringify(sqlite.prepare(`SELECT * FROM ${t}`).all());
  assert.doesNotMatch(
    dump,
    /見学したい|taro@example\.com/,
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
