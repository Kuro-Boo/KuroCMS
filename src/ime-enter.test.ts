// 契約テスト (node で直接実行)。入力欄の Enter と日本語入力(仕様 editor-editor-spec-ime)。
//
// 固定したいのは ——「変換を確定する Enter を、追加・送信・保存の Enter と取り違えない」。
// 管理画面と公開ページの部品で、Enter を拾う keydown は isImeComposing を通すこと。
// (2026-11-21: 設定 → IP 制限の追加の欄で、変換の確定で文字の途中のまま追加された)
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isImeComposing } from "../../KuroEditor/src/ime.js";

assert.equal(isImeComposing({ key: "Enter", isComposing: true }), true);
assert.equal(isImeComposing({ key: "Enter", keyCode: 229 }), true);
assert.equal(isImeComposing({ key: "Enter", keyCode: 13 }), false);

const SRC = new URL(".", import.meta.url).pathname;
const files: string[] = [];
const walk = (dir: string) => {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) walk(p);
    else if (/\.ts$/.test(d.name) && !/\.test\.ts$/.test(d.name)) files.push(p);
  }
};
walk(join(SRC, "admin"));
walk(join(SRC, "site"));
files.push(join(SRC, "admin.main.ts"));

// 文字を入れる欄ではない要素(code のコピーなど)は、ここに理由つきで載せる。
const NOT_TEXT_INPUT = [/code\[data-own-copy\]/];

const bad: string[] = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const re = /addEventListener\(\s*["']key(?:down|press|up)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const body = src.slice(m.index, m.index + 600);
    if (!/["']Enter["']|keyCode\s*===?\s*13/.test(body)) continue;
    if (/isImeComposing\(/.test(body)) continue;
    const before = src.slice(Math.max(0, m.index - 300), m.index);
    if (NOT_TEXT_INPUT.some((r) => r.test(before))) continue;
    const line = src.slice(0, m.index).split("\n").length;
    bad.push(`${f.slice(SRC.length)}:${line}`);
  }
}
assert.deepEqual(
  bad,
  [],
  `Enter を拾う keydown が isImeComposing を通していません: ${bad.join(", ")}`,
);

console.log("ime-enter: OK");
