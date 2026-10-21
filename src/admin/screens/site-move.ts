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
    // 走っている間・止まった後は、この 1 行と「進み具合を見る」だけを枠に残す(中身はダイアログ)。
    "<div id='siteMoveInline' class='toolbar' style='display:none;gap:12px;align-items:center'>" +
    "<b id='siteMoveInlineState'></b>" +
    "<button type='button' class='secondary' id='siteMoveShow'>" +
    escapeHtml(t("siteMoveShow")) +
    "</button></div>" +
    "</div>"
  );
}

/** 引っ越しのダイアログ。確かめ・Cloudflare の欄・作業の工程・進み具合を 1 枚で見せる。 */
function siteMoveDialogHtml(toSelf: boolean): string {
  return (
    "<div class='popupCard stack' role='dialog' aria-modal='true' aria-live='polite' style='width:min(640px,94vw);max-height:90vh;overflow:auto'>" +
    "<h3 class='popupTitle'>" +
    escapeHtml(t(toSelf ? "siteMoveToSelf" : "siteMoveToManaged")) +
    "</h3>" +
    "<div id='siteMoveForm' class='stack'>" +
    "<div class='muted'>" +
    escapeHtml(t(toSelf ? "siteMoveSelfLead" : "siteMoveManagedLead")) +
    "</div>" +
    (toSelf
      ? ""
      : "<div class='muted'>" +
        escapeHtml(t("siteMoveManagedPrice")) +
        "</div>") +
    (toSelf
      ? "<div class='stack'><label>" +
        escapeHtml(t("siteMoveAccountId")) +
        "<input id='siteMoveAccountId' autocomplete='off' maxlength='32' placeholder='0123456789abcdef0123456789abcdef' /></label>" +
        "<label>" +
        escapeHtml(t("siteMoveToken")) +
        "<div class='muted'>" +
        escapeHtml(t("siteMoveTokenHelp")) +
        "</div><input id='siteMoveToken' type='password' autocomplete='off' /></label></div>"
      : "") +
    "</div>" +
    "<div id='siteMoveProgress' class='stack' style='display:none'>" +
    "<div><b id='siteMoveState'></b></div>" +
    "<div style='height:8px;border-radius:4px;background:var(--surface-2);overflow:hidden'>" +
    "<div id='siteMoveBar' style='height:100%;width:0;background:var(--theme-accent,#0f766e);transition:width .4s'></div></div>" +
    "</div>" +
    // 工程は始める前から見せる(何が起きるかを先に分かるように)。始めたら印が付いていく。
    "<div class='fieldLabel'>" +
    escapeHtml(t("siteMoveStepsTitle")) +
    "</div>" +
    "<ol id='siteMoveSteps' class='muted' style='margin:0;padding-left:20px;font-size:13px;display:grid;gap:2px'></ol>" +
    "<div id='siteMoveOps' style='display:none'></div>" +
    "<div id='siteMoveResult'></div>" +
    "<div id='siteMoveConfirmRow' class='toggleRow'><div><b>" +
    escapeHtml(t("siteMoveConfirm")) +
    "</b></div><input id='siteMoveConfirm' type='checkbox' class='toggle' /></div>" +
    "<p class='muted' id='siteMoveCloseNote' style='display:none;font-size:12px;margin:0'>" +
    escapeHtml(t("siteMoveCloseNote")) +
    "</p>" +
    "<div class='toolbar' style='gap:8px;justify-content:flex-end'>" +
    "<button type='button' class='secondary' id='siteMoveCancel'>" +
    escapeHtml(t("cancel")) +
    "</button>" +
    "<button type='button' id='siteMoveStart'>" +
    escapeHtml(t("siteMoveStart")) +
    "</button></div>" +
    "</div>"
  );
}

/** 導入口の工程の順(deployer.ts の STEPS と move.ts の MOVE_STEPS)。始める前の一覧に使う。 */
const SITE_MOVE_STEP_KEYS = [
  "verify_token",
  "reserve_names",
  "create_storage",
  "fetch_release",
  "deploy_app",
  "apply_schema",
  "bootstrap_admin",
  "create_update_token",
  "deploy_workerops",
  "finish",
  "move_copy",
  "move_media",
  "move_build",
  "move_check",
  "move_finish",
];

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
  const inline = byId("siteMoveInline")!;
  const inlineState = byId("siteMoveInlineState")!;
  now.textContent = t(toSelf ? "siteMoveNowManaged" : "siteMoveNowSelf");
  open.textContent = t(toSelf ? "siteMoveToSelf" : "siteMoveToManaged");
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
  // 始めた後の工程(導入口が返す最新)。ダイアログを開き直したときに描き直す。
  let lastJob: Dynamic = null;
  let opsKey = "";

  // ダイアログ。閉じても引っ越しは導入口で続き、枠の 1 行が進み具合を追う。
  let overlay: HTMLDivElement | null = null;
  function closeDialog() {
    overlay?.remove();
    overlay = null;
    // 走っていないなら、もう追う必要はない(枠のボタンから開き直せる)。
    if (!lastJob) stop();
  }
  function openDialog() {
    closeDialog();
    overlay = createPopupBackdrop();
    overlay.id = "siteMoveOverlay";
    overlay.innerHTML = siteMoveDialogHtml(toSelf);
    document.body.appendChild(overlay);
    byId("siteMoveCancel")!.addEventListener("click", closeDialog);
    byId("siteMoveStart")!.addEventListener("click", () => void start());
    if (lastJob) {
      showOps(opsKey);
      render(lastJob);
    } else {
      // 始める前: 工程を並べて見せる(印なし)。
      paintSteps(
        SITE_MOVE_STEP_KEYS.map((key) => ({ key, status: "pending" })),
        !toSelf,
      );
    }
  }

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
    openDialog();
  });
  byId("siteMoveShow")!.addEventListener("click", openDialog);

  function showOps(key: string) {
    const ops = byId("siteMoveOps");
    if (!ops) return;
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

  function stepLabel(key: string, managedTarget: boolean): string {
    const managedKey = "siteMoveStepManaged_" + key;
    if (managedTarget && t(managedKey) !== managedKey) return t(managedKey);
    const k = "siteMoveStep_" + key;
    return t(k) !== k ? t(k) : key;
  }

  function paintSteps(list: Dynamic[], managedTarget: boolean) {
    const steps = byId("siteMoveSteps");
    if (!steps) return;
    steps.innerHTML = list
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
        // 導入口の工程は key で来る(古い形は id)。
        const key = String(s.key ?? s.id ?? "");
        return (
          "<li" +
          style +
          ">" +
          mark +
          escapeHtml(stepLabel(key, managedTarget)) +
          "</li>"
        );
      })
      .join("");
  }

  function paintInline(text: string) {
    open.style.display = "none";
    inline.style.display = "";
    inlineState.textContent = text;
  }

  function render(job: Dynamic) {
    lastJob = job;
    const pct = Math.max(0, Math.min(100, Number(job.progress) || 0));
    const running = job.status === "running";
    const stateText = running
      ? t("siteMoveRunning").replace("{p}", String(pct))
      : job.status === "error"
        ? t("siteMoveFailed")
        : t("siteMoveDone");
    paintInline(stateText);
    if (!running) stop();
    if (!overlay) return;
    byId("siteMoveForm")!.style.display = "none";
    byId("siteMoveConfirmRow")!.style.display = "none";
    byId("siteMoveStart")!.style.display = "none";
    byId("siteMoveCancel")!.textContent = t("close");
    byId("siteMoveCloseNote")!.style.display = running ? "" : "none";
    byId("siteMoveProgress")!.style.display = "";
    byId("siteMoveBar")!.style.width = pct + "%";
    byId("siteMoveState")!.textContent = stateText;
    paintSteps(job.steps || [], job.mode === "managed");
    const result = byId("siteMoveResult")!;
    result.innerHTML = "";
    if (running) return;
    if (job.status === "error") {
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
        // 写し始める前に止まった(鍵・権限・空きなど)。やり直せるように最初の形へ戻す。
        const again = document.createElement("button");
        again.type = "button";
        again.className = "secondary";
        again.textContent = t("siteMoveAgain");
        again.addEventListener("click", async () => {
          await api("/api/system/site-move", { method: "DELETE" }).catch(
            () => {},
          );
          siteMoveRemember(null);
          opsKey = "";
          lastJob = null;
          inline.style.display = "none";
          open.style.display = "";
          openDialog();
        });
        result.appendChild(again);
      }
      return;
    }
    if (job.status === "done" && job.result) {
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

  async function start() {
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
    let key = "";
    if (toSelf) {
      const accountId = (byId("siteMoveAccountId") as Dynamic).value.trim();
      const token = (byId("siteMoveToken") as Dynamic).value.trim();
      if (!/^[a-f0-9]{32}$/i.test(accountId) || token.length < 20) {
        toast(t("siteMoveCfRequired"), true);
        return;
      }
      key = siteMoveToken("wops_");
      Object.assign(body, { accountId, token, workerOpsToken: key });
    }
    const btn = byId("siteMoveStart") as Dynamic;
    btn.disabled = true;
    try {
      const job: Dynamic = await api("/api/system/site-move", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const tokenInput = byId("siteMoveToken") as Dynamic;
      if (tokenInput) tokenInput.value = "";
      if (key) {
        opsKey = key;
        siteMoveRemember(key);
        showOps(key);
      }
      // 最初の読み取りまでの間も、ダイアログは進み具合の形にしておく。
      render({
        status: "running",
        progress: 0,
        mode: toSelf ? "self" : "managed",
        steps: SITE_MOVE_STEP_KEYS.map((k) => ({ key: k, status: "pending" })),
      });
      follow(job.statusUrl);
    } catch (err) {
      toast(errorMessage(err), true);
    } finally {
      btn.disabled = false;
    }
  }

  if (info.job?.statusUrl) {
    opsKey = info.job.to === "self" ? siteMoveRemembered() : "";
    paintInline(t("siteMoveRunning").replace("{p}", "0"));
    follow(info.job.statusUrl);
  }
}

/** 枠を描き直す(持ち主を結んだ後など)。 */
async function refreshSiteMove(): Promise<void> {
  const box = byId("siteMoveSection");
  if (!box) return;
  byId("siteMoveOverlay")?.remove();
  box.outerHTML = siteMoveSectionHtml();
  await mountSiteMove();
}
