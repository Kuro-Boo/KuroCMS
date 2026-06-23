// KuroCMS admin screen module. Concatenated by scripts/build-admin.js.

async function loginScreen(errorMsg = "") {
  setSidebarMode("setup");
  app.innerHTML =
    "<section class='setup'><div class='setupHero'><h2>" +
    escapeHtml(t("loginTitle")) +
    "</h2><p>" +
    escapeHtml(t("loginLead")) +
    "</p></div><div class='setupLayout'><div class='stack panel'>" +
    (errorMsg
      ? "<div class='notice error'>" + escapeHtml(errorMsg) + "</div>"
      : "") +
    "<div class='toolbar' style='justify-content:center'><button id='passkeyLoginBtn' style='min-width:220px'>" +
    escapeHtml(t("loginWithPasskey")) +
    "</button></div></div></div></section>";
  byId("passkeyLoginBtn")!.addEventListener("click", async () => {
    const btn = byId("passkeyLoginBtn");
    if (btn) btn.disabled = true;
    try {
      const beginData = await api("/api/auth/passkey/login/begin", {
        method: "POST",
        body: "{}",
      });
      const credential = await navigator.credentials.get({
        publicKey: {
          challenge: b64uDecode(beginData.challenge),
          rpId: beginData.rpId,
          userVerification: "required",
          timeout: 60000,
        },
      });
      await api("/api/auth/passkey/login/complete", {
        method: "POST",
        body: JSON.stringify({
          challengeId: beginData.challengeId,
          credential: serializeCredentialForAuthentication(
            credential as PublicKeyCredential,
          ),
        }),
      });
      render();
    } catch (err) {
      loginScreen(errorMessage(err) || t("apiFailed"));
    }
  });
}

async function inviteScreen(token: Dynamic) {
  setSidebarMode("setup");
  app.innerHTML =
    "<section class='setup'><div class='setupHero'><h2>" +
    escapeHtml(t("registerPasskey")) +
    "</h2></div><div class='setupLayout'><div class='stack panel' id='inviteContent'><p>" +
    escapeHtml(t("loginLead")) +
    "</p></div></div></section>";
  const content = byId("inviteContent")!;
  try {
    const invite = await api("/api/auth/invite/" + encodeURIComponent(token));
    content.innerHTML =
      "<p><b>" +
      escapeHtml(invite.email) +
      "</b></p><div class='toolbar' style='justify-content:center'><button id='inviteRegBtn' style='min-width:220px'>" +
      escapeHtml(t("registerPasskey")) +
      "</button></div><div id='inviteStatus'></div>";
    byId("inviteRegBtn")!.addEventListener("click", async () => {
      const btn = byId("inviteRegBtn");
      if (btn) {
        btn.disabled = true;
        btn.textContent = t("registeringPasskey");
      }
      try {
        const beginData = await api("/api/auth/passkey/register/begin", {
          method: "POST",
          body: JSON.stringify({ invitationToken: token }),
        });
        const credential = await navigator.credentials.create({
          publicKey: {
            challenge: b64uDecode(beginData.challenge),
            rp: beginData.rp,
            user: {
              id: b64uDecode(beginData.user.id),
              name: beginData.user.name,
              displayName: beginData.user.displayName,
            },
            pubKeyCredParams: beginData.pubKeyCredParams,
            timeout: beginData.timeout,
            attestation: beginData.attestation,
            authenticatorSelection: beginData.authenticatorSelection,
          },
        });
        await api("/api/auth/passkey/register/complete", {
          method: "POST",
          body: JSON.stringify({
            challengeId: beginData.challengeId,
            credential: serializeCredentialForRegistration(
              credential as PublicKeyCredential,
            ),
            invitationToken: token,
          }),
        });
        const url = new URL(location.href);
        url.searchParams.delete("invite");
        history.replaceState(null, "", url.toString());
        render();
      } catch (err) {
        if (btn) {
          btn.disabled = false;
          btn.textContent = t("registerPasskey");
        }
        const st = byId("inviteStatus");
        if (st)
          st.innerHTML =
            "<div class='notice error'>" +
            escapeHtml(errorMessage(err) || t("apiFailed")) +
            "</div>";
      }
    });
  } catch (err) {
    content.innerHTML =
      "<div class='notice error'>" +
      escapeHtml(errorMessage(err) || t("apiFailed")) +
      "</div>";
  }
}

function captureSetupState() {
  const email = byId("setupAdminEmail");
  const licenseAccepted = byId("setupLicenseAccepted");
  return {
    email: email?.value || "",
    licenseAccepted: Boolean(licenseAccepted?.checked),
  };
}

async function setupScreen(
  status: Dynamic,
  preserve: { email?: string; licenseAccepted?: boolean } = {},
) {
  setSidebarMode("setup");
  app.innerHTML =
    "<section class='setup'><div class='setupHero'><h2>" +
    escapeHtml(t("setupTitle")) +
    "</h2><p>" +
    escapeHtml(t("setupLead")) +
    "</p></div><div class='setupLayout'><form class='stack panel' id='setupForm'><div><span class='sectionLabel'>" +
    escapeHtml(t("selectLanguage")) +
    "</span></div>" +
    localeSelectHtml() +
    "<div><span class='sectionLabel'>" +
    escapeHtml(t("administrator")) +
    "</span></div><label>" +
    escapeHtml(t("adminEmail")) +
    "<input id='setupAdminEmail' required type='email' autocomplete='username' placeholder='admin@example.com' /></label><div style='margin-top:12px'><span class='sectionLabel'>" +
    escapeHtml(t("adminUrlLabel")) +
    "</span><div class='muted' style='margin:6px 0 4px;font-size:13px'>" +
    escapeHtml(t("adminUrlDerivedFromBootstrap")) +
    "</div><div id='setupAdminUrlDisplay' style='padding:10px 12px;background:var(--surface-2);border-radius:10px;font-size:13px;font-family:ui-monospace,monospace;color:var(--ink)'></div></div><div><span class='sectionLabel'>" +
    escapeHtml(t("license")) +
    "</span><h3>Kuro License</h3><pre class='licenseBox'>" +
    escapeHtml(kuroLicenseText()) +
    "</pre></div><label class='checkRow'><input id='setupLicenseAccepted' type='checkbox' /> <span>" +
    escapeHtml(t("licenseAccept")) +
    " <code>with KuroCMS</code> " +
    escapeHtml(t("attributionArea")) +
    "</span></label><div class='toolbar'><button id='setupSubmit' type='submit' disabled>" +
    escapeHtml(t("completeSetup")) +
    "</button></div></form></div></section>";
  const email = byId("setupAdminEmail")!;
  const licenseAccepted = byId("setupLicenseAccepted")!;
  const submit = byId("setupSubmit")!;
  email.value = preserve.email || "";
  const derivedPublicDomain = (() => {
    const path = location.pathname;
    const idx = path.lastIndexOf("/kurocms/");
    if (idx > 0) return location.origin + path.slice(0, idx) + "/";
    return location.origin + "/";
  })();
  const adminUrlDisplay = byId("setupAdminUrlDisplay");
  if (adminUrlDisplay)
    adminUrlDisplay.textContent =
      location.origin + normalizedAdminEntryPath + "/";
  licenseAccepted.checked = Boolean(preserve.licenseAccepted);
  submit.disabled = !licenseAccepted.checked;
  bindLocaleSelect(() => setupScreen(status, captureSetupState()));
  licenseAccepted.addEventListener("change", () => {
    submit.disabled = !licenseAccepted.checked;
  });
  byId("setupForm")!.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!licenseAccepted?.checked) {
      fieldError("setupLicenseAccepted", t("licenseRequired"));
      return;
    }
    const submitBtn = byId("setupSubmit")!;
    const originalText = submitBtn.textContent;
    submitBtn.disabled = true;
    try {
      const setupLang = state.uiLang || "en";
      const setupResult = await api("/api/setup", {
        method: "POST",
        body: JSON.stringify({
          adminEmail: email.value,
          publicDomain: derivedPublicDomain,
          licenseAccepted: true,
          defaultLang: setupLang,
          initialLang: setupLang,
        }),
      });
      if (
        location.hostname === "localhost" ||
        location.hostname === "127.0.0.1"
      ) {
        history.pushState(null, "", adminHref("") + "/");
        render();
      } else {
        submitBtn.textContent = t("registeringPasskey");
        const beginData = await api("/api/auth/passkey/register/begin", {
          method: "POST",
          body: JSON.stringify({ uid: setupResult.uid }),
        });
        const credential = await navigator.credentials.create({
          publicKey: {
            challenge: b64uDecode(beginData.challenge),
            rp: beginData.rp,
            user: {
              id: b64uDecode(beginData.user.id),
              name: beginData.user.name,
              displayName: beginData.user.displayName,
            },
            pubKeyCredParams: beginData.pubKeyCredParams,
            timeout: beginData.timeout,
            attestation: beginData.attestation,
            authenticatorSelection: beginData.authenticatorSelection,
          },
        });
        await api("/api/auth/passkey/register/complete", {
          method: "POST",
          body: JSON.stringify({
            challengeId: beginData.challengeId,
            credential: serializeCredentialForRegistration(
              credential as PublicKeyCredential,
            ),
          }),
        });
        history.pushState(null, "", adminHref("") + "/");
        render();
      }
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
      const msg = (errorMessage(err) || "").toLowerCase();
      if (msg.includes("email"))
        fieldError("setupAdminEmail", errorMessage(err));
      else toast(errorMessage(err) || t("apiFailed"), true);
    }
  });
}
