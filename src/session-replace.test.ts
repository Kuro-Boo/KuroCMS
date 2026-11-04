// 契約テスト (node で直接実行: `node src/session-replace.test.ts`)。
// ログインでセッションを作るとき、そのブラウザが持っていたセッションを消して置き換える(src/auth.ts の createSession)。
//   ・cookie のセッションは消え、新しい 1 つだけが残る(同じブラウザで入り直しても増えない)
//   ・cookie が無ければ何も消さない。ほかのブラウザのセッションは残る
import { DatabaseSync } from "node:sqlite";
import { createSession, sessionKey } from "./auth.ts";
import type { Env } from "./types.ts";

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
`);
// 表は cookie の値の SHA-256 を持つ(課題 cc941872)。
const K = sessionKey;
for (const v of ["sess_this_browser", "sess_other_browser"]) {
  raw
    .prepare(
      "INSERT INTO sessions VALUES (?, 'u1', '2999-01-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', 'cred_a')",
    )
    .run(await K(v));
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
const env = { DB: { prepare: (sql: string) => stmt(sql) } } as unknown as Env;
const ids = () =>
  (
    raw
      .prepare("SELECT session_id FROM sessions ORDER BY session_id")
      .all() as { session_id: string }[]
  ).map((r) => r.session_id);
const login = (cookie?: string) =>
  new Request("https://example.test/api/auth/passkey/login", {
    method: "POST",
    headers: cookie ? { cookie } : {},
  });

const fresh = await createSession(
  env,
  login("theme=dark; kurocms_session=sess_this_browser"),
  "u1",
  "cred_a",
);
check(
  "このブラウザの前のセッションは消え、新しいものに置き換わる",
  ids(),
  [await K(fresh), await K("sess_other_browser")].sort(),
);

const again = await createSession(
  env,
  login("kurocms_session=" + fresh),
  "u1",
  "cred_a",
);
check(
  "同じブラウザで入り直しても増えない",
  ids(),
  [await K(again), await K("sess_other_browser")].sort(),
);

const noCookie = await createSession(env, login(), "u1", "cred_a");
check(
  "cookie が無ければ何も消さない",
  ids(),
  [await K(again), await K(noCookie), await K("sess_other_browser")].sort(),
);

check(
  "表には cookie の値そのものを持たない",
  ids().some((x) => x.startsWith("sess_")),
  false,
);

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall ok");
