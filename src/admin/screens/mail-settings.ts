// KuroCMS admin screen module. Concatenated by scripts/build-admin.js.
//
// メール送信(設定の「メール送信」のタブ・2026-10-21 にプロフィールから移した)。どの経路で送るかはサイト全体の
// 設定で、変えられるのは管理者だけ —— 一人ひとりのプロフィールに置くと、管理者でない人にも見え、どこで決まって
// いるのかが分からない。経路: 自分のドメイン(Cloudflare Email Routing)を先に試し、送れなければ黒兎のサーバー
// (Entamy Mailer)が代わりに送る(sendMail・api.ts)。委託運用は Entamy が送るのでタブを出さない。

function mailSettingsPanelHtml(): string {
  return (
    "<div id='panel-mail' class='settingsPanel' style='display:none'>" +
    "<div class='panel stack' id='mailDeliveryBox'>" +
    // 見出しはタブが言うので置かない(SNS のタブと同じ)。
    "<div class='tokenHelp'>" +
    escapeHtml(t("mailDeliveryLead")) +
    "</div><div class='tokenHelp'>" +
    escapeHtml(t("mailDeliveryRequirement")) +
    "</div><div class='tokenHelp' style='color:var(--danger,#b42318)'>" +
    escapeHtml(t("mailDeliveryKuroLimit")) +
    "</div><div id='mailDeliveryStatus' class='tokenBox' style='white-space:normal'>-</div>" +
    // ⚠ 設定は **Cloudflare 側でしか行えない**（宛先の verify も Email Routing の
    //   有効化も CMS からは実行できない）。手順を出さないと、トグルが押せない
    //   理由も、次に何をすればよいかも画面から分からない。
    "<details id='mailSetupGuide' style='border:1px solid var(--line,#2a2f3a);border-radius:8px;padding:10px'>" +
    "<summary style='cursor:pointer;font-weight:600'>" +
    escapeHtml(t("mailSetupGuideTitle")) +
    "</summary>" +
    "<div class='tokenHelp' style='margin-top:8px'>" +
    escapeHtml(t("mailSetupGuideIntro")) +
    "</div>" +
    "<div id='mailSetupGuideBody' class='stack' style='gap:10px;margin-top:10px'></div>" +
    "</details>" +
    "<div class='toggleRow'><div><div><b>" +
    escapeHtml(t("mailDeliveryToggle")) +
    "</b></div><div id='mailDeliveryManageHelp' class='tokenMeta'></div></div>" +
    "<input id='mailRoutingToggle' type='checkbox' class='toggle' disabled /></div></div>" +
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
  if (!status || !toggle || !help) return;

  const domains = (data.domains || [])
    .map((domain: Dynamic) => domain.hostname || "")
    .filter(Boolean)
    .join(", ");
  const destinationState = data.destinationVerified
    ? t("mailDeliveryVerified")
    : t("mailDeliveryUnverified");
  status.innerHTML =
    "<div><b>" +
    escapeHtml(t("mailDeliveryCurrent")) +
    ":</b> " +
    escapeHtml(data.enabled ? t("mailDeliveryCustom") : t("mailDeliveryKuro")) +
    "</div><div><b>" +
    escapeHtml(t("mailDeliveryDomain")) +
    ":</b> " +
    escapeHtml(domains || "-") +
    "</div><div><b>" +
    escapeHtml(t("mailDeliverySender")) +
    ":</b> " +
    escapeHtml(data.senderAddress || "-") +
    "</div><div><b>" +
    escapeHtml(t("mailDeliveryDestination")) +
    ":</b> " +
    escapeHtml(data.destination || "-") +
    "（" +
    escapeHtml(destinationState) +
    "）</div>" +
    // ⚠ 宛先の verify は**アカウント単位**、Email Routing の有効化は
    //   **zone 単位**。片方だけ満たしても送信は失敗するので、両方出す。
    "<div><b>" +
    escapeHtml(t("mailDeliveryZoneLabel")) +
    ":</b> " +
    escapeHtml(
      data.senderZoneEnabled === true
        ? t("mailDeliveryZoneStateOn")
        : // `null`（確認できない）を「無効」と見せない。既存の導入は
          // zone 側の権限を持たないため、ここは頻繁に不明になる。
          (data.senderZoneEnabled === false
            ? t("mailDeliveryZoneOff")
            : t("mailDeliveryZoneUnknown")) +
            (data.senderZoneReason ? "（" + data.senderZoneReason + "）" : ""),
    ) +
    "</div>" +
    // 復旧メールは要求した本人へ送るので、他の管理者が未 verified だと
    // その人だけ無言で締め出される。
    ((data.unverifiedAdmins || []).length > 0
      ? "<div style='color:var(--danger,#b42318);margin-top:4px'>" +
        escapeHtml(
          t("mailDeliveryAdminsUnverified") +
            ": " +
            (data.unverifiedAdmins || []).join(", "),
        ) +
        "</div>"
      : "") +
    (!data.available && data.reason
      ? "<div style='color:var(--danger,#b42318);margin-top:4px'>" +
        escapeHtml(mailReasonText(String(data.reason))) +
        "</div>"
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
  const mark = (done: boolean) => (done ? "✅ " : "▢ ");
  const step = (done: boolean, title: string, desc: string) =>
    "<div><div><b>" +
    mark(done) +
    escapeHtml(title) +
    "</b></div><div class='tokenMeta' style='white-space:normal'>" +
    escapeHtml(desc) +
    "</div></div>";
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
    "<div style='display:flex;gap:8px;flex-wrap:wrap'>" +
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
