// 契約テスト (node で直接実行: `node src/update-channel.test.ts`)。
// 更新の道を持ち主が開発アカウントかで決める(src/update-channel.ts・仕様 core-feature-flags 2節)。
import { channelAllowed, effectiveChannel } from "./update-channel.ts";

let failed = 0;
function check(name: string, got: unknown, want: unknown): void {
  if (got === want) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(
      `  FAIL ${name}\n    got : ${String(got)}\n    want: ${String(want)}`,
    );
  }
}

// 開発版を使うのは、開発版を選んだ開発アカウントのサイトだけ。
check(
  "開発アカウントが開発版を選べば開発版",
  effectiveChannel("latest", true),
  "latest",
);
check(
  "一般のサイトは開発版を選んでいても安定版",
  effectiveChannel("latest", false),
  "stable",
);
check(
  "開発アカウントでも安定版を選べば安定版",
  effectiveChannel("stable", true),
  "stable",
);
check("保存が無ければ安定版", effectiveChannel(null, true), "stable");
// 開発版へ切り替えられるのは開発アカウントのサイトだけ。安定版へはいつでも。
check(
  "開発アカウントは開発版へ切り替えられる",
  channelAllowed("latest", true),
  true,
);
check(
  "一般のサイトは開発版へ切り替えられない",
  channelAllowed("latest", false),
  false,
);
check("安定版へはいつでも", channelAllowed("stable", false), true);

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
