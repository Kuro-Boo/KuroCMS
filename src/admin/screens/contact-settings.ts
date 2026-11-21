// KuroCMS admin screen module. Concatenated by scripts/build-admin.js.
//
// 問い合わせフォームの届け先(設定の「問い合わせ」のタブ・cms-contact 5節・旗 contact-form)。
// 送り先は本文に書かせない。管理者のうちメールを確かめ済みの人から選ぶ(他人のアドレスを入れられない)。

function contactSettingsPanelHtml(): string {
  if (!state.editorFeatures?.contactForm) return "";
  return (
    "<div id='panel-contact' class='settingsPanel' style='display:none'>" +
    "<div class='panel stack' style='gap:12px'>" +
    "<div class='fieldLabel' style='margin:0'>" +
    escapeHtml(t("contactRecipientsTitle")) +
    "</div>" +
    "<div class='tokenMeta' style='white-space:normal'>" +
    escapeHtml(t("contactRecipientsLead")) +
    "</div>" +
    "<div id='contactRecipientList' class='stack' style='gap:6px'></div>" +
    "<div style='display:flex;gap:8px;flex-wrap:wrap'>" +
    "<button type='button' class='btn primary' id='contactSaveBtn'>" +
    escapeHtml(t("save")) +
    "</button>" +
    "<button type='button' class='btn' id='contactTestBtn'>" +
    escapeHtml(t("contactTestSend")) +
    "</button>" +
    "</div>" +
    "<div id='contactMsg' class='tokenMeta'></div>" +
    "</div>" +
    "</div>"
  );
}

async function loadContactSettings() {
  const list = byId("contactRecipientList");
  if (!list) return;
  const msg = byId("contactMsg");
  try {
    const data = await api("/api/system/contact");
    const selected: string[] = data.selected || [];
    const candidates: { uid: string; email: string; name: string }[] =
      data.candidates || [];
    list.innerHTML = candidates.length
      ? candidates
          .map(
            (c) =>
              "<label style='display:flex;gap:8px;align-items:center'>" +
              "<input type='checkbox' class='contactRecipient' value='" +
              escapeHtml(c.uid) +
              "'" +
              (selected.includes(c.uid) ? " checked" : "") +
              " />" +
              "<span>" +
              escapeHtml(c.name ? c.name + " <" + c.email + ">" : c.email) +
              "</span></label>",
          )
          .join("")
      : "<div class='tokenMeta'>" +
        escapeHtml(t("contactRecipientsNone")) +
        "</div>";
  } catch (e) {
    if (msg) msg.textContent = String((e as Error)?.message || e);
  }
}

function bindContactSettings() {
  byId("contactSaveBtn")?.addEventListener("click", async () => {
    const msg = byId("contactMsg");
    const recipients = Array.from(
      document.querySelectorAll<HTMLInputElement>(".contactRecipient"),
    )
      .filter((i) => i.checked)
      .map((i) => i.value);
    try {
      await api("/api/system/contact", {
        method: "PUT",
        body: JSON.stringify({ recipients }),
      });
      if (msg) msg.textContent = t("contactSaved");
    } catch (e) {
      if (msg) msg.textContent = String((e as Error)?.message || e);
    }
  });
  byId("contactTestBtn")?.addEventListener("click", async () => {
    const msg = byId("contactMsg");
    try {
      const r = await api("/api/system/contact/test", { method: "POST" });
      if (msg)
        msg.textContent = r.ok ? t("contactTestSent") : t("contactTestFailed");
    } catch (e) {
      if (msg) msg.textContent = String((e as Error)?.message || e);
    }
  });
}
