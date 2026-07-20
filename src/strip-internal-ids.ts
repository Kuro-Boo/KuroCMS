// KuroEditor の内部ブロック識別属性 (data-bid / data-cbid) を、公開 HTML から除去する。
//
// 実装は KuroEditor 上流の共有 tokenizer (src/kuro-blocks.js = dist/kuro-blocks.js の
// vendored copy・github_release_update.sh の ke sync が editor と同版に保つ) へ
// 一本化した (仕様書 §10.7 F0「共有 tokenizer 化」完遂)。当初ここに置いた同一
// ロジックの独立実装は削除。契約テスト (strip-internal-ids.test.ts) はこの
// re-export を import するので、vendored 実装が F0-2 の敵対的ケース
// (属性値内の '>'・単引用符・属性順・data-cbid・入れ子 bid) を守り続けることを
// 引き続き検証する。
export { stripInternalIds } from "./kuro-blocks.js";
