// 契約テスト (node で直接実行: `node src/me-sessions.test.ts`)。
// ログイン中の端末の一覧とログアウト(src/me-sessions.ts)。
//   ・自分の期限の切れていないセッションだけ。今の端末に印。名前はログインに使ったパスキーのデバイス名
//   ・セッションの ID そのものは返さない(目印だけ)
//   ・ほかの端末はログアウトさせられる。今の端末とほかの人のセッションは消せない
import { DatabaseSync } from "node:sqlite";
import { listMeSessions, revokeMeSession } from "./me-sessions.ts";
import type { AuthUser, Env } from "./types.ts";

let failed = 0;
function check(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.log(`  FAIL ${name}\n    got : ${g}\n    want: ${w}`);
  }
}

const raw = new DatabaseSync(":memory:");
raw.exec(`
  CREATE TABLE sessions (session_id TEXT PRIMARY KEY, uid TEXT, expires_at TEXT, created_at TEXT, last_active_at TEXT, credential_id TEXT);
  CREATE TABLE passkey_credentials (credential_id TEXT PRIMARY KEY, uid TEXT, display_name TEXT);
  INSERT INTO passkey_credentials VALUES ('cred_mac', 'u1', 'MacBook');
  INSERT INTO sessions VALUES ('sess_now', 'u1', '2999-01-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-11-02T10:00:00.000Z', 'cred_mac');
  INSERT INTO sessions VALUES ('sess_old_phone', 'u1', '2999-01-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-10-05T00:00:00.000Z', NULL);
  INSERT INTO sessions VALUES ('sess_expired', 'u1', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', NULL);
  INSERT INTO sessions VALUES ('sess_other_user', 'u2', '2999-01-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', NULL);
`);
const stmt = (sql: string, args: unknown[] = []) => ({
  bind: (...a: unknown[]) => stmt(sql, a),
  first: async () => raw.prepare(sql).get(...(args as never[])) ?? null,
  all: async () => ({ results: raw.prepare(sql).all(...(args as never[])) }),
  run: async () => {
    const r = raw.prepare(sql).run(...(args as never[]));
    return { meta: { changes: Number(r.changes) } };
  },
});
const env = { DB: { prepare: (sql: string) => stmt(sql) } } as unknown as Env;
const me: AuthUser = {
  uid: "u1",
  email: "a@example.com",
  isAdmin: true,
  isAuthor: true,
  sessionId: "sess_now",
  authSource: "session",
};

const list = await listMeSessions(env, me);
check("自分の期限の切れていないセッションだけ", list.length, 2);
check(
  "新しい順・今の端末に印・名前はパスキーのデバイス名",
  list.map((s) => [s.device, s.current]),
  [
    ["MacBook", true],
    [null, false],
  ],
);
check(
  "セッションの ID そのものは返さない",
  JSON.stringify(list).includes("sess_"),
  false,
);

const other = list.find((s) => !s.current)!;
let code = "";
try {
  await revokeMeSession(env, me, list.find((s) => s.current)!.id);
} catch (e) {
  code = (e as { code?: string }).code ?? (e as Error).message;
}
check(
  "今の端末はログアウトさせない(ログアウトで行う)",
  code.includes("current_session"),
  true,
);
check(
  "ほかの端末はログアウトさせられる",
  await revokeMeSession(env, me, other.id),
  { ok: true },
);
check("消えたのはその端末だけ", (await listMeSessions(env, me)).length, 1);
code = "";
try {
  await revokeMeSession(env, { ...me, uid: "u2", sessionId: "x" }, other.id);
} catch (e) {
  code = (e as { code?: string }).code ?? (e as Error).message;
}
check("ほかの人の目印では消せない", code.includes("not_found"), true);
check(
  "ほかの人のセッションは残る",
  (
    raw
      .prepare("SELECT COUNT(*) AS n FROM sessions WHERE uid = 'u2'")
      .get() as { n: number }
  ).n,
  1,
);

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
