/**
 * 公開ページの `<head>` で、描く前に走らせるもの(cms-cms-security「CSP」)。
 *
 * CSP は `'self'` のファイルだけを動かすので、ページに直接書いていたスクリプトをここへ移した。
 * 設定はこのファイルを読む `<script>` 要素の data 属性で渡す(同じファイルを用途ごとに置く):
 *
 *   data-kuro-lang='{"d":既定の言語,"c":このページ,"l":[このページの言語],"b":公開の基点,"u":クローラーの UA}'
 *       → 記憶した言語・ブラウザーの言語のページへ移る(lang-path.ts の langScript と同じ順番)
 *   data-kuro-ga="G-XXXX"
 *       → GA4 の設定(gtag の読み込みは CMS が別の script src で置く)
 *
 * `scripts/build-admin.js` が `kuro-head.{hash}.js` に焼く。モジュールにしない(import/export を
 * 書かない)—— 普通のスクリプトとして同期で走らせ、document.currentScript を読むため。
 */
(function () {
  const me = document.currentScript as HTMLScriptElement | null;
  if (!me) return;

  const langCfg = me.getAttribute("data-kuro-lang");
  if (langCfg) followLanguage(langCfg);

  const ga = me.getAttribute("data-kuro-ga");
  if (ga) configureGa(ga);

  function configureGa(id: string): void {
    const w = window as unknown as { dataLayer?: unknown[] };
    w.dataLayer = w.dataLayer || [];
    // gtag.js は arguments オブジェクトそのものを読む(配列にすると数えない)。

    function gtag(..._args: unknown[]): void {
      // eslint-disable-next-line prefer-rest-params
      w.dataLayer!.push(arguments);
    }
    (window as unknown as { gtag: typeof gtag }).gtag = gtag;
    gtag("js", new Date());
    gtag("config", id);
  }

  /**
   * 上から順に見て、最初に当たったものだけ行う:
   *   1. クローラー → 何もしない
   *   2. `?lang=xx` の古いリンク → その言語の版へ
   *   3. 言語選択で選んだ言語(localStorage)→ このページにその言語があれば移す
   *   4. この訪問の最初のページ(sessionStorage に印が無い)→ navigator.languages の最初に合う言語へ
   *   5. それ以外 → 何もしない
   */
  function followLanguage(raw: string): void {
    try {
      const K = JSON.parse(raw) as {
        d: string;
        c: string;
        l: string[];
        b: string;
        u: string;
      };
      if (new RegExp(K.u, "i").test(navigator.userAgent || "")) return;
      const CH = "kurocms_lang";
      const SEEN = "kurocms_lang_seen";
      const has = (l: string) => K.l.indexOf(l) >= 0;
      const bare = () => {
        let p = location.pathname.slice(K.b.length) || "/";
        if (K.c !== K.d && p.indexOf("/" + K.c) === 0)
          p = p.slice(K.c.length + 1) || "/";
        return p;
      };
      const href = (l: string, q: string) =>
        K.b + (l === K.d ? "" : "/" + l) + bare() + q + location.hash;
      const query = () => {
        const s = new URLSearchParams(location.search);
        s.delete("lang");
        const t = s.toString();
        return t ? "?" + t : "";
      };
      const mark = () => {
        try {
          sessionStorage.setItem(SEEN, "1");
        } catch {
          /* 保存できない環境では印を付けない */
        }
      };
      const go = (l: string) => {
        if (l !== K.c || location.search.indexOf("lang=") >= 0)
          location.replace(href(l, query()));
      };
      const q = new URLSearchParams(location.search).get("lang");
      if (q) {
        mark();
        if (has(q)) go(q);
        return;
      }
      let pick = "";
      try {
        pick = localStorage.getItem(CH) || "";
      } catch {
        /* 読めない環境 */
      }
      if (pick) {
        if (has(pick) && pick !== K.c) go(pick);
        return;
      }
      let seen = "";
      try {
        seen = sessionStorage.getItem(SEEN) || "";
      } catch {
        return;
      }
      if (seen) return;
      mark();
      const nl =
        navigator.languages && navigator.languages.length
          ? navigator.languages
          : [navigator.language || ""];
      for (let i = 0; i < nl.length; i++) {
        const c = String(nl[i] || "")
          .slice(0, 2)
          .toLowerCase();
        if (has(c)) {
          if (c !== K.c) go(c);
          return;
        }
      }
    } catch {
      /* 言語の判断が壊れても、ページは見せる */
    }
  }
})();
