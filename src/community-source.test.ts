// 契約テスト (node で直接実行: `npm run test:communitysource`)。
//
// Community テンプレート取り込みの「HTML 原本をどこから得るか」を固定する。
// ⚠ このテストの最大の目的は【他ユーザーへの非影響】の保証。同一ゾーン運用
//   (kuro.boo) 向けの inline 経路が、別ゾーンのインスタンスに漏れないこと。
import {
  chooseTemplateSourceOrigin,
  isAcceptableTemplateSource,
  isSameZoneAsCommunity,
  TEMPLATE_SOURCE_MAX_BYTES,
} from "./templates/community-source.ts";

let failed = 0;
function check(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}\n    got : ${g}\n    want: ${w}`);
  }
}

const COMMUNITY = "https://kuro.boo/kurocms";
const zone = (url: string) => isSameZoneAsCommunity(url, COMMUNITY);

// ─────────────────────────────────────────────────────────────
console.log("A. ゾーン判定 — 同一ゾーン運用だけを拾う");
// ─────────────────────────────────────────────────────────────

check(
  "Community と同一ホスト",
  zone("https://kuro.boo/kurocms/api/v1/templates"),
  true,
);
check(
  "同一ゾーンのサブドメイン (本番の管理ホスト)",
  zone("https://kurocms.kuro.boo/kurocms/api/v1/templates"),
  true,
);
check("多段サブドメインも同一ゾーン", zone("https://a.b.kuro.boo/x"), true);
check("大文字ホストでも判定できる", zone("https://KUROCMS.KURO.BOO/x"), true);

// ⚠ ここが「他ユーザーに影響しない」ことの本体。別ゾーンは必ず false。
check(
  "他ユーザー: 独自ドメイン",
  zone("https://cms.example.com/api/v1/templates"),
  false,
);
check(
  "他ユーザー: workers.dev",
  zone("https://kurocms-site-4bcbcd.entamy.workers.dev/x"),
  false,
);
check(
  "他ユーザー: 別インスタンス (harmo.life)",
  zone("https://harmo.life/x"),
  false,
);

// 接尾辞一致で誤判定しないこと（なりすまし対策）
check(
  "接尾辞が同じだけの別ドメインは false",
  zone("https://evilkuro.boo/x"),
  false,
);
check(
  "末尾に付けただけの別ドメインも false",
  zone("https://kuro.boo.example.com/x"),
  false,
);
check("部分一致の親ドメインは false", zone("https://boo/x"), false);

// 壊れた入力
check("URL でない文字列", zone("not a url"), false);
check("空文字", zone(""), false);
check(
  "Community 側 URL が壊れている",
  isSameZoneAsCommunity("https://kuro.boo/x", "???"),
  false,
);

// ─────────────────────────────────────────────────────────────
console.log("\nB. HTML 受け入れ判定 — fetch 経路と inline 経路で同一");
// ─────────────────────────────────────────────────────────────

const isTemplate = (h: string) =>
  h.startsWith("<!-- kurocms-template-api:1 -->");
const good = "<!-- kurocms-template-api:1 -->\n<!doctype html><html></html>";
const accept = (h: string) => isAcceptableTemplateSource(h, isTemplate);

check("正しいテンプレート HTML", accept(good), true);
check("空は拒否", accept(""), false);
check(
  "マーカーが無い HTML は拒否",
  accept("<!doctype html><html></html>"),
  false,
);
check(
  "上限ちょうどは許可",
  accept(good + "x".repeat(TEMPLATE_SOURCE_MAX_BYTES - good.length)),
  true,
);
check(
  "上限を 1 バイト超えたら拒否",
  accept(good + "x".repeat(TEMPLATE_SOURCE_MAX_BYTES - good.length + 1)),
  false,
);

// ⚠ 判定は必ず渡された isTemplate に委ねる（独自の緩い判定を持たないこと）
check(
  "テンプレート判定は注入された関数に従う",
  isAcceptableTemplateSource(good, () => false),
  false,
);

// ─────────────────────────────────────────────────────────────
console.log("\nC. 経路選択 — 既存経路を壊さない");
// ─────────────────────────────────────────────────────────────

const URL_ONLY = {
  sourceUrl: "https://kuro.boo/kurocms/api/v1/get/x/src.html",
  sourceHtml: "",
};
const BOTH = { sourceUrl: URL_ONLY.sourceUrl, sourceHtml: good };
const HTML_ONLY = { sourceUrl: "", sourceHtml: good };

// 他ユーザー（別ゾーン）— 従来どおり必ず fetch。sourceHtml は完全に無視される。
check(
  "別ゾーン + URL のみ → fetch (従来と同一)",
  chooseTemplateSourceOrigin({ ...URL_ONLY, sameZone: false }),
  "fetch",
);
check(
  "別ゾーン + 両方 → fetch (sourceHtml を無視)",
  chooseTemplateSourceOrigin({ ...BOTH, sameZone: false }),
  "fetch",
);
check(
  "別ゾーン + HTML のみ → none (勝手に受け付けない)",
  chooseTemplateSourceOrigin({ ...HTML_ONLY, sameZone: false }),
  "none",
);

// 同一ゾーン（kuro.boo 自身）— HTML があれば inline、無ければ従来どおり fetch。
check(
  "同一ゾーン + 両方 → inline",
  chooseTemplateSourceOrigin({ ...BOTH, sameZone: true }),
  "inline",
);
check(
  "同一ゾーン + URL のみ → fetch (旧クライアントは従来動作)",
  chooseTemplateSourceOrigin({ ...URL_ONLY, sameZone: true }),
  "fetch",
);
check(
  "同一ゾーン + HTML のみ → inline",
  chooseTemplateSourceOrigin({ ...HTML_ONLY, sameZone: true }),
  "inline",
);

// ソース無し登録（PUT source-html で後入れする従来の使い方）は不変。
check(
  "両方空 → none (別ゾーン)",
  chooseTemplateSourceOrigin({
    sourceUrl: "",
    sourceHtml: "",
    sameZone: false,
  }),
  "none",
);
check(
  "両方空 → none (同一ゾーン)",
  chooseTemplateSourceOrigin({ sourceUrl: "", sourceHtml: "", sameZone: true }),
  "none",
);

// ─────────────────────────────────────────────────────────────
console.log("\nD. 統合 — 実ホストを入れた経路決定");
// ─────────────────────────────────────────────────────────────

const decide = (requestUrl: string, sourceUrl: string, sourceHtml: string) =>
  chooseTemplateSourceOrigin({
    sourceUrl,
    sourceHtml,
    sameZone: isSameZoneAsCommunity(requestUrl, COMMUNITY),
  });

check(
  "kuro.boo 本番の管理ホスト + 新クライアント → inline",
  decide(
    "https://kurocms.kuro.boo/kurocms/api/v1/templates",
    URL_ONLY.sourceUrl,
    good,
  ),
  "inline",
);
check(
  "kuro.boo 本番 + 旧クライアント (HTML 無し) → fetch",
  decide(
    "https://kurocms.kuro.boo/kurocms/api/v1/templates",
    URL_ONLY.sourceUrl,
    "",
  ),
  "fetch",
);
check(
  "他ユーザーの独自ドメイン + 新クライアント → fetch (影響なし)",
  decide("https://cms.example.com/api/v1/templates", URL_ONLY.sourceUrl, good),
  "fetch",
);
check(
  "他ユーザーの workers.dev + 新クライアント → fetch (影響なし)",
  decide(
    "https://x.foo.workers.dev/api/v1/templates",
    URL_ONLY.sourceUrl,
    good,
  ),
  "fetch",
);

if (failed) {
  console.error(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log("\nすべて OK");
