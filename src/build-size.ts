/**
 * 自動ビルドの回の量(課題 a408a584・cms-cms-build)。
 *
 * CPU の上限の小さい口座では、1 回の Worker の実行が CPU の上限で打ち切られ、応答も後始末も無く
 * 止まる。Worker の中から使った CPU の時間は測れない(CPU を使っている間は時計が進まない)し、
 * 時間で区切る作りにもしない。だから「打ち切られた」という出来事で量を減らす: 回を始めるときに
 * 印(inflight)を残し、終わったら消す。次の回で印が残っていれば、前の回は打ち切られた。
 *
 * ⚠ ここは cloudflare:workers を読まない(node で直接試験する)。
 */

/** 1 回で作るページの数の既定(と上限)。 */
export const AUTO_BUILD_MAX_PER_INVOCATION = 50;

/**
 * 次の回の量。前の回の印が残っていれば減らす: ページ数を半分 → 1 ページになったら言語の数を半分。
 * 印が無ければ前の量のまま(既定は 50 ページ・言語は分けない)。
 */
export function nextAutoBuildSize(
  raw: string | null,
  langCount: number,
): { budget: number; langs?: number } {
  let prev: { budget?: number; langs?: number; inflight?: boolean };
  try {
    prev = raw ? JSON.parse(raw) : {};
  } catch {
    prev = {};
  }
  const budget =
    Number(prev.budget) >= 1
      ? Math.min(AUTO_BUILD_MAX_PER_INVOCATION, Math.floor(Number(prev.budget)))
      : AUTO_BUILD_MAX_PER_INVOCATION;
  const langs =
    Number(prev.langs) >= 1 ? Math.floor(Number(prev.langs)) : undefined;
  const keep = langs ? { langs } : {};
  if (!prev.inflight) return { budget, ...keep };
  if (budget > 1)
    return { budget: Math.max(1, Math.floor(budget / 2)), ...keep };
  if (langCount <= 1) return { budget: 1, ...keep };
  const next =
    langs === undefined ? Math.floor(langCount / 2) : Math.floor(langs / 2);
  return { budget: 1, langs: Math.max(1, next) };
}
