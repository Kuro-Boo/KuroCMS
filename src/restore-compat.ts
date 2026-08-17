// 古い版で作られたバックアップを、今のスキーマの意味へ合わせる純関数。
//
// なぜ要るか: バックアップは **常に別の時点の KuroCMS** から来る。復元先は
// 最新版なので、その間の migration が足した「約束」を、行を入れる前に満たして
// やらないといけない。migration は install 時に一度走るだけで、その後で全行を
// 消して古いデータを流し込む復元には効かないからである。
//
// ⚠ ここで守るのは 2 つ。
//   1. **1 行も失わない** —— 復元は `INSERT OR REPLACE` を使うが、SQLite の
//      REPLACE は主キーだけでなく【あらゆる UNIQUE 制約の衝突相手を削除する】。
//      後から一意制約が増えた列を含む古いバックアップを流すと、2 件目が 1 件目を
//      黙って上書きする（実例: migration 0050 が documents.slug をグローバル
//      一意にした。それ以前は UNIQUE(tid, slug) で、種別違いなら同じ slug が
//      正当に存在できた。実測で記事 2 件 → 1 件になった）。
//   2. **移行元と同じ見え方にする** —— 列が無いだけで公開サイトが空になる、
//      といったことを起こさない（migration 0060 の live）。
//
// 通信も SQL も持たない。DB から取ってくるのは呼び手（api.ts）の仕事で、
// 壊れやすい判断だけをここに置く（契約テスト: npm run test:restore）。

/** 復元行。バックアップの JSONL は SELECT * の結果そのままなので値は雑多。 */
export type RestoreRow = Record<string, unknown>;

/** 退避の記録。呼び手はこれを画面に出す。 */
export type UniqueRename = { column: string; from: string; to: string };

/**
 * 一意制約にぶつかる値を **消さずに退避** する。
 *
 * `taken` は「その値を既に持っている行の主キー」表。復元はページ単位で届く
 * ので、前のページで入った行との衝突も見るために呼び手が DB から詰めてくる。
 * この関数は衝突した行の値を書き換え、`taken` を更新する（次のページでも
 * 同じ表を使い回せるように）。
 *
 * 退避の形は migration 0050 に合わせて `値-主キー`。その版から順に更新して
 * きたインスタンスと同じ結果になるのが正しい。
 */
export function planUniqueRenames(
  rows: RestoreRow[],
  pk: string,
  column: string,
  taken: Map<string, string>,
): UniqueRename[] {
  const renames: UniqueRename[] = [];
  for (const row of rows) {
    const value = row[column];
    const key = row[pk];
    if (typeof value !== "string" || key === undefined || key === null)
      continue;
    const owner = taken.get(value);
    if (owner === undefined || owner === String(key)) {
      taken.set(value, String(key));
      continue;
    }
    let next = `${value}-${String(key)}`;
    for (let n = 2; taken.has(next); n++) next = `${value}-${String(key)}-${n}`;
    taken.set(next, String(key));
    row[column] = next;
    renames.push({ column, from: value, to: next });
  }
  return renames;
}

/** ISO 文字列（"2026-01-01T00:00:00Z" / "2026-01-01 00:00:00"）を ms に。 */
function parseWhen(v: unknown): number | null {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v.includes("T") ? v : v.replace(" ", "T") + "Z");
  return Number.isFinite(t) ? t : null;
}

/**
 * migration 0060 の bootstrap を、復元される行にも適用する。
 *
 * 0060 は「公開フラグ(mode)は状態にすぎず、ビルドが live に焼くまで公開側には
 * 出ない」を導入し、それ以前から公開されていた記事を live=1 にした。その列を
 * 持たない古いバックアップをそのまま入れると **全記事が live=0**、つまり復元
 * 直後の公開サイトが空になる（移行元と同じ状態にならない）。
 *
 * ⚠ `live` を持つ行（＝新しいバックアップ）には触らない。運用者が公開フラグを
 *   立てたままビルドしていない、という状態もそのまま運ぶ。
 */
export function backfillDocumentLive(
  rows: RestoreRow[],
  now: number = Date.now(),
): number {
  let filled = 0;
  for (const row of rows) {
    if ("live" in row) continue;
    const publishAt = parseWhen(row.publish_at);
    const unpublishAt = parseWhen(row.unpublish_at);
    row.live =
      Number(row.mode) === 1 &&
      (publishAt === null || publishAt <= now) &&
      (unpublishAt === null || unpublishAt > now)
        ? 1
        : 0;
    filled += 1;
  }
  return filled;
}
