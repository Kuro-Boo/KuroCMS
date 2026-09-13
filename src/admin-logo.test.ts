// Contract test: the release build must embed the canonical rabbit SVG in the
// Worker shell and must never reintroduce the external kuro.boo dependency.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ADMIN_LOGO_DATA_URL } from "./admin-logo.ts";

let failed = 0;
const check = (name: string, ok: boolean) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failed++;
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(root, "..", "asset", "kuroBoo.svg");
const sourceSvg = existsSync(sourcePath)
  ? readFileSync(sourcePath, "utf8").trim()
  : null;
const shellSource = readFileSync(join(root, "src", "admin-shell.ts"), "utf8");
const prefix = "data:image/svg+xml;base64,";
const embeddedSvg = ADMIN_LOGO_DATA_URL.startsWith(prefix)
  ? Buffer.from(ADMIN_LOGO_DATA_URL.slice(prefix.length), "base64").toString(
      "utf8",
    )
  : "";

if (sourceSvg !== null) {
  check("正本のSVGがdata URLへ完全に埋め込まれる", embeddedSvg === sourceSvg);
} else {
  console.log("  skip 共有 asset が無い単独 checkout では正本との照合を省略");
}
check(
  "管理画面faviconが埋め込みSVG定数を使う",
  shellSource.includes('href="${ADMIN_LOGO_DATA_URL}"'),
);
check(
  "管理画面JSへ埋め込みロゴ定数を注入する",
  shellSource.includes("window.__KUROCMS_ADMIN_LOGO__"),
);
check(
  "kuro.boo/favicon.svgへの外部依存がない",
  !shellSource.includes("https://kuro.boo/favicon.svg"),
);

if (failed) {
  console.error(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log("\nすべて OK");
