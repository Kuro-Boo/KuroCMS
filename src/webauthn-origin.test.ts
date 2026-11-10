// 署名された origin の確かめ(課題 4ace3c76)。ホスト名だけでなく scheme・ポートまで比べ、
// 別サイトの枠の中からの操作(crossOrigin)は受けない。
import { assertClientOrigin } from "./webauthn.ts";

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed++;
    console.log(
      `    got : ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`,
    );
  }
};
const passes = (clientData: Record<string, unknown>) => {
  try {
    assertClientOrigin(clientData, "https://site.example");
    return true;
  } catch {
    return false;
  }
};

eq("同じ origin は通す", passes({ origin: "https://site.example" }), true);
eq(
  "crossOrigin が false なら通す",
  passes({ origin: "https://site.example", crossOrigin: false }),
  true,
);
eq("http の同じホストは断る", passes({ origin: "http://site.example" }), false);
eq("別のポートは断る", passes({ origin: "https://site.example:8443" }), false);
eq("別のホストは断る", passes({ origin: "https://evil.example" }), false);
eq("origin が無ければ断る", passes({}), false);
eq(
  "別サイトの枠の中からは断る",
  passes({ origin: "https://site.example", crossOrigin: true }),
  false,
);

if (failed) {
  console.log(`\n${failed} 件 失敗`);
  process.exit(1);
}
console.log("\nwebauthn-origin: すべて OK");
