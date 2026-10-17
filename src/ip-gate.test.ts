// 接続元の登録(IP 制限・ip-gate.ts)の試験。
// 確かめるのは —— 登録は全自動(登録が無い人は次の回線をそのまま登録・パスキーで入った回線を登録)、
// 登録の無い回線から来たクッキーは止めて確認のメールを 1 通だけ送る、確認のリンクは申請した回線から
// 押したときだけ効く、PAT は既定で縛らない、切れば何もしない。
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  enforceNetwork,
  handleNetworkConfirm,
  registerLoginNetwork,
  writeIpGateConfig,
  type IpGateDeps,
} from "./ip-gate.ts";
import type { AuthUser, Env } from "./types";

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  console.log(`  ${g === w ? "ok  " : "FAIL"} ${name}`);
  if (g !== w) {
    failed++;
    console.log(`    got : ${g}\n    want: ${w}`);
  }
};

function world() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(
    readFileSync(
      new URL("../migrations/0074_ip_gate.sql", import.meta.url),
      "utf8",
    ),
  );
  raw.exec(
    "CREATE TABLE site_settings (id INTEGER PRIMARY KEY, site_name TEXT); INSERT INTO site_settings VALUES (1, 'My Site');",
  );
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => raw.prepare(sql).get(...(args as never[])) ?? null,
    all: async () => ({ results: raw.prepare(sql).all(...(args as never[])) }),
    run: async () => {
      const r = raw.prepare(sql).run(...(args as never[]));
      return { meta: { changes: Number(r.changes) } };
    },
  });
  const kv = new Map<string, string>();
  const env = {
    DB: { prepare: (sql: string) => stmt(sql) },
    PUBLIC_PAGES: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
    },
    ACCESS_ADMIN_URL: "/kurocms/admin",
  } as unknown as Env;
  const mails: Array<{ to: string; subject: string; text: string }> = [];
  let now = 1_800_000_000_000;
  const deps: IpGateDeps = {
    now: () => now,
    sendMail: async (_env, m) => void mails.push(m),
  };
  return { raw, env, mails, deps, tick: (ms: number) => (now += ms) };
}

const req = (
  ip: string,
  path = "/kurocms/api/admin/documents",
  init: RequestInit = {},
) =>
  new Request(`https://site.example${path}`, {
    ...init,
    headers: { "cf-connecting-ip": ip, ...(init.headers ?? {}) },
  });

const alice: AuthUser = {
  uid: "u1",
  email: "alice@example.com",
  isAdmin: true,
  isAuthor: true,
  sessionId: "s1",
  authSource: "session",
};
const HOME = "2400:4051:abcd:1200:1111:2222:3333:4444";
const HOME2 = "2400:4051:abcd:1200:aaaa:bbbb:cccc:dddd"; // 同じ /64
const AWAY = "2001:db8:9999:1::1";

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "passed";
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
}

console.log("ip-gate");
{
  const w = world();
  eq(
    "登録が 1 つも無い人は、その回線をそのまま登録して通す(更新で締め出さない)",
    await code(enforceNetwork(w.env, req(HOME), alice, w.deps)),
    "passed",
  );
  eq(
    "同じ /64 の別アドレスも通る",
    await code(enforceNetwork(w.env, req(HOME2), alice, w.deps)),
    "passed",
  );
  eq(
    "登録の無い回線から来たクッキーは止める",
    await code(enforceNetwork(w.env, req(AWAY), alice, w.deps)),
    "network_unregistered",
  );
  eq(
    "確認のメールを本人へ 1 通",
    w.mails.map((m) => m.to),
    ["alice@example.com"],
  );
  await code(enforceNetwork(w.env, req(AWAY), alice, w.deps));
  eq("10 分の間は同じ回線へ送り直さない", w.mails.length, 1);
  w.tick(11 * 60 * 1000);
  await code(enforceNetwork(w.env, req(AWAY), alice, w.deps));
  eq("10 分を過ぎたらまた送る", w.mails.length, 2);

  const link =
    /\/kurocms\/api\/auth\/network\/confirm\?t=([A-Za-z0-9_-]+)/.exec(
      w.mails[1]!.text,
    )!;
  eq("リンクは API の確認の口へ向く", !!link, true);
  const token = link[1]!;
  const get = await handleNetworkConfirm(
    req(AWAY, `/kurocms/api/auth/network/confirm?t=${token}`),
    w.env,
    w.deps,
  );
  eq(
    "GET は頁を出すだけ(押すまで登録しない)",
    [get.status, await code(enforceNetwork(w.env, req(AWAY), alice, w.deps))],
    [200, "network_unregistered"],
  );
  const post = (ip: string) =>
    handleNetworkConfirm(
      req(ip, "/kurocms/api/auth/network/confirm", {
        method: "POST",
        body: `t=${token}`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
      w.env,
      w.deps,
    );
  eq("申請と違う回線から押しても登録しない", (await post(HOME)).status, 403);
  eq("申請した回線から押せば登録する", (await post(AWAY)).status, 200);
  eq(
    "登録した回線は通る",
    await code(enforceNetwork(w.env, req(AWAY), alice, w.deps)),
    "passed",
  );
  eq("リンクは 1 回だけ", (await post(AWAY)).status, 410);
}
{
  const w = world();
  await registerLoginNetwork(
    w.env,
    req(HOME),
    "u1",
    "alice@example.com",
    w.deps,
  );
  eq("初めての回線のログインは知らせない", w.mails.length, 0);
  await registerLoginNetwork(
    w.env,
    req(AWAY),
    "u1",
    "alice@example.com",
    w.deps,
  );
  eq(
    "新しい回線からパスキーで入ったら登録して知らせる",
    [
      w.mails.length,
      await code(enforceNetwork(w.env, req(AWAY), alice, w.deps)),
    ],
    [1, "passed"],
  );
  await registerLoginNetwork(
    w.env,
    req(AWAY),
    "u1",
    "alice@example.com",
    w.deps,
  );
  eq("登録済みの回線では知らせない", w.mails.length, 1);
}
{
  const w = world();
  const pat: AuthUser = {
    ...alice,
    sessionId: undefined,
    tokenId: "t1",
    authSource: "pat",
  };
  await registerLoginNetwork(
    w.env,
    req(HOME),
    "u1",
    "alice@example.com",
    w.deps,
  );
  eq(
    "PAT は既定で縛らない(AI はクラウドの回線から来る)",
    await code(enforceNetwork(w.env, req(AWAY), pat, w.deps)),
    "passed",
  );
  await writeIpGateConfig(w.env, { enabled: true, pat: true });
  eq(
    "PAT も縛る設定なら止める",
    await code(enforceNetwork(w.env, req(AWAY), pat, w.deps)),
    "network_unregistered",
  );
  await writeIpGateConfig(w.env, { enabled: false });
  eq(
    "切れば何もしない",
    await code(enforceNetwork(w.env, req(AWAY), alice, w.deps)),
    "passed",
  );
  await writeIpGateConfig(w.env, { enabled: true, ipv4: false });
  eq(
    "受け付けない族(IPv4)は止める",
    await code(enforceNetwork(w.env, req("203.0.113.7"), alice, w.deps)),
    "network_family_not_allowed",
  );
  eq(
    "IPv4 と IPv6 の両方は切れない",
    await code(writeIpGateConfig(w.env, { ipv4: false, ipv6: false })),
    "ip_gate_no_family",
  );
  eq(
    "接続元の分からない要求(手元の開発)は止めない",
    await code(
      enforceNetwork(
        w.env,
        new Request("https://site.example/x"),
        alice,
        w.deps,
      ),
    ),
    "passed",
  );
}

if (failed) {
  console.error(`${failed} 件失敗`);
  process.exit(1);
}
console.log("すべて OK");
