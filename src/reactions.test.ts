import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Script } from "node:vm";
import { renderTemplate } from "./templates/html-template.ts";
import {
  placeReactionSlot,
  reactionEndpoint,
  renderReactionWidget,
} from "./reactions.ts";
import type { Env } from "./types.ts";

// The same migration SQL runs against SQLite; the adapter only supplies D1's
// prepared-statement response shape so API tests exercise real constraints.
const sqlite = new DatabaseSync(":memory:");
sqlite.exec("PRAGMA foreign_keys = ON");
sqlite.exec(
  "CREATE TABLE documents (did TEXT PRIMARY KEY, live INTEGER NOT NULL)",
);
sqlite.exec(
  "CREATE TABLE taxonomy_items (id TEXT, kind TEXT, lang TEXT, name TEXT, is_system INTEGER, created_at TEXT, updated_at TEXT, PRIMARY KEY (id, kind, lang))",
);
sqlite.exec(
  "INSERT INTO taxonomy_items (id, kind, lang) VALUES ('ja', 'language', ''), ('en', 'language', '')",
);
sqlite.exec(
  readFileSync(
    new URL("../migrations/0071_article_reactions.sql", import.meta.url),
    "utf8",
  ),
);
sqlite.exec(
  "INSERT INTO documents (did, live) VALUES ('a', 1), ('b', 1), ('c', 1), ('draft', 0)",
);

const db = {
  prepare(sql: string) {
    return {
      bind(...args: unknown[]) {
        const stmt = sqlite.prepare(sql);
        return {
          async first() {
            return stmt.get(...args) || null;
          },
          async all() {
            return { results: stmt.all(...args) };
          },
          async run() {
            const result = stmt.run(...args);
            return { meta: { changes: Number(result.changes) } };
          },
        };
      },
    };
  },
};
const env = { DB: db } as unknown as Env;
const url = (id: string) => `https://example.com/_reactions/${id}`;
const req = (id: string, init?: RequestInit) => new Request(url(id), init);
async function api(id: string, init?: RequestInit) {
  const res = await reactionEndpoint(req(id, init), env, id);
  return {
    status: res.status,
    data: (await res.json()) as {
      counts?: Record<string, number>;
      votedType?: string | null;
      error?: string;
    },
    cookie: res.headers.get("set-cookie"),
    cache: res.headers.get("cache-control"),
  };
}

assert.equal(
  sqlite
    .prepare(
      "SELECT name FROM taxonomy_items WHERE id='article-reactions' AND lang='ja'",
    )
    .get()?.name,
  "<h2>この記事はいかがでしたか？</h2>",
);
assert.match(
  renderReactionWidget("a", "/test", "ja"),
  /data-endpoint="\/test\/_reactions\/a"/,
);
assert.equal(
  (renderReactionWidget("a", "", "ja").match(/data-type="/g) || []).length,
  3,
);
const widget = renderReactionWidget("a", "", "ja", "<h2>編集した見出し</h2>");
new Script(widget.match(/<script>([\s\S]*?)<\/script>/)?.[1] || "");
const rendered = renderTemplate(
  "<!-- kurocms-template-api:1 -->[[#if page.isArticle]][[html:article.bodyHtml]][[html:content.article-reactions]][[/if]]",
  {
    path: "/blog/a/",
    params: { type: "blog", article: "a" },
    lang: "ja",
    basePath: "",
    content: { "article-reactions": widget },
    article: {
      did: "a",
      slug: "a",
      type: "blog",
      title: "A",
      summary: "",
      bodyHtml: "<p>本文</p>",
      publishAt: "",
      updatedAt: "",
    },
  },
);
// 本文の直後に付くこと。**属性は増えうる**ので、順序だけを見る
assert.match(rendered, /<p>本文<\/p><section [^>]*class="kuro-reactions"/);
assert.match(rendered, /編集した見出し/);
assert.equal(
  placeReactionSlot("[[html:article.bodyHtml]]", true),
  "[[html:article.bodyHtml]][[html:content.article-reactions]]",
);
assert.equal(
  placeReactionSlot("[[html:article.bodyHtml]]", false),
  "[[html:article.bodyHtml]]",
);
assert.equal(
  placeReactionSlot(
    "[[html:article.bodyHtml]][[html:content.article-reactions]]",
    true,
  ),
  "[[html:article.bodyHtml]][[html:content.article-reactions]]",
);

const first = await api("a");
assert.equal(first.status, 200);
assert.equal(first.cache, "private, no-store");
assert.deepEqual(first.data.counts, { like: 0, useful: 0, excellent: 0 });
assert.match(first.cookie || "", /HttpOnly; SameSite=Lax; Secure/);
const cookie = first.cookie?.split(";")[0];
assert.ok(cookie);
const post = (id: string, type: string, extra: Record<string, string> = {}) =>
  api(id, {
    method: "POST",
    headers: {
      Origin: "https://example.com",
      Cookie: cookie,
      "Content-Type": "application/json",
      ...extra,
    },
    body: JSON.stringify({ type }),
  });
assert.equal((await post("draft", "like")).status, 404);
assert.equal((await post("missing", "like")).status, 404);
assert.equal((await post("a", "bad")).status, 400);
assert.equal(
  (await post("a", "like", { Origin: "https://evil.example" })).status,
  403,
);
assert.equal(
  (
    await api("a", {
      method: "POST",
      headers: {
        Origin: "https://example.com",
        "Content-Type": "application/json",
      },
      body: '{"type":"like"}',
    })
  ).status,
  428,
);
assert.equal(
  (
    await api("a", {
      method: "POST",
      headers: {
        Origin: "https://example.com",
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: "not json",
    })
  ).status,
  400,
);
const voted = await post("a", "like");
assert.equal(voted.status, 200);
assert.equal(voted.data.counts?.like, 1);
assert.equal(voted.data.votedType, "like");
assert.equal((await post("a", "useful")).status, 409);
assert.equal(
  (await api("a", { headers: { Cookie: cookie } })).data.counts?.like,
  1,
);
assert.equal(
  (await api("a", { headers: { Cookie: cookie } })).data.votedType,
  "like",
);
assert.equal((await api("a")).data.votedType, null);
assert.equal((await post("b", "useful")).data.counts?.useful, 1);
const raced = await Promise.all([post("c", "like"), post("c", "excellent")]);
assert.deepEqual(raced.map((r) => r.status).sort(), [200, 409]);
const c = await api("c", { headers: { Cookie: cookie } });
assert.equal((c.data.counts?.like || 0) + (c.data.counts?.excellent || 0), 1);
assert.equal(
  sqlite.prepare("SELECT COUNT(*) AS n FROM article_reactions").get()?.n,
  3,
);
sqlite.exec("DELETE FROM documents WHERE did = 'b'");
assert.equal(
  sqlite.prepare("SELECT COUNT(*) AS n FROM article_reactions").get()?.n,
  2,
);

// ── 枠の置き方は、雛形の解釈器と同じ読み方であること ────────────────────
//
// 解釈器はトークンの中身を trim するので `[[ html:… ]]` も正しい綴りである。
// 文字列の完全一致で探していたため、**どちらの向きにも静かに壊れていた**:
// 空白入りの雛形では枠が置かれず(ボタンが一生出ない)、空白入りの枠を手で
// 置いてあると二重に置かれた(ウィジェットとインライン script が2つ出る)。
const slots = (html: string): number =>
  (html.match(/content\.article-reactions/g) || []).length;

assert.equal(
  slots(
    placeReactionSlot("<article>[[html:article.bodyHtml]]</article>", true),
  ),
  1,
  "詰めて書いた雛形に枠が置かれない",
);
assert.equal(
  slots(
    placeReactionSlot("<article>[[ html:article.bodyHtml ]]</article>", true),
  ),
  1,
  "空白を入れた雛形に枠が置かれない(解釈器は受け付ける綴り)",
);
assert.equal(
  slots(
    placeReactionSlot(
      "<article>[[html:article.bodyHtml]]</article><footer>[[ html:content.article-reactions ]]</footer>",
      true,
    ),
  ),
  1,
  "手で置いた枠(空白入り)を見落として二重に置いている",
);
assert.equal(
  slots(
    placeReactionSlot("<article>[[html:article.bodyHtml]]</article>", false),
  ),
  0,
  "記事でないページに枠を置いている",
);

// ── 自分の枠は id で見つけること ────────────────────────────────────────
//
// 兄弟要素を2つ遡る形は、整形や最適化で並びが変わると**静かに効かなくなる**。
{
  const widget = renderReactionWidget("doc-1", "", "ja");
  assert.ok(
    widget.includes('id="kuro-reactions-doc-1"') &&
      widget.includes('getElementById("kuro-reactions-doc-1")'),
    "枠を id で見つけていない",
  );
  assert.ok(
    !widget.includes("previousElementSibling"),
    "兄弟要素を遡って自分を探している",
  );
  // 口が受け付けない id は、動きようがないので出さない(誤りの札だけが残る)
  assert.equal(renderReactionWidget("bad id!", "", "ja"), "");
}

console.log(
  "reaction migration, widget, public API and duplicate-vote contract OK",
);
