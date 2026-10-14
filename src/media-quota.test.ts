// 契約テスト (node で直接実行: `node src/media-quota.test.ts`)。
// Entamy 委託のメディア上限 (media-quota.ts) と、上限で断られたときの画面の文を固定する。
//
// ⚠ 守っているのは 2 つ。
//   ① 委託の導入だけが上限を持ち、上限を超える書き込みは断られる。
//   ② 断られたとき、どのアップロードの口でも「上限に達した」と画面の言語で出る。
//      本文への貼り付け(KuroEditor)は失敗を「アップロード失敗: ファイル名」としか
//      出さないので、理由を出すのはこちらの務め。口ごとに書くと一部の口だけ抜ける。
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  exceedsMediaQuota,
  MEDIA_QUOTA_ERROR,
  parseMediaQuota,
} from "./media-quota.ts";

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

const MB = 1024 * 1024;

console.log("parseMediaQuota");
check("委託の値(100 MB)", parseMediaQuota(String(100 * MB)), 100 * MB);
check("前後の空白は落とす", parseMediaQuota(` ${100 * MB} `), 100 * MB);
check("未設定(自社の導入)は上限なし", parseMediaQuota(undefined), null);
check("空も上限なし", parseMediaQuota(""), null);
check("0 は上限なし(全部断るにはしない)", parseMediaQuota("0"), null);
check("負の数は上限なし", parseMediaQuota("-1"), null);
check("数でないものは上限なし", parseMediaQuota("100MB"), null);

console.log("exceedsMediaQuota");
check(
  "上限なしは決して超えない",
  exceedsMediaQuota(10 * 1024 * MB, MB, null),
  false,
);
check(
  "ちょうど上限までは通す",
  exceedsMediaQuota(99 * MB, MB, 100 * MB),
  false,
);
check(
  "1 バイトでも超えれば断る",
  exceedsMediaQuota(99 * MB, MB + 1, 100 * MB),
  true,
);
check(
  "空のときの大きな 1 枚も断る",
  exceedsMediaQuota(0, 101 * MB, 100 * MB),
  true,
);
check(
  "復元(足さずに比べる)は、すでに超えていれば断る",
  exceedsMediaQuota(101 * MB, 0, 100 * MB),
  true,
);

// ── 画面の文 ────────────────────────────────────────────────────────────────
const SRC = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(SRC, p), "utf8");
const main = read("admin.main.ts");
const screens = readdirSync(join(SRC, "admin/screens"))
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ f, s: read(join("admin/screens", f)) }));

console.log("画面の文");
const key = `err_${MEDIA_QUOTA_ERROR}:`;
check(
  "英語と日本語の辞書に上限の言い換えがある",
  main.split(key).length - 1,
  2,
);
check(
  "アップロードの失敗の文は辞書の言い換えを先に見る",
  /function uploadErrorMessage[\s\S]{0,400}errText\(code\)/.test(main),
  true,
);

// 投げるエラーはコードを持つ。持たないと errorMessage が言い換えの "limit" を見て
// Cloudflare の制限の注記を足す(英語の画面で実際に起きた)。
check(
  "uploadError はコードを持たせて投げる",
  /function uploadError\([\s\S]{0,400}e\.code = data\.error\.code/.test(main),
  true,
);

// アップロードの口(/upload か /restore/media/ へ送るところ)が、サーバーの説明を
// 自前で並べずに uploadError / uploadErrorMessage を通しているか。
const rawPattern = /\.error\?\.message \|\|/;
for (const { f, s } of screens) {
  if (!/\/upload"|\/restore\/media\//.test(s)) continue;
  check(
    `${f}: アップロードの失敗は uploadError を通す`,
    /uploadError(Message)?\(/.test(s),
    true,
  );
  check(`${f}: サーバーの説明を自前で並べていない`, rawPattern.test(s), false);
}

// 本文への貼り付け・ドロップ(onMediaUpload)は、投げる前に理由をトーストで出す。
for (const f of ["article-editor.ts", "site.ts"]) {
  const s = screens.find((x) => x.f === f)!.s;
  const hook = s.slice(s.indexOf("onMediaUpload"));
  check(
    `${f}: 本文への貼り付けの失敗は理由をトーストで出す`,
    /const msg = uploadErrorMessage\([\s\S]{0,80}toast\(msg, true\)/.test(hook),
    true,
  );
}

// 本文に残る失敗の印も画面の言語で(KuroEditor 2.40.0 の uploadErrorText)。
for (const f of ["article-editor.ts", "site.ts"]) {
  const s = screens.find((x) => x.f === f)!.s;
  check(
    `${f}: 失敗の印の文を KuroEditor に渡す`,
    /uploadErrorText:[\s\S]{0,80}t\("mediaUploadFailedInline"\)/.test(s),
    true,
  );
}
check(
  "失敗の印の文が英語と日本語の辞書にある",
  main.split("mediaUploadFailedInline:").length - 1,
  2,
);

// 委託はお客様の無料枠ではない —— 見出しを替える。
const dash = screens.find((x) => x.f === "dashboard.ts")!.s;
check(
  "委託のときはダッシュボードの見出しから「無料枠」を外す",
  /managedQuota[\s\S]{0,200}storageManagedUsage/.test(dash),
  true,
);

if (failed) {
  console.log(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log("\nすべて OK");
