/**
 * 言語を URL のパスに入れる(2026-10-16 決定。cms-cms-build「公開ページを
 * Workers Static Assets に置く」・cms-cms-i18n)。
 *
 *   既定の言語   /post/slug/
 *   他の言語     /en/post/slug/
 *
 * ## なぜ `?lang=` をやめたか
 *
 * 公開ページを Static Assets に置くと、資産は**パスだけ**で一致を見る。
 * `/post/?lang=en` も `/post/` の資産に当たり、Worker が動かないまま既定の言語が
 * 返る(2026-10-16 に試験用 Worker で確かめた)。`run_worker_first` もパスでしか
 * 選べない。だから言語はパスで分け、全言語を資産に置く。
 *
 * ## ブラウザの言語・選んだ言語はページの JS が受け持つ
 *
 * 資産から返るページでは Worker が動かず `Accept-Language` を見られない。
 * 「選んだ言語 → ブラウザの言語」の判断は、全ページの `<head>` に埋め込む
 * `langScript()` が行う(順番と検索エンジンへの配慮は仕様書)。
 *
 * ⚠ ここは依存を持たない(node で直接試験する)。
 */

/** 言語コードの形(api.ts の validateLanguage と同じ)。 */
const LANG_CODE = new RegExp("^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$");

export function looksLikeLang(seg: string): boolean {
  return LANG_CODE.test(seg);
}

/**
 * 公開パス(publicBase を外したもの)を、言語とページのパスに分ける。
 * 先頭の部分が「登録された、既定でない言語」のときだけ言語として扱う。
 * それ以外(タイプ名など)はそのままページのパス。
 */
export function splitLangPath(
  path: string,
  registered: string[],
  defaultLang: string,
): { lang: string | null; path: string } {
  const seg = path.split("/")[1] ?? "";
  if (seg && seg !== defaultLang && registered.includes(seg)) {
    const rest = path.slice(seg.length + 1);
    return { lang: seg, path: rest === "" ? "/" : rest };
  }
  return { lang: null, path };
}

/** ページのパスに言語を付ける(既定の言語はそのまま)。 */
export function langPath(
  path: string,
  lang: string,
  defaultLang: string,
): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return lang && lang !== defaultLang ? `/${lang}${p}` : p;
}

/**
 * 既定でない言語のページの中の、同じサイトの公開ページへのリンクに言語を付ける。
 * 記事カード・ナビ・本文中のリンクなど、組み立て元がどこでも 1 か所で揃う。
 *
 * - 対象は `<a href>` だけ(CSS・画像・`<link>` は触らない)。
 * - `isPage` が公開ページと認めたパスだけ(管理画面・API・メディアは除く)。
 * - 既に言語が付いているもの・別のサイトへのものは触らない。
 * - 古い `?lang=` は外す(パスが言語を表す)。
 */
export function localizeLinks(
  html: string,
  opts: {
    lang: string;
    defaultLang: string;
    registered: string[];
    /** 公開サイトの根(例 "/blog")。無ければ "" */
    publicBase: string;
    /** public_domain の origin。無ければ "" */
    origin: string;
    isPage: (path: string) => boolean;
  },
): string {
  const { lang, defaultLang, registered, publicBase, origin, isPage } = opts;
  if (!lang || lang === defaultLang) return html;
  const re = new RegExp("(<a\\b[^>]*?\\shref=)([\"'])([^\"']*)\\2", "gi");
  return html.replace(re, (all, head: string, q: string, href: string) => {
    let rest = href;
    let prefix = "";
    if (origin && rest.startsWith(origin + "/")) {
      prefix = origin;
      rest = rest.slice(origin.length);
    }
    if (!rest.startsWith("/") || rest.startsWith("//")) return all;
    const cut = rest.search(new RegExp("[?#]"));
    let path = cut < 0 ? rest : rest.slice(0, cut);
    let tail = cut < 0 ? "" : rest.slice(cut);
    if (publicBase) {
      if (path !== publicBase && !path.startsWith(publicBase + "/")) return all;
      path = path.slice(publicBase.length) || "/";
    }
    if (splitLangPath(path, registered, defaultLang).lang) return all;
    if (!isPage(path)) return all;
    tail = dropLangQuery(tail);
    return `${head}${q}${prefix}${publicBase}${langPath(path, lang, defaultLang)}${tail}${q}`;
  });
}

/** `?a=1&lang=en#x` → `?a=1#x`。 */
function dropLangQuery(tail: string): string {
  if (!tail.startsWith("?")) return tail;
  const hashAt = tail.indexOf("#");
  const query = hashAt < 0 ? tail.slice(1) : tail.slice(1, hashAt);
  const hash = hashAt < 0 ? "" : tail.slice(hashAt);
  const kept = query
    .split("&")
    .filter((kv) => kv && kv.split("=")[0] !== "lang");
  return (kept.length ? `?${kept.join("&")}` : "") + hash;
}

/** クローラーとみなす UA(この JS は何もしない)。Googlebot は描画時も `Googlebot/2.1` を名乗る。 */
export const BOT_UA =
  "bot|crawl|spider|slurp|mediapartners|lighthouse|inspectiontool|facebookexternalhit|embedly|preview";

/**
 * 全ページの `<head>` に置く言語の判断(多言語のサイトだけ)。上から順に見て、
 * 最初に当たったものだけ行う:
 *   1. クローラー → 何もしない
 *   2. `?lang=xx` の古いリンク → その言語の版へ
 *   3. 言語選択で選んだ言語(localStorage)→ このページにその言語があれば移す
 *   4. 選んでいない・この訪問の最初のページ(sessionStorage に印が無い)→
 *      navigator.languages を 2 文字に縮め、最初にこのページにある言語へ
 *   5. それ以外 → 何もしない
 * 2・4 では移る前に印を付け、移った先・続けて見るページで戻されないようにする。
 * 移るのは location.replace(戻るボタンで繰り返さない)。
 *
 * ⚠ テンプレートリテラルの中の JS なので、正規表現リテラルを書かない。
 */
export function langScript(opts: {
  defaultLang: string;
  current: string;
  pageLangs: string[];
  publicBase: string;
}): string {
  const cfg = JSON.stringify({
    d: opts.defaultLang,
    c: opts.current,
    l: opts.pageLangs,
    b: opts.publicBase,
    u: BOT_UA,
  }).replace(/</g, "\\u003c");
  return `<script>(function(){try{var K=${cfg};
if(new RegExp(K.u,"i").test(navigator.userAgent||""))return;
var CH="kurocms_lang",SEEN="kurocms_lang_seen";
function has(l){return K.l.indexOf(l)>=0;}
function bare(){var p=location.pathname.slice(K.b.length)||"/";if(K.c!==K.d&&p.indexOf("/"+K.c)===0)p=p.slice(K.c.length+1)||"/";return p;}
function href(l,q){return K.b+(l===K.d?"":"/"+l)+bare()+q+location.hash;}
function query(){var s=new URLSearchParams(location.search);s.delete("lang");var t=s.toString();return t?"?"+t:"";}
function mark(){try{sessionStorage.setItem(SEEN,"1");}catch(e){}}
function go(l){if(l!==K.c||location.search.indexOf("lang=")>=0)location.replace(href(l,query()));}
var q=new URLSearchParams(location.search).get("lang");
if(q){mark();if(has(q))go(q);return;}
var pick="";try{pick=localStorage.getItem(CH)||"";}catch(e){}
if(pick){if(has(pick)&&pick!==K.c)go(pick);return;}
var seen="";try{seen=sessionStorage.getItem(SEEN)||"";}catch(e){return;}
if(seen)return;mark();
var nl=navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language||""];
for(var i=0;i<nl.length;i++){var c=String(nl[i]||"").slice(0,2).toLowerCase();if(has(c)){if(c!==K.c)go(c);return;}}
}catch(e){}})();</script>`;
}
