// このサイトの短い証(site-proof.ts)の試験。確かめるのは —— 置いた証だけが通る、期限が切れたら通らない、
// 消したら通らない、KV にはハッシュだけを置く。
import { checkSiteProof, clearSiteProof, makeSiteProof } from "./site-proof.ts";
import type { Env } from "./types";

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  console.log(`  ${g === w ? "ok  " : "FAIL"} ${name}`);
  if (g !== w) {
    failed++;
    console.log(`    got : ${g}\n    want: ${w}`);
  }
};

const kv = new Map<string, string>();
const env = {
  PUBLIC_PAGES: {
    get: async (k: string) => kv.get(k) ?? null,
    put: async (k: string, v: string) => void kv.set(k, v),
    delete: async (k: string) => void kv.delete(k),
  },
} as unknown as Env;
const req = (t: string) =>
  new Request("https://site.example/kurocms/api/system/site-proof", {
    headers: { authorization: `Bearer ${t}` },
  });

console.log("site-proof");
const proof = await makeSiteProof(env, 1000);
eq("置いた証は通る", await checkSiteProof(req(proof), env, 2000), true);
eq(
  "KV に証そのものは置かない",
  [...kv.values()].join("").includes(proof),
  false,
);
eq(
  "違う証は通らない",
  await checkSiteProof(req("kproof_" + "x".repeat(43)), env, 2000),
  false,
);
eq(
  "10 分を過ぎたら通らない",
  await checkSiteProof(req(proof), env, 1000 + 10 * 60 * 1000 + 1),
  false,
);
await clearSiteProof(env);
eq("消したら通らない", await checkSiteProof(req(proof), env, 2000), false);

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall ok");
