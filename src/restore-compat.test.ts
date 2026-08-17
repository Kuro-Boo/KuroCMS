// 契約テスト (node で直接実行: `npm run test:restore`)。
// 「古い版のバックアップを最新版へ復元しても、1 行も失わず、移行元と同じ
// 見え方になる」を固定する。fixture は v1.7.7（ZIP バックアップ実装当初）の
// スキーマで実際に作れる行の形。
import {
  planUniqueRenames,
  backfillDocumentLive,
  type RestoreRow,
} from "./restore-compat.ts";

let failed = 0;
function check(name: string, got: unknown, want: unknown): void {
  const g = typeof got === "object" ? JSON.stringify(got) : String(got);
  const w = typeof want === "object" ? JSON.stringify(want) : String(want);
  if (g === w) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}\n    got : ${g}\n    want: ${w}`);
  }
}

console.log("planUniqueRenames（一意制約の衝突を消さずに退避する）");

// v1.7.7 は UNIQUE(tid, slug) だったので、種別が違えば同じ slug が正当に存在
// できた。0050 が slug をグローバル一意にしたので、そのバックアップを今の
// スキーマへ流すと衝突する。⚠ ここで退避しないと INSERT OR REPLACE が
// 1 件目を黙って消す。
{
  const rows: RestoreRow[] = [
    { did: "d1", slug: "about", tid: "article" },
    { did: "d2", slug: "about", tid: "page" },
  ];
  const renames = planUniqueRenames(rows, "did", "slug", new Map());
  check("2 件目だけを退避する", renames, [
    { column: "slug", from: "about", to: "about-d2" },
  ]);
  check("1 件目は元のまま", rows[0].slug, "about");
  check(
    "退避の形は migration 0050 と同じ（値-主キー）",
    rows[1].slug,
    "about-d2",
  );
}

{
  // 復元はページ単位で届く。前のページで入った行との衝突も見る必要がある。
  const taken = new Map<string, string>([["about", "d1"]]);
  const rows: RestoreRow[] = [{ did: "d3", slug: "about", tid: "news" }];
  const renames = planUniqueRenames(rows, "did", "slug", taken);
  check("ページを跨いだ衝突も退避する", rows[0].slug, "about-d3");
  check("退避を 1 件報告する", renames.length, 1);
}

{
  // 同じ行がもう一度来ただけ（＝主キーが同じ）なら、それは衝突ではない。
  const taken = new Map<string, string>([["about", "d1"]]);
  const rows: RestoreRow[] = [{ did: "d1", slug: "about" }];
  const renames = planUniqueRenames(rows, "did", "slug", taken);
  check("同じ主キーの再投入は退避しない", renames.length, 0);
  check("値も変えない", rows[0].slug, "about");
}

{
  // 退避先まで既に埋まっている場合。無限ループも上書きも起こさない。
  const taken = new Map<string, string>([
    ["about", "d1"],
    ["about-d2", "dX"],
  ]);
  const rows: RestoreRow[] = [{ did: "d2", slug: "about" }];
  planUniqueRenames(rows, "did", "slug", taken);
  check("退避先も埋まっていれば更にずらす", rows[0].slug, "about-d2-2");
}

{
  const rows: RestoreRow[] = [
    { did: "d1", slug: null },
    { did: "d2" },
    { slug: "about" },
  ];
  const renames = planUniqueRenames(rows, "did", "slug", new Map());
  check("値や主キーが無い行は素通し（落とさない）", renames.length, 0);
}

console.log(
  "backfillDocumentLive（0060 の live を古いバックアップにも与える）",
);

// v1.7.7 の documents 行には live 列が無い。そのまま入れると全記事 live=0 で
// 公開サイトが空になる。0060 と同じ規則で埋める。
const NOW = Date.parse("2026-06-01T00:00:00.000Z");
{
  const rows: RestoreRow[] = [
    { did: "d1", mode: 1, publish_at: "2026-01-01T00:00:00.000Z" },
    { did: "d2", mode: 0, publish_at: "2026-01-01T00:00:00.000Z" },
    { did: "d3", mode: 1, publish_at: "2026-12-01T00:00:00.000Z" }, // 公開予定日が未来
    {
      did: "d4",
      mode: 1,
      publish_at: "2026-01-01T00:00:00.000Z",
      unpublish_at: "2026-02-01T00:00:00.000Z", // 公開終了済み
    },
  ];
  const filled = backfillDocumentLive(rows, NOW);
  check("4 行すべてを埋める", filled, 4);
  check("公開中は live=1", rows[0].live, 1);
  check("非公開は live=0", rows[1].live, 0);
  check("公開予定日が未来なら live=0", rows[2].live, 0);
  check("公開終了済みなら live=0", rows[3].live, 0);
}

{
  // 新しいバックアップ（live 列を持つ）には触らない。「公開フラグは立てたが
  // まだビルドしていない」という状態も、そのまま運ぶ。
  const rows: RestoreRow[] = [
    { did: "d1", mode: 1, live: 0, publish_at: "2026-01-01T00:00:00.000Z" },
  ];
  const filled = backfillDocumentLive(rows, NOW);
  check("live を持つ行は書き換えない", rows[0].live, 0);
  check("埋めた件数は 0", filled, 0);
}

{
  // 日付は "2026-01-01 00:00:00"（T 無し・UTC 前提）でも保存されうる。
  const rows: RestoreRow[] = [
    { did: "d1", mode: 1, publish_at: "2026-01-01 00:00:00" },
  ];
  backfillDocumentLive(rows, NOW);
  check("T の無い日時も読める", rows[0].live, 1);
}

{
  const rows: RestoreRow[] = [{ did: "d1", mode: 1, publish_at: "" }];
  backfillDocumentLive(rows, NOW);
  check(
    "日時が空でも公開中として扱う（判断材料が無い側に倒さない）",
    rows[0].live,
    1,
  );
}

console.log(failed === 0 ? "\nすべて OK" : `\n${failed} 件 FAIL`);
process.exit(failed === 0 ? 0 : 1);
