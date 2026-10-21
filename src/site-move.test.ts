// 運用の形の引っ越し(site-move.ts・仕様 cms-move-to-self「CMS の画面から」)の試験。
// 確かめるのは —— 委託運用なら顧客導入へ、顧客導入なら委託運用へ頼む、Worker の名前が無い導入(v1)は
// 頼まずに断る、導入口が断ったら置いた鍵を消して符号のまま返す、走っている引っ越しがあれば鍵を置き替えない。
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  readSiteMoveJob,
  startSiteMove,
  type SiteMoveSession,
} from "./site-move.ts";
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

const JOB = "0f2c7a1e-5b3d-4c8e-9a6f-1d2e3f4a5b6c";

function world(vars: Record<string, string> = {}) {
  const raw = new DatabaseSync(":memory:");
  for (const m of ["0076_move.sql", "0078_move_out.sql"])
    raw.exec(
      readFileSync(new URL(`../migrations/${m}`, import.meta.url), "utf8"),
    );
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => raw.prepare(sql).get(...(args as never[])) ?? null,
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
      delete: async (k: string) => void kv.delete(k),
    },
    ...vars,
  } as unknown as Env;
  return { raw, env };
}

function session(
  answer:
    | { ok: true; value: { jobId: string; statusUrl: string } }
    | {
        ok: false;
        failure: { kind: string; status?: number; message?: string };
      },
  status: Record<string, unknown> | null = null,
) {
  const sent: Array<Record<string, unknown>> = [];
  const s = {
    startSiteMove: async (body: Record<string, unknown>) => {
      sent.push(body);
      return answer;
    },
    siteMoveStatus: async () =>
      status
        ? { ok: true, value: status }
        : { ok: false, failure: { kind: "network" } },
    resumeSiteMove: async () => ({ ok: true, value: undefined }),
  } as unknown as SiteMoveSession;
  return { s, sent };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "passed";
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
}

const accepted = {
  ok: true as const,
  value: {
    jobId: JOB,
    statusUrl: `https://install.example/installer/api/jobs/${JOB}`,
  },
};

console.log("site-move");
{
  // 顧客導入 → 委託運用。鍵を置き、Worker の名前と鍵と時間帯だけを送る。
  const { raw, env } = world({ CF_WORKER_NAME: "kurocms-app-0123abcd" });
  const { s, sent } = session(accepted);
  const job = await startSiteMove(
    env,
    { timeZone: "Asia/Tokyo", accountId: "x" },
    "ja",
    s,
  );
  eq("顧客導入からは委託運用へ", sent[0]?.to, "managed");
  eq("Cloudflare の欄は送らない", "accountId" in (sent[0] ?? {}), false);
  eq("Worker の名前を名乗る", sent[0]?.worker, "kurocms-app-0123abcd");
  const row = raw
    .prepare("SELECT role, token_hash FROM move_state")
    .get() as Record<string, string>;
  eq("移す元の鍵を置く", [row.role, row.token_hash.length], ["source", 64]);
  eq("ジョブを覚える", (await readSiteMoveJob(env))?.id, JOB);
  eq("返すのは進み具合の宛先", job.statusUrl, accepted.value.statusUrl);

  // 走っている間に押し直しても、鍵を置き替えない。
  const before = row.token_hash;
  const busy = session(accepted, { status: "running" });
  eq(
    "走っている間は始めない",
    await code(startSiteMove(env, {}, "ja", busy.s)),
    "move_in_progress",
  );
  eq(
    "鍵はそのまま",
    (
      raw.prepare("SELECT token_hash FROM move_state").get() as Record<
        string,
        string
      >
    ).token_hash,
    before,
  );
  const resumable = session(accepted, {
    status: "error",
    move: { resumable: true },
  });
  eq(
    "再開を待つ間も始めない",
    await code(startSiteMove(env, {}, "ja", resumable.s)),
    "move_in_progress",
  );
  const over = session(accepted, {
    status: "error",
    move: { resumable: false },
  });
  eq(
    "写し始める前に止まったものは、やり直せる",
    await code(startSiteMove(env, {}, "ja", over.s)),
    "passed",
  );
}
{
  // 委託運用 → 顧客導入。Cloudflare の欄も渡す。
  const { env } = world({
    CF_WORKER_NAME: "kurocms-app-0123abcd",
    MEDIA_QUOTA_BYTES: "10737418240",
  });
  const { s, sent } = session(accepted);
  await startSiteMove(
    env,
    {
      accountId: "acct-placeholder",
      token: "t".repeat(40),
      workerOpsToken: "wops_x",
    },
    "ja",
    s,
  );
  eq("委託運用からは顧客導入へ", sent[0]?.to, "self");
  eq(
    "Cloudflare の欄を渡す",
    [sent[0]?.accountId, sent[0]?.workerOpsToken],
    ["acct-placeholder", "wops_x"],
  );
}
{
  // 導入口が断ったら、置いた鍵を消して符号のまま返す。
  const { raw, env } = world({ CF_WORKER_NAME: "kurocms-app-0123abcd" });
  const { s } = session({
    ok: false,
    failure: { kind: "conflict", status: 409, message: "owner_unknown" },
  });
  eq(
    "符号のまま返す",
    await code(startSiteMove(env, {}, "ja", s)),
    "owner_unknown",
  );
  eq(
    "鍵を消す",
    (
      raw.prepare("SELECT token_hash FROM move_state").get() as Record<
        string,
        string
      >
    ).token_hash,
    "",
  );
  eq("ジョブは覚えない", await readSiteMoveJob(env), null);
  const down = session({ ok: false, failure: { kind: "network" } });
  eq(
    "届かなければ entamy_unavailable",
    await code(startSiteMove(env, {}, "ja", down.s)),
    "entamy_unavailable",
  );
}
{
  // 導入口より前の導入(Worker の名前が無い v1)も導入口へ頼む。持ち主は導入口が ID から引くので、自分の口を渡す。
  const { env } = world();
  const { s, sent } = session(accepted);
  await startSiteMove(
    env,
    { api: "https://blog.example.com/kurocms/api/system/move/" },
    "ja",
    s,
  );
  eq("名前は空のまま", sent[0]?.worker, "");
  eq(
    "自分の引っ越しの口を渡す",
    sent[0]?.api,
    "https://blog.example.com/kurocms/api/system/move/",
  );
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall ok");
