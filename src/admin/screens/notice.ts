// KuroCMS admin screen module. Concatenated by scripts/build-admin.js.

/**
 * お知らせ(Entamy Notice・notice-placement 1節)。**ダッシュボードの最上部**に専用の枠を置き、
 * 緊急・重要の未読は起動時に窓で出す。
 *
 * ★**ここは描くだけ。** 何を窓で出すか(緊急が先)・未読の数・既読の送り直しは Worker の
 *   EntamyNotice(entamy-connect)が決め、`/api/system/notices` がその結果を返す。
 *   共有の画面部品(@entamy/ui)を使わないのは、公開ミラーで差し替えられるのが `src/` 直下からの
 *   参照だけで、管理画面から entamy-connect を取り込むとミラーが組み立てられなくなるため。
 * ★緊急は**閉じる手段を置かない**(確認するか、示された操作をするまで進めない)。
 *   重要は「あとで読む」で閉じられるが、既読にはならず、次に開いた時にまた出る。
 * ★本文は**文字として**入れる(textContent)。お知らせの本文は書式を持たない。
 * ★口座宛ての知らせ(`direct`・基盤のサービスが書いた。無料期間の終わりなど・notice-delivery 7節)は、
 *   知らせが持つ答えのボタンを並べる。窓を閉じても「閉じる」と答え、記録に残す(2026-10-30・利用者の指示)。
 *   答えても既読にはならず、解決するまで開くたびに出る。契約の窓は KuroCMS では持たない(Notice が出す)。
 * ★一度出したもの(読んだもの・答え・規約の同意)は、枠の下に日付と概要の 1 行で並べ、5 件ずつページ送り。
 *   見出しは置かない。枠の中の口座宛ての知らせには「閉じる」を置かない(窓の中だけ)。
 */
type NoticeItemView = {
  id: string;
  kind: "critical" | "important" | "info_product" | "info_other";
  section: "product" | "other";
  title: string;
  body: string;
  action: { kind: "ack" | "open"; label?: string | null; url?: string };
  direct?: boolean;
  answers?: { id: string; label: string; url?: string }[];
  /** タブの区分(notice-delivery 7.5)。 */
  category?: NoticeCategory;
};
type NoticeCategory = "alert" | "info" | "security";
type NoticeHistoryView = {
  items: {
    id: string;
    title: string;
    body: string;
    at: string;
    answer: string | null;
    answerLabel: string | null;
  }[];
  page: number;
  pages: number;
  total: number;
};
type NoticeStateView = {
  notices: NoticeItemView[];
  acked: string[];
  otherEnabled: boolean;
  dialogs: string[];
  unread: number;
  stale: boolean;
};

let noticeCurrent: NoticeStateView | null = null;

const noticeTz = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};
const noticeQuery = () =>
  "?lang=" +
  encodeURIComponent(state.uiLang || "ja") +
  "&tz=" +
  encodeURIComponent(noticeTz());

/**
 * 口座宛ての知らせに答える。行き先があれば開き、引っ越しは設定の契約のタブへ。届かなくても画面は進める。
 * 答えた後は引き直す(解決していれば消える)。
 */
async function noticeAnswer(n: NoticeItemView, answer: string) {
  const a = (n.answers || []).find((x) => x.id === answer);
  if (a?.url) noticeOpenUrl(a.url);
  try {
    await api(
      "/api/system/notices/" +
        encodeURIComponent(n.id) +
        "/answer" +
        noticeQuery(),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer }),
      },
    );
  } catch {
    // 届かなくても進める(窓は次に開いた時にまた出る)。
  }
  if (answer === "move") {
    location.href = adminHref("/settings") + "?tab=hosting";
    return;
  }
  // 公開中のページ(このサイトの頭)を別タブで。削除はプロフィールと同じ確認の窓(site-delete.ts)。
  if (answer === "view_site") noticeOpenUrl(location.origin + "/");
  if (answer === "delete_site") void siteDeleteDialog();
  void loadNotices();
}

function noticeApplied(v: NoticeStateView | null) {
  if (!v) return;
  noticeCurrent = v;
  if (state.noticeUnread !== v.unread) {
    state.noticeUnread = v.unread;
    // 左の項目の数を描き直す(枠が見えていなくても、数は変わる)。
    // 数はダッシュボードの項目にだけ付く(menuHtml)。項目の data-nav は道("/")で、
    // 鍵("dashboard")ではない —— 鍵で探していたので、既読にしても印が消えなかった(2026-10-21)。
    document.querySelectorAll(".navNoticeCount").forEach((el) => el.remove());
    if (v.unread > 0) {
      const link = document.querySelector("a[data-nav='/']");
      if (link) {
        const b = document.createElement("span");
        b.className = "navNoticeCount";
        b.textContent = String(v.unread);
        link.appendChild(b);
      }
    }
  }
  renderNoticePanel();
}

async function loadNotices(): Promise<NoticeStateView | null> {
  try {
    noticeApplied(
      (await api("/api/system/notices" + noticeQuery())) as NoticeStateView,
    );
  } catch {
    // 取れなくても管理画面は使える。枠は前の中身のまま。
  }
  return noticeCurrent;
}

function noticeOpenUrl(url: string) {
  window.open(url, "_blank", "noopener");
}

async function noticeAckOne(id: string) {
  try {
    noticeApplied(
      (await api(
        "/api/system/notices/" +
          encodeURIComponent(id) +
          "/ack" +
          noticeQuery(),
        { method: "POST" },
      )) as NoticeStateView,
    );
  } catch {
    // 既読は Worker の手元に残り、次に引く時に送り直される。
  }
}

function noticeActionLabel(n: NoticeItemView) {
  return (
    n.action.label ||
    (n.action.kind === "open" ? t("noticeOpen") : t("noticeAck"))
  );
}

/** ダッシュボードの最上部の枠。中身は renderNoticePanel が入れる。 */
function noticePanelHtml(): string {
  return (
    "<div class='panel' id='noticePanel' style='margin-bottom:16px'>" +
    "<div style='display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;margin-bottom:8px'>" +
    "<div style='font-weight:700;font-size:14px'>" +
    escapeHtml(t("noticeHeading")) +
    "</div><div id='noticePrefs' style='margin-left:auto'></div></div>" +
    "<div id='noticeBody'></div></div>"
  );
}

function renderNoticePanel() {
  const body = document.getElementById("noticeBody");
  const prefs = document.getElementById("noticePrefs");
  if (!body) return;
  body.textContent = "";
  if (prefs) prefs.textContent = "";
  const v = noticeCurrent;
  const el = (tag: string, text?: string, css?: string) => {
    const x = document.createElement(tag);
    if (text !== undefined) x.textContent = text;
    if (css) x.style.cssText = css;
    return x;
  };
  // タブ(notice-delivery 7.5)。新しいものがあるタブに赤い数。KuroCMS の管理画面は ID のログインを持たないので、
  // セキュリティ通知のタブは「これまで」だけ(7.6)。見た目は設定画面と同じタブの部品。
  const acked = new Set(v?.acked ?? []);
  const catOf = (n: NoticeItemView): NoticeCategory =>
    n.category ??
    (n.kind === "critical" || n.kind === "important" ? "alert" : "info");
  const fresh = (c: NoticeCategory) =>
    (v?.notices ?? []).filter(
      (n) =>
        catOf(n) === c &&
        n.section === "product" &&
        (n.direct || !acked.has(n.id)),
    ).length;
  if (!noticeTabPicked) {
    noticeTab = fresh("alert") > 0 ? "alert" : "info";
    if (v) noticeTabPicked = true;
  }
  const bar = el("div", undefined, "margin:0 0 8px");
  bar.className = "settingsTabBar";
  bar.setAttribute("role", "tablist");
  const labels: Record<NoticeCategory, string> = {
    alert: t("noticeTabAlert"),
    info: t("noticeTabInfo"),
    security: t("noticeTabSecurity"),
  };
  for (const c of ["alert", "info", "security"] as NoticeCategory[]) {
    const b = el("button", labels[c]) as HTMLButtonElement;
    b.type = "button";
    b.className = "settingsTab" + (c === noticeTab ? " active" : "");
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(c === noticeTab));
    const n = fresh(c);
    if (n > 0) {
      const badge = el(
        "span",
        String(n),
        "display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 6px;margin-left:6px;border-radius:10px;background:#e5484d;color:#fff;font-size:12px;font-weight:700;line-height:1",
      );
      b.appendChild(badge);
    }
    b.onclick = () => {
      noticeTab = c;
      noticeTabPicked = true;
      noticeHistoryPage = 1;
      renderNoticePanel();
    };
    bar.appendChild(b);
  }
  body.appendChild(bar);
  // 上には新しいもの(読んでいない・解決していない)だけ。一度読んだものは下の 1 行に移る。
  const mine = (v?.notices ?? []).filter(
    (n) => catOf(n) === noticeTab && (n.direct || !acked.has(n.id)),
  );
  const freshHere = mine.filter((n) => n.direct || !acked.has(n.id)).length;
  if (!freshHere) {
    body.appendChild(
      el(
        "div",
        t(
          noticeTab === "alert"
            ? "noticeEmptyAlert"
            : noticeTab === "security"
              ? "noticeEmptySecurity"
              : "noticeEmpty",
        ),
        "color:var(--muted);font-size:13px",
      ),
    );
  }
  {
    const sections: [string, NoticeItemView[]][] =
      noticeTab === "info"
        ? [
            [
              t("noticeSectionProduct"),
              mine.filter((n) => n.section === "product"),
            ],
            [
              t("noticeSectionOther"),
              mine.filter((n) => n.section === "other"),
            ],
          ]
        : [["", mine]];
    for (const [label, items] of sections) {
      if (!items.length) continue;
      if (label)
        body.appendChild(
          el(
            "div",
            label,
            "font-size:12px;color:var(--muted);margin:8px 0 4px",
          ),
        );
      for (const n of items) {
        const row = el(
          "div",
          undefined,
          "border-top:1px solid var(--line);padding:10px 0",
        );
        row.appendChild(
          el(
            "div",
            n.title,
            acked.has(n.id) ? "font-weight:500" : "font-weight:700",
          ),
        );
        row.appendChild(
          el(
            "div",
            n.body,
            "white-space:pre-wrap;color:var(--muted);font-size:13px;margin:4px 0 8px",
          ),
        );
        // 口座宛ての知らせは答えのボタンを並べる(管理者だけ・解決するまで残る)。
        if (n.direct) {
          if (state.isAdmin) {
            const line = el(
              "div",
              undefined,
              "display:flex;gap:8px;flex-wrap:wrap",
            );
            // 「閉じる」は窓のためのもの。枠の中には置かない(閉じるものが無い・2026-10-30・利用者)。
            for (const a of (n.answers || []).filter((x) => x.id !== "close")) {
              const b = el(
                "button",
                a.label,
                "font-size:12px;padding:4px 12px",
              ) as HTMLButtonElement;
              b.type = "button";
              if (a.id === "close") b.className = "secondary";
              b.onclick = () => {
                b.disabled = true;
                void noticeAnswer(n, a.id);
              };
              line.appendChild(b);
            }
            row.appendChild(line);
          }
          body.appendChild(row);
          continue;
        }
        // 読んだものはボタンを出さない(押せたことが見て分かるように)。
        // 「開く」のお知らせは、読んだ後も行き先を開けるよう残す。
        if (!acked.has(n.id) || n.action.kind === "open") {
          const b = el(
            "button",
            noticeActionLabel(n),
            "font-size:12px;padding:4px 12px",
          ) as HTMLButtonElement;
          b.type = "button";
          b.onclick = async () => {
            if (n.action.kind === "open" && n.action.url)
              noticeOpenUrl(n.action.url);
            if (acked.has(n.id)) return;
            b.disabled = true;
            await noticeAckOne(n.id);
            b.disabled = false;
          };
          row.appendChild(b);
        }
        body.appendChild(row);
      }
    }
  }
  if (v?.stale)
    body.appendChild(
      el(
        "div",
        t("noticeStale"),
        "color:var(--muted);font-size:11px;margin-top:8px",
      ),
    );
  body.appendChild(noticeHistoryBox());
  // 「ほかの製品のお知らせを受け取る」は導入ごと(管理者全員で共通)なので、管理者だけが変えられる。
  // 見出しの行の右端に小さく置く(共通の label は grid・input は幅いっぱいなので、ここで打ち消す)。
  if (state.isAdmin && v && prefs) {
    const label = el(
      "label",
      undefined,
      "display:inline-flex;gap:6px;align-items:center;margin:0;font-size:12px;font-weight:400;color:var(--muted);white-space:nowrap;cursor:pointer",
    );
    const box = el(
      "input",
      undefined,
      "width:14px;height:14px;margin:0;flex:none",
    ) as HTMLInputElement;
    box.type = "checkbox";
    box.checked = v.otherEnabled;
    box.onchange = async () => {
      box.disabled = true;
      try {
        noticeApplied(
          (await api("/api/system/notices/prefs" + noticeQuery(), {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ otherEnabled: box.checked }),
          })) as NoticeStateView,
        );
      } catch {
        box.checked = !box.checked;
      }
      box.disabled = false;
    };
    label.appendChild(box);
    label.appendChild(document.createTextNode(t("noticeOther")));
    prefs.appendChild(label);
  }
}

/** 開いているタブ。新しいものがある緊急の連絡を先に開き、人が押したら動かさない。 */
let noticeTab: NoticeCategory = "info";
let noticeTabPicked = false;

/** これまでのお知らせ(5 件ずつ・開いているタブの区分)。開いている頁は描き直しても保つ。 */
let noticeHistoryPage = 1;
function noticeHistoryBox(): HTMLElement {
  const box = document.createElement("div");
  box.style.cssText =
    "border-top:1px solid var(--line);margin-top:12px;padding-top:8px";
  // 見出しは置かない(2026-10-30・利用者)。一度出したものは、枠の下に日付と概要の 1 行で並べる。
  const list = document.createElement("div");
  box.append(list);
  const load = async (page: number) => {
    let d: NoticeHistoryView;
    try {
      d = (await api(
        "/api/system/notices/history" +
          noticeQuery() +
          "&page=" +
          page +
          "&category=" +
          noticeTab,
      )) as NoticeHistoryView;
    } catch {
      list.textContent = t("noticeHistoryFailed");
      list.style.cssText = "color:var(--muted);font-size:13px";
      return;
    }
    noticeHistoryPage = d.page;
    list.textContent = "";
    list.style.cssText = "";
    if (!d.items.length) {
      const e = document.createElement("div");
      e.textContent = t("noticeHistoryEmpty");
      e.style.cssText = "color:var(--muted);font-size:13px";
      list.appendChild(e);
    }
    for (const h of d.items) {
      // 1 行: 日付・題・どうなったか。本文は重ねたときの説明に回す(1 行に収める)。
      const row = document.createElement("div");
      row.style.cssText =
        "display:flex;gap:12px;align-items:baseline;border-top:1px solid var(--line);padding:6px 0;font-size:13px;min-width:0";
      row.title = h.body;
      const when = document.createElement("span");
      const at = new Date(h.at);
      when.textContent = Number.isNaN(at.getTime())
        ? h.at
        : at.toLocaleString(state.uiLang, {
            dateStyle: "medium",
            timeStyle: "short",
          });
      when.style.cssText = "color:var(--muted);white-space:nowrap;flex:none";
      const what = document.createElement("span");
      what.textContent = h.title + (h.answerLabel ? " — " + h.answerLabel : "");
      what.style.cssText =
        "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      // 右に「詳細」。押すと窓で全文を出す(2026-10-30・利用者。スマホのアプリは行を押す形)。
      const more = document.createElement("button");
      more.type = "button";
      more.className = "secondary";
      more.textContent = t("noticeDetail");
      more.style.cssText = "font-size:12px;padding:2px 10px;flex:none";
      more.onclick = () =>
        noticeDetailDialog(
          h.title,
          when.textContent ?? "",
          h.answerLabel,
          h.body,
        );
      row.append(when, what, more);
      list.appendChild(row);
    }
    if (d.pages > 1) {
      const nav = document.createElement("div");
      nav.style.cssText =
        "display:flex;gap:8px;align-items:center;justify-content:center;margin-top:8px;font-size:12px";
      const prev = document.createElement("button");
      prev.type = "button";
      prev.className = "secondary";
      prev.textContent = t("noticePrev");
      prev.disabled = d.page <= 1;
      prev.onclick = () => void load(d.page - 1);
      const next = document.createElement("button");
      next.type = "button";
      next.className = "secondary";
      next.textContent = t("noticeNext");
      next.disabled = d.page >= d.pages;
      next.onclick = () => void load(d.page + 1);
      const at = document.createElement("span");
      at.textContent = d.page + " / " + d.pages;
      nav.append(prev, at, next);
      list.appendChild(nav);
    }
  };
  void load(noticeHistoryPage);
  return box;
}

/** 一度出したものの全文(読んだものの 1 行の「詳細」)。閉じるだけの窓。 */
function noticeDetailDialog(
  title: string,
  when: string,
  answer: string | null,
  body: string,
) {
  const ov = document.createElement("div");
  ov.setAttribute("role", "dialog");
  ov.setAttribute("aria-modal", "true");
  ov.style.cssText =
    "position:fixed;inset:0;z-index:3000;background:rgba(8,12,22,.72);display:flex;align-items:center;justify-content:center;padding:20px";
  const card = document.createElement("div");
  card.style.cssText =
    "width:min(520px,100%);background:var(--panel,#141f35);color:var(--ink,#e9eefc);border:1px solid var(--line,#293b5d);" +
    "border-radius:14px;padding:22px;font-size:14px;line-height:1.8;box-shadow:0 18px 50px rgba(0,0,0,.5)";
  const h = document.createElement("h3");
  h.textContent = title;
  h.style.cssText = "margin:0 0 4px;font-size:18px";
  const meta = document.createElement("div");
  meta.textContent = when + (answer ? " — " + answer : "");
  meta.style.cssText =
    "font-size:12px;color:var(--muted,#91a0c3);margin:0 0 12px";
  const text = document.createElement("p");
  text.textContent = body;
  text.style.cssText = "white-space:pre-wrap;margin:0 0 18px";
  const row = document.createElement("div");
  row.style.cssText = "display:flex;justify-content:flex-end";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = t("contractWindowClose");
  const done = () => ov.remove();
  close.onclick = done;
  ov.addEventListener("click", (e) => {
    if (e.target === ov) done();
  });
  ov.addEventListener("keydown", (e) => {
    if (e.key === "Escape") done();
  });
  row.appendChild(close);
  card.append(h, meta, text, row);
  ov.appendChild(card);
  document.body.appendChild(ov);
  close.focus();
}

/** 緊急・重要の未読を1件ずつ窓で出す。規約の窓と重ねないよう、規約の窓が閉じてから出す。 */
let noticeGateDone = false;
async function noticeGateOnce() {
  if (noticeGateDone) return;
  noticeGateDone = true;
  // 規約の窓が出ている間は待つ(同じ画面に窓を重ねない)。
  while (document.querySelector("[role='dialog'][aria-modal='true']")) {
    await new Promise((r) => setTimeout(r, 500));
  }
  const v = await loadNotices();
  if (!v) return;
  const byId = new Map(v.notices.map((n) => [n.id, n]));
  const items = v.dialogs
    .map((id) => byId.get(id))
    .filter((n): n is NoticeItemView => !!n);
  for (let i = 0; i < items.length; i++)
    await noticeDialog(items[i]!, i, items.length);
}

function noticeDialog(
  n: NoticeItemView,
  i: number,
  total: number,
): Promise<void> {
  return new Promise((done) => {
    const critical = n.kind === "critical";
    const ov = document.createElement("div");
    ov.setAttribute("role", "alertdialog");
    ov.setAttribute("aria-modal", "true");
    ov.style.cssText =
      "position:fixed;inset:0;z-index:3000;background:rgba(8,12,22,.72);display:flex;align-items:center;justify-content:center;padding:20px";
    const card = document.createElement("div");
    card.style.cssText =
      "width:min(520px,100%);background:var(--panel,#141f35);color:var(--ink,#e9eefc);border:1px solid var(--line,#293b5d);" +
      "border-radius:14px;padding:22px;font-size:14px;line-height:1.8;box-shadow:0 18px 50px rgba(0,0,0,.5)";
    const head = document.createElement("div");
    head.textContent =
      (critical ? t("noticeCritical") : t("noticeImportant")) +
      (total > 1 ? " (" + (i + 1) + " / " + total + ")" : "");
    head.style.cssText = "font-size:12px;color:var(--muted,#91a0c3)";
    const title = document.createElement("h3");
    title.textContent = n.title;
    title.style.cssText = "margin:4px 0 10px;font-size:18px";
    const body = document.createElement("p");
    body.textContent = n.body;
    body.style.cssText = "white-space:pre-wrap;margin:0 0 18px";
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:10px;justify-content:flex-end";
    const close = () => {
      ov.remove();
      done();
    };
    // 口座宛ての知らせ: 答えのボタンを並べる。答えるのは管理者だけ(ほかの人には「閉じる」だけ・記録しない)。
    if (n.direct) {
      for (const a of state.isAdmin ? n.answers || [] : []) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = a.label;
        b.className = a.id === "close" ? "secondary" : "primary";
        b.onclick = () => {
          close();
          void noticeAnswer(n, a.id);
        };
        row.appendChild(b);
      }
      if (!state.isAdmin) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = t("contractWindowClose");
        b.onclick = close;
        row.appendChild(b);
      }
      card.append(head, title, body, row);
      ov.appendChild(card);
      document.body.appendChild(ov);
      (row.lastElementChild as HTMLElement | null)?.focus();
      return;
    }
    if (!critical) {
      const later = document.createElement("button");
      later.type = "button";
      later.textContent = t("noticeLater");
      later.onclick = close; // 既読にしない(次に開いた時にまた出る)
      row.appendChild(later);
    }
    const primary = document.createElement("button");
    primary.type = "button";
    primary.className = "primary";
    primary.textContent = noticeActionLabel(n);
    primary.onclick = async () => {
      primary.disabled = true;
      if (n.action.kind === "open" && n.action.url) noticeOpenUrl(n.action.url);
      await noticeAckOne(n.id);
      close();
    };
    row.appendChild(primary);
    card.append(head, title, body, row);
    ov.appendChild(card);
    // 緊急は Esc で閉じない(閉じる手段を置かない)。
    ov.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && critical) e.preventDefault();
    });
    document.body.appendChild(ov);
    primary.focus();
  });
}
