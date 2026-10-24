// 契約テスト (node で直接実行: `node src/build-size.test.ts`)。
// 自動ビルドの回の量は、打ち切られた(印が残った)ときだけ減らす(課題 a408a584)。
import assert from "node:assert/strict";
import {
  AUTO_BUILD_MAX_PER_INVOCATION,
  nextAutoBuildSize,
} from "./build-size.ts";

const at = (o: object) => JSON.stringify(o);
assert.deepEqual(
  nextAutoBuildSize(null, 11),
  { budget: AUTO_BUILD_MAX_PER_INVOCATION },
  "既定は 50 ページ・言語は分けない",
);
assert.deepEqual(nextAutoBuildSize("壊れた値", 11), {
  budget: AUTO_BUILD_MAX_PER_INVOCATION,
});
assert.deepEqual(
  nextAutoBuildSize(at({ budget: 12, inflight: false }), 11),
  { budget: 12 },
  "前の回が終わっていれば量はそのまま",
);
assert.deepEqual(
  nextAutoBuildSize(at({ budget: 50, inflight: true }), 11),
  { budget: 25 },
  "打ち切られたら半分",
);
assert.deepEqual(
  nextAutoBuildSize(at({ budget: 1, inflight: true }), 11),
  { budget: 1, langs: 5 },
  "1 ページでも切れたら言語を半分",
);
assert.deepEqual(
  nextAutoBuildSize(at({ budget: 1, langs: 5, inflight: true }), 11),
  { budget: 1, langs: 2 },
);
assert.deepEqual(
  nextAutoBuildSize(at({ budget: 1, langs: 1, inflight: true }), 11),
  { budget: 1, langs: 1 },
  "1 言語より小さくしない",
);
assert.deepEqual(
  nextAutoBuildSize(at({ budget: 1, inflight: true }), 1),
  { budget: 1 },
  "1 言語のサイトは言語を分けない",
);
assert.deepEqual(
  nextAutoBuildSize(at({ budget: 999 }), 3),
  { budget: AUTO_BUILD_MAX_PER_INVOCATION },
  "上限を超えない",
);

console.log("auto build size contract OK");
