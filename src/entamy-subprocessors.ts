/**
 * Entamy のサブプロセッサー一覧(基盤の仕様 admin §10.2.11・2026-10-11 決定)。
 *
 * 利用者(サイトの持ち主)が自分のサイトに置く terms / privacy は**利用者が書いて管理する**
 * (Entamy の規約とは別物)。ただ、Entamy がデータを預かる形で使っている利用者は、自分の
 * プライバシーポリシーに **Entamy の先の委託先**を示す必要がある。一覧を知っているのは Entamy なので、
 * リリースの前に基盤の配信から取って同梱し(ops/subprocessors_bundle.mjs・手で書かない)、
 * 本文の `[[entamy.subprocessors]]` を表に置き換える。実行中に Entamy へ取りに行かない。
 */
import bundle from "./generated/entamy-subprocessors.json" with { type: "json" };

interface SubprocessorBundle {
  status: "published" | "unpublished";
  updated_at: string | null;
  items: {
    name: string;
    purpose: string;
    data: string;
    location: string;
    url: string;
  }[];
}

const data = bundle as SubprocessorBundle;

const esc = (s: string): string =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] ?? c,
  );

/** 一覧の表。未公開なら準備中と書く(空の表を出さない)。 */
export function renderEntamySubprocessors(
  lang: string,
  source: SubprocessorBundle = data,
): string {
  const ja = (lang || "").split("-")[0] === "ja";
  if (source.status !== "published" || !source.items.length) {
    return `<p class="kuro-entamy-subprocessors">${ja ? "Entamy の委託先の一覧は準備中です。" : "Entamy's list of subprocessors is being prepared."}</p>`;
  }
  const head = ja
    ? ["委託先", "委託する業務", "扱う情報", "情報の所在国"]
    : ["Subprocessor", "Purpose", "Data", "Location"];
  const rows = source.items
    .map((x) => {
      const name = /^https:\/\/\S+$/.test(x.url)
        ? `<a href="${esc(x.url)}" rel="noopener noreferrer">${esc(x.name)}</a>`
        : esc(x.name);
      return `<tr><td>${name}</td><td>${esc(x.purpose)}</td><td>${esc(x.data)}</td><td>${esc(x.location)}</td></tr>`;
    })
    .join("");
  const asOf = source.updated_at
    ? `<p class="kuro-entamy-subprocessors-date">${ja ? "Entamy の一覧の更新日" : "As of"} ${esc(source.updated_at.slice(0, 10))}</p>`
    : "";
  return `<table class="kuro-entamy-subprocessors"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>${asOf}`;
}

/**
 * 本文の `[[entamy.subprocessors]]` を表にする。段落に1つだけ置かれたもの(エディターが書く形)は
 * 段落ごと置き換える(<p> の中に表を入れない)。
 */
export function expandEntamySubprocessors(
  html: string,
  lang: string,
  source: SubprocessorBundle = data,
): string {
  if (!html.includes("[[entamy.subprocessors]]")) return html;
  const table = renderEntamySubprocessors(lang, source);
  return html
    .replace(/<p\b[^>]*>\s*\[\[entamy\.subprocessors\]\]\s*<\/p>/g, table)
    .split("[[entamy.subprocessors]]")
    .join(table);
}
