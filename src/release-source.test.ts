// Contract test: 配布基盤(update)の manifest を確かめる canonical() は、署名する側
// (Entamy の発行の道具と配布基盤の manifest 検査)と同じバイト列を作る。
// 片方だけ直すと「署名は通らないのに理由が何も出ない」(cms-release)。
import {
  canonical,
  ReleaseError,
  reasonOf,
  updateChannelOf,
} from "./release-source.ts";

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
// Defects へ送る理由は符号(detail は文を受けない)。通信の失敗と確かめの失敗を分ける。
check(
  "確かめの失敗は、その符号のまま",
  reasonOf(new ReleaseError("digest_mismatch", "x")) === "digest_mismatch",
);
const timeout = new Error("t");
timeout.name = "TimeoutError";
check("時間切れは timeout", reasonOf(timeout) === "timeout");
check(
  "届かないは unreachable",
  reasonOf(new TypeError("fetch failed")) === "unreachable",
);
check("それ以外は other", reasonOf("x") === "other");

if (failed) {
  console.error(`${failed} 件失敗`);
  process.exit(1);
}
