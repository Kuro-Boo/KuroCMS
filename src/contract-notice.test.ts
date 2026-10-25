// 契約テスト (node で直接実行: `node src/contract-notice.test.ts`)。
// 契約の無い委託へ、データを消す前の知らせ (contract-notice.ts・課題 8396f3b7) を固定する。
//
// ⚠ 守っているのは 3 つ。
//   ① 消す日の 7 日前と前日に、管理者だけへ 1 度ずつ送る(毎時見ても 2 度送らない)。
//   ② 契約がある・委託でない・消す日が無い・消す日を過ぎた時は送らない。
//   ③ 文面はサイトの言語(日本語 / 英語)で、消す日を書く。
import { deletionStage, remindDataDeletion } from "./contract-notice.ts";

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

const DAY = 86_400_000;
const DEL = Date.UTC(2026, 11, 1);

console.log("deletionStage");
check("8 日前は送らない", deletionStage(DEL, DEL - 8 * DAY), null);
check("7 日前", deletionStage(DEL, DEL - 7 * DAY), "7d");
check("3 日前も 7 日前の段", deletionStage(DEL, DEL - 3 * DAY), "7d");
check("前日", deletionStage(DEL, DEL - DAY), "1d");
check("当日以降は送らない", deletionStage(DEL, DEL), null);

interface Row {
  subscription: string;
  delete_at: number | null;
}
function fakeEnv(row: Row | null, lang = "ja", managed = true) {
  const kv = new Map<string, string>();
  return {
    kv,
    env: {
      MEDIA_QUOTA_BYTES: managed ? String(10 * 1024 ** 3) : undefined,
      PUBLIC_PAGES: {
        get: async (k: string) => kv.get(k) ?? null,
        put: async (k: string, v: string) => void kv.set(k, v),
      },
      DB: {
        prepare(sql: string) {
          return {
            first: async () =>
              sql.includes("contract_info")
                ? row
                : { site_name: "黒兎", default_lang: lang },
            all: async () => ({
              results: [{ email: "a@example.com" }, { email: "b@example.com" }],
            }),
          };
        },
      },
    } as never,
  };
}

async function run(): Promise<void> {
  console.log("remindDataDeletion");
  const sent: { to: string[]; subject: string; text: string }[] = [];
  const send = async (m: { to: string[]; subject: string; text: string }) =>
    void sent.push(m);

  const f = fakeEnv({ subscription: "none", delete_at: DEL });
  check(
    "7 日前に送る",
    await remindDataDeletion(f.env, send, DEL - 6 * DAY),
    "7d",
  );
  check("管理者全員へ", sent[0]?.to, ["a@example.com", "b@example.com"]);
  check("日本語の題に日付", sent[0]?.subject.includes("2026-12-01"), true);
  check(
    "同じ段は 2 度送らない",
    await remindDataDeletion(f.env, send, DEL - 5 * DAY),
    null,
  );
  check(
    "前日に送る",
    await remindDataDeletion(f.env, send, DEL - 12 * 3600_000),
    "1d",
  );
  check("送ったのは 2 通", sent.length, 2);

  sent.length = 0;
  check(
    "契約があれば送らない",
    await remindDataDeletion(
      fakeEnv({ subscription: "active", delete_at: DEL }).env,
      send,
      DEL - DAY,
    ),
    null,
  );
  check(
    "消す日が無ければ送らない",
    await remindDataDeletion(
      fakeEnv({ subscription: "none", delete_at: null }).env,
      send,
      DEL - DAY,
    ),
    null,
  );
  check(
    "行が無ければ送らない",
    await remindDataDeletion(fakeEnv(null).env, send, DEL - DAY),
    null,
  );
  check(
    "委託でなければ送らない",
    await remindDataDeletion(
      fakeEnv({ subscription: "none", delete_at: DEL }, "ja", false).env,
      send,
      DEL - DAY,
    ),
    null,
  );
  check("どれも送っていない", sent.length, 0);

  await remindDataDeletion(
    fakeEnv({ subscription: "none", delete_at: DEL }, "en").env,
    send,
    DEL - DAY,
  );
  check(
    "英語のサイトは英語",
    sent[0]?.subject.includes("will be deleted tomorrow"),
    true,
  );
}

await run();
if (failed) {
  console.log(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log("\nすべて OK");
