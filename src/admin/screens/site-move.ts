// KuroCMS admin screen module. Concatenated by scripts/build-admin.js.
//
// 運用の形(仕様 cms-move-to-self「CMS の画面から」・2026-10-21)。設定の専用のタブ(「基本」の隣)に置く枠。
// いま委託運用で動いていれば「ご自身の Cloudflare アカウントへ引っ越す」、顧客導入で動いていれば
// 「Entamy の委託運用へ引っ越す」だけを出す(トグルのように片方)。LP と導入口の頁は、まだ CMS を
// 持っていない人のためのもので、運用中の人は確かめ・Cloudflare の欄・進み具合・再開までこの枠で済ませる。
//
// 頼むのはサーバー(/api/system/site-move・src/site-move.ts)。進み具合は導入口から直に読む ——
// 委託のアドレスは最後に案内へ替わるので、サーバーを通すと結果を見届けられない。

const SITE_MOVE_POLL_MS = 3000;
// 番人(WorkerOps)の鍵は、顧客導入へ移るときにこの端末で作り、終わるまでこの端末にだけ覚える
// (引っ越しの結果には載らない。閉じても控え直せるように)。
const SITE_MOVE_OPS_KEY = "kurocms_site_move_ops";

/** 版 a が b より古いか(major.minor.patch)。読めない版は古いと見る。 */
function siteMoveOlder(a: string, b: string): boolean {
  const p = (v: string) =>
    /^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : null;
  const x = p(a);
  const y = p(b);
  if (!y) return false;
  if (!x) return true;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]!;
  return false;
}

function siteMoveSectionHtml(): string {
  return (
    "<div id='siteMoveSection' class='panel stack' style='display:none'>" +
    // 持ち主(連絡先)。導入口より前の導入は、ここで結んでから引っ越す(renderContactPanel)。
    "<div id='contactPanel' class='stack' style='gap:8px;padding-bottom:16px;border-bottom:1px solid var(--line)'></div>" +
    // 見出しはタブが言うので置かない(SNS のタブと同じ)。いまの形を最初の行に。
    "<div id='siteMoveNow' style='font-weight:700'></div>" +
    "<div class='muted' id='siteMoveNote' style='display:none'></div>" +
    "<div><button type='button' class='secondary' id='siteMoveOpen'></button></div>" +
    "<div id='siteMoveForm' class='stack' style='display:none'>" +
    "<div class='muted' id='siteMoveLead'></div>" +
    "<div class='muted' id='siteMovePrice' style='display:none'></div>" +
    "<div id='siteMoveCf' class='stack' style='display:none'>" +
    "<label>" +
    escapeHtml(t("siteMoveAccountId")) +
    "<input id='siteMoveAccountId' autocomplete='off' maxlength='32' placeholder='0123456789abcdef0123456789abcdef' /></label>" +
    "<label>" +
    escapeHtml(t("siteMoveToken")) +
    "<div class='muted'>" +
    escapeHtml(t("siteMoveTokenHelp")) +
    "</div><input id='siteMoveToken' type='password' autocomplete='off' /></label>" +
    "</div>" +
    "<div class='toggleRow'><div><b>" +
    escapeHtml(t("siteMoveConfirm")) +
    "</b></div><input id='siteMoveConfirm' type='checkbox' class='toggle' /></div>" +
    "<div class='toolbar' style='gap:8px'>" +
    "<button type='button' id='siteMoveStart'>" +
    escapeHtml(t("siteMoveStart")) +
    "</button>" +
    "<button type='button' class='secondary' id='siteMoveCancel'>" +
    escapeHtml(t("cancel")) +
    "</button></div>" +
    "</div>" +
    "<div id='siteMoveProgress' class='stack' style='display:none'>" +
    "<div><b id='siteMoveState'></b></div>" +
    "<div style='height:8px;border-radius:4px;background:var(--surface-2);overflow:hidden'>" +
    "<div id='siteMoveBar' style='height:100%;width:0;background:var(--theme-accent,#0f766e);transition:width .4s'></div></div>" +
    "<ol id='siteMoveSteps' class='muted' style='margin:0;padding-left:20px;font-size:13px;display:grid;gap:2px'></ol>" +
    "<div id='siteMoveOps' style='display:none'></div>" +
    "<div id='siteMoveResult'></div>" +
    "</div>" +
    "</div>"
  );
}

function siteMoveToken(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(36));
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  return (
    prefix +
    btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  );
}

function siteMoveRemembered(): string {
  try {
    return localStorage.getItem(SITE_MOVE_OPS_KEY) || "";
  } catch {
    return "";
  }
}

function siteMoveRemember(value: string | null): void {
  try {
    if (value) localStorage.setItem(SITE_MOVE_OPS_KEY, value);
    else localStorage.removeItem(SITE_MOVE_OPS_KEY);
  } catch {
    /* 覚えられなくても、画面に出ている間に控えられる */
  }
}

async function mountSiteMove(): Promise<void> {
  const box = byId("siteMoveSection");
  if (!box) return;
  let info: Dynamic;
  try {
    info = await api("/api/system/site-move");
  } catch {
    // 管理者でない・古いサーバー。タブごと出さない。
    box.remove();
    byId("siteMoveTabBtn")?.remove();
    return;
  }
  box.style.display = "";
  void renderContactPanel(byId("contactPanel"));
  const toSelf = info.to === "self";
  const now = byId("siteMoveNow")!;
  const note = byId("siteMoveNote")!;
  const open = byId("siteMoveOpen") as Dynamic;
  const form = byId("siteMoveForm")!;
  const progress = byId("siteMoveProgress")!;
  now.textContent = t(toSelf ? "siteMoveNowManaged" : "siteMoveNowSelf");
  open.textContent = t(toSelf ? "siteMoveToSelf" : "siteMoveToManaged");
  byId("siteMoveLead")!.textContent = t(
    toSelf ? "siteMoveSelfLead" : "siteMoveManagedLead",
  );
  const price = byId("siteMovePrice")!;
  if (!toSelf) {
    price.style.display = "";
    price.textContent = t("siteMoveManagedPrice");
  }
  byId("siteMoveCf")!.style.display = toSelf ? "" : "none";
  // 持ち主が分からなければ、先に持ち主の登録(確認メール 1 通)。結ばれたら枠を描き直す。
  let needOwner = false;
  if (info.owner === null) {
    needOwner = true;
    note.style.display = "";
    note.textContent = t("siteMoveNeedOwner");
    open.textContent = t("siteMoveRegisterOwner");
  } else if (info.owner === "unknown") {
    note.style.display = "";
    note.textContent = t("siteMoveOwnerUnavailable");
    open.disabled = true;
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  // 引っ越しを受ける版の下限(導入口が持つ)。足りなければ、押したときに先に更新を求める。
  const tooOld =
    typeof info.minVersion === "string" &&
    siteMoveOlder(String(info.version || ""), info.minVersion);
  open.addEventListener("click", () => {
    if (tooOld) {
      const msg = t("siteMoveNeedUpdate")
        .replace("{min}", info.minVersion)
        .replace("{now}", String(info.version || ""));
      note.style.display = "";
      note.textContent = msg;
      toast(msg, true);
      return;
    }
    if (needOwner) {
      openContactDialog(
        { state: "none" },
        { prompt: false, onClose: () => void refreshSiteMove() },
      );
      return;
    }
    form.style.display = "";
    open.style.display = "none";
  });
  byId("siteMoveCancel")!.addEventListener("click", () => {
    form.style.display = "none";
    open.style.display = "";
  });

  function showOps(key: string) {
    const ops = byId("siteMoveOps")!;
    if (!key) {
      ops.style.display = "none";
      return;
    }
    ops.style.display = "";
    ops.innerHTML =
      "<div class='fieldLabel'>" +
      escapeHtml(t("siteMoveOpsKey")) +
      "</div><code style='display:block;padding:8px 10px;background:var(--surface-2);border-radius:8px;font-size:12px;word-break:break-all'>" +
      escapeHtml(key) +
      "</code><div class='muted' style='font-size:12px;margin-top:4px'>" +
      escapeHtml(t("siteMoveOpsKeyNote")) +
      "</div>";
  }

  function stepLabel(id: string, managedTarget: boolean): string {
    const managedKey = "siteMoveStepManaged_" + id;
    if (managedTarget && t(managedKey) !== managedKey) return t(managedKey);
    const key = "siteMoveStep_" + id;
    return t(key) !== key ? t(key) : id;
  }

  function render(job: Dynamic) {
    progress.style.display = "";
    form.style.display = "none";
    open.style.display = "none";
    const pct = Math.max(0, Math.min(100, Number(job.progress) || 0));
    byId("siteMoveBar")!.style.width = pct + "%";
    const managedTarget = job.mode === "managed";
    const steps = byId("siteMoveSteps")!;
    steps.innerHTML = (job.steps || [])
      .map((s: Dynamic) => {
        const mark =
          s.status === "done"
            ? "✓ "
            : s.status === "running"
              ? "… "
              : s.status === "error"
                ? "✕ "
                : "";
        const style =
          s.status === "running"
            ? " style='color:var(--ink);font-weight:700'"
            : s.status === "error"
              ? " style='color:var(--danger)'"
              : "";
        return (
          "<li" +
          style +
          ">" +
          mark +
          escapeHtml(stepLabel(String(s.id), managedTarget)) +
          "</li>"
        );
      })
      .join("");
    const state = byId("siteMoveState")!;
    const result = byId("siteMoveResult")!;
    result.innerHTML = "";
    if (job.status === "running") {
      state.textContent = t("siteMoveRunning").replace("{p}", String(pct));
      return;
    }
    stop();
    if (job.status === "error") {
      state.textContent = t("siteMoveFailed");
      if (job.move?.resumable) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = t("siteMoveResume");
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            await api("/api/system/site-move/resume", {
              method: "POST",
              body: "{}",
            });
            follow(statusUrl);
          } catch (err) {
            btn.disabled = false;
            toast(errorMessage(err), true);
          }
        });
        result.appendChild(btn);
      } else {
        // 写し始める前に止まった(鍵・権限・空きなど)。やり直せるように枠を戻す。
        const again = document.createElement("button");
        again.type = "button";
        again.className = "secondary";
        again.textContent = t("siteMoveAgain");
        again.addEventListener("click", async () => {
          await api("/api/system/site-move", { method: "DELETE" }).catch(
            () => {},
          );
          siteMoveRemember(null);
          showOps("");
          progress.style.display = "none";
          open.style.display = "";
        });
        result.appendChild(again);
      }
      return;
    }
    if (job.status === "done" && job.result) {
      state.textContent = t("siteMoveDone");
      const url = String(job.result.publicUrl || "");
      const p = document.createElement("div");
      p.className = "stack";
      p.style.gap = "6px";
      p.innerHTML =
        "<div>" +
        escapeHtml(
          t("siteMoveMailed").replace("{n}", String(job.result.mailed ?? 0)),
        ) +
        "</div><div>" +
        escapeHtml(t("siteMoveNewAddress")) +
        ": <a target='_blank' rel='noopener' href='" +
        escapeHtml(url) +
        "'>" +
        escapeHtml(url) +
        "</a></div><div><a target='_blank' rel='noopener' href='" +
        escapeHtml(url + "/kurocms/admin") +
        "'>" +
        escapeHtml(t("siteMoveOpenAdmin")) +
        " →</a></div>";
      result.appendChild(p);
    }
  }

  let statusUrl = "";
  async function poll() {
    try {
      const res = await fetch(statusUrl, { cache: "no-store" });
      if (!res.ok) return;
      render(await res.json());
    } catch {
      /* 一時的に読めないだけなら、次の回に読む */
    }
  }
  function follow(url: string) {
    statusUrl = url;
    stop();
    void poll();
    timer = setInterval(poll, SITE_MOVE_POLL_MS);
  }

  byId("siteMoveStart")!.addEventListener("click", async () => {
    const confirmBox = byId("siteMoveConfirm") as Dynamic;
    if (!confirmBox.checked) {
      toast(t("siteMoveConfirmRequired"), true);
      return;
    }
    const body: Record<string, string> = {
      lang: state.uiLang,
      // 自分の引っ越しの口(導入口より前の導入は、導入口の記録にアドレスが無い)。
      api: location.origin + withBase("/api/system/move/"),
      timeZone: detectBrowserTimezone(),
    };
    let opsKey = "";
    if (toSelf) {
      const accountId = (byId("siteMoveAccountId") as Dynamic).value.trim();
      const token = (byId("siteMoveToken") as Dynamic).value.trim();
      if (!/^[a-f0-9]{32}$/i.test(accountId) || token.length < 20) {
        toast(t("siteMoveCfRequired"), true);
        return;
      }
      opsKey = siteMoveToken("wops_");
      Object.assign(body, { accountId, token, workerOpsToken: opsKey });
    }
    const btn = byId("siteMoveStart") as Dynamic;
    btn.disabled = true;
    try {
      const job: Dynamic = await api("/api/system/site-move", {
        method: "POST",
        body: JSON.stringify(body),
      });
      (byId("siteMoveToken") as Dynamic).value = "";
      if (opsKey) {
        siteMoveRemember(opsKey);
        showOps(opsKey);
      }
      follow(job.statusUrl);
    } catch (err) {
      toast(errorMessage(err), true);
    } finally {
      btn.disabled = false;
    }
  });

  if (info.job?.statusUrl) {
    showOps(info.job.to === "self" ? siteMoveRemembered() : "");
    follow(info.job.statusUrl);
  }
}

/** 枠を描き直す(持ち主を結んだ後など)。 */
async function refreshSiteMove(): Promise<void> {
  const box = byId("siteMoveSection");
  if (!box) return;
  box.outerHTML = siteMoveSectionHtml();
  await mountSiteMove();
}
