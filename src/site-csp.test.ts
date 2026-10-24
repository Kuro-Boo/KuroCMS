// 契約テスト (node で直接実行: `node src/site-csp.test.ts`)。
// 公開サイトの CSP(cms-cms-security「CSP」): 組み立て・テンプレートのスクリプトを移す・
// 報告を数える・部品がページにスクリプトを書かない。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { siteCspHeaders, siteHeadersFile, SITE_CSP_MODE } from "./site-csp.ts";
import {
  externalizeTemplateScripts,
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
  assert.equal(SITE_CSP_MODE, "report", "最初の版は報告だけ(core-csp §4)");
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
    "script-src 'self'",
    "設定の無いサイトは自分のファイルだけ(nonce も unsafe も入れない)",
  );
  assert.match(plain, /object-src 'none'/);
  assert.match(plain, /base-uri 'self'/);
  assert.match(plain, /frame-ancestors 'self'/);
  assert.match(plain, /report-uri \/_csp;/, "報告はサイト自身の口へ");
  assert.doesNotMatch(plain, /defects\.entamy\.com/, "Entamy へ直接送らせない");
  assert.match(directive(plain, "frame-src"), /www\.youtube-nocookie\.com/);
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
  assert.match(full, /report-uri \/blog\/_csp;/);

  const file = siteHeadersFile(
    siteCspHeaders({
      publicBase: "",
      ga: false,
      adsense: false,
      bluesky: false,
    }),
  );
  assert.ok(file.startsWith("/*\n  content-security-policy-report-only: "));
  assert.ok(file.includes('\n  reporting-endpoints: entamy-csp="/_csp"\n'));
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
      new URL("../migrations/0080_csp_reports.sql", import.meta.url),
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
        directive: "script-src-elem",
        blocked: "evil.example",
        disposition: "report",
      },
    ],
    "出どころはホスト名だけ",
  );
  const rows = raw
    .prepare("SELECT * FROM csp_reports ORDER BY first_at")
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
    raw.prepare("SELECT COUNT(*) AS n FROM csp_reports").get() as { n: number }
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

console.log("site CSP contract OK");
