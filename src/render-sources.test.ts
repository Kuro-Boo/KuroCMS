// 契約テスト (node で直接実行: `node src/render-sources.test.ts`)。
// 組み立てのコードの一覧(render-sources.ts)に漏れが無いこと。漏れたファイルを変えても全体ビルドの
// ハッシュが変わらず、古いページが出続ける(2026-10-24 の CSP の変更で起きた)。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EDITOR_DIR,
  EDITOR_SOURCES,
  NOT_RENDER,
  RENDER_SOURCES,
} from "./render-sources.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const editorFiles = EDITOR_SOURCES.map((f) => join(...EDITOR_DIR, f));
const renderFiles = [...RENDER_SOURCES, ...editorFiles];
const known = new Set([...renderFiles, ...Object.keys(NOT_RENDER)]);

/** 読み込みの指す先(拡張子の無いもの・.js と書いた .ts は .ts)を、根からのパスで。 */
function resolveImport(from: string, spec: string): string {
  let path = normalize(join(dirname(from), spec));
  if (!existsSync(join(ROOT, path))) {
    const ts = path.replace(/\.js$/, "") + ".ts";
    if (existsSync(join(ROOT, ts))) path = ts;
  }
  return relative(".", path);
}

const IMPORT_RE = /(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g;

for (const file of renderFiles) {
  assert.ok(existsSync(join(ROOT, file)), `一覧のファイルが無い: ${file}`);
  if (!/\.(ts|js)$/.test(file)) continue;
  const src = readFileSync(join(ROOT, file), "utf8");
  for (const m of src.matchAll(IMPORT_RE)) {
    const target = resolveImport(file, m[1]!);
    assert.ok(
      known.has(target),
      `${file} が読み込む ${target} が render-sources.ts のどちらの一覧にも無い。` +
        "ページの HTML を変えうるなら RENDER_SOURCES、変えないなら理由を付けて NOT_RENDER へ",
    );
  }
}

for (const file of Object.keys(NOT_RENDER))
  assert.ok(
    existsSync(join(ROOT, file)),
    `NOT_RENDER のファイルが無い: ${file}`,
  );

console.log("render-sources: ok");
