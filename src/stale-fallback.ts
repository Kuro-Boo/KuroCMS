/**
 * 「読めなかったら、直前に読めた値で凌ぐ」の型。依存を持たない純粋な部品。
 *
 * ## 何のためにあるか
 *
 * 公開ページはエッジキャッシュを引く**前に**サイト全体の値（設定・言語・
 * テンプレート）を D1 から読む。ここが素の D1 依存だと、D1 が数十秒詰まった
 * だけで**キャッシュ済みのページすら返せない**。2026-08-22 に実際そうなり、
 * 公開サイトが断続的に 503 になった。
 *
 * ## 順序を間違えない
 *
 * **必ず本体を先に試す。** 「控えが新しければ本体を引かない」にすると、
 * 管理画面の編集が画面に出るまで遅れる。ここが直したいのは**遅さではなく
 * 落ちること**なので、正常時の挙動は一切変えない。
 *
 * ## 推測で出さない
 *
 * 控えが無い（初回・長時間の停止）なら、素直に失敗を投げる。
 * 中途半端な値でページを出すと、何が正しいのか誰にも分からなくなる。
 */

export interface StaleFallbackOptions<T> {
  /** どこまで古い控えを使うか。これを過ぎたら控えを捨てる。 */
  staleMs: number;
  /** 控えを外部（KV 等）へ置き直す間隔。**要求ごとには書かない。** */
  snapshotMs: number;
  /** 冷えた isolate 用の控えを読む。無ければ null。 */
  readSnapshot: () => Promise<T | null>;
  /** 控えを置く。失敗しても本筋は止めない。 */
  writeSnapshot: (value: T) => Promise<void>;
  /** 試験で時刻を差し替えるため。 */
  now?: () => number;
}

export interface StaleFallback<T> {
  /** `fresh` を試し、失敗したら控えへ落ちる。 */
  load(fresh: () => Promise<T>): Promise<T>;
  /** 手元の控えを捨てる（試験用）。 */
  reset(): void;
}

export function createStaleFallback<T>(
  options: StaleFallbackOptions<T>,
): StaleFallback<T> {
  const now = options.now ?? (() => Date.now());
  let lastGood: { at: number; value: T } | null = null;
  let lastSnapshotAt = 0;

  return {
    reset() {
      lastGood = null;
      lastSnapshotAt = 0;
    },

    async load(fresh: () => Promise<T>): Promise<T> {
      try {
        // **本体が先。** 控えを先に見ると編集の反映が遅れる。
        const value = await fresh();
        lastGood = { at: now(), value };
        // 冷えた isolate は手元に控えを持たない。外に置いておくとそちらでも
        // 凌げる。⚠ 要求ごとに書くと書き込み枠を焼くので間隔を空ける。
        if (now() - lastSnapshotAt > options.snapshotMs) {
          lastSnapshotAt = now();
          try {
            await options.writeSnapshot(value);
          } catch {
            /* 置けなくても本筋は動く */
          }
        }
        return value;
      } catch (err) {
        if (lastGood && now() - lastGood.at < options.staleMs) {
          return lastGood.value;
        }
        const snapshot = await options.readSnapshot().catch(() => null);
        if (snapshot !== null) {
          lastGood = { at: now(), value: snapshot };
          return snapshot;
        }
        // 控えが無い。**推測で出さない。**
        throw err;
      }
    },
  };
}
