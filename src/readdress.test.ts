// 委託用ドメインの付け替え(readdress.ts)の試験。
// 確かめるのは —— HOSTED_DOMAIN が置かれ、導入 ID の別のドメインで開いたときだけ新しいアドレスへ送る、
// 独自ドメイン・workers.dev・顧客運用・HOSTED_DOMAIN の無い導入は送らない、設定のアドレスは前の origin だけ替える。
import { readdressRedirect, swapOrigin } from "./readdress.ts";
import type { Env } from "./types.ts";

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

const managed = {
  CF_WORKER_NAME: "kurocms-app-ab12cd34ef56",
  MEDIA_QUOTA_BYTES: "10737418240",
  HOSTED_DOMAIN: "kurocms.com",
} as unknown as Env;
const go = (url: string, env: Env = managed) => {
  const r = readdressRedirect(new Request(url), env);
  return r ? [r.status, r.headers.get("location")] : null;
};

eq(
  "前のドメインは同じ頁の新しいアドレスへ 301",
  go("https://ab12cd34ef56.kurocms.site/kurocms/admin/?x=1"),
  [301, "https://ab12cd34ef56.kurocms.com/kurocms/admin/?x=1"],
);
eq(
  "新しいアドレスはそのまま",
  go("https://ab12cd34ef56.kurocms.com/posts/1"),
  null,
);
eq("独自ドメインはそのまま", go("https://harmo.example/posts/1"), null);
eq("別の導入 ID はそのまま", go("https://ffffffffffff.kurocms.site/"), null);
eq(
  "HOSTED_DOMAIN が無い導入は送らない(新しいアドレスが付く前)",
  go("https://ab12cd34ef56.kurocms.site/", {
    ...managed,
    HOSTED_DOMAIN: undefined,
  } as Env),
  null,
);
eq(
  "HOSTED_DOMAIN がまだ前のドメインなら送らない",
  go("https://ab12cd34ef56.kurocms.site/", {
    ...managed,
    HOSTED_DOMAIN: "kurocms.site",
  } as Env),
  null,
);
eq(
  "顧客運用は送らない",
  go("https://ab12cd34ef56.kurocms.site/", {
    ...managed,
    MEDIA_QUOTA_BYTES: undefined,
  } as Env),
  null,
);

const from = "https://ab12cd34ef56.kurocms.site";
const to = "https://ab12cd34ef56.kurocms.com";
eq("公開ドメインを替える", swapOrigin(`${from}/`, from, to), `${to}/`);
eq(
  "開発ドメインの下の道も替える",
  swapOrigin(`${from}/kurocms/admin/preview`, from, to),
  `${to}/kurocms/admin/preview`,
);
eq(
  "独自ドメインは替えない",
  swapOrigin("https://harmo.example/", from, to),
  "https://harmo.example/",
);
eq(
  "似た名前は替えない",
  swapOrigin(`${from}x.example/`, from, to),
  `${from}x.example/`,
);
eq("空はそのまま", swapOrigin(null, from, to), null);

if (failed) {
  console.log(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log("\nreaddress: 全部通った");
