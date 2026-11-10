// 契約テスト (node で直接実行)。更新の時点で管理画面の部品を KV へ取り寄せておくこと(asset-prefill.ts)。
//
// 固定したいのは ——「**部品だけを取る・既にあるものは取り直さない・1 つ落ちても残りは取る**」。
// 新しい版の部品を最初に開いた人の要求の中で取っていたため、管理画面が開かなかった(2026-11-11)。
import assert from "node:assert/strict";
import { KV_PREFIX, prefillAssets } from "./asset-prefill.ts";
import type { UpdateManifest } from "./release-source.ts";

const manifest = {
  schema: "x",
  product: "cms",
  version: "9.9.9",
  artifacts: [
    { name: "worker.js", sha256: "a" },
    { name: "migrations-manifest.json", sha256: "b" },
    { name: "admin-app.abc123.js", sha256: "c" },
    { name: "ke.2.45.5.css", sha256: "d" },
    { name: "kuro-site.ff00.js", sha256: "e" },
  ],
  signature: { alg: "x", key_id: "x", sig: "x" },
} as unknown as UpdateManifest;

const store = new Map<string, ArrayBuffer>();
store.set(KV_PREFIX + "ke.2.45.5.css", new ArrayBuffer(1));
const kv = {
  get: async (k: string) => store.get(k) ?? null,
  put: async (k: string, v: ArrayBuffer) => {
    store.set(k, v);
  },
};
const fetched: string[] = [];
const reports: Array<{ code: string; detail: Record<string, unknown> }> = [];
const r = await prefillAssets(kv, manifest, {
  fetchArtifact: async (name) => {
    fetched.push(name);
    if (name.startsWith("kuro-site")) throw new Error("http_503");
    return new ArrayBuffer(3);
  },
  report: async (code, detail) => {
    reports.push({
      code,
      detail: detail as unknown as Record<string, unknown>,
    });
  },
});

assert.deepEqual(r, { filled: 1, kept: 1, failed: 1 });
assert.deepEqual(
  fetched,
  ["admin-app.abc123.js", "kuro-site.ff00.js"],
  "部品だけを取り、既にあるものは取らない",
);
assert.ok(store.has(KV_PREFIX + "admin-app.abc123.js"));
assert.ok(!store.has(KV_PREFIX + "worker.js"));
assert.equal(reports.at(-1)?.code, "release_update_ok");
assert.equal(
  reports.filter((x) => x.code === "release_update_failed").length,
  1,
);
console.log("asset-prefill: ok");
