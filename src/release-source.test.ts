// Contract test: 配布基盤(update)の manifest を確かめる canonical() は、署名する側
// (Entamy の発行の道具と配布基盤の manifest 検査)と同じバイト列を作る。
// 片方だけ直すと「署名は通らないのに理由が何も出ない」(cms-release)。
import { canonical, updateChannelOf } from "./release-source.ts";

let failed = 0;
const check = (name: string, ok: boolean) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failed++;
};

const m = {
  version: "1.0.0",
  signature: { sig: "x" },
  artifacts: [{ size: 1, name: "worker.js", sha256: "a" }],
  product: "cms",
};
check(
  "署名を外し、キーを再帰的に昇順へ並べる",
  canonical(m) ===
    '{"artifacts":[{"name":"worker.js","sha256":"a","size":1}],"product":"cms","version":"1.0.0"}',
);
check(
  "stable は stable、latest は dev",
  updateChannelOf("stable") === "stable" && updateChannelOf("latest") === "dev",
);

if (failed) {
  console.error(`${failed} 件失敗`);
  process.exit(1);
}
