// 契約テスト (node で直接実行)。更新の道を持ち主が開発アカウントかで決める
// (src/update-channel.ts・仕様 core-feature-flags 2節)。

import { channelAllowed, effectiveChannel } from "./update-channel.ts";

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.log(`  FAIL ${name}\n       got  ${g}\n       want ${w}`);
  }
};

// 開発版を使うのは、開発版を選んだ開発アカウントのサイトだけ
eq("開発版を選んだ開発アカウント", effectiveChannel("latest", true), "latest");
eq(
  "開発版を選んだ一般のアカウント",
  effectiveChannel("latest", false),
  "stable",
);
eq("安定版を選んだ開発アカウント", effectiveChannel("stable", true), "stable");
eq("選んでいない開発アカウント", effectiveChannel(null, true), "stable");

// 開発版へ切り替えられるのは開発アカウントのサイトだけ。安定版へはいつでも
eq("開発アカウントは開発版へ", channelAllowed("latest", true), true);
eq(
  "一般のアカウントは開発版へ行けない",
  channelAllowed("latest", false),
  false,
);
eq("一般のアカウントも安定版へ", channelAllowed("stable", false), true);

if (failed) {
  console.log(`\n${failed} 件が失敗しました。`);
  process.exit(1);
}
