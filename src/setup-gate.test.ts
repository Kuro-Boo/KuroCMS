// 初期設定とパスキー登録の証(課題 4dea81be・c4974eea・ddfefa78・migration 0082)の試験。
// 確かめるのは —— 初期設定の鍵が無いと最初の管理者を作れない、uid を知るだけではパスキーを登録できない、
// 登録は始めた時と同じ証でしか完了できない、証は署名を確かめた後で 1 回だけ使い切る、PAT では
// パスキーを足せず新しい PAT も作れない、PAT の役割は範囲と今の役割の重なりだけ。
//
// api.ts は拡張子の無い import で書かれているので、esbuild で 1 つに束ねてから読む(本物の口を叩く)。
// D1 は本物の SQLite に全部の migration を当てる。
import { readdirSync, readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { sha256Hex } from "./crypto.ts";

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

const out = join(mkdtempSync(join(tmpdir(), "kurocms-setup-gate-")), "api.mjs");
await build({
  entryPoints: [new URL("./api.ts", import.meta.url).pathname],
  bundle: true,
  format: "esm",
  platform: "neutral",
  external: ["cloudflare:workers"],
  outfile: out,
  logLevel: "warning",
});
const { handleApi } = (await import(pathToFileURL(out).href)) as {
  handleApi: (r: Request, env: unknown, ctx: unknown) => Promise<Response>;
};

function world() {
  const raw = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    raw.exec(readFileSync(new URL(f, dir), "utf8"));
  }
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
    DB: {
      prepare: (sql: string) => stmt(sql),
      batch: async (list: { run: () => Promise<unknown> }[]) =>
        Promise.all(list.map((x) => x.run())),
    },
    PUBLIC_PAGES: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
      delete: async (k: string) => void kv.delete(k),
      list: async () => ({ keys: [], list_complete: true }),
    },
  };
  return { raw, env };
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
type W = ReturnType<typeof world>;
const call = async (
  w: W,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) => {
  const res = await handleApi(
    new Request(`https://site.example${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    w.env,
    ctx,
  );
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    status: res.status,
    code: (json.error as { code?: string } | undefined)?.code ?? null,
    json,
  };
};

const SETUP = "kcset_" + "s".repeat(48);
const credential = {
  id: "x",
  rawId: "x",
  type: "public-key",
  response: { clientDataJSON: "e30", attestationObject: "AA" },
};

console.log("setup-gate");
{
  const w = world();
  eq(
    "鍵が無くても初期設定の画面は出る(パスキーが 0)",
    (await call(w, "GET", "/api/setup/status")).json.needsSetup,
    true,
  );
  eq(
    "初期設定の鍵が無ければ、最初の管理者を作れない",
    (await call(w, "POST", "/api/setup", { adminEmail: "a@example.com" })).code,
    "setup_token_invalid",
  );
  w.raw
    .prepare(
      "INSERT INTO setup_tokens (token_hash, expires_at, created_at) VALUES (?, ?, ?)",
    )
    .run(
      await sha256Hex(SETUP),
      new Date(Date.now() + 86_400_000).toISOString(),
      new Date().toISOString(),
    );
  eq(
    "違う鍵では作れない",
    (
      await call(w, "POST", "/api/setup", {
        setupToken: "kcset_" + "x".repeat(48),
        adminEmail: "a@example.com",
      })
    ).code,
    "setup_token_invalid",
  );
  const ok = await call(w, "POST", "/api/setup", {
    setupToken: SETUP,
    adminEmail: "a@example.com",
  });
  eq("鍵があれば作れる", ok.status, 200);
  const uid = ok.json.uid as string;
  eq(
    "やり直しても管理者は 1 人(アドレスを直す)",
    [
      (
        await call(w, "POST", "/api/setup", {
          setupToken: SETUP,
          adminEmail: "b@example.com",
        })
      ).status,
      w.raw.prepare("SELECT COUNT(*) AS n, MAX(email) AS e FROM users").get(),
    ],
    [200, { n: 1, e: "b@example.com" }],
  );

  eq(
    "uid を知るだけではパスキーを登録できない",
    (await call(w, "POST", "/api/auth/passkey/register/begin", { uid })).code,
    "registration_not_authorized",
  );
  const begin = await call(w, "POST", "/api/auth/passkey/register/begin", {
    setupToken: SETUP,
  });
  eq("初期設定の鍵で登録を始められる", begin.status, 200);
  eq(
    "challenge に証が結び付く",
    w.raw
      .prepare(
        "SELECT auth_kind, auth_hash = ? AS same FROM webauthn_challenges",
      )
      .get(await sha256Hex(SETUP)),
    { auth_kind: "setup", same: 1 },
  );
  eq(
    "完了に鍵が無ければ断る(challenge は残る)",
    [
      (
        await call(w, "POST", "/api/auth/passkey/register/complete", {
          challengeId: begin.json.challengeId,
          credential,
        })
      ).code,
      w.raw.prepare("SELECT COUNT(*) AS n FROM webauthn_challenges").get(),
    ],
    ["registration_not_authorized", { n: 1 }],
  );
  const bad = await call(w, "POST", "/api/auth/passkey/register/complete", {
    challengeId: begin.json.challengeId,
    credential,
    setupToken: SETUP,
  });
  eq(
    "署名が通らなければ、鍵は使い切らない(やり直せる)",
    [bad.code, w.raw.prepare("SELECT used_at FROM setup_tokens").get()],
    ["webauthn_verification_failed", { used_at: null }],
  );
  eq(
    "同じ challenge は 2 度使えない",
    (
      await call(w, "POST", "/api/auth/passkey/register/complete", {
        challengeId: begin.json.challengeId,
        credential,
        setupToken: SETUP,
      })
    ).code,
    "invalid_challenge",
  );
  eq(
    "パスキーが 1 つでもあれば、鍵があっても初期設定は済み",
    await (async () => {
      w.raw
        .prepare(
          "INSERT INTO passkey_credentials (credential_id, uid, public_key_spki, sign_count, created_at) VALUES ('c1', ?, 'k', 0, ?)",
        )
        .run(uid, new Date().toISOString());
      return (
        await call(w, "POST", "/api/auth/passkey/register/begin", {
          setupToken: SETUP,
        })
      ).code;
    })(),
    "setup_completed",
  );
}

{
  // 回復の証は、始めた証で完了しなければならない。
  const w = world();
  const now = new Date().toISOString();
  w.raw
    .prepare(
      "INSERT INTO users (uid, email, author_id, is_admin, is_author, created_at, updated_at) VALUES ('usr_001', 'a@example.com', 'au', 1, 1, ?, ?)",
    )
    .run(now, now);
  w.raw
    .prepare(
      "INSERT INTO passkey_credentials (credential_id, uid, public_key_spki, sign_count, created_at) VALUES ('c1', 'usr_001', 'k', 0, ?)",
    )
    .run(now);
  const REC = "r".repeat(43);
  w.raw
    .prepare(
      "INSERT INTO recovery_tokens (token_hash, uid, email, expires_at, created_at) VALUES (?, 'usr_001', 'a@example.com', ?, ?)",
    )
    .run(
      await sha256Hex(REC),
      new Date(Date.now() + 3_600_000).toISOString(),
      now,
    );
  const begin = await call(w, "POST", "/api/auth/passkey/register/begin", {
    recoveryToken: REC,
  });
  eq("回復の証で始められる", begin.status, 200);
  eq(
    "回復の証を出さずに完了させない",
    (
      await call(w, "POST", "/api/auth/passkey/register/complete", {
        challengeId: begin.json.challengeId,
        credential,
      })
    ).code,
    "registration_not_authorized",
  );
  eq(
    "回復の証は残っている(使い切っていない)",
    w.raw.prepare("SELECT used_at FROM recovery_tokens").get(),
    { used_at: null },
  );
}

{
  // PAT の範囲と、PAT でできないこと。
  const w = world();
  const now = new Date().toISOString();
  w.raw
    .prepare(
      "INSERT INTO users (uid, email, author_id, is_admin, is_author, created_at, updated_at) VALUES ('usr_001', 'a@example.com', 'au', 1, 1, ?, ?)",
    )
    .run(now, now);
  w.raw
    .prepare(
      "INSERT INTO passkey_credentials (credential_id, uid, public_key_spki, sign_count, created_at) VALUES ('c1', 'usr_001', 'k', 0, ?)",
    )
    .run(now);
  const add = async (token: string, scopes: string[]) =>
    w.raw
      .prepare(
        "INSERT INTO personal_access_tokens (token_id, uid, token_hash, name, scopes_json, created_at) VALUES (?, 'usr_001', ?, 'x', ?, ?)",
      )
      .run(
        "pat_" + token.slice(-4),
        await sha256Hex(token),
        JSON.stringify(scopes),
        now,
      );
  const ADMIN = "kuro_" + "a".repeat(40);
  const AUTHOR = "kuro_" + "b".repeat(40);
  await add(ADMIN, ["admin", "author"]);
  await add(AUTHOR, ["author"]);
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  eq(
    "PAT ではパスキーを足せない",
    (
      await call(
        w,
        "POST",
        "/api/auth/passkey/register/begin",
        {},
        bearer(ADMIN),
      )
    ).code,
    "session_required",
  );
  eq(
    "PAT から PAT を作れない",
    (await call(w, "POST", "/api/me/tokens", { name: "y" }, bearer(ADMIN)))
      .code,
    "session_required",
  );
  eq(
    "執筆者だけの鍵は、管理者の利用者でも管理の口を通らない",
    (await call(w, "GET", "/api/users", undefined, bearer(AUTHOR))).status,
    403,
  );
  eq(
    "管理者の範囲の鍵は管理の口を通る",
    (await call(w, "GET", "/api/users", undefined, bearer(ADMIN))).status,
    200,
  );
}

{
  // 公開の migrate の口(課題 afe5e3fa)。外から来た要求(cf-connecting-ip がある)は通さない。
  const w = world();
  eq(
    "外からの migrate は 404",
    (
      await call(w, "POST", "/api/system/migrate", undefined, {
        "cf-connecting-ip": "203.0.113.9",
      })
    ).status,
    404,
  );
  eq(
    "旧名の口も同じ",
    (
      await call(w, "POST", "/api/migrate", undefined, {
        "cf-connecting-ip": "2001:db8::1",
      })
    ).status,
    404,
  );
}

{
  // cookie で名乗る変更の要求は、この管理画面自身から(課題 b936bf55)。
  const w = world();
  const now = new Date().toISOString();
  w.raw
    .prepare(
      "INSERT INTO users (uid, email, author_id, is_admin, is_author, created_at, updated_at) VALUES ('usr_001', 'a@example.com', 'au', 1, 1, ?, ?)",
    )
    .run(now, now);
  w.raw
    .prepare(
      "INSERT INTO sessions (session_id, uid, expires_at, created_at, last_active_at) VALUES ('sess_x', 'usr_001', ?, ?, ?)",
    )
    .run(new Date(Date.now() + 3_600_000).toISOString(), now, now);
  const cookie = { cookie: "kurocms_session=sess_x" };
  eq(
    "別の origin からの cookie の変更は断る",
    (
      await call(
        w,
        "POST",
        "/api/me/tokens",
        { name: "x" },
        { ...cookie, origin: "https://other.example" },
      )
    ).code,
    "cross_origin_request",
  );
  eq(
    "Origin が無く、Sec-Fetch-Site が別のサイトなら断る",
    (
      await call(
        w,
        "POST",
        "/api/me/tokens",
        { name: "x" },
        { ...cookie, "sec-fetch-site": "same-site" },
      )
    ).code,
    "cross_origin_request",
  );
  eq(
    "同じ origin からは通る",
    (
      await call(
        w,
        "POST",
        "/api/me/tokens",
        { name: "x" },
        { ...cookie, origin: "https://site.example" },
      )
    ).status,
    201,
  );
  eq(
    "読むだけの要求は Origin を見ない",
    (
      await call(w, "GET", "/api/me/tokens", undefined, {
        ...cookie,
        origin: "https://other.example",
      })
    ).status,
    200,
  );
}

{
  // 本文は読みながら上限を見る(課題 cfaaee70)。
  const w = world();
  const big = "x".repeat(25 * 1024 * 1024);
  eq(
    "上限を超える JSON は 413(読み切る前に打ち切る)",
    (await call(w, "POST", "/api/setup", { setupToken: big })).code,
    "body_too_large",
  );
}

{
  // バックアップに鍵を入れない(課題 ac344ac4)。
  const w = world();
  const now = new Date().toISOString();
  w.raw
    .prepare(
      "INSERT INTO users (uid, email, author_id, is_admin, is_author, created_at, updated_at) VALUES ('usr_001', 'a@example.com', 'au', 1, 1, ?, ?)",
    )
    .run(now, now);
  w.raw
    .prepare(
      "INSERT INTO sessions (session_id, uid, expires_at, created_at, last_active_at) VALUES ('sess_x', 'usr_001', ?, ?, ?)",
    )
    .run(new Date(Date.now() + 3_600_000).toISOString(), now, now);
  w.raw
    .prepare(
      "UPDATE site_settings SET bluesky_token = 'secret-bsky', site_name = 'S' WHERE id = 1",
    )
    .run();
  w.raw
    .prepare(
      "INSERT INTO external_connections (id, service, label, access_token, token_secret, is_active, created_at, updated_at) VALUES ('sns-001', 'x', 'X', 'tok', 'sec', 1, ?, ?)",
    )
    .run(now, now);
  const cookie = { cookie: "kurocms_session=sess_x" };
  const settings = (
    await call(
      w,
      "GET",
      "/api/system/backup/table/site_settings",
      undefined,
      cookie,
    )
  ).json.rows as Record<string, unknown>[];
  eq(
    "設定の鍵は書き出さない(ほかの値は書き出す)",
    [settings[0]?.site_name, "bluesky_token" in (settings[0] ?? {})],
    ["S", false],
  );
  const conns = (
    await call(
      w,
      "GET",
      "/api/system/backup/table/external_connections",
      undefined,
      cookie,
    )
  ).json.rows as Record<string, unknown>[];
  eq(
    "外部の接続は鍵を外し、つながっていないとして書き出す",
    [
      conns[0]?.id,
      "access_token" in (conns[0] ?? {}),
      "token_secret" in (conns[0] ?? {}),
      conns[0]?.is_active,
    ],
    ["sns-001", false, false, 0],
  );
}

if (failed) {
  console.log(`\n${failed} 件 失敗`);
  process.exit(1);
}
console.log("\nsetup-gate: すべて OK");
