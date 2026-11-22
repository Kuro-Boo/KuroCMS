// KuroCMS admin screen module. Concatenated by scripts/build-admin.js.
//
// 問い合わせフォームの送り先(設定の「問い合わせ」のタブ・cms-contact 5節・旗 contact-form)。
// 送り先を足す・変えるのはサイト文字 mail-to-<名前>。ここは様子(確認済みか)を見せ、確認のメールの
// 送り直しと試しの送信だけを置く(設定の項目を増やさない)。

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
    "<div id='contactRecipientList' class='stack' style='gap:8px'></div>" +
    "<div style='display:flex;gap:8px;flex-wrap:wrap'>" +
    "<button type='button' class='btn' id='contactTestBtn'>" +
    escapeHtml(t("contactTestSend")) +
    "</button>" +
    "</div>" +
    "<div id='contactMsg' class='tokenMeta'></div>" +
    "</div>" +
    "</div>"
  );
}

interface ContactRecipientRow {
  name: string;
  label: string;
  email: string;
  own: boolean;
  verified: boolean;
}

async function loadContactSettings() {
  const list = byId("contactRecipientList");
  if (!list) return;
  const msg = byId("contactMsg");
  try {
    const data = await api("/api/system/contact-form");
    const rows: ContactRecipientRow[] = data.recipients || [];
    list.innerHTML = rows.length
      ? rows
          .map((r) => {
            const state = r.own
              ? t("contactStateOwn")
              : r.verified
                ? t("contactStateVerified")
                : t("contactStatePending");
            const ok = r.own || r.verified;
            return (
              "<div style='display:flex;gap:8px;align-items:center;flex-wrap:wrap'>" +
              "<span style='min-width:8em'>" +
              escapeHtml(r.label) +
              "</span>" +
              "<span class='tokenMeta'>" +
              escapeHtml(r.email) +
              "</span>" +
              "<span class='tokenMeta'>mail-to-" +
              escapeHtml(r.name) +
              "</span>" +
              "<span class='badge'" +
              (ok ? "" : " style='background:#fff3cd;color:#8a5a00'") +
              ">" +
              escapeHtml(state) +
              "</span>" +
              (ok
                ? ""
                : "<button type='button' class='btn contactVerifyBtn' data-name='" +
                  escapeHtml(r.name) +
                  "'>" +
                  escapeHtml(t("contactVerifySend")) +
                  "</button>") +
              "</div>"
            );
          })
          .join("")
      : "<div class='tokenMeta'>" +
        escapeHtml(t("contactRecipientsNone")) +
        "</div>";
  } catch (e) {
    if (msg) msg.textContent = String((e as Error)?.message || e);
  }
}

function bindContactSettings() {
  byId("contactRecipientList")?.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(
      ".contactVerifyBtn",
    );
    if (!btn) return;
    const msg = byId("contactMsg");
    btn.disabled = true;
    try {
      const r = await api("/api/system/contact-form/verify", {
        method: "POST",
        body: JSON.stringify({ name: btn.dataset.name }),
      });
      if (msg)
        msg.textContent = r.ok
          ? t("contactVerifySent")
          : t("contactVerifyFailed");
    } catch (err) {
      if (msg) msg.textContent = String((err as Error)?.message || err);
    } finally {
      btn.disabled = false;
    }
  });
  byId("contactTestBtn")?.addEventListener("click", async () => {
    const msg = byId("contactMsg");
    try {
      const r = await api("/api/system/contact-form/test", { method: "POST" });
      if (msg)
        msg.textContent = r.ok ? t("contactTestSent") : t("contactTestFailed");
    } catch (e) {
      if (msg) msg.textContent = String((e as Error)?.message || e);
    }
  });
}
