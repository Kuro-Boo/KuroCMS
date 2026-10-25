// Contract test: 配布基盤(update)の manifest を確かめる canonical() は、署名する側
// (Entamy の発行の道具と配布基盤の manifest 検査)と同じバイト列を作る。
// 片方だけ直すと「署名は通らないのに理由が何も出ない」(cms-release)。
import {
  canonical,
  checkArtifactBytes,
  fetchGithubVerified,
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

// GitHub の予備の道は、署名つきの一覧に照らしてから使う(課題 7abbf662)。
{
  const body = new TextEncoder().encode("worker body");
  const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", body))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const signed = {
    schema: "1",
    product: "cms",
    version: "1.0.0",
    artifacts: [{ name: "worker.js", sha256: sha, size: body.byteLength }],
    signature: { alg: "ed25519", key_id: "k", sig: "s" },
  };
  const reason = async (p: Promise<unknown>) => {
    try {
      await p;
      return "ok";
    } catch (e) {
      return e instanceof ReleaseError ? e.reason : String(e);
    }
  };
  check(
    "一覧と同じバイト列は通る",
    (await reason(checkArtifactBytes(signed, "worker.js", body.buffer))) ===
      "ok",
  );
  const evil = new TextEncoder().encode("worker bodX");
  check(
    "中身が違えば通さない",
    (await reason(checkArtifactBytes(signed, "worker.js", evil.buffer))) ===
      "digest_mismatch",
  );
  check(
    "一覧に無い名前は通さない",
    (await reason(checkArtifactBytes(signed, "other.js", body.buffer))) ===
      "artifact_missing",
  );
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(evil)) as typeof fetch;
  check(
    "GitHub から取った中身が違えば使わない",
    (await reason(
      fetchGithubVerified("https://github.example/w.js", signed, "worker.js"),
    )) === "digest_mismatch",
  );
  globalThis.fetch = (async () =>
    new Response("", { status: 404 })) as typeof fetch;
  check(
    "GitHub に無ければ github_http_404",
    (await reason(
      fetchGithubVerified("https://github.example/w.js", signed, "worker.js"),
    )) === "github_http_404",
  );
  globalThis.fetch = realFetch;
}

if (failed) {
  console.error(`${failed} 件失敗`);
  process.exit(1);
}
