// 契約テスト (node で直接実行: `node src/lang-path.test.ts`)。
// 言語をパスに入れる形(/en/post/)と、全ページの <head> に置く言語の判断。
import { runInNewContext } from "node:vm";
import {
  splitLangPath,
  langPath,
  localizeLinks,
  langScript,
} from "./lang-path.ts";

let f = 0;
const eq = (n: string, g: unknown, w: unknown) => {
  const a = JSON.stringify(g),
    b = JSON.stringify(w);
  if (a === b) console.log("  ok   " + n);
  else {
    f++;
    console.log(`  FAIL ${n}\n   got ${a}\n   want ${b}`);
  }
};

const langs = ["ja", "en", "fr"];
eq("言語の付いたパス", splitLangPath("/en/post/a/", langs, "ja"), {
  lang: "en",
  path: "/post/a/",
});
eq("言語のトップ", splitLangPath("/en/", langs, "ja"), {
  lang: "en",
  path: "/",
});
eq("末尾の / が無いトップ", splitLangPath("/en", langs, "ja"), {
  lang: "en",
  path: "/",
});
eq(
  "既定の言語はパスに付けない(/ja/ は言語扱いしない)",
  splitLangPath("/ja/post/", langs, "ja"),
  { lang: null, path: "/ja/post/" },
);
eq("登録の無いものはタイプ名", splitLangPath("/de/post/", langs, "ja"), {
  lang: null,
  path: "/de/post/",
});
eq("言語を付ける", langPath("/post/a/", "en", "ja"), "/en/post/a/");
eq("既定の言語は付けない", langPath("/post/a/", "ja", "ja"), "/post/a/");

const isPage = (p: string) =>
  !p.startsWith("/kurocms") && !p.startsWith("/images") && !p.includes(".");
const loc = (
  html: string,
  o: Partial<Parameters<typeof localizeLinks>[1]> = {},
) =>
  localizeLinks(html, {
    lang: "en",
    defaultLang: "ja",
    registered: langs,
    publicBase: "",
    origin: "https://ex.com",
    isPage,
    ...o,
  });
eq(
  "公開ページへのリンクに言語を付ける",
  loc(`<a class="x" href="/post/a/">`),
  `<a class="x" href="/en/post/a/">`,
);
eq("トップ", loc(`<a href="/">`), `<a href="/en/">`);
eq(
  "古い ?lang= を外す",
  loc(`<a href="/post/a/?lang=en&p=2#h">`),
  `<a href="/en/post/a/?p=2#h">`,
);
eq(
  "同じ origin の絶対 URL",
  loc(`<a href="https://ex.com/post/a/">`),
  `<a href="https://ex.com/en/post/a/">`,
);
eq(
  "別のサイトは触らない",
  loc(`<a href="https://other.com/post/a/">`),
  `<a href="https://other.com/post/a/">`,
);
eq(
  "既に言語が付いたものは触らない",
  loc(`<a href="/fr/post/a/">`),
  `<a href="/fr/post/a/">`,
);
eq(
  "管理画面・メディアは触らない",
  loc(`<a href="/kurocms/admin"><a href="/images/i.webp">`),
  `<a href="/kurocms/admin"><a href="/images/i.webp">`,
);
eq(
  "<a> 以外は触らない",
  loc(`<link href="/post/a/">`),
  `<link href="/post/a/">`,
);
eq(
  "既定の言語のページは触らない",
  loc(`<a href="/post/a/">`, { lang: "ja" }),
  `<a href="/post/a/">`,
);
eq(
  "公開サイトの根の下",
  loc(`<a href="/blog/post/a/"><a href="/other/x/">`, { publicBase: "/blog" }),
  `<a href="/blog/en/post/a/"><a href="/other/x/">`,
);

// ── <head> の判断(ブラウザの代わりに vm で走らせる)──
function run(o: {
  path: string;
  search?: string;
  current: string;
  pageLangs?: string[];
  ua?: string;
  languages?: string[];
  picked?: string;
  seen?: boolean;
  base?: string;
}): { to: string | null; seen: boolean } {
  let to: string | null = null;
  const ls = new Map<string, string>(
    o.picked ? [["kurocms_lang", o.picked]] : [],
  );
  const ss = new Map<string, string>(
    o.seen ? [["kurocms_lang_seen", "1"]] : [],
  );
  const store = (m: Map<string, string>) => ({
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  });
  const src = langScript({
    defaultLang: "ja",
    current: o.current,
    pageLangs: o.pageLangs ?? ["ja", "en", "fr"],
    publicBase: o.base ?? "",
  })
    .replace("<script>", "")
    .replace("</script>", "");
  runInNewContext(src, {
    location: {
      pathname: o.path,
      search: o.search ?? "",
      hash: "",
      replace: (u: string) => (to = u),
    },
    navigator: {
      userAgent: o.ua ?? "Mozilla/5.0 Chrome",
      languages: o.languages ?? ["ja-JP"],
      language: (o.languages ?? ["ja-JP"])[0],
    },
    localStorage: store(ls),
    sessionStorage: store(ss),
    URLSearchParams,
  });
  return { to, seen: ss.has("kurocms_lang_seen") };
}
eq(
  "Googlebot は移さない",
  run({
    path: "/post/a/",
    current: "ja",
    languages: ["en-US"],
    ua: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/120",
  }).to,
  null,
);
eq(
  "古い ?lang= は新しい URL へ",
  run({ path: "/post/a/", search: "?lang=en&p=2", current: "ja" }),
  { to: "/en/post/a/?p=2", seen: true },
);
eq(
  "古い ?lang= が今の言語なら、付けたクエリだけ外す",
  run({ path: "/post/a/", search: "?lang=ja", current: "ja" }).to,
  "/post/a/",
);
eq(
  "選んだ言語へ移す",
  run({ path: "/post/a/", current: "ja", picked: "fr" }).to,
  "/fr/post/a/",
);
eq(
  "選んだ言語が既定なら言語の無い URL へ",
  run({ path: "/en/post/a/", current: "en", picked: "ja" }).to,
  "/post/a/",
);
eq(
  "選んだ言語がこのページに無ければ移さない",
  run({
    path: "/post/a/",
    current: "ja",
    picked: "fr",
    pageLangs: ["ja", "en"],
  }).to,
  null,
);
eq(
  "選んだ言語があればブラウザの言語は見ない",
  run({ path: "/post/a/", current: "ja", picked: "ja", languages: ["en-US"] })
    .to,
  null,
);
eq(
  "初めてのページはブラウザの言語へ",
  run({ path: "/post/a/", current: "ja", languages: ["en-US", "ja"] }),
  { to: "/en/post/a/", seen: true },
);
eq(
  "ブラウザの言語の順に、このページにあるものを選ぶ",
  run({ path: "/post/a/", current: "ja", languages: ["de-DE", "fr-FR"] }).to,
  "/fr/post/a/",
);
eq(
  "合う言語が無ければ移さない",
  run({ path: "/post/a/", current: "ja", languages: ["de-DE"] }).to,
  null,
);
eq(
  "2 ページ目以降はブラウザの言語で移さない",
  run({ path: "/en/post/b/", current: "en", languages: ["ja"], seen: true }).to,
  null,
);
eq(
  "公開サイトの根の下",
  run({
    path: "/blog/post/a/",
    current: "ja",
    languages: ["en"],
    base: "/blog",
  }).to,
  "/blog/en/post/a/",
);
eq(
  "言語のトップから既定へ",
  run({ path: "/en/", current: "en", picked: "ja" }).to,
  "/",
);

if (f) {
  console.log(`\n${f} failed`);
  process.exit(1);
}
console.log("\nall ok");
