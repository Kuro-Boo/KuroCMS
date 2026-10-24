// 委託の独自ドメイン(site-domain.ts・core-offering 14 節)の試験。
// 確かめるのは —— 委託でなければ頼まない、知らない action は頼まない、頼むときは Worker の名前と
// 短い証を渡して終わったら証を消す、導入口が断ったら符号のまま返す、届かなければ entamy_unavailable。
import {
  hostOfDomain,
  ownDomainSaveBlocked,
  siteDomain,
  type SiteDomainSession,
} from "./site-domain.ts";
import type { Env } from "./types";

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

function world(managed: boolean) {
  const kv = new Map<string, string>();
  const env = {
    PUBLIC_PAGES: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
      delete: async (k: string) => void kv.delete(k),
    },
    CF_WORKER_NAME: "kurocms-app-ab12cd",
    ...(managed ? { MEDIA_QUOTA_BYTES: String(10 * 1024 ** 3) } : {}),
  } as unknown as Env;
  return { env, kv };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "resolved";
  } catch (e) {
    return String((e as { code?: string }).code ?? e);
  }
}

console.log("site-domain");

{
  const { env } = world(false);
  let asked = 0;
  const session: SiteDomainSession = {
    siteDomain: async () => {
      asked++;
      return { ok: true, value: { domain: null } };
    },
  };
  eq(
    "顧客導入では not_managed",
    await code(siteDomain(env, "status", undefined, session)),
    "not_managed",
  );
  eq("顧客導入では導入口へ頼まない", asked, 0);
}

{
  const { env } = world(true);
  let asked = 0;
  const session: SiteDomainSession = {
    siteDomain: async () => {
      asked++;
      return { ok: true, value: {} };
    },
  };
  eq(
    "知らない action は invalid_request",
    await code(siteDomain(env, "delete-all", undefined, session)),
    "invalid_request",
  );
  eq("知らない action は頼まない", asked, 0);
}

{
  const { env, kv } = world(true);
  let sent: Record<string, unknown> = {};
  const domain = {
    hostname: "harmo.life",
    status: "pending",
    sslStatus: "active",
    switched: false,
  };
  const session: SiteDomainSession = {
    siteDomain: async (body) => {
      sent = body;
      return { ok: true, value: { domain } };
    },
  };
  const res = await siteDomain(env, "prepare", "harmo.life", session);
  eq(
    "Worker の名前と action・hostname を渡す",
    [sent.worker, sent.action, sent.hostname],
    ["kurocms-app-ab12cd", "prepare", "harmo.life"],
  );
  eq("短い証を渡す", /^kproof_/.test(String(sent.proof)), true);
  eq("終わったら証を消す", kv.has("system:site_proof"), false);
  eq("導入口の答えをそのまま返す", res, { domain });
}

{
  const { env, kv } = world(true);
  const session: SiteDomainSession = {
    siteDomain: async () => ({
      ok: false,
      failure: { kind: "server", status: 409, message: "domain_not_verified" },
    }),
  };
  eq(
    "導入口の断りは符号のまま",
    await code(siteDomain(env, "switch", undefined, session)),
    "domain_not_verified",
  );
  eq("断られても証を消す", kv.has("system:site_proof"), false);
}

{
  const { env } = world(true);
  const session: SiteDomainSession = {
    siteDomain: async () => ({
      ok: false,
      failure: { kind: "network", message: "fetch failed" },
    }),
  };
  eq(
    "届かなければ entamy_unavailable",
    await code(siteDomain(env, "status", undefined, session)),
    "entamy_unavailable",
  );
}

// ── 有効になる前の自分のドメインは保存させない(サーバーでも・課題 89b71d8e) ──
{
  const base = {
    fallbackHost: "ab12cd.kurocms.site",
    savedHost: "ab12cd.kurocms.site",
  };
  const active = { hostname: "example.jp", status: "active", switched: true };
  eq(
    "ホスト名を取る(https:// でも名前だけでも)",
    [
      hostOfDomain("https://Example.JP/"),
      hostOfDomain("example.jp"),
      hostOfDomain(""),
    ],
    ["example.jp", "example.jp", ""],
  );
  eq(
    "委託のアドレスへ戻すのは止めない",
    ownDomainSaveBlocked("ab12cd.kurocms.site", { ...base, domain: null }),
    false,
  );
  eq(
    "いま保存されているアドレスは止めない",
    ownDomainSaveBlocked("old.example", {
      ...base,
      savedHost: "old.example",
      domain: null,
    }),
    false,
  );
  eq(
    "準備しただけ(切り替える前)は止める",
    ownDomainSaveBlocked("example.jp", {
      ...base,
      domain: { ...active, switched: false },
    }),
    true,
  );
  eq(
    "証明書がまだ(active でない)は止める",
    ownDomainSaveBlocked("example.jp", {
      ...base,
      domain: { ...active, status: "pending" },
    }),
    true,
  );
  eq(
    "別のドメインを準備しているときは止める",
    ownDomainSaveBlocked("other.jp", { ...base, domain: active }),
    true,
  );
  eq(
    "有効になった自分のドメインは保存できる",
    ownDomainSaveBlocked("example.jp", { ...base, domain: active }),
    false,
  );
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall ok");
