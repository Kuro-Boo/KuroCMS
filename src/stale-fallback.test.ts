// 契約テスト (node で直接実行: `npm run test:stalefallback`)。
//
// 固定したいのは1つ ——「**依存先が詰まっても、出せるものは出す**」。
//
// 公開ページはエッジキャッシュを引く**前に** D1 を読む（設定・言語・
// テンプレート）。ここが素の D1 依存だと、D1 が数十秒詰まっただけで
// **キャッシュ済みのページすら返せない**。2026-08-22 に実際そうなり、
// 公開サイトが断続的に 503 になった。
//
// ⚠ 同時に、**正常時の挙動を変えていない**ことも固定する。控えを先に見る
//   作りにすると、管理画面の編集が画面に出るまで遅れる。直したいのは
//   「遅いこと」ではなく「落ちること」である。

import { createStaleFallback } from "./stale-fallback.ts";

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.log(`  FAIL ${name}\n    got : ${g}\n    want: ${w}`);
  }
};
const ok = (name: string, cond: boolean) => eq(name, !!cond, true);

/** 外部の控え置き場（KV の代役）と、差し替え可能な時計。 */
function harness(shared = new Map<string, string>()) {
  let clock = 1_000_000;
  let writes = 0;
  const gate = createStaleFallback<string>({
    staleMs: 60_000,
    snapshotMs: 10_000,
    now: () => clock,
    async readSnapshot() {
      return shared.get("snap") ?? null;
    },
    async writeSnapshot(v) {
      writes++;
      shared.set("snap", v);
    },
  });
  return {
    gate,
    shared,
    advance: (ms: number) => {
      clock += ms;
    },
    writes: () => writes,
  };
}

const boom = async (): Promise<string> => {
  throw new Error(
    "D1_ERROR: D1 DB is overloaded. Requests queued for too long.",
  );
};

const run = async () => {
  // ── 1. 正常時は本体の値をそのまま返す ──────────────────────────────
  const h = harness();
  eq("本体の値を返す", await h.gate.load(async () => "A"), "A");

  // ── 2. 正常時は控えを先に見ない（編集が遅れないこと）───────────────
  // ⚠ ここが「控えが新しければ本体を引かない」になると、管理画面の編集が
  //   画面に出るまで遅れる。**正常時の挙動は変えない。**
  eq("次の呼び出しも本体を引く", await h.gate.load(async () => "B"), "B");

  // ── 3. 失敗したら直前の値で凌ぐ（これが本題）──────────────────────
  eq("落ちても直前の値で出せる", await h.gate.load(boom), "B");

  // ── 4. 復帰したら新しい値に戻る ────────────────────────────────────
  eq("復帰すれば新しい値", await h.gate.load(async () => "C"), "C");

  // ── 5. 古すぎる控えは使わない ──────────────────────────────────────
  h.advance(61_000); // staleMs を超える
  h.shared.delete("snap"); // 外部の控えも無い状態にする
  let threw = false;
  try {
    await h.gate.load(boom);
  } catch {
    threw = true;
  }
  ok("古すぎる控えは使わず失敗する", threw);

  // ── 6. 冷えた isolate は外部の控えで凌ぐ ──────────────────────────
  const shared = new Map<string, string>();
  const warm = harness(shared);
  await warm.gate.load(async () => "SNAP");
  ok("外部に控えが置かれる", shared.get("snap") === "SNAP");

  const cold = harness(shared); // 手元の控えは空＝別 isolate
  eq(
    "冷えた isolate でも外部の控えで出せる",
    await cold.gate.load(boom),
    "SNAP",
  );

  // ── 7. 控えがどこにも無ければ素直に失敗する（推測で出さない）────────
  const bare = harness(new Map());
  let threw2 = false;
  try {
    await bare.gate.load(boom);
  } catch {
    threw2 = true;
  }
  ok("控えが無ければ失敗する", threw2);

  // ── 8. 外部への書き込みは要求ごとではない ─────────────────────────
  // ⚠ 要求ごとに書くと、KV の無料枠（1,000 writes/日）を焼く。しかも
  //   焼き切るのは「弱っているとき」ではなく平常時なので、気づきにくい。
  const w = harness(new Map());
  for (let i = 0; i < 50; i++) await w.gate.load(async () => "X");
  eq("50 回読んでも書き込みは 1 回", w.writes(), 1);
  w.advance(11_000); // snapshotMs を超えたら置き直す
  await w.gate.load(async () => "Y");
  eq("間隔を過ぎたら置き直す", w.writes(), 2);

  // ── 9. 控えの書き込みが失敗しても本筋は止まらない ──────────────────
  const flaky = createStaleFallback<string>({
    staleMs: 60_000,
    snapshotMs: 0,
    async readSnapshot() {
      return null;
    },
    async writeSnapshot() {
      throw new Error("KV unavailable");
    },
  });
  eq("控えを置けなくても値は返る", await flaky.load(async () => "Z"), "Z");

  console.log("");
  if (failed) {
    console.log(`${failed} 件 FAIL`);
    process.exit(1);
  }
  console.log("すべて OK");
};

await run();
