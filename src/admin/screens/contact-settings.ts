// KuroCMS admin screen module. Concatenated by scripts/build-admin.js.
//
// 問い合わせフォームの送り先(設定の「問い合わせ」のタブ・cms-contact 5節・旗 contact-form)。
// 登録・確認・送り直し・試しの送信をここに纏める(2026-11-22 利用者「メール送信はどのサイトでも使うので、設定画面に纏める」)。
// ID は画像の img-023 と同じく CMS が付ける(mail-001…)。入力させない。登録した後は変えない(フォームが ID で指すため)。

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
    // 足す・直す
    "<div class='stack' style='gap:8px;border-top:1px solid var(--line);padding-top:12px'>" +
    "<div id='contactFormTitle' class='fieldLabel' style='margin:0'>" +
    escapeHtml(t("contactAddTitle")) +
    "</div>" +
    // 2 つの欄を横に並べる(狭い画面では折り返す)
    "<div style='display:grid;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));gap:12px'>" +
    "<label class='stack' style='gap:4px'><span class='fieldLabel' style='margin:0'>" +
    escapeHtml(t("contactLabelField")) +
    "</span><input id='contactLabelInput' type='text' maxlength='40' autocomplete='off' /></label>" +
    "<label class='stack' style='gap:4px'><span class='fieldLabel' style='margin:0'>" +
    escapeHtml(t("contactEmailField")) +
    "</span><input id='contactEmailInput' type='email' autocomplete='off' /></label>" +
    "</div>" +
    "<div style='display:flex;gap:8px;flex-wrap:wrap'>" +
    "<button type='button' id='contactSaveBtn'>" +
    escapeHtml(t("contactAdd")) +
    "</button>" +
    "<button type='button' class='secondary' id='contactCancelBtn' hidden>" +
    escapeHtml(t("contactCancelEdit")) +
    "</button>" +
    "</div>" +
    "</div>" +
    "<div style='display:flex;gap:8px;flex-wrap:wrap;border-top:1px solid var(--line);padding-top:12px'>" +
    "<button type='button' class='secondary' id='contactTestBtn'>" +
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

/** 直している送り先の ID(空なら足す)。 */
let contactEditing = "";
let contactRows: ContactRecipientRow[] = [];

function contactSetEditing(row: ContactRecipientRow | null) {
  contactEditing = row?.name ?? "";
  const label = byId("contactLabelInput") as HTMLInputElement | null;
  const email = byId("contactEmailInput") as HTMLInputElement | null;
  if (label) label.value = row?.label ?? "";
  if (email) email.value = row?.email ?? "";
  const title = byId("contactFormTitle");
  if (title)
    title.textContent = row
      ? t("contactEditTitle").replace("{id}", row.name)
      : t("contactAddTitle");
  const save = byId("contactSaveBtn");
  if (save) save.textContent = row ? t("save") : t("contactAdd");
  const cancel = byId("contactCancelBtn") as HTMLButtonElement | null;
  if (cancel) cancel.hidden = !row;
  if (row) label?.focus();
}

async function loadContactSettings() {
  const list = byId("contactRecipientList");
  if (!list) return;
  const msg = byId("contactMsg");
  try {
    const data = await api("/api/system/contact-form");
    contactRows = data.recipients || [];
    // 表にする。列のボタンは共通の .rowActions で小さく(2026-11-22 利用者「一覧を表形式に、列のボタンは小さく」)
    const pending = "background:#fff3cd;color:#8a5a00;border-color:#f0d68a";
    list.innerHTML = contactRows.length
      ? "<div class='tableScroll'><table class='tableCompact'><thead><tr>" +
        "<th>ID</th><th>" +
        escapeHtml(t("contactColLabel")) +
        "</th><th class='flexible'>" +
        escapeHtml(t("contactColEmail")) +
        "</th><th>" +
        escapeHtml(t("contactColState")) +
        "</th><th style='text-align:right'>" +
        escapeHtml(t("actions")) +
        "</th></tr></thead><tbody>" +
        contactRows
          .map((r) => {
            const ok = r.own || r.verified;
            const stateText = r.own
              ? t("contactStateOwn")
              : r.verified
                ? t("contactStateVerified")
                : t("contactStatePending");
            const nameAttr = escapeHtml(r.name);
            return (
              "<tr><td><code>" +
              escapeHtml(r.name) +
              "</code></td><td>" +
              escapeHtml(r.label) +
              "</td><td class='flexible'>" +
              escapeHtml(r.email) +
              "</td><td><span class='badge'" +
              (ok ? "" : " style='" + pending + "'") +
              ">" +
              escapeHtml(stateText) +
              "</span></td><td><div class='rowActions'>" +
              (ok
                ? ""
                : "<button type='button' class='secondary contactVerifyBtn' data-name='" +
                  nameAttr +
                  "'>" +
                  escapeHtml(t("contactVerifySend")) +
                  "</button>") +
              "<button type='button' class='secondary contactEditBtn' data-name='" +
              nameAttr +
              "'>" +
              escapeHtml(t("contactEdit")) +
              "</button>" +
              "<button type='button' class='danger-soft contactDeleteBtn' data-name='" +
              nameAttr +
              "'>" +
              escapeHtml(t("delete")) +
              "</button>" +
              "</div></td></tr>"
            );
          })
          .join("") +
        "</tbody></table></div>"
      : "<div class='tokenMeta'>" +
        escapeHtml(t("contactRecipientsNone")) +
        "</div>";
  } catch (e) {
    if (msg) msg.textContent = String((e as Error)?.message || e);
  }
}

function bindContactSettings() {
  byId("contactRecipientList")?.addEventListener("click", async (e) => {
    const target = e.target as HTMLElement;
    const msg = byId("contactMsg");
    const edit = target.closest<HTMLButtonElement>(".contactEditBtn");
    if (edit) {
      contactSetEditing(
        contactRows.find((r) => r.name === edit.dataset.name) ?? null,
      );
      return;
    }
    const del = target.closest<HTMLButtonElement>(".contactDeleteBtn");
    if (del) {
      const row = contactRows.find((r) => r.name === del.dataset.name);
      if (!row) return;
      if (!confirm(t("contactDeleteConfirm").replace("{label}", row.label)))
        return;
      try {
        await withButtonBusy(del, () =>
          api(
            "/api/system/contact-form/recipients/" +
              encodeURIComponent(row.name),
            { method: "DELETE" },
          ),
        );
        if (contactEditing === row.name) contactSetEditing(null);
        if (msg) msg.textContent = t("contactDeleted");
        await loadContactSettings();
      } catch (err) {
        if (msg) msg.textContent = String((err as Error)?.message || err);
      }
      return;
    }
    const btn = target.closest<HTMLButtonElement>(".contactVerifyBtn");
    if (!btn) return;
    try {
      const r = await withButtonBusy(btn, () =>
        api("/api/system/contact-form/verify", {
          method: "POST",
          body: JSON.stringify({ name: btn.dataset.name }),
        }),
      );
      if (!r) return; // 回っている間の二度押し
      if (msg)
        msg.textContent = r.ok
          ? t("contactVerifySent")
          : t("contactVerifyFailed");
    } catch (err) {
      if (msg) msg.textContent = String((err as Error)?.message || err);
    }
  });
  byId("contactCancelBtn")?.addEventListener("click", () =>
    contactSetEditing(null),
  );
  byId("contactSaveBtn")?.addEventListener("click", async () => {
    const saveBtn = byId("contactSaveBtn");
    if (saveBtn?.dataset.busy === "1") return;
    const msg = byId("contactMsg");
    const labelEl = byId("contactLabelInput") as HTMLInputElement | null;
    const emailEl = byId("contactEmailInput") as HTMLInputElement | null;
    const label = (labelEl?.value ?? "").trim();
    const email = (emailEl?.value ?? "").trim();
    // 誤りはその欄に出す(画面で分かるものは送る前に)
    if (!label)
      return fieldError("contactLabelInput", t("contactLabelRequired"));
    if (label.length > 40)
      return fieldError("contactLabelInput", t("contactLabelTooLong"));
    if (!emailEl?.checkValidity() || !email.includes("@"))
      return fieldError("contactEmailInput", t("contactEmailInvalid"));
    try {
      // 終わるまで押せなくしてスピンを回す(何度も押されて同じ送り先が並ぶのを防ぐ)
      const r = await withButtonBusy(saveBtn, () =>
        api(
          contactEditing
            ? "/api/system/contact-form/recipients/" +
                encodeURIComponent(contactEditing)
            : "/api/system/contact-form/recipients",
          {
            method: contactEditing ? "PUT" : "POST",
            body: JSON.stringify({ label, email }),
          },
        ),
      );
      if (!r) return;
      contactSetEditing(null);
      if (msg)
        msg.textContent = r.verify_mail_sent
          ? t("contactSavedVerify").replace("{email}", r.recipient?.email ?? "")
          : t("contactSaved");
      await loadContactSettings();
    } catch (err) {
      const text = String((err as Error)?.message || err);
      if (/メールアドレス|email/i.test(text))
        return fieldError("contactEmailInput", text);
      if (/表示名|label/i.test(text))
        return fieldError("contactLabelInput", text);
      if (msg) msg.textContent = text;
    }
  });
  byId("contactTestBtn")?.addEventListener("click", async () => {
    const msg = byId("contactMsg");
    try {
      const r = await withButtonBusy(byId("contactTestBtn"), () =>
        api("/api/system/contact-form/test", { method: "POST" }),
      );
      if (!r) return;
      if (msg)
        msg.textContent = r.ok ? t("contactTestSent") : t("contactTestFailed");
    } catch (e) {
      if (msg) msg.textContent = String((e as Error)?.message || e);
    }
  });
}
