// KuroCMS admin screen module. Concatenated by scripts/build-admin.js.
//
// 委託の独自ドメイン(core-offering 14 節・2026-10-22)。設定の「ドメイン」タブの、委託運用だけに出す枠。
// 委託用ゾーン(kurocms.site)の Cloudflare for SaaS で、お客様のドメインを付ける:
//   準備する(Custom Hostname を作る) → お客様が TXT を足す → 状態を確かめる(証明書が発行済みか)
//   → ドメインを切り替える(kurocms.site 側のルートをこの導入へ) → お客様が CNAME を向ける → 有効
//   → 公開ドメインに入れて保存・全ページをビルド
// 頼むのはサーバー(/api/system/site-domain・src/site-domain.ts)。鍵はどこにも置かない。

type OwnDomainRecord = {
  type: string;
  name: string;
  value: string;
  purpose: "ownership" | "certificate" | "traffic";
};
type OwnDomain = {
  hostname: string;
  status: string;
  sslStatus: string;
  switched: boolean;
  target: string;
  records: OwnDomainRecord[];
  errors: string[];
};

function ownDomainPanelHtml(): string {
  return "<div id='ownDomainPanel' class='panel stack' style='display:none'></div>";
}

/** 手順の一覧({target} は CNAME の向け先)。文言は改行区切りで持つ。 */
function ownDomainSteps(key: string, target: string): string {
  return (
    "<ol style='margin:0;padding-left:20px;display:grid;gap:6px'>" +
    t(key)
      .split("\n")
      .map(
        (line) =>
          "<li>" +
          escapeHtml(line).replace(
            "{target}",
            "<code>" + escapeHtml(target) + "</code>",
          ) +
          "</li>",
      )
      .join("") +
    "</ol>"
  );
}

async function mountOwnDomain(publicDomain: string): Promise<void> {
  const panel = byId("ownDomainPanel");
  if (!panel) return;
  panel.style.display = "";
  // 向け先は導入口が返す。準備する前は、いまの公開アドレス(委託のアドレス)のホスト名を出す。
  let fallbackTarget = "";
  try {
    fallbackTarget = new URL(publicDomain).host;
  } catch {
    /* 公開ドメインが空・形が悪い */
  }
  let dns: "cloudflare" | "other" = "cloudflare";
  let domain: OwnDomain | null = null;
  let busy = false;

  const pill = (ok: boolean, text: string) =>
    "<span class='badge' style='" +
    (ok ? "" : "background:var(--surface-2);color:var(--muted)") +
    "'>" +
    escapeHtml(text) +
    "</span>";

  function nextLine(d: OwnDomain): string {
    const certOk = d.sslStatus === "active";
    const hostOk = d.status === "active";
    let pd = "";
    try {
      pd = new URL(
        (byId("publicDomain") as HTMLInputElement | null)?.value || "",
      ).host;
    } catch {
      /* 空 */
    }
    if (!certOk) return t("ownDomainNextTxt");
    if (!d.switched) return t("ownDomainNextSwitch");
    if (!hostOk)
      return t("ownDomainNextCname")
        .replace("{host}", d.hostname)
        .replace("{target}", d.target);
    if (pd !== d.hostname) return t("ownDomainNextPublic");
    return t("ownDomainDone");
  }

  function render() {
    const target = domain?.target || fallbackTarget;
    const purpose: Record<string, string> = {
      ownership: t("ownDomainPurposeOwnership"),
      certificate: t("ownDomainPurposeCertificate"),
      traffic: t("ownDomainPurposeTraffic"),
    };
    let html =
      "<div class='panelHead'><h3 style='margin:0'>" +
      escapeHtml(t("ownDomainTitle")) +
      "</h3></div>" +
      "<div class='muted'>" +
      escapeHtml(t("ownDomainLead")) +
      "</div>" +
      "<div class='toolbar' style='gap:6px'>" +
      "<button type='button' class='secondary" +
      (dns === "cloudflare" ? " active" : "") +
      "' data-own-dns='cloudflare'>" +
      escapeHtml(t("ownDomainDnsCloudflare")) +
      "</button>" +
      "<button type='button' class='secondary" +
      (dns === "other" ? " active" : "") +
      "' data-own-dns='other'>" +
      escapeHtml(t("ownDomainDnsOther")) +
      "</button>" +
      "</div>" +
      ownDomainSteps(
        dns === "cloudflare"
          ? "ownDomainStepsCloudflare"
          : "ownDomainStepsOther",
        target,
      ) +
      "<div class='muted' style='font-size:12px'>" +
      escapeHtml(t("ownDomainOverwriteNote")) +
      "</div>";

    if (!domain) {
      html +=
        "<label>" +
        escapeHtml(t("ownDomainHostLabel")) +
        "<div style='display:flex;gap:8px'>" +
        "<input id='ownDomainHost' placeholder='www.example.com' autocomplete='off' style='flex:1;min-width:0' />" +
        "<button type='button' id='ownDomainPrepareBtn'>" +
        escapeHtml(t("ownDomainPrepare")) +
        "</button></div></label>";
    } else {
      const certOk = domain.sslStatus === "active";
      const hostOk = domain.status === "active";
      html +=
        "<div style='display:flex;flex-wrap:wrap;align-items:center;gap:8px'>" +
        "<b style='font-size:15px'>" +
        escapeHtml(domain.hostname) +
        "</b>" +
        escapeHtml(t("ownDomainCert")) +
        " " +
        pill(
          certOk,
          certOk ? t("ownDomainCertActive") : t("ownDomainCertPending"),
        ) +
        escapeHtml(t("ownDomainSwitchedLabel")) +
        " " +
        pill(
          domain.switched,
          domain.switched
            ? t("ownDomainSwitchedYes")
            : t("ownDomainSwitchedNo"),
        ) +
        escapeHtml(t("ownDomainHost")) +
        " " +
        pill(
          hostOk,
          hostOk ? t("ownDomainHostActive") : t("ownDomainHostPending"),
        ) +
        "</div>" +
        "<div><b>" +
        escapeHtml(nextLine(domain)) +
        "</b></div>" +
        "<div class='fieldLabel'>" +
        escapeHtml(t("ownDomainRecordsTitle")) +
        "</div>" +
        "<div class='tableScroll'><table class='tableCompact'><thead><tr><th>" +
        escapeHtml(t("ownDomainColType")) +
        "</th><th class='flexible'>" +
        escapeHtml(t("ownDomainColName")) +
        " / " +
        escapeHtml(t("ownDomainColValue")) +
        "</th><th>" +
        escapeHtml(t("ownDomainColPurpose")) +
        "</th></tr></thead><tbody>" +
        domain.records
          .map(
            (r, i) =>
              "<tr><td>" +
              escapeHtml(r.type) +
              "</td><td class='flexible' style='white-space:normal'>" +
              "<div><code>" +
              escapeHtml(r.name) +
              "</code></div><div style='display:flex;align-items:center;gap:6px;margin-top:4px'><code style='word-break:break-all'>" +
              escapeHtml(r.value) +
              "</code><button type='button' class='secondary' data-own-copy='" +
              i +
              "' style='font-size:11px;padding:3px 8px'>" +
              escapeHtml(t("copy")) +
              "</button></div></td><td>" +
              escapeHtml(purpose[r.purpose] || r.purpose) +
              "</td></tr>",
          )
          .join("") +
        "</tbody></table></div>" +
        (domain.errors.length && !hostOk
          ? "<div class='muted' style='font-size:12px'>" +
            escapeHtml(t("ownDomainErrors")) +
            ": " +
            escapeHtml(domain.errors.join(" / ")) +
            "</div>"
          : "") +
        "<div class='toolbar' style='gap:8px;flex-wrap:wrap'>" +
        "<button type='button' class='secondary' id='ownDomainCheckBtn'>" +
        escapeHtml(t("ownDomainCheck")) +
        "</button>" +
        "<button type='button' id='ownDomainSwitchBtn'" +
        (certOk && !domain.switched ? "" : " disabled") +
        ">" +
        escapeHtml(t("ownDomainSwitch")) +
        "</button>" +
        (hostOk && domain.switched
          ? "<button type='button' id='ownDomainUseBtn'>" +
            escapeHtml(t("ownDomainUsePublic")) +
            "</button>"
          : "") +
        "<button type='button' class='secondary' id='ownDomainRemoveBtn'>" +
        escapeHtml(t("ownDomainRemove")) +
        "</button>" +
        "</div>";
    }
    panel!.innerHTML = html;
    wire();
  }

  async function call(action: string, hostname?: string, btn?: Element | null) {
    if (busy) return;
    busy = true;
    if (btn) (btn as HTMLButtonElement).disabled = true;
    try {
      const res = (await api("/api/system/site-domain", {
        method: "POST",
        body: JSON.stringify({ action, ...(hostname ? { hostname } : {}) }),
      })) as { domain: OwnDomain | null };
      domain = res.domain;
      render();
    } catch (error) {
      toast(errorMessage(error), true, btn || undefined);
      if (btn) (btn as HTMLButtonElement).disabled = false;
    } finally {
      busy = false;
    }
  }

  function wire() {
    panel!.querySelectorAll<HTMLElement>("[data-own-dns]").forEach((el) =>
      el.addEventListener("click", () => {
        dns = el.dataset.ownDns === "other" ? "other" : "cloudflare";
        render();
      }),
    );
    panel!.querySelectorAll<HTMLElement>("[data-own-copy]").forEach((el) =>
      el.addEventListener("click", async () => {
        const r = domain?.records[Number(el.dataset.ownCopy)];
        if (!r) return;
        try {
          await navigator.clipboard.writeText(r.value);
          toast(t("copySuccess"), false, el);
        } catch {
          toast(t("copyFailed"), true);
        }
      }),
    );
    byId("ownDomainPrepareBtn")?.addEventListener("click", (e: Dynamic) => {
      const host = (
        (byId("ownDomainHost") as HTMLInputElement | null)?.value || ""
      ).trim();
      if (host) void call("prepare", host, e.currentTarget);
    });
    byId("ownDomainHost")?.addEventListener("keydown", (e: Dynamic) => {
      if (e.key === "Enter") {
        e.preventDefault();
        byId("ownDomainPrepareBtn")?.click();
      }
    });
    byId("ownDomainCheckBtn")?.addEventListener("click", (e: Dynamic) => {
      void call("status", undefined, e.currentTarget);
    });
    byId("ownDomainSwitchBtn")?.addEventListener("click", (e: Dynamic) => {
      void call("switch", undefined, e.currentTarget);
    });
    byId("ownDomainRemoveBtn")?.addEventListener("click", (e: Dynamic) => {
      if (confirm(t("ownDomainRemoveConfirm")))
        void call("remove", undefined, e.currentTarget);
    });
    byId("ownDomainUseBtn")?.addEventListener("click", (e: Dynamic) => {
      const input = byId("publicDomain") as HTMLInputElement | null;
      if (!input || !domain) return;
      input.value = "https://" + domain.hostname + "/";
      input.dispatchEvent(new Event("input"));
      toast(t("ownDomainUsePublicDone"), false, e.currentTarget);
      render();
    });
  }

  render();
  // 準備したドメインがあれば、その状態を出す(読めなければ入力欄のまま)。
  try {
    const res = (await api("/api/system/site-domain")) as {
      domain: OwnDomain | null;
    };
    domain = res.domain;
    render();
  } catch {
    /* 基盤に届かない・古い導入口。入力欄のまま */
  }
}
