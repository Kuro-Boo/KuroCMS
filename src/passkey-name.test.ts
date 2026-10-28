// 契約テスト (node で直接実行: `node src/passkey-name.test.ts`)。
// 管理画面のパスキーの名前は、Entamy ID のパスキーと見分けられ、どのサイトのものかが分かる。
import assert from "node:assert/strict";
import { adminPasskeyRpName } from "./passkey-name.ts";

assert.equal(adminPasskeyRpName("Harmo Life"), "KuroCMS 管理者（Harmo Life）");
assert.equal(
  adminPasskeyRpName("  Harmo Life  "),
  "KuroCMS 管理者（Harmo Life）",
);
assert.equal(
  adminPasskeyRpName("KuroCMS"),
  "KuroCMS 管理者",
  "既定のサイト名は入れない",
);
assert.equal(adminPasskeyRpName(""), "KuroCMS 管理者");
assert.equal(adminPasskeyRpName(null), "KuroCMS 管理者");

console.log("passkey-name: ok");
