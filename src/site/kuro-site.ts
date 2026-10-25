/**
 * 公開ページの部品を動かす(cms-cms-security「CSP」)。
 *
 * CSP は `'self'` のファイルだけを動かすので、部品がページに直接書いていたスクリプトを
 * ここへ集めた。**ページにある部品だけを動かす**(要素を探して、無ければ何もしない)。
 * 設定は部品の要素の data 属性で渡す(値をスクリプトの文字列に埋め込まない)。
 *
 * このファイルを読む `<script defer>` の data 属性:
 *   data-kuro-links  KuroEditor の共有モジュール(URL カード・壊れたメディアの表示)の URL
 *   data-kuro-unfurl URL カードの最新の情報を取る口
 *
 * `scripts/build-admin.js` が `kuro-site.{hash}.js` に焼く。モジュールにしない(import/export を
 * 書かない)—— document.currentScript を読むため。共有モジュールは import() で読み、読めなくても
 * 画像の拡大などは止めない。
 */
(function () {
  const me = document.currentScript as HTMLScriptElement | null;
  const linksModule = me?.getAttribute("data-kuro-links") || "";
  const unfurlEndpoint = me?.getAttribute("data-kuro-unfurl") || "";

  const run = (name: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      // 1 つの部品が壊れても、他の部品は動かす。
      console.error(`[kurocms] ${name}`, e);
    }
  };
  const all = <T extends Element = HTMLElement>(sel: string): T[] =>
    Array.prototype.slice.call(document.querySelectorAll(sel)) as T[];
  const escHtml = (s: unknown) =>
    String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  run("bluesky", () => all("[data-kuro-bsky]").forEach(bluesky));
  run("lang", () => all("[data-kuro-langsw]").forEach(languageSwitcher));
  run("carousel", () =>
    all(".kuro-carousel[data-kc-interval]").forEach(carousel),
  );
  run("search", () => all(".kuro-search[data-ks-ep]").forEach(search));
  run("adsense", adsense);
  run("date", localDates);
  run("reactions", () =>
    all(".kuro-reactions[data-endpoint]").forEach(reactions),
  );
  run("archives", archives);
  run("zoom", zoom);
  run("video", video);
  run("links", links);
  // テンプレートの組み込み部品(cms-cms-template 9.11・template-ui.ts が [[…]] を data 属性に展開する)。
  run("toggle", toggles);
  run("tab", tabs);
  run("linkfrom", linkFrom);

  // ── [[toggle:名前]] / [[panel:名前]] ─────────────────────────────────
  // 押すと、同じ名前の panel に class open を付け外しし、ボタンの aria-expanded を合わせる。
  function toggles(): void {
    all("[data-kuro-toggle]").forEach((btn) => {
      const name = btn.getAttribute("data-kuro-toggle") || "";
      btn.addEventListener("click", () => {
        const panels = all("[data-kuro-panel]").filter(
          (p) => p.getAttribute("data-kuro-panel") === name,
        );
        const open = !panels.some((p) => p.classList.contains("open"));
        panels.forEach((p) => p.classList.toggle("open", open));
        all("[data-kuro-toggle]")
          .filter((b) => b.getAttribute("data-kuro-toggle") === name)
          .forEach((b) => b.setAttribute("aria-expanded", String(open)));
      });
    });
  }

  // ── [[tab:組]] / [[tabitem:組]] ─────────────────────────────────────
  // タブの値は data-tab-value(無ければ「すべて」)。押したタブの値を data-tab-values(空白区切り)に
  // 含む項目だけを見せる。初めは値の無いタブが押された形。
  function tabs(): void {
    const tabsAll = all("[data-kuro-tab]");
    tabsAll.forEach((tab) =>
      tab.setAttribute(
        "aria-pressed",
        String(!(tab.getAttribute("data-tab-value") || "")),
      ),
    );
    tabsAll.forEach((tab) => {
      const group = tab.getAttribute("data-kuro-tab") || "";
      tab.addEventListener("click", () => {
        const value = (tab.getAttribute("data-tab-value") || "").trim();
        tabsAll
          .filter((t) => t.getAttribute("data-kuro-tab") === group)
          .forEach((t) => t.setAttribute("aria-pressed", String(t === tab)));
        all("[data-kuro-tabitem]")
          .filter((i) => i.getAttribute("data-kuro-tabitem") === group)
          .forEach((i) => {
            const values = (i.getAttribute("data-tab-values") || "")
              .split(/\s+/)
              .filter(Boolean);
            i.hidden = !!value && values.indexOf(value) < 0;
          });
      });
    });
  }

  // ── [[linkfrom:名前]] ────────────────────────────────────────────────
  // 頁の中の最初の a[data-名前][href] の href を写す(http・https だけ)。
  function linkFrom(): void {
    all<HTMLAnchorElement>("a[data-kuro-linkfrom]").forEach((a) => {
      const name = a.getAttribute("data-kuro-linkfrom") || "";
      if (!/^[a-z0-9_-]{1,40}$/.test(name)) return;
      const from = document.querySelector<HTMLAnchorElement>(
        `a[data-${name}][href]`,
      );
      if (!from) return;
      try {
        const url = new URL(from.getAttribute("href") || "", location.href);
        if (url.protocol === "http:" || url.protocol === "https:")
          a.setAttribute("href", url.href);
      } catch {
        /* 読めない URL は写さない */
      }
    });
  }

  // ── Bluesky の投稿 ──────────────────────────────────────────────────
  function bluesky(el: HTMLElement): void {
    const H = el.getAttribute("data-kuro-bsky") || "";
    if (!H) return;
    const rt = (iso: string) => {
      const d = Date.now() - new Date(iso).getTime();
      const m = Math.floor(d / 60000);
      if (m < 1) return "たった今";
      if (m < 60) return m + "分前";
      const h = Math.floor(m / 60);
      if (h < 24) return h + "時間前";
      const dy = Math.floor(h / 24);
      if (dy < 7) return dy + "日前";
      return new Date(iso).toLocaleDateString("ja-JP", {
        month: "numeric",
        day: "numeric",
      });
    };
    type Post = {
      uri?: string;
      likeCount?: number;
      repostCount?: number;
      author?: { handle?: string; displayName?: string; avatar?: string };
      record?: { text?: string; createdAt?: string };
      embed?: {
        images?: Array<{ thumb?: string; fullsize?: string; alt?: string }>;
        external?: { thumb?: string; title?: string };
      };
    };
    fetch(
      "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=" +
        encodeURIComponent(H) +
        "&limit=10&filter=posts_no_replies",
      { headers: { accept: "application/json" } },
    )
      .then((r) => r.json())
      .then((data: { feed?: Array<{ post?: Post }> }) => {
        const items = (data.feed || []).filter(
          (f) => f.post && f.post.record && f.post.record.text,
        );
        if (!items.length) {
          el.innerHTML =
            "<p style='font-size:12px;color:#94a3b8;text-align:center;padding:10px 0;margin:0'>投稿がありません</p>";
          return;
        }
        el.innerHTML = items
          .map((f) => {
            const post = f.post!;
            const author = post.author || {};
            const record = post.record || {};
            const rkey = (post.uri || "").split("/").pop();
            const postUrl =
              "https://bsky.app/profile/" +
              encodeURIComponent(author.handle || "") +
              "/post/" +
              (rkey || "");
            const avatar = author.avatar
              ? "<img src='" +
                escHtml(author.avatar) +
                "' style='width:40px;height:40px;border-radius:50%;object-fit:cover;flex-shrink:0' alt='' />"
              : "<div style='width:40px;height:40px;border-radius:50%;background:rgba(0,133,255,.2);flex-shrink:0'></div>";
            const images = ((post.embed && post.embed.images) || []).slice(
              0,
              4,
            );
            let imgHtml = "";
            if (images.length) {
              imgHtml =
                "<div style='margin-top:8px;display:grid;grid-template-columns:" +
                (images.length > 1 ? "1fr 1fr" : "1fr") +
                ";gap:4px;border-radius:8px;overflow:hidden'>" +
                images
                  .map((img) => {
                    const t = img.thumb || img.fullsize || "";
                    return t
                      ? "<img src='" +
                          escHtml(t) +
                          "' style='width:100%;object-fit:cover;max-height:150px;border-radius:6px' alt='" +
                          escHtml(img.alt || "") +
                          "' />"
                      : "";
                  })
                  .join("") +
                "</div>";
            } else if (
              post.embed &&
              post.embed.external &&
              post.embed.external.thumb
            ) {
              imgHtml =
                "<div style='margin-top:8px;border-radius:8px;overflow:hidden;border:1px solid #f1f5f9'><img src='" +
                escHtml(post.embed.external.thumb) +
                "' style='width:100%;object-fit:cover;max-height:150px' alt='' />" +
                (post.embed.external.title
                  ? "<div style='padding:6px 8px;background:#f8fafc;font-size:11px;color:#475569;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'>" +
                    escHtml(post.embed.external.title) +
                    "</div>"
                  : "") +
                "</div>";
            }
            return (
              "<a href='" +
              postUrl +
              "' target='_blank' rel='noopener noreferrer' style='display:block;background:#fff;border-radius:12px;padding:12px;box-shadow:0 1px 2px rgba(0,0,0,.06);text-decoration:none'>" +
              "<div style='display:flex;align-items:center;gap:8px;margin-bottom:8px'>" +
              avatar +
              "<div style='min-width:0;flex:1;display:flex;flex-direction:column'>" +
              "<span style='font-weight:700;font-size:13px;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'>" +
              escHtml(author.displayName || author.handle || "") +
              "</span>" +
              "<div style='display:flex;align-items:center;justify-content:space-between;margin-top:1px'>" +
              "<span style='font-size:11px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'>@" +
              escHtml(author.handle || "") +
              "</span>" +
              "<span style='font-size:11px;color:#94a3b8;white-space:nowrap;margin-left:4px'>" +
              rt(record.createdAt || "") +
              "</span>" +
              "</div></div></div>" +
              "<p style='font-size:13px;color:#1f2937;line-height:1.6;white-space:pre-wrap;word-break:break-word;margin:0'>" +
              escHtml(record.text || "") +
              "</p>" +
              imgHtml +
              "<div style='display:flex;align-items:center;gap:16px;margin-top:8px;font-size:11px;color:#64748b'>" +
              "<span style='display:inline-flex;align-items:center;gap:4px'><svg style='width:14px;height:14px;fill:#0085ff' viewBox='0 0 24 24'><path d='M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z'/></svg>" +
              (post.likeCount || 0) +
              "</span>" +
              "<span style='display:inline-flex;align-items:center;gap:4px'><svg style='width:14px;height:14px;fill:#64748b' viewBox='0 0 24 24'><path d='M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z'/></svg>" +
              (post.repostCount || 0) +
              "</span>" +
              "</div>" +
              "</a>"
            );
          })
          .join("");
      })
      .catch(() => {
        el.innerHTML =
          "<p style='font-size:12px;color:#94a3b8;text-align:center;padding:10px 0;margin:0'>読み込めませんでした</p>";
      });
  }

  // ── 言語の切り替え([[lang]]) ───────────────────────────────────────
  function languageSwitcher(root: HTMLElement): void {
    const btn = root.querySelector<HTMLElement>("[data-kl-toggle]");
    const menu = root.querySelector<HTMLElement>("[data-kl-menu]");
    const KEY = "kurocms_lang";
    const D = root.getAttribute("data-kl-default") || "";
    const C = root.getAttribute("data-kl-current") || "";
    const B = root.getAttribute("data-kl-base") || "";
    // 言語は道筋にある(/en/post/)。選んだ言語を覚え、以後は頭のスクリプトが従う。
    const go = (code: string) => {
      try {
        localStorage.setItem(KEY, code);
      } catch {
        /* 覚えられなくても移る */
      }
      let p = location.pathname.slice(B.length) || "/";
      if (C !== D && p.indexOf("/" + C) === 0) p = p.slice(C.length + 1) || "/";
      location.href = B + (code === D ? "" : "/" + code) + p + location.hash;
    };
    if (!btn || !menu) return;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.style.display = menu.style.display === "block" ? "none" : "block";
    });
    document.addEventListener("click", () => {
      menu.style.display = "none";
    });
    menu.querySelectorAll<HTMLElement>("[data-kl-code]").forEach((b) => {
      b.addEventListener("click", (e) => {
        e.preventDefault();
        go(b.getAttribute("data-kl-code") || "");
      });
    });
  }

  // ── カルーセル([[carousel:…]]) ─────────────────────────────────────
  function carousel(r: HTMLElement): void {
    const st = r.querySelector<HTMLElement>(".kuro-carousel__stage");
    const sl = r.querySelectorAll<HTMLElement>(".kuro-carousel__slide");
    if (!st || sl.length < 2) return;
    const dt = r.querySelectorAll<HTMLElement>("[data-kc-go]");
    const slide = r.getAttribute("data-kc-effect") === "slide";
    const iv = parseInt(r.getAttribute("data-kc-interval") || "0", 10) || 0;
    let cur = 0;
    let t: ReturnType<typeof setInterval> | null = null;
    const show = (n: number) => {
      cur = (n + sl.length) % sl.length;
      if (slide) st.style.transform = "translateX(-" + cur * 100 + "%)";
      else
        for (let i = 0; i < sl.length; i++)
          sl[i]!.classList.toggle("is-on", i === cur);
      for (let k = 0; k < dt.length; k++)
        dt[k]!.classList.toggle("is-on", k === cur);
    };
    const stop = () => {
      if (t) {
        clearInterval(t);
        t = null;
      }
    };
    // 自動送りは reduced-motion を尊重して止める。
    const start = () => {
      stop();
      if (!iv) return;
      const m =
        window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)");
      if (m && m.matches) return;
      t = setInterval(() => show(cur + 1), iv);
    };
    const p = r.querySelector<HTMLElement>("[data-kc-prev]");
    const n = r.querySelector<HTMLElement>("[data-kc-next]");
    if (p)
      p.addEventListener("click", () => {
        show(cur - 1);
        start();
      });
    if (n)
      n.addEventListener("click", () => {
        show(cur + 1);
        start();
      });
    dt.forEach((el) =>
      el.addEventListener("click", () => {
        show(parseInt(el.getAttribute("data-kc-go") || "0", 10));
        start();
      }),
    );
    r.addEventListener("mouseenter", stop);
    r.addEventListener("mouseleave", start);
    start();
  }

  // ── 記事の検索([[search]]) ─────────────────────────────────────────
  function search(root: HTMLElement): void {
    const EP = root.getAttribute("data-ks-ep") || "/_search";
    const LANG = root.getAttribute("data-ks-lang") || "";
    const EMPTY = root.getAttribute("data-ks-empty") || "";
    const MORE = root.getAttribute("data-ks-more") || "";
    const input = root.querySelector<HTMLInputElement>(".kuro-search__input");
    const btn = root.querySelector<HTMLElement>("[data-ks-btn]");
    const panel = root.querySelector<HTMLElement>("[data-ks-panel]");
    const dialog = root.querySelector<HTMLElement>("[data-ks-dialog]");
    const dinput = root.querySelector<HTMLInputElement>(".kuro-search__dinput");
    const dres = root.querySelector<HTMLElement>("[data-ks-dresults]");
    const dclose = root.querySelector<HTMLElement>("[data-ks-close]");
    type Hit = { url: string; title?: string; snippet?: string };
    const isMobile = () =>
      !!(window.matchMedia && window.matchMedia("(max-width:640px)").matches);
    const render = (
      box: HTMLElement,
      items: Hit[] | undefined,
      append: boolean,
    ) => {
      const old = box.querySelector(".kuro-search__more");
      if (old) old.remove();
      if (!append) box.textContent = "";
      if (!append && (!items || !items.length)) {
        const e = document.createElement("div");
        e.className = "kuro-search__empty";
        e.textContent = EMPTY;
        box.appendChild(e);
        return;
      }
      (items || []).forEach((r) => {
        const a = document.createElement("a");
        a.className = "kuro-search__item";
        a.href = r.url;
        const t = document.createElement("span");
        t.className = "kuro-search__title";
        t.textContent = r.title || r.url;
        a.appendChild(t);
        if (r.snippet) {
          const s = document.createElement("span");
          s.className = "kuro-search__snip";
          s.textContent = r.snippet;
          a.appendChild(s);
        }
        box.appendChild(a);
      });
    };
    let seq = 0;
    const runQuery = (
      raw: string,
      box: HTMLElement,
      show: ((on: boolean) => void) | null,
      offset?: number,
    ) => {
      const q = (raw || "").trim();
      if (!q) {
        box.textContent = "";
        if (show) show(false);
        return;
      }
      const my = offset ? seq : ++seq;
      fetch(
        EP +
          "?q=" +
          encodeURIComponent(q) +
          "&lang=" +
          encodeURIComponent(LANG) +
          (offset ? "&offset=" + offset : ""),
      )
        .then((r) => (r.ok ? r.json() : { results: [] }))
        .then(
          (d: { results?: Hit[]; next_offset?: number; total?: number }) => {
            if (my !== seq) return;
            render(box, d && d.results, !!offset);
            if (d && typeof d.next_offset === "number") {
              const next = d.next_offset;
              const m = document.createElement("button");
              m.type = "button";
              m.className = "kuro-search__more";
              m.textContent = MORE.split("{n}").join(
                String((d.total || 0) - next),
              );
              m.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                runQuery(q, box, null, next);
              });
              box.appendChild(m);
            }
            if (show) show(true);
          },
        )
        .catch(() => {
          if (my !== seq) return;
          if (!offset) render(box, [], false);
          if (show) show(true);
        });
    };
    const debounce = (fn: () => void) => {
      let t: ReturnType<typeof setTimeout> | undefined;
      return () => {
        clearTimeout(t);
        t = setTimeout(fn, 220);
      };
    };
    const showPanel = (on: boolean) => {
      if (panel) panel.style.display = on ? "block" : "none";
    };
    if (input && panel) {
      input.addEventListener(
        "input",
        debounce(() => runQuery(input.value, panel, showPanel)),
      );
      input.addEventListener("focus", () => {
        if (input.value.trim()) showPanel(true);
      });
      document.addEventListener("click", (e) => {
        if (!root.contains(e.target as Node)) showPanel(false);
      });
    }
    const openDialog = () => {
      if (!dialog || !dinput || !dres) return;
      dialog.style.display = "block";
      dinput.value = input ? input.value : "";
      if (dinput.value.trim()) runQuery(dinput.value, dres, null);
      setTimeout(() => dinput.focus(), 30);
    };
    const closeDialog = () => {
      if (dialog) dialog.style.display = "none";
    };
    if (btn)
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        if (isMobile()) openDialog();
        else if (input && panel) {
          input.focus();
          runQuery(input.value, panel, showPanel);
        }
      });
    if (dinput && dres)
      dinput.addEventListener(
        "input",
        debounce(() => runQuery(dinput.value, dres, null)),
      );
    if (dclose) dclose.addEventListener("click", closeDialog);
    if (dialog)
      dialog.addEventListener("click", (e) => {
        if (e.target === dialog) closeDialog();
      });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeDialog();
    });
  }

  // ── AdSense の枠([[ad]]) ────────────────────────────────────────────
  // 枠ごとに 1 回 push する(読み込みより先でも、adsbygoogle は溜めた分を後で処理する)。
  function adsense(): void {
    const units = all("ins.adsbygoogle[data-kuro-ad]");
    if (!units.length) return;
    const w = window as unknown as { adsbygoogle?: unknown[] };
    w.adsbygoogle = w.adsbygoogle || [];
    units.forEach((u) => {
      u.removeAttribute("data-kuro-ad");
      w.adsbygoogle!.push({});
    });
  }

  // ── 日付の地域表示 ────────────────────────────────────────────────
  // 日付は「サイトの時計」で整形する。ロケール(曜日名・月名・区切り)だけを閲覧者に合わせ、
  // どの暦日かは全閲覧者で同じにする(月アーカイブの区切りはビルド時にサイトの時計で決まる)。
  // Intl が時計を拒んだら空 = ビルド時に焼いた文字をそのまま残す。
  function localDates(): void {
    const times = all("time[data-kuro-local-date]");
    if (!times.length) return;
    const tzEl = document.querySelector("[data-kuro-tz]");
    const TZ = (tzEl && tzEl.getAttribute("data-kuro-tz")) || "UTC";
    const o = (x: Intl.DateTimeFormatOptions) => {
      x.timeZone = TZ;
      return x;
    };
    const fmt = (iso: string, kind: string) => {
      const d = new Date(iso);
      if (!isFinite(d.getTime())) return "";
      const loc =
        (navigator.languages && navigator.languages[0]) ||
        navigator.language ||
        document.documentElement.lang ||
        undefined;
      try {
        if (kind === "dateDay")
          return new Intl.DateTimeFormat("en-US", o({ day: "numeric" })).format(
            d,
          );
        if (kind === "dateYm")
          return new Intl.DateTimeFormat(
            loc,
            o({ year: "numeric", month: "long" }),
          ).format(d);
        if (kind === "dateWeekday")
          return new Intl.DateTimeFormat(loc, o({ weekday: "short" })).format(
            d,
          );
        return new Intl.DateTimeFormat(
          loc,
          o({ year: "numeric", month: "2-digit", day: "2-digit" }),
        ).format(d);
      } catch {
        return "";
      }
    };
    times.forEach((el) => {
      const v = fmt(
        el.getAttribute("data-kuro-local-date") || "",
        el.getAttribute("data-kuro-date-format") || "date",
      );
      if (v) el.textContent = v;
    });
  }

  // ── 記事の反応のボタン ─────────────────────────────────────────────
  function reactions(box: HTMLElement): void {
    const url = box.getAttribute("data-endpoint") || "";
    const THANKS = box.getAttribute("data-thanks") || "";
    const ERROR = box.getAttribute("data-error") || "";
    const buttons = Array.prototype.slice.call(
      box.querySelectorAll("button[data-type]"),
    ) as HTMLButtonElement[];
    const status = box.querySelector<HTMLElement>("[role=status]");
    const say = (s: string) => {
      if (status) status.textContent = s;
    };
    type State = { counts: Record<string, number>; votedType?: string | null };
    const paint = (data: State) => {
      buttons.forEach((b) => {
        const type = b.dataset.type || "";
        const count = b.querySelector("[data-count]");
        if (count) count.textContent = String(data.counts[type] || 0);
        b.disabled = !!data.votedType;
        b.dataset.voted = String(data.votedType === type);
      });
    };
    const load = () =>
      fetch(url, { credentials: "same-origin", cache: "no-store" })
        .then((r) => {
          if (!r.ok) throw Error("GET " + r.status);
          return r.json();
        })
        .then(paint);
    const vote = (e: Event) => {
      const type = (e.currentTarget as HTMLButtonElement).dataset.type;
      buttons.forEach((b) => {
        b.disabled = true;
      });
      fetch(url, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type }),
      })
        .then((r) =>
          r.json().then((d: State & { error?: string }) => {
            if (!r.ok) throw Error(d.error || String(r.status));
            return d;
          }),
        )
        .then((d) => {
          paint(d);
          say(THANKS);
        })
        .catch(() => {
          say(ERROR);
          load()
            .then(() => {
              if (!buttons.some((b) => b.dataset.voted === "true"))
                buttons.forEach((b) => {
                  b.disabled = false;
                });
            })
            .catch(() =>
              buttons.forEach((b) => {
                b.disabled = false;
              }),
            );
        });
    };
    load()
      .then(() =>
        buttons.forEach((b) => {
          if (!b.disabled) b.addEventListener("click", vote);
        }),
      )
      .catch(() => say(ERROR));
  }

  // ── 月の選択(アーカイブ) ───────────────────────────────────────────
  function archives(): void {
    all<HTMLSelectElement>("select.kuro-archives").forEach((s) =>
      s.addEventListener("change", () => {
        if (s.value) window.location.href = s.value;
      }),
    );
  }

  // ── 画像の拡大(スマホだけ) ─────────────────────────────────────────
  // ページのすべての画像が対象。外すのは 3 つだけ: <a> の中(タップは移動)・拡大の層の自分・
  // data-kuro-nozoom。拡大表示は暗転させない(記事の上に浮かせる)—— 動画と揃えてある。
  function zoom(): void {
    if (!document.querySelector("img")) return;
    const mq = window.matchMedia
      ? window.matchMedia("(max-width:640px)")
      : null;
    let ov: HTMLElement | null = null;
    const close = () => {
      if (ov) {
        if (ov.parentNode) ov.parentNode.removeChild(ov);
        ov = null;
        document.documentElement.style.overflow = "";
      }
    };
    const open = (src: string) => {
      close();
      ov = document.createElement("div");
      ov.setAttribute("data-kuro-zoom", "");
      ov.style.cssText =
        "position:fixed;inset:0;z-index:3000;background:transparent;display:flex;align-items:center;justify-content:center;touch-action:none;cursor:zoom-out";
      const im = document.createElement("img");
      im.src = src;
      im.style.cssText =
        "max-width:94vw;max-height:92vh;width:auto;height:auto;object-fit:contain;border-radius:8px;box-shadow:0 12px 44px rgba(0,0,0,.45)";
      ov.appendChild(im);
      ov.addEventListener("click", close);
      document.body.appendChild(ov);
      document.documentElement.style.overflow = "hidden";
    };
    const able = (img: Element | null): img is HTMLImageElement => {
      if (!img || img.tagName !== "IMG" || !img.closest) return false;
      if (img.getAttribute("data-kuro-nozoom") !== null) return false;
      if (img.closest("a")) return false;
      if (img.closest("[data-kuro-zoom]")) return false;
      return true;
    };
    document.addEventListener(
      "click",
      (e) => {
        if (!mq || !mq.matches) return;
        const img = e.target as Element | null;
        if (!able(img)) return;
        e.preventDefault();
        open(img.currentSrc || img.src);
      },
      false,
    );
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });
  }

  // ── 動画のオーバーレイ再生(YouTube の facade) ──────────────────────
  function video(): void {
    if (!document.querySelector(".kuro-video-facade")) return;
    let ov: HTMLElement | null = null;
    const close = () => {
      if (ov) {
        if (ov.parentNode) ov.parentNode.removeChild(ov);
        ov = null;
        document.documentElement.style.overflow = "";
      }
    };
    const open = (src: string) => {
      close();
      ov = document.createElement("div");
      ov.className = "kuro-video-ov";
      const box = document.createElement("div");
      box.className = "kuro-video-ov__box";
      const f = document.createElement("iframe");
      f.src = src;
      f.setAttribute("allowfullscreen", "");
      f.setAttribute("frameborder", "0");
      f.setAttribute(
        "allow",
        "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture",
      );
      f.setAttribute("title", "埋め込み動画");
      box.appendChild(f);
      const b = document.createElement("button");
      b.type = "button";
      b.className = "kuro-video-ov__close";
      b.setAttribute("aria-label", "閉じる");
      b.textContent = "✕";
      b.addEventListener("click", close);
      box.appendChild(b);
      ov.appendChild(box);
      const layer = ov;
      ov.addEventListener("click", (e) => {
        if (e.target === layer) close();
      });
      document.body.appendChild(ov);
      document.documentElement.style.overflow = "hidden";
    };
    document.addEventListener("click", (e) => {
      const t = e.target as Element | null;
      if (!t || !t.closest) return;
      const btn = t.closest(".kuro-video-facade");
      if (!btn) return;
      e.preventDefault();
      open(btn.getAttribute("data-kuro-embed") || "");
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });
  }

  // ── URL カード・壊れたメディア(KuroEditor の共有モジュール) ──────────
  // 共有モジュールが読めなくても、上の部品(画像の拡大など)は止めない —— だから import() で
  // 後から読む(前は 1 つの module script だったので、読み込みの失敗で拡大まで止まりえた)。
  function links(): void {
    const cards = all<HTMLAnchorElement>("a.kuro-url-card[data-kuro-sig]");
    const media = document.querySelector(".kuro-media-wrap");
    if ((!cards.length && !media) || !linksModule) return;
    type Links = {
      _urlCardInner: (slug: string, url: string, meta: unknown) => string;
      _urlCardErrorInner: (slug: string, url: string) => string;
      buildBrokenMedia: (src: string) => string;
    };
    import(linksModule)
      .then((m: Links) => {
        if (media) brokenMedia(m);
        if (cards.length && unfurlEndpoint) unfurl(m, cards);
      })
      .catch((e) => console.error("[kurocms] links", e));

    function brokenMedia(m: Links): void {
      const fix = (el: Element | null) => {
        if (!el || !el.classList || !el.classList.contains("kuro-media"))
          return;
        const fig = el.closest(".kuro-media-wrap");
        if (!fig) return;
        fig.innerHTML = m.buildBrokenMedia(el.getAttribute("src") || "");
      };
      window.addEventListener(
        "error",
        (e) => fix(e.target as Element | null),
        true,
      );
      all<HTMLImageElement>("img.kuro-media").forEach((img) => {
        if (img.complete && img.naturalWidth === 0) fix(img);
      });
    }

    function unfurl(m: Links, list: HTMLAnchorElement[]): void {
      type Meta = { ok?: boolean; reason?: string; meta?: unknown };
      const apply = (a: HTMLAnchorElement, d: Meta | null, slug: string) => {
        if (!d) return;
        const url = a.getAttribute("href") || slug;
        if (d.ok === false) {
          if (d.reason === "target_404" || d.reason === "target_unreachable") {
            a.innerHTML = m._urlCardErrorInner(slug, url);
            a.classList.add("kuro-url-card--error");
          }
          return;
        }
        a.innerHTML = m._urlCardInner(slug, url, d.meta || null);
        a.classList.add("kuro-url-card--rich");
      };
      const load = (a: HTMLAnchorElement) => {
        const u = a.getAttribute("data-kuro-unfurl");
        const s = a.getAttribute("data-kuro-sig");
        if (!u || !s) return;
        a.removeAttribute("data-kuro-unfurl");
        const ck = "kuf:" + u;
        try {
          const c = sessionStorage.getItem(ck);
          if (c) {
            apply(a, JSON.parse(c), u);
            return;
          }
        } catch {
          /* 控えが読めなければ取りに行く */
        }
        fetch(
          unfurlEndpoint +
            "?url=" +
            encodeURIComponent(u) +
            "&sig=" +
            encodeURIComponent(s),
        )
          .then((r) => (r.ok ? r.json() : null))
          .then((d: Meta | null) => {
            if (d) {
              try {
                sessionStorage.setItem(ck, JSON.stringify(d));
              } catch {
                /* 控えられなくても表示はする */
              }
            }
            apply(a, d, u);
          })
          .catch(() => {});
      };
      if ("IntersectionObserver" in window) {
        const io = new IntersectionObserver(
          (es) =>
            es.forEach((e) => {
              if (e.isIntersecting) {
                io.unobserve(e.target);
                load(e.target as HTMLAnchorElement);
              }
            }),
          { rootMargin: "200px" },
        );
        list.forEach((a) => io.observe(a));
      } else list.forEach(load);
    }
  }
})();
