// KuroCMS admin screen module. Concatenated by scripts/build-admin.js.

/**
 * サイトの削除の確認の窓(cms-pricing「サイトを消す」・2026-10-30・利用者の指示)。
 *
 * 入口は 2 つで、**どちらもこの窓を開く** —— 無料期間が終わった知らせ(Notice)の「このサイトを削除する」と、
 * 設定の契約のタブの「サイトの持ち主」の枠の「サイトの削除」(2026-11-02 にプロフィールから移した)。窓は**消えるものを件数で見せ**(/api/system/site-delete)、
 * 消すのは Entamy の契約の頁で行う(Entamy ID でログインした持ち主が識別名を入れて消す・導入口の owner-sites)。
 * この管理画面は Entamy ID のログインを持たず、管理者は持ち主とは限らないので、ここでは消さない。
 * 契約があるサイトは消せない(先に解約)。顧客導入は自分の Cloudflare で片付ける(Entamy の「サイト管理」)。
 */
const SITE_DELETE_PAGE = "https://kurocms.entamy.com/contract/";
const SITE_MANAGE_PAGE = "https://kurocms.entamy.com/manage/";

type SiteDeletePreviewView = {
  managed: boolean;
  subscription: string | null;
  counts: {
    documents: number;
    media: number;
    mediaBytes: number;
    users: number;
    categories: number;
  };
};

async function siteDeleteDialog() {
  let p: SiteDeletePreviewView;
  try {
    p = (await api("/api/system/site-delete")) as SiteDeletePreviewView;
  } catch (e) {
    toast(errorMessage(e), true);
    return;
  }
  const ov = document.createElement("div");
  ov.setAttribute("role", "dialog");
  ov.setAttribute("aria-modal", "true");
  ov.style.cssText =
    "position:fixed;inset:0;z-index:3000;background:rgba(8,12,22,.72);display:flex;align-items:center;justify-content:center;padding:20px";
  const card = document.createElement("div");
  card.style.cssText =
    "width:min(560px,100%);background:var(--panel,#141f35);color:var(--ink,#e9eefc);border:1px solid var(--line,#293b5d);" +
    "border-radius:14px;padding:22px;font-size:14px;line-height:1.8;box-shadow:0 18px 50px rgba(0,0,0,.5)";
  const h = document.createElement("h3");
  h.textContent = t("siteDeleteTitle");
  h.style.cssText = "margin:0 0 8px;font-size:18px";
  const lead = document.createElement("p");
  lead.textContent = t("siteDeleteLead");
  lead.style.cssText = "margin:0 0 12px";
  // 消えるもの(空のサイトと運用中のサイトを取り違えないよう、件数で見せる)。
  const list = document.createElement("ul");
  list.style.cssText = "margin:0 0 12px;padding-left:1.2em";
  const items: string[] = [
    t("siteDeleteDocuments").replace("{n}", String(p.counts.documents)),
    t("siteDeleteMedia")
      .replace("{n}", String(p.counts.media))
      .replace("{size}", fmtBytes(p.counts.mediaBytes)),
    t("siteDeleteUsers").replace("{n}", String(p.counts.users)),
    t("siteDeleteCategories").replace("{n}", String(p.counts.categories)),
    t("siteDeleteSettings"),
    t("siteDeleteAddress").replace("{host}", location.hostname),
  ];
  for (const text of items) {
    const li = document.createElement("li");
    li.textContent = text;
    list.appendChild(li);
  }
  const note = document.createElement("p");
  note.style.cssText =
    "margin:0 0 16px;color:var(--muted,#91a0c3);font-size:13px";
  const row = document.createElement("div");
  row.style.cssText =
    "display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "secondary";
  close.textContent = t("contractWindowClose");
  close.onclick = () => ov.remove();
  const go = document.createElement("a");
  go.className = "button danger";
  go.target = "_blank";
  go.rel = "noopener";
  if (!p.managed) {
    // 顧客導入: 自分の Cloudflare のサイトは「サイト管理」で片付ける。
    note.textContent = t("siteDeleteSelf");
    go.href = SITE_MANAGE_PAGE;
    go.textContent = t("siteDeleteOpenManage");
  } else if (p.subscription && p.subscription !== "none") {
    // 契約がある: 先に解約(契約の頁)。
    note.textContent = t("siteDeleteContract");
    go.href = SITE_DELETE_PAGE;
    go.className = "button secondary";
    go.textContent = t("contractOpenPage");
  } else {
    note.textContent = t("siteDeleteHow");
    go.href =
      SITE_DELETE_PAGE + "?delete=" + encodeURIComponent(location.hostname);
    go.textContent = t("siteDeleteGo");
  }
  go.addEventListener("click", () => ov.remove());
  row.append(close, go);
  card.append(h, lead, list, note, row);
  ov.appendChild(card);
  ov.addEventListener("click", (e) => {
    if (e.target === ov) ov.remove();
  });
  ov.addEventListener("keydown", (e) => {
    if (e.key === "Escape") ov.remove();
  });
  document.body.appendChild(ov);
  close.focus();
}

/**
 * Entamy ID のアカウントの削除の窓(2026-11-02・利用者の指示)。入口は設定の「サイトの持ち主(Entamy ID)」の枠。
 *
 * KuroCMS は Entamy 基盤とつながって動くので、持ち主の Entamy ID が無いサイトは単体では残れない。そこで
 * **サイトを先に削除しなければ ID は削除できない**順にする(契約の解約 → サイトの削除 → 削除の窓口で ID)。
 * この窓は、その順と、ID を消すと何が消え何が残るか・いまの契約を見せ、赤いボタンでサイトの削除の窓(siteDeleteDialog)へ進める。
 * ID の削除そのもの(id.entamy.com/delete・ID 10.4節)は、サイトを消した後に窓口で行う —— サイトが残っている間は
 * ここから窓口へは送らない。ID の側でも、持ち主のサイトが残っていれば断る(課題 a8179991)。
 */
async function accountDeleteDialog() {
  let p: SiteDeletePreviewView;
  try {
    p = (await api("/api/system/site-delete")) as SiteDeletePreviewView;
  } catch (e) {
    toast(errorMessage(e), true);
    return;
  }
  const sub = p.subscription;
  // 契約: block = 自動更新が続く(申し込み済み・引き継ぎ中を含む)、unknown = 分からない、cancelled = 解約済み(終わるまで残る)。
  const contract: "block" | "unknown" | "cancelled" | "none" = !p.managed
    ? "none"
    : sub === null
      ? "unknown"
      : sub === "cancelled"
        ? "cancelled"
        : sub === "none"
          ? "none"
          : "block";

  const ov = document.createElement("div");
  ov.setAttribute("role", "dialog");
  ov.setAttribute("aria-modal", "true");
  ov.style.cssText =
    "position:fixed;inset:0;z-index:3000;background:rgba(8,12,22,.72);display:flex;align-items:center;justify-content:center;padding:20px";
  const card = document.createElement("div");
  card.style.cssText =
    "width:min(600px,100%);max-height:calc(100vh - 40px);overflow:auto;background:var(--panel,#141f35);color:var(--ink,#e9eefc);border:1px solid var(--line,#293b5d);" +
    "border-radius:14px;padding:22px;font-size:14px;line-height:1.8;box-shadow:0 18px 50px rgba(0,0,0,.5)";
  const h = document.createElement("h3");
  h.textContent = t("accountDeleteTitle");
  h.style.cssText = "margin:0 0 8px;font-size:18px";
  const lead = document.createElement("p");
  lead.textContent = t("accountDeleteLead");
  lead.style.cssText = "margin:0 0 14px";

  const section = (
    title: string,
    lines: string[],
    tone: "" | "danger" = "",
    ordered = false,
  ) => {
    const box = document.createElement("div");
    box.style.cssText =
      "margin:0 0 12px;padding:12px 14px;border:1px solid " +
      (tone === "danger" ? "rgba(239,68,68,.45)" : "var(--line,#293b5d)") +
      ";border-radius:10px;" +
      (tone === "danger" ? "background:rgba(239,68,68,.08)" : "");
    const b = document.createElement("div");
    b.textContent = title;
    b.style.cssText = "font-weight:700;margin-bottom:4px";
    const list = document.createElement(ordered ? "ol" : "ul");
    list.style.cssText = "margin:0;padding-left:1.4em;font-size:13px";
    for (const text of lines) {
      const li = document.createElement("li");
      li.textContent = text;
      list.appendChild(li);
    }
    box.append(b, list);
    return box;
  };

  // 委託の人には、削除の前に「無料の顧客導入へ引っ越す」道を見せる(費用を止めたいだけなら、ID もサイトも消さずに済む)。
  // 引っ越しの窓は設定の「運用の形」のボタン(siteMoveOpen)が開く —— 持ち主の登録や版の確かめもそちらが持つ。
  const moveBtn = byId("siteMoveOpen") as HTMLButtonElement | null;
  let free: HTMLDivElement | null = null;
  if (p.managed && moveBtn && !moveBtn.disabled) {
    free = document.createElement("div");
    free.style.cssText =
      "margin:0 0 12px;padding:12px 14px;border:1px solid var(--accent,#157a6e);border-radius:10px;background:var(--accent-soft,rgba(21,122,110,.1))";
    const ft = document.createElement("div");
    ft.textContent = t("accountDeleteFreeTitle");
    ft.style.cssText = "font-weight:700;margin-bottom:4px";
    const fb = document.createElement("div");
    fb.textContent = t("accountDeleteFreeBody");
    fb.style.cssText = "font-size:13px;margin-bottom:10px";
    const fg = document.createElement("button");
    fg.type = "button";
    fg.textContent = t("accountDeleteFreeGo");
    fg.onclick = () => {
      ov.remove();
      moveBtn.scrollIntoView({ block: "center" });
      moveBtn.click();
    };
    free.append(ft, fb, fg);
  }
  const required = section(
    t("accountDeleteSiteTitle"),
    [t("accountDeleteSiteRequired")],
    "danger",
  );
  const steps = section(
    t("accountDeleteStepsTitle"),
    p.managed
      ? [
          t("accountDeleteStepContract"),
          t("accountDeleteStepSiteManaged"),
          t("accountDeleteStepId"),
        ]
      : [t("accountDeleteStepSiteSelf"), t("accountDeleteStepId")],
    "",
    true,
  );
  const contractBox = section(
    t("accountDeleteContractTitle"),
    [
      t(
        contract === "block"
          ? "accountDeleteContractBlock"
          : contract === "unknown"
            ? "accountDeleteContractUnknown"
            : contract === "cancelled"
              ? "accountDeleteContractCancelled"
              : p.managed
                ? "accountDeleteContractNone"
                : "accountDeleteContractSelf",
      ),
    ],
    contract === "none" ? "" : "danger",
  );
  const gone = section(t("accountDeleteGoneTitle"), [
    t("accountDeleteGoneAccount"),
    t("accountDeleteGoneOwner"),
  ]);
  const kept = section(t("accountDeleteKeptTitle"), [
    t("accountDeleteKeptRecords"),
  ]);

  const row = document.createElement("div");
  row.style.cssText =
    "display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;align-items:center;margin-top:4px";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "secondary";
  close.textContent = t("contractWindowClose");
  close.onclick = () => ov.remove();
  row.appendChild(close);
  if (p.managed && contract !== "none") {
    const page = document.createElement("button");
    page.type = "button";
    page.className = "secondary";
    page.textContent = t("contractOpenPage");
    page.onclick = () => {
      window.open(SITE_DELETE_PAGE, "_blank", "noopener");
      ov.remove();
    };
    row.appendChild(page);
  }
  // 次の一歩はサイトの削除。契約の確かめと、消えるものの件数はサイトの削除の窓が見せる。
  const go = document.createElement("button");
  go.type = "button";
  go.className = "danger";
  go.textContent = t("accountDeleteGoSite");
  go.onclick = () => {
    ov.remove();
    void siteDeleteDialog();
  };
  row.appendChild(go);

  card.append(h, lead);
  if (free) card.append(free);
  card.append(required, steps, contractBox, gone, kept, row);
  ov.appendChild(card);
  ov.addEventListener("click", (e) => {
    if (e.target === ov) ov.remove();
  });
  ov.addEventListener("keydown", (e) => {
    if (e.key === "Escape") ov.remove();
  });
  document.body.appendChild(ov);
  close.focus();
}
