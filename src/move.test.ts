// 引っ越しの口(move.ts・仕様 cms-move-to-self)の試験。
// 確かめるのは —— 鍵はハッシュで照合し、期限と役(移す元・移す先)を見る、止めている間と
// 仕上げ前を見分ける、rowid の続きから読むので途中で行が増えても読み落とさない、
// 主キー(複数列も)で引く・消す、R2 のキーは決まった形しか通さない。
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { sha256Hex } from "./crypto.ts";
import {
  authorizeMove,
  deleteByKeys,
  hasMoveToken,
  mediaKey,
  moveFrozen,
  moveTargetPending,
  readRows,
  readRowsByKey,
  rowsByKeys,
  tableShape,
} from "./move.ts";
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

function world() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(
    readFileSync(
      new URL("../migrations/0076_move.sql", import.meta.url),
      "utf8",
    ),
  );
  raw.exec(
    `CREATE TABLE document_translations (did TEXT NOT NULL, lang TEXT NOT NULL, title TEXT, PRIMARY KEY (did, lang));
     CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT);`,
  );
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => raw.prepare(sql).get(...(args as never[])) ?? null,
    all: async () => ({ results: raw.prepare(sql).all(...(args as never[])) }),
    run: async () => {
      const r = raw.prepare(sql).run(...(args as never[]));
      return { meta: { changes: Number(r.changes) } };
    },
  });
  const env = { DB: { prepare: (sql: string) => stmt(sql) } } as unknown as Env;
  return { raw, env };
}

const TOKEN = "kmove_" + "a".repeat(40);
const req = (token = TOKEN) =>
  new Request("https://site.example/kurocms/api/system/move/manifest", {
    headers: { authorization: `Bearer ${token}` },
  });

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "passed";
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
}

console.log("move");
{
  const { raw, env } = world();
  eq("鍵の形を見分ける", hasMoveToken(req()), true);
  eq(
    "PAT は引っ越しの鍵ではない",
    hasMoveToken(req("kuro_" + "a".repeat(40))),
    false,
  );
  eq(
    "行が無ければ通さない",
    await code(authorizeMove(req(), env, ["source"])),
    "move_unauthorized",
  );
  eq("行が無ければ止めていない", await moveFrozen(env), false);

  const now = Date.now();
  raw
    .prepare(
      "INSERT INTO move_state (id, role, token_hash, expires_at, created_at) VALUES (1, 'source', ?, ?, ?)",
    )
    .run(await sha256Hex(TOKEN), now + 60_000, now);
  eq(
    "正しい鍵と役は通る",
    await code(authorizeMove(req(), env, ["source"])),
    "passed",
  );
  eq(
    "違う鍵は通さない",
    await code(authorizeMove(req("kmove_" + "b".repeat(40)), env, ["source"])),
    "move_unauthorized",
  );
  eq(
    "移す元の鍵で移す先の口は使えない",
    await code(authorizeMove(req(), env, ["target"])),
    "move_wrong_role",
  );
  raw.prepare("UPDATE move_state SET frozen = 1").run();
  eq("止めている間を見分ける", await moveFrozen(env), true);
  eq("移す元は仕上げ待ちではない", await moveTargetPending(env), false);
  raw.prepare("UPDATE move_state SET expires_at = ?").run(now - 1);
  eq(
    "期限が切れた鍵は通さない",
    await code(authorizeMove(req(), env, ["source"])),
    "move_expired",
  );
  raw
    .prepare(
      "UPDATE move_state SET role = 'target', frozen = 0, expires_at = ?, token_hash = ''",
    )
    .run(now + 60_000);
  eq("仕上げの前は初期化を止める", await moveTargetPending(env), true);
  eq(
    "鍵を消したら通さない",
    await code(authorizeMove(req(), env, ["target"])),
    "move_unauthorized",
  );
  raw.prepare("UPDATE move_state SET finished_at = ?").run(now);
  eq("仕上げの後は初期化を止めない", await moveTargetPending(env), false);
}
{
  const { raw, env } = world();
  eq("主キーは宣言の順", (await tableShape(env, "document_translations")).pk, [
    "did",
    "lang",
  ]);
  eq(
    "変な表の名前は通さない",
    await code(tableShape(env, "x; DROP TABLE categories")),
    "bad_table",
  );
  for (let i = 1; i <= 5; i++)
    raw.prepare("INSERT INTO categories VALUES (?, ?)").run(`c${i}`, `n${i}`);
  const p1 = await readRows(env, "categories", 0, 2);
  eq(
    "1 枚目",
    p1.rows.map((r) => r.id),
    ["c1", "c2"],
  );
  eq("rowid を行に残さない", Object.keys(p1.rows[0]!), ["id", "name"]);
  // 読んでいる間に増えた行・消えた行。続きは rowid からなので、位置がずれない。
  raw.prepare("DELETE FROM categories WHERE id = 'c1'").run();
  raw.prepare("INSERT INTO categories VALUES ('c6', 'n6')").run();
  const p2 = await readRows(env, "categories", p1.last!, 2);
  eq(
    "2 枚目は読んだ続きから",
    p2.rows.map((r) => r.id),
    ["c3", "c4"],
  );
  const p3 = await readRows(env, "categories", p2.last!, 2);
  eq(
    "3 枚目で増えた行も読む",
    p3.rows.map((r) => r.id),
    ["c5", "c6"],
  );
  const p4 = await readRows(env, "categories", p3.last!, 2);
  eq("終わりは last が null", [p4.rows.length, p4.last], [0, null]);

  raw.exec(
    `INSERT INTO document_translations VALUES ('d1','ja','あ'),('d1','en','a'),('d2','ja','い')`,
  );
  const pk = ["did", "lang"];
  const k1 = await readRowsByKey(env, "document_translations", pk, null, 2);
  eq(
    "主キーの順に読む",
    k1.rows.map((r) => `${r.did}/${r.lang}`),
    ["d1/en", "d1/ja"],
  );
  eq("続きの主キー", k1.lastKey, ["d1", "ja"]);
  const k2 = await readRowsByKey(
    env,
    "document_translations",
    pk,
    k1.lastKey,
    2,
  );
  eq(
    "複数列の主キーの続きから",
    [k2.rows.map((r) => `${r.did}/${r.lang}`), k2.lastKey],
    [["d2/ja"], null],
  );
  eq(
    "1 列の主キーの続きから",
    (await readRowsByKey(env, "categories", ["id"], ["c4"], 10)).rows.map(
      (r) => r.id,
    ),
    ["c5", "c6"],
  );
  eq(
    "複数列の主キーで引く",
    (
      await rowsByKeys(env, "document_translations", pk, [
        ["d1", "en"],
        ["d2", "ja"],
      ])
    )
      .map((r) => r.title)
      .sort(),
    ["a", "い"],
  );
  eq(
    "形の違う鍵は断る",
    await code(rowsByKeys(env, "document_translations", pk, [["d1"]])),
    "bad_keys",
  );
  eq(
    "一度に 100 を超えて引かない",
    await code(
      rowsByKeys(
        env,
        "document_translations",
        pk,
        Array.from({ length: 101 }, () => ["d1", "ja"]),
      ),
    ),
    "bad_keys",
  );
  eq(
    "主キーで消す",
    await deleteByKeys(env, "document_translations", pk, [["d1", "ja"]]),
    1,
  );
  eq(
    "消えたのはその行だけ",
    raw.prepare("SELECT COUNT(*) AS c FROM document_translations").get(),
    { c: 2 },
  );
}
{
  eq("R2 のキー", mediaKey("/images/img-0001.webp"), "images/img-0001.webp");
  eq(
    "決まった形でなければ断る",
    await code(Promise.resolve().then(() => mediaKey("/../system/x"))),
    "bad_media_path",
  );
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall ok");
