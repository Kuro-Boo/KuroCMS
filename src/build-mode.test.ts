// 契約テスト (node で直接実行: `node src/build-mode.test.ts`)。
// 毎分の自動ビルドが見るビルドの方式の控え(build-mode.ts・2026-11-03)。
// 「別の isolate で auto に変えたら、予定公開は最長 5 分遅れる」を確かめる。
import {
  BUILD_MODE_KEY,
  BUILD_MODE_TTL_MS,
  __resetBuildModeForTest,
  buildModeForMinute,
  getBuildMode,
  setBuildMode,
} from "./build-mode.ts";
import type { Env } from "./types";

let f = 0;
const eq = (n: string, g: unknown, w: unknown) => {
  const a = JSON.stringify(g),
    b = JSON.stringify(w);
  if (a === b) console.log("  ok   " + n);
  else {
    f++;
    console.log(`  FAIL ${n}\n   got ${a}\n   want ${b}`);
  }
};

const MIN = 60_000;

/** KV(読み出しを数える)。2 つの isolate が同じ KV を見る。 */
function kv() {
  const m = new Map<string, string>();
  const box = { reads: 0, m };
  const env = {
    PUBLIC_PAGES: {
      get: async (k: string) => {
        box.reads++;
        return m.get(k) ?? null;
      },
      put: async (k: string, v: string) => {
        m.set(k, v);
      },
    },
  } as unknown as Pick<Env, "PUBLIC_PAGES">;
  return { env, box };
}

// 別の isolate(管理画面)が auto に変えた —— この isolate の控えは知らない。
const otherIsolateSets = (box: { m: Map<string, string> }, mode: string) =>
  box.m.set(BUILD_MODE_KEY, mode);

{
  __resetBuildModeForTest();
  const { env, box } = kv();
  const t0 = 1_000_000;
  eq(
    "最初の 1 分は KV を読む(既定は manual)",
    await buildModeForMinute(env, t0),
    "manual",
  );
  eq("そのとき 1 回だけ読む", box.reads, 1);
  otherIsolateSets(box, "auto");
  const seen: string[] = [];
  for (let i = 1; i <= 5; i++)
    seen.push(await buildModeForMinute(env, t0 + i * MIN));
  eq(
    "別の isolate で auto にしても、読んでから 5 分の間は控えの manual のまま。5 分たった分で auto",
    seen,
    ["manual", "manual", "manual", "manual", "auto"],
  );
  eq(
    "5 分の間は KV を読まない(読むのは 5 分たった分の 1 回だけ)",
    box.reads,
    2,
  );
}

{
  // 変えた時刻が控えのどこに当たっても、気づくまでの遅れは 5 分を超えない(毎分の tick で数える)。
  let worst = 0;
  for (let offset = 0; offset < BUILD_MODE_TTL_MS; offset += 15_000) {
    __resetBuildModeForTest();
    const { env, box } = kv();
    const t0 = 2_000_000;
    // この isolate は毎分(t0, t0+1分, …)に確かめる。最初の分で manual を控える。
    await buildModeForMinute(env, t0);
    const switchedAt = t0 + offset;
    otherIsolateSets(box, "auto");
    let tick = t0 + MIN;
    while (tick < switchedAt) tick += MIN;
    while ((await buildModeForMinute(env, tick)) !== "auto") tick += MIN;
    worst = Math.max(worst, tick - switchedAt);
  }
  eq(
    "別の isolate で変えてから自動ビルドが動くまでの遅れは最長 5 分",
    worst <= BUILD_MODE_TTL_MS,
    true,
  );
  eq("(いちばん遅いときの遅れ・分)", worst / MIN, 5);
}

{
  __resetBuildModeForTest();
  const { env, box } = kv();
  const t0 = 3_000_000;
  await buildModeForMinute(env, t0);
  await setBuildMode(env, "auto", t0 + 10_000);
  eq(
    "同じ isolate で変えたら、次の分ですぐ auto",
    await buildModeForMinute(env, t0 + MIN),
    "auto",
  );
  eq("そのとき KV を読み直さない", box.reads, 1);
  await setBuildMode(env, "manual", t0 + 2 * MIN);
  eq(
    "manual に戻したら、次の分ですぐ止まる",
    await buildModeForMinute(env, t0 + 3 * MIN),
    "manual",
  );
}

{
  __resetBuildModeForTest();
  const { env, box } = kv();
  const t0 = 4_000_000;
  await buildModeForMinute(env, t0);
  otherIsolateSets(box, "auto");
  eq(
    "画面が方式を読んだら(getBuildMode)、控えもその場で替わる",
    await getBuildMode(env, t0 + 30_000),
    "auto",
  );
  eq("次の分は auto", await buildModeForMinute(env, t0 + MIN), "auto");
}

{
  __resetBuildModeForTest();
  const { env, box } = kv();
  let t = 5_000_000;
  for (let i = 0; i < 24 * 60; i++, t += MIN) await buildModeForMinute(env, t);
  eq(
    "1 日(1,440 分)で KV を読むのは 288 回(毎分だと 1,440 回)",
    box.reads,
    288,
  );
}

{
  __resetBuildModeForTest();
  eq(
    "KV が無ければ manual",
    await buildModeForMinute({} as Pick<Env, "PUBLIC_PAGES">),
    "manual",
  );
}

if (f) {
  console.log(`\n${f} failed`);
  process.exit(1);
}
console.log("\nall ok");
