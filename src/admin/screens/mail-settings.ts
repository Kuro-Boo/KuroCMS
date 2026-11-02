// KuroCMS admin screen module. Concatenated by scripts/build-admin.js.
//
// メール送信(設定の「メール送信」のタブ・2026-10-21 にプロフィールから移した)。どの経路で送るかはサイト全体の
// 設定で、変えられるのは管理者だけ —— 一人ひとりのプロフィールに置くと、管理者でない人にも見え、どこで決まって
// いるのかが分からない。経路: 自分のドメイン(Cloudflare Email Routing)を先に試し、送れなければ黒兎のサーバー
// (Entamy Mailer)が代わりに送る(sendMail・api.ts)。委託運用は Entamy が送るのでタブを出さない。

function mailSettingsPanelHtml(): string {
  // 3 つの枠(2026-11-02 に作り直した): ① いまの送り方と切り替え ② 設定の状態 ③ 自分のドメインから送る手順。
  // 前は長い説明が 3 段続き、手順は畳まれ、切り替えは一番下で、何を見て何をするかが分かりにくかった。
  return (
    "<div id='panel-mail' class='settingsPanel' style='display:none'>" +
    "<div class='stack' id='mailDeliveryBox' style='gap:20px'>" +
    // ① いまの送り方と切り替え
    "<div class='panel stack' style='gap:12px'>" +
    "<div style='display:flex;align-items:flex-start;gap:20px'>" +
    "<div style='flex:1 1 auto;min-width:0'>" +
    "<div class='muted' style='font-size:12px;font-weight:700'>" +
    escapeHtml(t("mailNowTitle")) +
    "</div>" +
    "<div id='mailNowValue' style='font-size:20px;font-weight:800;margin-top:4px'>-</div>" +
    "<div class='tokenMeta' style='white-space:normal;margin-top:8px'>" +
    escapeHtml(t("mailDeliveryLead")) +
    "</div>" +
    "</div>" +
    "<label style='flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-end;gap:8px;margin:0'>" +
    "<span style='font-size:12px;font-weight:700;white-space:nowrap'>" +
    escapeHtml(t("mailDeliveryToggle")) +
    "</span>" +
    "<input id='mailRoutingToggle' type='checkbox' class='toggle' disabled />" +
    "</label>" +
    "</div>" +
    "<div id='mailDeliveryManageHelp' class='tokenMeta'></div>" +
    "<div id='mailAlerts' class='stack' style='gap:8px'></div>" +
    "</div>" +
    // ② 設定の状態
    "<div class='panel stack' style='gap:12px'>" +
    "<div class='fieldLabel' style='margin:0'>" +
    escapeHtml(t("mailStateTitle")) +
    "</div>" +
    "<div id='mailDeliveryStatus' style='display:grid;grid-template-columns:max-content minmax(0,1fr);gap:10px 20px;font-size:13px'>-</div>" +
    "</div>" +
    // ③ 自分のドメインから送る手順(畳まない)
    // ⚠ 設定は **Cloudflare 側でしか行えない**(宛先の verify も Email Routing の有効化も CMS からは実行できない)。
    "<div class='panel stack' id='mailSetupGuide' style='gap:14px'>" +
    "<div class='fieldLabel' style='margin:0'>" +
    escapeHtml(t("mailSetupGuideTitle")) +
    "</div>" +
    "<div class='tokenMeta' style='white-space:normal'>" +
    escapeHtml(t("mailSetupGuideIntro")) +
    "</div>" +
    "<div id='mailSetupGuideBody' class='stack' style='gap:16px'></div>" +
    "</div>" +
    "</div>" +
    "</div>"
  );
}

/** 設定を読めなかった理由を、次に何をすればよいかが分かる文にする(生の英語のエラーを出さない)。 */
function mailReasonText(reason: string): string {
  if (/cf_creds_missing|credentials are not configured/i.test(reason))
    return t("mailDeliveryCfMissing");
  if (/auth|token|permission|forbidden|10000|9109/i.test(reason))
    return t("mailDeliveryCfAuth");
  return t("mailDeliveryUnavailable") + ": " + reason;
}

/** 直近の送信がどの経路で届いたか(代わりに送った・送れなかった、を黙らない)。 */
function mailLastStatusHtml(last: Dynamic): string {
  if (!last || !last.at) return "";
  const when = formatDateTime(new Date(Number(last.at)).toISOString());
  const text =
    last.path === "routing"
      ? t("mailLastRouting")
      : last.path === "entamy"
        ? last.relayed
          ? t("mailLastRelayed")
          : t("mailLastKuro")
        : t("mailLastFailed");
  const bad = !last.path || last.relayed;
  return (
    "<div style='margin-top:4px" +
    (bad ? ";color:var(--danger,#b42318)" : "") +
    "'><b>" +
    escapeHtml(t("mailLastTitle")) +
    ":</b> " +
    escapeHtml(text + "（" + when + "）") +
    "</div>"
  );
}

function renderMailSettings(data: Dynamic) {
  const status = byId("mailDeliveryStatus");
  const toggle = byId("mailRoutingToggle");
  const help = byId("mailDeliveryManageHelp");
  const now = byId("mailNowValue");
  const alerts = byId("mailAlerts");
  if (!status || !toggle || !help) return;

  if (now)
    now.textContent = data.enabled
      ? t("mailDeliveryCustom")
      : t("mailDeliveryKuro");
  const domains = (data.domains || [])
    .map((domain: Dynamic) => domain.hostname || "")
    .filter(Boolean)
    .join(", ");
  // 済んでいる = ✅、足りない = ⚠、確かめられない = ?(「無効」と見せない)。
  const chip = (state: "ok" | "ng" | "unknown", text: string) =>
    "<span style='font-weight:700;color:" +
    (state === "ok"
      ? "var(--accent)"
      : state === "ng"
        ? "var(--danger,#b42318)"
        : "var(--muted)") +
    "'>" +
    (state === "ok" ? "✅ " : state === "ng" ? "⚠ " : "? ") +
    escapeHtml(text) +
    "</span>";
  const row = (label: string, value: string) =>
    "<div class='muted' style='font-weight:700'>" +
    escapeHtml(label) +
    "</div><div style='min-width:0;overflow-wrap:anywhere'>" +
    value +
    "</div>";
  // ⚠ 宛先の verify は**アカウント単位**、Email Routing の有効化は **zone 単位**。片方だけでは送れないので両方出す。
  status.innerHTML =
    row(t("mailDeliverySender"), escapeHtml(data.senderAddress || "-")) +
    row(t("mailDeliveryDomain"), escapeHtml(domains || "-")) +
    row(
      t("mailDeliveryZoneLabel"),
      data.senderZoneEnabled === true
        ? chip("ok", t("mailDeliveryZoneStateOn"))
        : data.senderZoneEnabled === false
          ? chip("ng", t("mailDeliveryZoneOff"))
          : chip("unknown", t("mailDeliveryZoneUnknown")),
    ) +
    row(
      t("mailDeliveryDestination"),
      escapeHtml(data.destination || "-") +
        " " +
        (data.destinationVerified
          ? chip("ok", t("mailDeliveryVerified"))
          : chip("ng", t("mailDeliveryUnverified"))),
    );
  // 気をつけること(未認証の管理者・読めなかった理由)と、最後のメールの結果。
  const warn = (text: string) =>
    "<div style='color:var(--danger,#b42318);font-size:13px'>⚠ " +
    escapeHtml(text) +
    "</div>";
  if (alerts)
    alerts.innerHTML =
      // 復旧メールは要求した本人へ送るので、他の管理者が未 verified だとその人だけ無言で締め出される。
      ((data.unverifiedAdmins || []).length > 0
        ? warn(
            t("mailDeliveryAdminsUnverified") +
              ": " +
              (data.unverifiedAdmins || []).join(", "),
          )
        : "") +
      (!data.available && data.reason
        ? warn(mailReasonText(String(data.reason)))
        : "") +
      mailLastStatusHtml(data.lastStatus);
  toggle.checked = Boolean(data.enabled);
  toggle.disabled = !data.canManage || (!data.enabled && !data.canEnable);
  help.textContent = data.canManage ? "" : t("mailDeliveryAdminOnly");
  renderMailSetupGuide(data);
}

/**
 * 自ドメイン送信の設定手順。
 *
 * ⚠ **済んだ手順にも印を付ける。** どこで止まっているのかが分からないと、
 *   トグルが押せない理由を探して Cloudflare 中をさまようことになる。
 *   verify すべきアドレスは**この画面のプロフィールのメールアドレス**であって、
 *   ドメインに紐づく適当なアドレスではない（復旧メールは本人へ送るため）。
 */
function renderMailSetupGuide(data: Dynamic) {
  const body = byId("mailSetupGuideBody");
  if (!body) return;
  const zone =
    ((data.domains || [])[0] || {}).zoneName ||
    String(data.senderAddress || "").split("@")[1] ||
    "";
  // ⚠ **zone 配下ではない。** 宛先アドレスはアカウント単位で共有され
  //   （同じアカウントのどのドメインでも使い回せる）、現在の入口は
  //   Compute → Email Service → Email Routing。zone を差し込んだ URL
  //   （/:account/<zone>/email/routing）は宛先の画面に着かない。
  //   ドメインは、この画面に入ってから選ぶ。
  const dash =
    "https://dash.cloudflare.com/?to=/:account/email-service/routing";
  // 番号の丸(済んだ手順は ✓)と、短い題・説明。
  let n = 0;
  const step = (done: boolean, title: string, desc: string) => {
    n += 1;
    return (
      "<div style='display:flex;gap:12px;align-items:flex-start'>" +
      "<div style='flex:0 0 26px;height:26px;border-radius:999px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;" +
      (done
        ? "background:var(--accent-soft);color:var(--accent)"
        : "background:var(--surface-2);color:var(--muted);border:1px solid var(--line)") +
      "'>" +
      (done ? "✓" : String(n)) +
      "</div>" +
      "<div style='min-width:0'><div style='font-weight:700'>" +
      escapeHtml(title) +
      "</div><div class='tokenMeta' style='white-space:normal;margin-top:2px'>" +
      escapeHtml(desc) +
      "</div></div></div>"
    );
  };
  body.innerHTML =
    step(
      data.senderZoneEnabled === true,
      t("mailSetupStep1"),
      t("mailSetupStep1Body").replace("{zone}", zone || "-"),
    ) +
    step(
      // ⚠ **自分が verified でも足りない。** 管理者が複数いるなら全員分が要る。
      //   誰か 1 人でも未 verified だと、その人だけ復旧メールが届かず、
      //   自分の画面は緑のまま相手が締め出される。
      Boolean(data.destinationVerified) &&
        (data.unverifiedAdmins || []).length === 0,
      t("mailSetupStep2"),
      t("mailSetupStep2Body").replace(
        "{address}",
        // 本人のアドレスと、未 verified の管理者を重複なく並べる。
        // そのまま Cloudflare に貼れる形で出す。
        Array.from(
          new Set(
            [data.destination as string]
              .concat(data.unverifiedAdmins || [])
              .filter(Boolean),
          ),
        ).join(", ") || "-",
      ),
    ) +
    step(Boolean(data.enabled), t("mailSetupStep3"), t("mailSetupStep3Body")) +
    "<div style='display:flex;gap:16px 20px;flex-wrap:wrap;margin-top:8px'>" +
    "<a class='secondary' target='_blank' rel='noopener' href='" +
    escapeHtml(dash) +
    "' style='font-size:12px;padding:6px 14px;text-decoration:none'>" +
    escapeHtml(t("mailSetupOpenCf")) +
    "</a>" +
    "<a class='secondary' target='_blank' rel='noopener' href='https://developers.cloudflare.com/email-routing/get-started/enable-email-routing/' style='font-size:12px;padding:6px 14px;text-decoration:none'>" +
    escapeHtml(t("mailSetupDocs")) +
    "</a></div>" +
    "<div class='tokenMeta' style='white-space:normal'>" +
    escapeHtml(t("mailSetupNote")) +
    "</div>";
}

async function loadMailSettings() {
  if (state.preview) {
    renderMailSettings({
      available: true,
      enabled: false,
      provider: "kuro_boo",
      domains: [{ hostname: "cms.example.com" }],
      senderAddress: "no-reply@example.com",
      destination: "admin@example.com",
      destinationVerified: true,
      canEnable: false,
      canManage: false,
    });
    return;
  }
  try {
    renderMailSettings(await api("/api/me/mail-settings"));
  } catch (error) {
    // 委託: 自分のドメインから送る設定は無いので、タブごと出さない(メールは Entamy が送る)。
    if ((error as { code?: string })?.code === "managed_hosting") {
      byId("mailTabBtn")?.remove();
      byId("panel-mail")?.remove();
      return;
    }
    renderMailSettings({
      available: false,
      enabled: false,
      domains: [],
      destination: "",
      destinationVerified: false,
      canEnable: false,
      canManage: Boolean(state.currentUser?.isAdmin),
      reason: errorMessage(error),
    });
  }
}

async function mountMailSettings(): Promise<void> {
  byId("mailRoutingToggle")!.addEventListener(
    "change",
    async (event: Dynamic) => {
      const toggle = event.target;
      const enabled = Boolean(toggle.checked);
      toggle.disabled = true;
      if (state.preview) {
        toggle.checked = !enabled;
        toast(t("previewReadOnly"), false, toggle);
        return;
      }
      try {
        await api("/api/me/mail-settings", {
          method: "PUT",
          body: JSON.stringify({ enabled }),
        });
        toast(t("mailDeliverySaved"), false, toggle);
        await loadMailSettings();
      } catch (error) {
        toggle.checked = !enabled;
        toast(errorMessage(error), true, toggle);
        await loadMailSettings();
      }
    },
  );
  await loadMailSettings();
}
