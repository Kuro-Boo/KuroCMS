// 契約テスト (node で直接実行: `npm run test:timezone`)。
// サイトの時計 (timezone.ts) の切り出し規則を固定する。
//
// ⚠ ここが守っているのは「ビルド側と表示側が同じ暦日を指す」こと。かつては
//   月アーカイブの区切りが UTC、公開ページの日付が閲覧者のローカル TZ という
//   2 つの時計で動いていて、JST 00:00〜08:59 の記事が前月に落ちていた
//   （8 月を選ぶと 9/1 の記事が出る）。以下の期待値はその再発を止める。
import {
  currentZonedMonth,
  isValidTimeZone,
  monthRangeUtc,
  resolveTimeZone,
  zonedDateParts,
  zonedMonth,
} from "./timezone.ts";

let failed = 0;
function check(name: string, got: unknown, want: unknown): void {
  const g = typeof got === "string" ? got : JSON.stringify(got);
  const w = typeof want === "string" ? want : JSON.stringify(want);
  if (g === w) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}\n    got : ${g}\n    want: ${w}`);
  }
}

console.log("resolveTimeZone");
check("未設定は UTC", resolveTimeZone(""), "UTC");
check("null も UTC", resolveTimeZone(null), "UTC");
check("空白だけも UTC", resolveTimeZone("   "), "UTC");
check("壊れた値は UTC に落とす", resolveTimeZone("Mars/Olympus"), "UTC");
check("正しい IANA 名はそのまま", resolveTimeZone("Asia/Tokyo"), "Asia/Tokyo");
check(
  "前後の空白は落とす",
  resolveTimeZone(" America/New_York "),
  "America/New_York",
);

console.log("isValidTimeZone");
check("空文字は許す (= UTC)", isValidTimeZone(""), true);
check("IANA 名は許す", isValidTimeZone("Asia/Tokyo"), true);
check("でたらめは弾く", isValidTimeZone("Not/AZone"), false);

console.log("zonedMonth");
// publish_at は保存時に UTC へ潰される。JST 9/1 00:00 は "2026-08-31T15:00:00Z"。
check(
  "JST 未明の記事は、著者が見た 9 月に入る",
  zonedMonth("2026-08-31T15:00:00.000Z", "Asia/Tokyo"),
  "2026-09",
);
check(
  "同じ値を UTC で読むと 8 月 —— これが壊れていた形",
  zonedMonth("2026-08-31T15:00:00.000Z", "UTC"),
  "2026-08",
);
check(
  "JST 8/31 23:59 は 8 月のまま",
  zonedMonth("2026-08-31T14:59:00.000Z", "Asia/Tokyo"),
  "2026-08",
);
check(
  "UTC より遅れる TZ でも正しい (NY はまだ 8/31)",
  zonedMonth("2026-09-01T02:00:00.000Z", "America/New_York"),
  "2026-08",
);
check("空文字は空文字", zonedMonth("", "Asia/Tokyo"), "");
check("壊れた日付は空文字", zonedMonth("not a date", "Asia/Tokyo"), "");

console.log("monthRangeUtc");
check(
  "JST の 9 月 = UTC 8/31 15:00 から",
  monthRangeUtc("2026-09", "Asia/Tokyo")?.startIso,
  "2026-08-31T15:00:00.000Z",
);
check(
  "JST の 9 月 = UTC 9/30 15:00 まで (半開)",
  monthRangeUtc("2026-09", "Asia/Tokyo")?.endIso,
  "2026-09-30T15:00:00.000Z",
);
check(
  "12 月は年をまたぐ",
  monthRangeUtc("2026-12", "Asia/Tokyo")?.endIso,
  "2026-12-31T15:00:00.000Z",
);
// 米東部の DST は 2026-11-01 に終わる (EDT -04:00 → EST -05:00)。固定オフセットで
// 計算すると月の端が 1 時間ずれる ——「+9 hours」方式を採らない理由。
check(
  "DST 開始側のオフセット (EDT)",
  monthRangeUtc("2026-11", "America/New_York")?.startIso,
  "2026-11-01T04:00:00.000Z",
);
check(
  "DST 終了側のオフセット (EST)",
  monthRangeUtc("2026-11", "America/New_York")?.endIso,
  "2026-12-01T05:00:00.000Z",
);
check("月が壊れていれば null", monthRangeUtc("2026-13", "UTC"), null);
check("年だけでも null", monthRangeUtc("2026", "UTC"), null);
check("空文字も null", monthRangeUtc("", "UTC"), null);

// 区間と月の切り出しが同じ境界を指すこと ——「一覧に入る記事」と「一覧が
// 名乗る月」がずれないための本丸。
for (const tz of [
  "Asia/Tokyo",
  "UTC",
  "America/New_York",
  "Pacific/Auckland",
]) {
  const r = monthRangeUtc("2026-09", tz)!;
  check(`${tz}: 区間の先頭は 9 月`, zonedMonth(r.startIso, tz), "2026-09");
  check(`${tz}: 区間の終端は翌月 (半開)`, zonedMonth(r.endIso, tz), "2026-10");
  check(
    `${tz}: 先頭の 1ms 手前は 8 月`,
    zonedMonth(new Date(Date.parse(r.startIso) - 1).toISOString(), tz),
    "2026-08",
  );
}

console.log("currentZonedMonth");
check(
  "今この瞬間を TZ で読む (JST では既に 9 月)",
  currentZonedMonth("Asia/Tokyo", new Date("2026-08-31T15:30:00.000Z")),
  "2026-09",
);
check(
  "同じ瞬間が UTC では 8 月",
  currentZonedMonth("UTC", new Date("2026-08-31T15:30:00.000Z")),
  "2026-08",
);

console.log("zonedDateParts");
// UTC 8/31(月) 15:00 = JST 9/1(火) 00:00。曜日も 1 日ずれない。
check(
  "JST では 9/1 火曜",
  zonedDateParts("2026-08-31T15:00:00.000Z", "Asia/Tokyo"),
  { year: 2026, month: 9, day: 1, weekday: 2 },
);
check("UTC では 8/31 月曜", zonedDateParts("2026-08-31T15:00:00.000Z", "UTC"), {
  year: 2026,
  month: 8,
  day: 31,
  weekday: 1,
});
check("空文字は null", zonedDateParts("", "UTC"), null);
check("壊れた日付は null", zonedDateParts("nope", "UTC"), null);

if (failed) {
  console.error(`\n${failed} 件失敗しました。`);
  process.exit(1);
}
console.log("\nすべて通りました。");
