// 契約テスト (node で直接実行: `node src/site-csp.test.ts`)。
// 公開サイトの CSP(cms-cms-security「CSP」): 組み立て・テンプレートのスクリプトを移す・
// 報告を数える・部品がページにスクリプトを書かない。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  adminCspHeaders,
  ADMIN_CSP_MODE,
  siteCspHeaders,
  siteHeadersFile,
  SITE_CSP_MODE,
} from "./site-csp.ts";
import {
  externalizeTemplateScripts,
  templateHandlerScript,
  templateScriptBody,
  templateScriptWarnings,
  scriptHash,
} from "./template-scripts.ts";
import { recordCspReports, CSP_REPORT_MAX_KINDS } from "./csp-report.ts";

const policyOf = (h: Record<string, string>) =>
  h["content-security-policy-report-only"] ??
  h["content-security-policy"] ??
  "";
const directive = (p: string, name: string) =>
  p.split("; ").find((d) => d.startsWith(name + " ")) ?? "";

// ── 組み立て ────────────────────────────────────────────────────────────
{
  assert.equal(
    SITE_CSP_MODE,
    "enforce",
    "報告で漏れが無いと確かめて強制にした(課題 ad495461)",
  );
  const plain = policyOf(
    siteCspHeaders({
      publicBase: "",
      ga: false,
      adsense: false,
      bluesky: false,
    }),
  );
  assert.equal(
    directive(plain, "script-src"),
    "script-src 'self' https://static.cloudflareinsights.com",
    "設定の無いサイトは自分のファイルと Cloudflare の Web Analytics だけ(nonce も unsafe も入れない)",
  );
  assert.match(plain, /object-src 'none'/);
  assert.match(plain, /base-uri 'self'/);
  assert.match(plain, /frame-ancestors 'self'/);
  assert.match(
    plain,
    /report-uri \/_csp$/,
    "報告はサイト自身の口へ(report-uri だけ)",
  );
  assert.doesNotMatch(plain, /defects\.entamy\.com/, "Entamy へ直接送らせない");
  assert.match(directive(plain, "frame-src"), /www\.youtube-nocookie\.com/);
  assert.match(
    directive(plain, "style-src"),
    /fonts\.googleapis\.com/,
    "Google Fonts(フォント設定・テンプレート)はいつも許す",
  );
  assert.match(directive(plain, "font-src"), /fonts\.gstatic\.com/);
  assert.doesNotMatch(plain, /googletagmanager|googlesyndication|bsky/);

  const full = policyOf(
    siteCspHeaders({
      publicBase: "/blog",
      ga: true,
      adsense: true,
      bluesky: true,
    }),
  );
  assert.match(directive(full, "script-src"), /googletagmanager\.com/);
  assert.match(
    directive(full, "script-src"),
    /pagead2\.googlesyndication\.com/,
  );
  assert.match(directive(full, "connect-src"), /public\.api\.bsky\.app/);
  assert.doesNotMatch(directive(full, "script-src"), /unsafe/);
  assert.match(full, /report-uri \/blog\/_csp$/);

  const file = siteHeadersFile(
    siteCspHeaders({
      publicBase: "",
      ga: false,
      adsense: false,
      bluesky: false,
    }),
  );
  assert.ok(file.startsWith("/*\n  content-security-policy: "));
  assert.ok(
    !file.includes("reporting-endpoints"),
    "報告は report-uri だけ(report-to は届かずに失われた)",
  );
}

// ── テンプレートのスクリプトを移す ──────────────────────────────────────
{
  const inline = "document.documentElement.dataset.kuroTemplate = 'x';";
  const src = [
    "<head>",
    `<script>${inline}</script>`,
    `<script type="module" defer>import("./a.js")</script>`,
    `<script src="https://evil.example/x.js"></script>`,
    `<script src="//cdn.example/y.js" async></script>`,
    `<script src="https://cdn.tailwindcss.com"></script>`,
    `<script src="/local.js"></script>`,
    `<script type="application/ld+json">{"a":1}</script>`,
    `<script>var t = "[[content.title]]";</script>`,
    "</head>",
  ].join("\n");
  const out = await externalizeTemplateScripts(src, "kuro-boo", "/blog");
  const h = await scriptHash(inline);
  assert.ok(
    out.includes(`<script src="/blog/_tjs/kuro-boo.${h}.js"></script>`),
    "インラインはサイトのファイルへ(元の位置)",
  );
  assert.match(
    out,
    /<script type="module" src="\/blog\/_tjs\/kuro-boo\.[a-f0-9]{16}\.js"><\/script>/,
    "type は引き継ぎ、インラインで効かない defer は外す",
  );
  assert.ok(
    !out.includes("evil.example") && !out.includes("cdn.example"),
    "外部の JS は外す",
  );
  assert.ok(
    out.includes("cdn.tailwindcss.com"),
    "Tailwind の CDN は CMS が置き換えるので残す",
  );
  assert.ok(
    out.includes(`<script src="/local.js"></script>`),
    "自分のサイトの src はそのまま",
  );
  assert.ok(out.includes(`{"a":1}`), "動かない type(JSON-LD)は触らない");
  assert.ok(
    out.includes(`[[content.title]]`),
    "[[…]] を含むスクリプトは移せない(インラインのまま)",
  );
  assert.equal(
    await templateScriptBody(src, h),
    inline,
    "/_tjs/ はハッシュで中身を引き当てる",
  );
  assert.equal(await templateScriptBody(src, "0".repeat(16)), null);

  const warnings = await templateScriptWarnings(src);
  assert.deepEqual(
    warnings.map((w) => `${w.kind}:${w.detail}`),
    [
      "external:https://evil.example/x.js",
      "external://cdn.example/y.js",
      'token:var t = "[[content.title]]";',
    ],
    "管理画面の警告は外部の JS と [[…]] を含むスクリプト",
  );
  assert.equal(
    await externalizeTemplateScripts("<p>no script</p>", "t", ""),
    "<p>no script</p>",
  );
}

// ── 報告を数える ────────────────────────────────────────────────────────
{
  const raw = new DatabaseSync(":memory:");
  raw.exec(
    readFileSync(
      new URL("../migrations/0085_csp_page_reports.sql", import.meta.url),
      "utf8",
    ),
  );
  const stmt = (sql: string) => {
    let args: unknown[] = [];
    const s = {
      bind: (...a: unknown[]) => ((args = a), s),
      run: async () => {
        const r = raw.prepare(sql).run(...(args as never[]));
        return { meta: { changes: Number(r.changes) } };
      },
      all: async () => ({
        results: raw.prepare(sql).all(...(args as never[])),
      }),
    };
    return s;
  };
  const env = { DB: { prepare: (sql: string) => stmt(sql) } } as never;
  const report = (
    blocked: string,
    page = "https://site.example/a/?token=secret",
  ) =>
    JSON.stringify({
      "csp-report": {
        "document-uri": page,
        "violated-directive": "script-src-elem",
        "blocked-uri": blocked,
        disposition: "report",
      },
    });
  const first = await recordCspReports(env, report("inline"), 1);
  assert.deepEqual(
    first,
    [
      {
        page: "site",
        directive: "script-src-elem",
        blocked: "inline",
        disposition: "report",
      },
    ],
    "初めての組は送る分として返す",
  );
  assert.deepEqual(
    await recordCspReports(env, report("inline"), 2),
    [],
    "同じ組は数を足すだけ",
  );
  assert.deepEqual(
    await recordCspReports(env, report("https://evil.example/x.js?a=1"), 3),
    [
      {
        page: "site",
        directive: "script-src-elem",
        blocked: "evil.example",
        disposition: "report",
      },
    ],
    "出どころはホスト名だけ",
  );
  assert.equal(
    (await recordCspReports(env, report("inline"), 3, "admin")).length,
    1,
    "同じ組でも、管理画面の分は別に数える",
  );
  const rows = raw
    .prepare("SELECT * FROM csp_page_reports ORDER BY first_at")
    .all() as Array<Record<string, unknown>>;
  assert.equal(rows[0]!.count, 2);
  assert.ok(
    !JSON.stringify(rows).includes("site.example") &&
      !JSON.stringify(rows).includes("secret"),
    "ページの URL は残さない",
  );
  assert.deepEqual(
    await recordCspReports(env, report("chrome-extension://abc/x.js"), 4),
    [],
    "拡張機能の分は数えない",
  );
  assert.deepEqual(await recordCspReports(env, "not json", 5), []);
  for (let i = 0; i < CSP_REPORT_MAX_KINDS + 5; i++)
    await recordCspReports(env, report(`https://h${i}.example/x.js`), 10 + i);
  const n = (
    raw.prepare("SELECT COUNT(*) AS n FROM csp_page_reports").get() as {
      n: number;
    }
  ).n;
  assert.equal(n, CSP_REPORT_MAX_KINDS, "組の数は上限で止まる(誰でも送れる口)");
}

// ── 部品はページにスクリプトを書かない ───────────────────────────────────
//
// 公開ページを作るコードに、インラインの <script>(src 無し)やイベント属性が戻ると、
// 強制にした日にその部品だけ黙って止まる。出してよいのは src 付きと JSON-LD だけ。
{
  for (const file of [
    "public.ts",
    "reactions.ts",
    "lang-path.ts",
    "templates/html-template.ts",
  ]) {
    const code = readFileSync(new URL(`./${file}`, import.meta.url), "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    const literals = [...code.matchAll(/<script(?![a-z])([^>`]*)>/g)].map(
      (m) => m[1] ?? "",
    );
    const inline = literals.filter(
      (a) =>
        !/\bsrc=/.test(a) &&
        !/application\/ld\+json/.test(a) &&
        !/\\b|\[/.test(a),
    );
    assert.deepEqual(
      inline,
      [],
      `${file} がインラインの <script> を出している`,
    );
    assert.doesNotMatch(
      code,
      /\son(change|click|load|error)=\\?"/,
      `${file} がイベント属性を出している`,
    );
  }
}

// 管理画面の CSP(課題 dffbd3ff)。要求ごとの nonce だけでインラインの script を許し、枠に入れさせない。
{
  const h = adminCspHeaders({ publicBase: "/blog", nonce: "n0nce" });
  const name =
    ADMIN_CSP_MODE === "enforce"
      ? "content-security-policy"
      : "content-security-policy-report-only";
  const policy = h[name] ?? "";
  assert.match(policy, /script-src 'self' 'nonce-n0nce'/);
  assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /report-uri \/blog\/_csp/);
  assert.match(policy, /object-src 'none'/);
  // report-only の間も、枠に入れさせないことは強制する(課題 97b74d87)。
  assert.match(h["content-security-policy"] ?? "", /frame-ancestors 'none'/);
  assert.equal(h["x-frame-options"], "DENY");
}

// ── GA は標準の機能: Google の案内の一覧を最初から全部許す(2026-11-07 利用者の指摘) ──────────
{
  const on = directive(
    policyOf(
      siteCspHeaders({
        publicBase: "",
        ga: true,
        adsense: false,
        bluesky: false,
      }),
    ),
    "connect-src",
  );
  for (const src of [
    "https://*.google-analytics.com",
    "https://*.analytics.google.com",
    "https://*.googletagmanager.com",
    "https://*.g.doubleclick.net",
    "https://*.google.com",
  ])
    assert.ok(on.split(" ").includes(src), `GA の接続先 ${src}`);
  const off = directive(
    policyOf(
      siteCspHeaders({
        publicBase: "",
        ga: false,
        adsense: false,
        bluesky: false,
      }),
    ),
    "connect-src",
  );
  assert.doesNotMatch(off, /google/, "GA を使わないサイトには許さない");
  // 標準の機能を全部入れても、静的資産の `_headers` の 1 行は Cloudflare の上限(2,000 文字)に収まる
  // (1.10.208 で国ごとの Google を足して超え、資産の登録が落ちた)。
  const file = siteHeadersFile(
    siteCspHeaders({
      publicBase: "/blog-with-a-long-base-path",
      ga: true,
      adsense: true,
      bluesky: true,
    }),
  );
  for (const line of file.split("\n"))
    assert.ok(
      line.length <= 2000,
      `_headers の行が ${line.length} 文字(上限 2,000)`,
    );
}

// ── 属性のハンドラーをファイルへ移す(課題 dffbd3ff・entamy.com の携帯のメニュー) ─────────────
{
  const src =
    `<html><body><button class="m" onclick="var m=document.getElementById('d');if(m){m.classList.toggle(&quot;open&quot;)}return false">≡</button>` +
    `<a href="/x" onmouseover='this.dataset.h="1"' onclick="go([[page.id]])">x</a>` +
    `<script>var a = '<b onclick="no">';</script><!-- <i onclick="no"> --></body></html>`;
  const out = await externalizeTemplateScripts(src, "tmpl_1", "");
  // 移したものは印だけになり、[[…]] を含むものは残る。script と注記の中には触らない。
  assert.match(out, /<button class="m" data-kt-on="0">≡<\/button>/);
  assert.match(
    out,
    /<a href="\/x" onclick="go\(\[\[page\.id\]\]\)" data-kt-on="1">x<\/a>/,
  );
  assert.doesNotMatch(out, /onmouseover/);
  assert.match(out, /<!-- <i onclick="no"> -->/);
  const m = out.match(
    /<script src="(\/_tjs\/tmpl_1\.([0-9a-f]{16})\.js)"><\/script><\/body>/,
  );
  assert.ok(m, "ファイルは </body> の直前で読む");
  const body = await templateScriptBody(src, m![2]);
  assert.ok(body, "同じハッシュでファイルの中身を引き当てられる");
  // 静的資産に置くファイルと、頁が指すファイルが同じ。
  assert.deepEqual(await templateHandlerScript(src), { hash: m![2], body });
  // 文字参照を戻して JS にしている。
  assert.match(body!, /m\.classList\.toggle\("open"\)/);
  // ファイルを動かして、this・event・return false が属性のときと同じに効くこと。
  const listeners: Array<{
    el: { dataset: Record<string, string>; tag: string };
    ev: string;
    fn: (e: unknown) => void;
  }> = [];
  const els = [
    {
      tag: "button",
      attrs: { "data-kt-on": "0" },
      dataset: {} as Record<string, string>,
    },
    {
      tag: "a",
      attrs: { "data-kt-on": "1" },
      dataset: {} as Record<string, string>,
    },
  ];
  let toggled = 0;
  const fakeDoc = {
    readyState: "complete",
    getElementById: () => ({ classList: { toggle: () => toggled++ } }),
    querySelectorAll: () =>
      els.map((e) => ({
        getAttribute: (k: string) => (e.attrs as Record<string, string>)[k],
        dataset: e.dataset,
        addEventListener: (ev: string, fn: (e: unknown) => void) =>
          listeners.push({ el: e as never, ev, fn }),
      })),
    addEventListener: () => {},
  };
  new Function("document", body!)(fakeDoc);
  assert.deepEqual(
    listeners.map((l) => [l.el.tag, l.ev]),
    [
      ["button", "click"],
      ["a", "mouseover"],
    ],
  );
  let prevented = false;
  listeners[0]!.fn.call({}, { preventDefault: () => (prevented = true) });
  assert.equal(toggled, 1);
  assert.equal(prevented, true, "return false は既定の動きを止める");
  const target = { dataset: {} as Record<string, string> };
  listeners[1]!.fn.call(target, { preventDefault: () => {} });
  assert.equal(target.dataset.h, "1", "this は要素");
  // [[…]] を含むハンドラーは警告に出る。
  assert.deepEqual(
    (await templateScriptWarnings(src)).filter(
      (w) => w.kind === "handler_token",
    ),
    [{ kind: "handler_token", detail: "go([[page.id]])" }],
  );
  // ハンドラーが無ければ、何も足さない。
  assert.equal(
    await externalizeTemplateScripts("<p>x</p>", "t", ""),
    "<p>x</p>",
  );
}

// ── 管理画面のコードに属性のハンドラーを書かない(管理画面の CSP が止める・2026-11-06 に「←」の色で踏んだ) ──
{
  const { readdirSync } = await import("node:fs");
  const files = [
    "./admin.main.ts",
    "./admin-shell.ts",
    ...["screens", "lib"].flatMap((d) =>
      readdirSync(new URL(`./admin/${d}/`, import.meta.url)).map(
        (f) => `./admin/${d}/${f}`,
      ),
    ),
  ].filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  for (const f of files) {
    const text = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.doesNotMatch(
      text,
      /[ '"]on[a-z]{3,}=[\\"']/,
      `${f} に属性のハンドラーがある`,
    );
  }
}

// ── テンプレートのプレビューを管理画面と同じ origin で動かさない(課題 dffbd3ff) ──────────
// テンプレート(他人の作った Community のものも)のスクリプトが、管理画面の画面・cookie 付きの API に届かないこと。
{
  const api = readFileSync(new URL("./api.ts", import.meta.url), "utf8");
  assert.match(
    api,
    /export const TEMPLATE_PREVIEW_CSP = "sandbox allow-scripts";/,
  );
  assert.match(api, /"Content-Security-Policy": TEMPLATE_PREVIEW_CSP,/);
  const site = readFileSync(
    new URL("./admin/screens/site.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    site,
    /sandbox=["']allow-same-origin/,
    "縮小図の枠に allow-same-origin を付けない",
  );
  assert.doesNotMatch(
    site,
    /sandbox=["'][^"']*allow-same-origin[^"']*allow-scripts/,
  );
}

console.log("site CSP contract OK");
