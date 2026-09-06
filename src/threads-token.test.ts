import {
  isThreadsTokenDailyCheckTime,
  isThreadsTokenRefreshDue,
  nextThreadsTokenRefreshAt,
  parseThreadsTokenRefreshPayload,
} from "./threads-token.ts";

let failed = 0;
function check(name: string, got: unknown, want: unknown): void {
  const actual = JSON.stringify(got);
  const expected = JSON.stringify(want);
  if (actual === expected) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}\n    got : ${actual}\n    want: ${expected}`);
  }
}

const updatedAt = "2026-09-06T06:13:37.000Z";
const nextAt = "2026-10-06T06:13:37.000Z";

console.log("nextThreadsTokenRefreshAt");
check("成功日時から30日後", nextThreadsTokenRefreshAt(updatedAt), nextAt);
check("未記録は予定なし", nextThreadsTokenRefreshAt(null), null);
check("壊れた日時は予定なし", nextThreadsTokenRefreshAt("invalid"), null);

console.log("isThreadsTokenRefreshDue");
check(
  "30日直前は未到来",
  isThreadsTokenRefreshDue(updatedAt, Date.parse(nextAt) - 1),
  false,
);
check(
  "30日の境界で更新対象",
  isThreadsTokenRefreshDue(updatedAt, Date.parse(nextAt)),
  true,
);
check(
  "既存の未記録トークンは更新対象",
  isThreadsTokenRefreshDue(null, Date.now()),
  true,
);

console.log("isThreadsTokenDailyCheckTime");
check(
  "UTC 00:17だけ日次確認",
  isThreadsTokenDailyCheckTime(Date.parse("2026-09-07T00:17:00Z")),
  true,
);
check(
  "隣の分では確認しない",
  isThreadsTokenDailyCheckTime(Date.parse("2026-09-07T00:18:00Z")),
  false,
);

console.log("parseThreadsTokenRefreshPayload");
check(
  "Meta成功応答を読む",
  parseThreadsTokenRefreshPayload({
    access_token: "next-token",
    expires_in: 5_184_000,
  }),
  { accessToken: "next-token", expiresIn: 5_184_000 },
);
check(
  "トークン欠落を拒否",
  parseThreadsTokenRefreshPayload({ expires_in: 5_184_000 }),
  null,
);
check(
  "期限欠落を拒否",
  parseThreadsTokenRefreshPayload({ access_token: "next-token" }),
  null,
);

if (failed) {
  console.error(`\n${failed} 件失敗しました。`);
  process.exit(1);
}
console.log("\nすべて通りました。");
