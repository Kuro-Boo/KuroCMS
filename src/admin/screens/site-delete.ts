// KuroCMS admin screen module. Concatenated by scripts/build-admin.js.

/**
 * サイトの削除の確認の窓(cms-pricing「サイトを消す」・2026-10-30・利用者の指示)。
 *
 * 入口は 2 つで、**どちらもこの窓を開く** —— 無料期間が終わった知らせ(Notice)の「このサイトを削除する」と、
 * プロフィールの「サイトの削除」。窓は**消えるものを件数で見せ**(/api/system/site-delete)、
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
