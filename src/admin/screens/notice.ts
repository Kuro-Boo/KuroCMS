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
 */
type NoticeItemView = {
  id: string;
  kind: "critical" | "important" | "info_product" | "info_other";
  section: "product" | "other";
  title: string;
  body: string;
  action: { kind: "ack" | "open"; label?: string | null; url?: string };
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

const noticeQuery = () => "?lang=" + encodeURIComponent(state.uiLang || "ja");

function noticeApplied(v: NoticeStateView | null) {
  if (!v) return;
  noticeCurrent = v;
  if (state.noticeUnread !== v.unread) {
    state.noticeUnread = v.unread;
    // 左の項目の数を描き直す(枠が見えていなくても、数は変わる)。
    document
      .querySelectorAll("a[data-nav='dashboard'] .navNoticeCount")
      .forEach((el) => el.remove());
    if (v.unread > 0) {
      const link = document.querySelector("a[data-nav='dashboard']");
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
    "<div style='font-weight:700;font-size:14px;margin-bottom:8px'>" +
    escapeHtml(t("noticeHeading")) +
    "</div><div id='noticeBody'></div></div>"
  );
}

function renderNoticePanel() {
  const body = document.getElementById("noticeBody");
  if (!body) return;
  body.textContent = "";
  const v = noticeCurrent;
  const el = (tag: string, text?: string, css?: string) => {
    const x = document.createElement(tag);
    if (text !== undefined) x.textContent = text;
    if (css) x.style.cssText = css;
    return x;
  };
  if (!v || !v.notices.length) {
    body.appendChild(
      el("div", t("noticeEmpty"), "color:var(--muted);font-size:13px"),
    );
  } else {
    const acked = new Set(v.acked);
    const sections: [string, NoticeItemView[]][] = [
      [
        t("noticeSectionProduct"),
        v.notices.filter((n) => n.section === "product"),
      ],
      [t("noticeSectionOther"), v.notices.filter((n) => n.section === "other")],
    ];
    for (const [label, items] of sections) {
      if (!items.length) continue;
      body.appendChild(
        el("div", label, "font-size:12px;color:var(--muted);margin:8px 0 4px"),
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
        const b = el(
          "button",
          noticeActionLabel(n),
          "font-size:12px;padding:4px 12px",
        ) as HTMLButtonElement;
        b.type = "button";
        b.onclick = () => {
          if (n.action.kind === "open" && n.action.url)
            noticeOpenUrl(n.action.url);
          void noticeAckOne(n.id);
        };
        row.appendChild(b);
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
  // 「ほかの製品のお知らせを受け取る」は導入ごと(管理者全員で共通)なので、管理者だけが変えられる。
  if (state.isAdmin && v) {
    const label = el(
      "label",
      undefined,
      "display:flex;gap:8px;align-items:center;margin-top:10px;font-size:13px;color:var(--muted)",
    );
    const box = el("input") as HTMLInputElement;
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
    body.appendChild(label);
  }
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
