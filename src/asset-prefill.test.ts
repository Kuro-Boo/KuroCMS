// 契約テスト (node で直接実行)。更新の時点で管理画面の部品を KV へ取り寄せておくこと(asset-prefill.ts)。
//
// 固定したいのは ——「**部品だけを取る・既にあるものは取り直さない・1 つ落ちても残りは取る**」。
// 新しい版の部品を最初に開いた人の要求の中で取っていたため、管理画面が開かなかった(2026-11-11)。
import assert from "node:assert/strict";
import {
  KV_PREFIX,
  READY_PREFIX,
  ensureAssets,
  ensureOnce,
  prefillAssets,
} from "./asset-prefill.ts";
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

// ── そろった印(2026-11-21)——「1 つでも落ちたら印を置かない・そろえば置く・印があれば何も取らない」。
// 新しい導入で部品の取り寄せが返らず、管理画面が 10 分ほど開かなかった。部品を頼んだ人の要求では待たず、
// 毎分の刻みと導入口が、印が付くまで取りそろえる。
{
  const kvStore = new Map<string, ArrayBuffer>();
  const kv2 = {
    get: async (k: string) => kvStore.get(k) ?? null,
    put: async (k: string, v: ArrayBuffer) => {
      kvStore.set(k, v);
    },
  };
  let manifestReads = 0;
  let fail = true;
  const got: string[] = [];
  const deps = {
    fetchArtifact: async (name: string) => {
      got.push(name);
      if (fail && name.startsWith("kuro-site")) throw new Error("http_503");
      return new ArrayBuffer(2);
    },
    report: async () => {},
  };
  const load = async () => {
    manifestReads++;
    return manifest;
  };
  const first = await ensureAssets(kv2, "9.9.9", load, deps);
  assert.equal(first.ready, false, "1 つ落ちたら、そろったとは言わない");
  assert.ok(!kvStore.has(READY_PREFIX + "9.9.9"), "落ちたら印を置かない");
  fail = false;
  const second = await ensureAssets(kv2, "9.9.9", load, deps);
  assert.equal(second.ready, true);
  assert.deepEqual(
    second,
    { ready: true, filled: 1, kept: 2, failed: 0 },
    "落ちたものだけを取り直す",
  );
  assert.ok(kvStore.has(READY_PREFIX + "9.9.9"), "そろえば印を置く");
  const before = got.length;
  const third = await ensureAssets(kv2, "9.9.9", load, deps);
  assert.equal(third.ready, true);
  assert.equal(got.length, before, "印があれば何も取らない");
  assert.equal(manifestReads, 2, "印があれば版の一覧も読まない");

  // 同じ isolate で重なった呼び出しは 1 本にまとめる
  let runs = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const job = async () => {
    runs++;
    await gate;
    return { ready: true, filled: 0, kept: 0, failed: 0 };
  };
  const a = ensureOnce("v", job);
  const b = ensureOnce("v", job);
  release();
  await Promise.all([a, b]);
  assert.equal(runs, 1, "重なった取りそろえは 1 本");
  await ensureOnce("v", job);
  assert.equal(runs, 2, "終わった後の呼び出しは、また走る");
}
console.log("asset-prefill: ok");
