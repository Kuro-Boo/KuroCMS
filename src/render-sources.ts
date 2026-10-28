/**
 * 公開ページの HTML を組み立てるコードの一覧(全体ビルドのハッシュに混ぜる指紋の元)。
 *
 * 全体ビルドは、ページの入力(記事・サイト文字・テンプレート)が前と同じなら作り直さない。
 * 組み立てのコードを変えても入力は変わらないので、これまでは人が描画の版を手で上げていた ——
 * 上げ忘れると、古い HTML が出続ける(2026-10-24 の CSP の変更で、entamy.com と harmo.life が
 * インラインの script のまま残った)。今は scripts/build-admin.js がここに並べたファイルの中身から
 * 指紋(admin-assets.ts の RENDER_FINGERPRINT)を作り、ビルドのハッシュに混ぜる。
 *
 * ⚠ 組み立てに関わるファイルを読み込みに足したら、ここ(RENDER_SOURCES)か NOT_RENDER に足す。
 *   どちらにも無い読み込みは render-sources.test.ts が落とす。迷ったら RENDER_SOURCES へ
 *   (余計に作り直すだけで済む。漏らすと古いページが残る)。
 *
 * パスは KuroCMS の根から。⚠ ここは何も読み込まない(build-admin.js が node で直接読む)。
 */

/** 隣の KuroEditor(モノレポの KuroBrand/KuroEditor の src)のファイル。
 *  ⚠ 道を丸ごと書かない —— 公開ミラーの検査が、モノレポの内側への道を断る(github_public_release.sh)。 */
export const EDITOR_DIR = ["..", "KuroEditor", "src"] as const;
export const RENDER_SOURCES: readonly string[] = [
  "src/public.ts",
  "src/templates/html-template.ts",
  "src/templates/static-pages.ts",
  "src/templates/font-catalog.ts",
  "src/template-ui.ts",
  "src/template-scripts.ts",
  "src/lang-path.ts",
  "src/timezone.ts",
  "src/fonts.ts",
  "src/headings.ts",
  "src/link-attr.ts",
  "src/reactions.ts",
  "src/related.ts",
  "src/published-sql.ts",
  "src/recipe-guard.ts",
  "src/strip-internal-ids.ts",
  "src/unfurl.ts",
  "src/crypto.ts",
  "src/entamy-subprocessors.ts",
  "src/generated/entamy-subprocessors.json",
];

/** 組み立てが読む KuroEditor のファイル(EDITOR_DIR の中)。 */
export const EDITOR_SOURCES: readonly string[] = [
  "normalize.js",
  "recipe.js",
  "kuro-links.js",
  "blocks.js",
];

/** 組み立てに読み込まれるが、ページの HTML を変えないもの(理由つき)。 */
export const NOT_RENDER: Readonly<Record<string, string>> = {
  "src/admin-assets.ts":
    "生成物。ページに焼き込む部品の名前と KuroEditor の版は、build-admin.js が指紋に直接混ぜる",
  "src/assets-publish.ts": "静的資産の索引と登録",
  "src/build-dependencies.ts":
    "どのページを作り直すかを決める(HTML は変えない)",
  "src/build-size.ts": "ビルドの回の量",
  "src/http.ts": "応答の組み立て",
  "src/move.ts": "引っ越しの後の転送",
  "src/site-csp.ts":
    "応答のヘッダーと静的資産の _headers だけ(_headers は全体ビルドが済むたびに登録し直す)",
  "src/stale-fallback.ts": "配信の予備の道",
  "src/types.ts": "型だけ",
  "src/templates/types.ts": "型だけ",
};
