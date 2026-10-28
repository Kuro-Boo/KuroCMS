// KuroCMS admin screen module. Concatenated by scripts/build-admin.js.
//
// 委託の独自ドメイン(core-offering 14 節・2026-10-22)。設定の「ドメイン」タブの、委託運用だけに出す枠。
// 委託用ゾーン(kurocms.site)の Cloudflare for SaaS で、お客様のドメインを付ける:
//   準備する(Custom Hostname を作る) → お客様が TXT を足す → 状態を確かめる(証明書が発行済みか)
//   → ドメインを切り替える(kurocms.site 側のルートをこの導入へ) → お客様が CNAME を向ける → 有効
//   → 保存して全ページをビルド
// ドメイン名を入れる欄は上の公開ドメインの 1 つだけ(2026-10-22 利用者の指示)。「準備する」はその欄から
// 読むだけで保存しない。有効になる前の保存は止める(全ページのリンクがまだ開けないアドレスに向くので・
// ownDomainSaveBlocked)。
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

/** 公開ドメインの欄の値からホスト名を取る(https://… でも、ドメイン名だけでもよい)。 */
function hostOfDomainInput(value: string): string {
  const v = value.trim();
  if (!v) return "";
  try {
    return new URL(
      /^https?:\/\//i.test(v) ? v : "https://" + v,
    ).host.toLowerCase();
  } catch {
    return "";
  }
}

/** 委託の枠が見ている状態(保存の前の確かめに使う)。委託でなければ null のまま。 */
let ownDomainWatch: {
  /** 委託のアドレス({導入ID}.kurocms.site)。 */
  fallbackHost: string;
  /** いま保存されている公開ドメイン。 */
  savedHost: string;
  domain: OwnDomain | null;
  /** 保存したあとに枠を描き直す(5 段目を済みにする)。値は欄に入っていたまま。 */
  onSaved: (value: string) => void;
} | null = null;

/**
 * 公開ドメインをこの値で保存してはいけないか。委託で、委託のアドレスでも、いま保存されているアドレスでも、
 * 有効になった自分のドメインでもないとき(準備しただけ・切り替える前・CNAME を向ける前)は止める。
 */
function ownDomainSaveBlocked(value: string): boolean {
  if (!ownDomainWatch) return false;
  const host = hostOfDomainInput(value);
  if (
    !host ||
    host === ownDomainWatch.fallbackHost ||
    host === ownDomainWatch.savedHost
  )
    return false;
  const d = ownDomainWatch.domain;
  return !(d && d.hostname === host && d.status === "active" && d.switched);
}

/** 設定を保存したあとに呼ぶ(保存した公開ドメインを覚え、枠を描き直す)。 */
function ownDomainSaved(value: string): void {
  ownDomainWatch?.onSaved(value);
}

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

async function mountOwnDomain(
  defaultDomain: string,
  savedDomain: string,
): Promise<void> {
  const panel = byId("ownDomainPanel");
  if (!panel) return;
  panel.style.display = "";
  // 向け先は導入口が返す。準備する前は、委託のアドレス({導入ID}.kurocms.site)のホスト名を出す。
  const fallbackTarget = hostOfDomainInput(defaultDomain);
  let savedValue = savedDomain;
  let savedHost = hostOfDomainInput(savedDomain);
  let dns: "cloudflare" | "other" = "cloudflare";
  let domain: OwnDomain | null = null;
  let busy = false;
  const watch = () => {
    ownDomainWatch = {
      fallbackHost: fallbackTarget,
      savedHost,
      domain,
      onSaved: (value) => {
        savedValue = value;
        savedHost = hostOfDomainInput(value);
        render();
      },
    };
  };

  const pill = (ok: boolean, text: string) =>
    "<span class='badge' style='" +
    (ok ? "" : "background:var(--surface-2);color:var(--muted)") +
    "'>" +
    escapeHtml(text) +
    "</span>";

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

  /** 欄に入れるときの形(上の公開ドメインの欄と同じ https://…/)。 */
  const asUrl = (host: string) => "https://" + host + "/";

  /**
   * 上の公開ドメインの欄と「サイト設定を保存」を、準備したドメインに合わせる(2026-10-29 利用者の指示)。
   * 準備した後は欄をそのドメインで読み取りだけにし、保存は 5 段目(有効になって、まだ保存していない)の
   * 間だけ押せる。取り消すと元に戻す —— 欄が 2 つの値を持たないように。
   */
  function syncField(locked: boolean, saveOpen: boolean) {
    const input = byId("publicDomain") as HTMLInputElement | null;
    const save = byId("saveSiteBtn") as HTMLButtonElement | null;
    const reset = byId("resetPublicDomainBtn");
    const help = byId("publicDomainHelpText");
    if (!input) return;
    const want = locked && domain ? asUrl(domain.hostname) : null;
    if (want !== null && input.value !== want) {
      input.value = want;
      input.dispatchEvent(new Event("input"));
    }
    input.readOnly = locked;
    if (save) save.disabled = locked && !saveOpen;
    // 既定値に戻すのボタンは、戻す先が分かるとき(settings.ts が data-available を付ける)だけ出す。
    if (reset)
      reset.style.display = !locked && reset.dataset.available ? "" : "none";
    if (help)
      help.textContent = locked
        ? t("publicDomainLockedHelp").replace("{url}", asUrl(fallbackTarget))
        : t("publicDomainManagedHelp");
  }

  function render() {
    watch();
    const target = domain?.target || fallbackTarget;
    const cf = dns === "cloudflare";
    const d = domain;
    const certOk = d?.sslStatus === "active";
    const hostOk = d?.status === "active";
    const switched = !!d?.switched;
    // 5 段目: このドメインを公開ドメインとして保存したか。
    const pubOk = !!d && hostOk && savedHost === d.hostname;
    // どの段が済んだか。最初の済んでいない段が「今ここ」。
    const done = [!!d, certOk, switched, hostOk, pubOk];
    const cur = done.indexOf(false);
    syncField(!!d, cur === 4);
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
        escapeHtml(asUrl(d.hostname)) +
        "</b><button type='button' class='secondary' id='ownDomainRemoveBtn' style='font-size:12px;padding:4px 10px'>" +
        escapeHtml(t("ownDomainRemove")) +
        "</button></div>"
      : "<div><button type='button' id='ownDomainPrepareBtn'>" +
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
      })) as { domain: OwnDomain | null; publicDomain?: string };
      domain = res.domain;
      if (action === "remove") {
        // 取り消したドメインが公開ドメインなら、サーバーが既定へ戻している。欄は保存した値へ戻す。
        if (res.publicDomain) {
          savedValue = res.publicDomain;
          savedHost = hostOfDomainInput(res.publicDomain);
          toast(
            t("ownDomainRemovedReset").replace("{url}", res.publicDomain),
            false,
            btn || undefined,
          );
        }
        const input = byId("publicDomain") as HTMLInputElement | null;
        if (input) {
          input.value = savedValue;
          input.dispatchEvent(new Event("input"));
        }
      }
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
      // 上の公開ドメインの欄から読む(保存はしない)。
      const host = hostOfDomainInput(
        (byId("publicDomain") as HTMLInputElement | null)?.value || "",
      );
      if (!host || host === fallbackTarget) {
        toast(t("ownDomainNeedHost"), true, e.currentTarget);
        byId("publicDomain")?.focus();
        return;
      }
      void call("prepare", host, e.currentTarget);
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
