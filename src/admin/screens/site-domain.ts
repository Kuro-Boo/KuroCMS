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
  done?: boolean;
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

/**
 * 手順の 1 段(部品 .stepList)。state = done(済み・✓)/ current(今ここ)/ todo(まだ)。
 * title はやることを 1 行で、desc は補足を短く。body はその段で使う欄やボタン。
 */
function ownDomainStep(
  n: number,
  state: "done" | "current" | "todo",
  title: string,
  desc: string,
  body = "",
): string {
  return (
    "<li class='stepItem " +
    state +
    "'><div class='stepNum'>" +
    (state === "done" ? "✓" : String(n)) +
    "</div><div><div class='stepTitle'>" +
    title +
    "</div>" +
    (desc ? "<div class='stepDesc'>" + desc + "</div>" : "") +
    (body ? "<div class='stepBody'>" + body + "</div>" : "") +
    "</div></li>"
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

  /** 公開ドメインの欄が、このドメインになっているか(5 段目が済んだか)。 */
  function publicIsDomain(d: OwnDomain): boolean {
    try {
      return (
        new URL((byId("publicDomain") as HTMLInputElement | null)?.value || "")
          .host === d.hostname
      );
    } catch {
      return false;
    }
  }

  /** 名前や値。押してもコピー、横のボタンでもコピー(2026-10-22 利用者の指示)。 */
  function copyCell(text: string, key: string): string {
    return (
      "<div style='display:flex;align-items:center;gap:6px'><code role='button' tabindex='0' style='word-break:break-all;cursor:copy' title='" +
      escapeHtml(t("copy")) +
      "' data-own-copy='" +
      key +
      "'>" +
      escapeHtml(text) +
      "</code><button type='button' class='secondary' data-own-copy='" +
      key +
      "' style='font-size:11px;padding:3px 8px'>" +
      escapeHtml(t("copy")) +
      "</button></div>"
    );
  }

  /** 「名前」「値」のラベルと中身を横に並べる(狭い画面では縦)。 */
  function labeled(label: string, body: string): string {
    return (
      "<div style='display:grid;grid-template-columns:minmax(48px,auto) minmax(0,1fr);gap:8px;align-items:center'><span class='fieldLabel' style='margin:0'>" +
      escapeHtml(label) +
      "</span>" +
      body +
      "</div>"
    );
  }

  function render() {
    const target = domain?.target || fallbackTarget;
    const cf = dns === "cloudflare";
    const d = domain;
    const certOk = d?.sslStatus === "active";
    const hostOk = d?.status === "active";
    const switched = !!d?.switched;
    const pubOk = !!d && hostOk && publicIsDomain(d);
    // どの段が済んだか。最初の済んでいない段が「今ここ」。
    const done = [!!d, certOk, switched, hostOk, pubOk];
    const cur = done.indexOf(false);
    const st = (k: number) =>
      done[k] ? "done" : k === cur ? "current" : "todo";
    const purpose: Record<string, string> = {
      ownership: t("ownDomainPurposeOwnership"),
      certificate: t("ownDomainPurposeCertificate"),
    };
    const txt = (d?.records ?? [])
      .map((r, i) => ({ r, i }))
      .filter((x) => x.r.type === "TXT");
    const cname = (d?.records ?? []).findIndex((r) => r.type === "CNAME");

    // 1. ドメイン名
    const step1 = d
      ? "<div style='display:flex;flex-wrap:wrap;align-items:center;gap:10px'><b style='font-size:15px'>" +
        escapeHtml(d.hostname) +
        "</b><button type='button' class='secondary' id='ownDomainRemoveBtn' style='font-size:12px;padding:4px 10px'>" +
        escapeHtml(t("ownDomainRemove")) +
        "</button></div>"
      : "<div style='display:flex;gap:8px'>" +
        "<input id='ownDomainHost' placeholder='blog.example.com' autocomplete='off' style='flex:1;min-width:0' />" +
        "<button type='button' id='ownDomainPrepareBtn'>" +
        escapeHtml(t("ownDomainPrepare")) +
        "</button></div>";

    // 2. TXT
    let step2 = "";
    if (!d) {
      step2 =
        "<div class='muted' style='padding:12px;border:1px dashed var(--line);border-radius:10px;font-size:13px'>" +
        escapeHtml(t("ownDomainRecordsBefore")) +
        "</div>";
    } else if (txt.length) {
      // レコードごとのカード(用途と状態を見出しに、名前と値はラベル付きで押せばコピー)。
      step2 = txt
        .map(
          ({ r, i }) =>
            "<div style='border:1px solid var(--line);border-radius:10px;padding:12px 14px;display:grid;gap:8px;background:var(--surface-2)'>" +
            "<div style='display:flex;align-items:center;gap:8px'><b>TXT</b><span class='muted'>" +
            escapeHtml(purpose[r.purpose] || r.purpose) +
            "</span><span style='margin-left:auto'>" +
            pill(
              !!r.done,
              r.done ? t("ownDomainRecDone") : t("ownDomainRecTodo"),
            ) +
            "</span></div>" +
            labeled(t("ownDomainColName"), copyCell(r.name, i + ":name")) +
            labeled(t("ownDomainColValue"), copyCell(r.value, i + ":value")) +
            "</div>",
        )
        .join("");
    } else if (certOk) {
      step2 =
        "<div class='muted' style='font-size:12px'>" +
        escapeHtml(t("ownDomainTxtGone")) +
        "</div>";
    }

    // 3. 確かめて切り替える
    const step3 = d
      ? "<div class='toolbar' style='gap:8px;flex-wrap:wrap'>" +
        "<button type='button' class='secondary' id='ownDomainCheckBtn'>" +
        escapeHtml(t("ownDomainCheck")) +
        "</button>" +
        "<button type='button' id='ownDomainSwitchBtn'" +
        (certOk && !switched ? "" : " disabled") +
        ">" +
        escapeHtml(t("ownDomainSwitch")) +
        "</button></div>" +
        ""
      : "";

    // 4. CNAME
    const step4 =
      (d && cname >= 0
        ? "<div style='border:1px solid var(--line);border-radius:10px;padding:12px 14px;display:grid;gap:8px;background:var(--surface-2)'>" +
          "<div style='display:flex;align-items:center;gap:8px'><b>CNAME</b><span style='margin-left:auto'>" +
          pill(hostOk, hostOk ? t("ownDomainRecDone") : t("ownDomainRecTodo")) +
          "</span></div>" +
          labeled(
            t("ownDomainColName"),
            copyCell(d.hostname, cname + ":name"),
          ) +
          labeled(t("ownDomainColValue"), copyCell(target, cname + ":value")) +
          "</div>"
        : "") +
      "<div class='muted' style='font-size:12px'>⚠ " +
      escapeHtml(t("ownDomainOverwriteNote")) +
      "</div>";

    // 5. 公開ドメイン
    const step5 =
      hostOk && switched && !pubOk
        ? "<div><button type='button' id='ownDomainUseBtn'>" +
          escapeHtml(t("ownDomainUsePublic")) +
          "</button></div>"
        : "";

    const html =
      "<div class='panelHead'><h3 style='margin:0'>" +
      escapeHtml(t("ownDomainTitle")) +
      "</h3></div>" +
      "<div class='muted'>" +
      escapeHtml(t("ownDomainLead")) +
      "</div>" +
      "<div class='fieldLabel' style='margin:0'>" +
      escapeHtml(t("ownDomainDnsQuestion")) +
      "</div>" +
      segmentedHtml(
        "own-dns",
        [
          ["cloudflare", escapeHtml(t("ownDomainDnsCloudflare"))],
          ["other", escapeHtml(t("ownDomainDnsOther"))],
        ],
        dns,
      ) +
      "<ol class='stepList'>" +
      ownDomainStep(
        1,
        st(0),
        escapeHtml(t("ownDomainStep1Title")),
        escapeHtml(t("ownDomainStep1Desc")),
        step1,
      ) +
      ownDomainStep(
        2,
        st(1),
        escapeHtml(t("ownDomainStep2Title")),
        escapeHtml(t(cf ? "ownDomainStep2DescCf" : "ownDomainStep2DescOther")),
        step2,
      ) +
      ownDomainStep(
        3,
        st(2),
        escapeHtml(t("ownDomainStep3Title")),
        escapeHtml(t("ownDomainStep3Desc")),
        step3,
      ) +
      ownDomainStep(
        4,
        st(3),
        escapeHtml(t("ownDomainStep4Title")),
        escapeHtml(t(cf ? "ownDomainStep4DescCf" : "ownDomainStep4DescOther")),
        step4,
      ) +
      ownDomainStep(
        5,
        st(4),
        escapeHtml(t("ownDomainStep5Title")),
        escapeHtml(t("ownDomainStep5Desc")),
        step5,
      ) +
      "</ol>" +
      (pubOk
        ? "<div class='notice' style='margin:0'>✅ " +
          escapeHtml(t("ownDomainDone")) +
          "</div>"
        : "");

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
    panel!.querySelectorAll<HTMLElement>("code[data-own-copy]").forEach((el) =>
      el.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          el.click();
        }
      }),
    );
    panel!.querySelectorAll<HTMLElement>("[data-own-copy]").forEach((el) =>
      el.addEventListener("click", async () => {
        const [idx, part] = String(el.dataset.ownCopy).split(":");
        const r = domain?.records[Number(idx)];
        if (!r) return;
        try {
          await navigator.clipboard.writeText(
            part === "name" ? r.name : r.value,
          );
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
