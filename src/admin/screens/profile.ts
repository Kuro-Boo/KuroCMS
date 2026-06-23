// KuroCMS admin screen module. Concatenated by scripts/build-admin.js.

async function profile() {
  shell(
    t("profile"),
    "<div class='grid two profileGrid'><div class='stack'><div class='panel stack'><h3>" +
      escapeHtml(t("profileIdentity")) +
      "</h3><table><tbody><tr><th>" +
      escapeHtml(t("roles")) +
      "</th><td id='profileRoles'>-</td></tr></tbody></table><form class='stack' id='accountForm'><label>" +
      escapeHtml(t("displayName")) +
      "<input id='profileDisplayName' /></label><label>" +
      escapeHtml(t("userIdLabel")) +
      "<div class='tokenOutputRow'><div id='profileAuthorId' class='tokenBox' style='font-size:11px;font-family:ui-monospace,monospace'>-</div><button type='button' class='secondary' id='copyAuthorId'>" +
      escapeHtml(t("copy")) +
      "</button></div></label><label>" +
      escapeHtml(t("email")) +
      "<input id='profileEmail' type='email' /></label><button>" +
      escapeHtml(t("updateAccount")) +
      "</button></form></div><div class='panel stack'><h3>" +
      escapeHtml(t("profilePreferences")) +
      "</h3><label>" +
      escapeHtml(t("interfaceLanguage")) +
      "<select class='localeSelect' id='uiLocale'>" +
      supportedLocales
        .map(
          (locale) =>
            "<option value='" +
            locale +
            "'" +
            (locale === state.uiLang ? " selected" : "") +
            ">" +
            localeNames[locale] +
            "</option>",
        )
        .join("") +
      "</select></label><div class='toggleRow'><div><div><b>" +
      escapeHtml(t("darkMode")) +
      "</b></div><div class='tokenMeta'>" +
      escapeHtml(t("darkModeHelp")) +
      "</div></div><input id='darkModeToggle' type='checkbox' class='toggle'" +
      (state.colorMode === "dark" ? " checked" : "") +
      " /></div></div><div class='panel' style='padding:12px 16px'><button class='danger' id='logoutBtn' style='width:100%'>" +
      escapeHtml(t("logout")) +
      "</button></div></div><div class='stack'><div class='panel stack'><h3>" +
      escapeHtml(t("profileApiAccess")) +
      "</h3><p class='muted' style='margin:-4px 0 2px'>" +
      escapeHtml(t("profileApiAccessLead")) +
      "</p><form class='toolbar' id='tokenForm'><button>" +
      escapeHtml(t("createPatAction")) +
      "</button></form><div class='stack' style='gap:8px'><div class='tokenLabel'>" +
      escapeHtml(t("generatedToken")) +
      "</div><div class='tokenHelp'>" +
      escapeHtml(t("patScopeNote")) +
      "</div><div class='tokenOutputRow'><div id='generatedToken' class='tokenBox'></div><button class='secondary' id='copyToken'>" +
      escapeHtml(t("copy")) +
      "</button></div></div><div class='stack' style='gap:8px'><div class='tokenMeta'>" +
      escapeHtml(t("tokenHistory")) +
      "</div><div id='tokenHistory' class='tokenList'></div></div></div></div></div>",
  );
  byId("logoutBtn")?.addEventListener("click", async () => {
    try {
      await api("/api/auth/logout", { method: "POST", body: "{}" });
      render();
    } catch {
      render();
    }
  });
  let generatedToken = "";
  async function loadProfileAndTokens() {
    if (state.preview) {
      byId("profileDisplayName")!.value = "Preview Admin";
      byId("profileAuthorId")!.textContent = "author_preview0000";
      byId("profileEmail")!.value = "admin@example.com";
      byId("profileRoles")!.textContent = t("adminRole");
      byId("tokenHistory")!.innerHTML =
        "<div class='tokenRow'><div><b>Personal token</b><div class='tokenMeta'>" +
        formatDateTime(new Date().toISOString()) +
        "</div></div><button class='danger' disabled>&#128465; " +
        t("revoke") +
        "</button></div>";
      return;
    }
    const [meData, tokenData] = await Promise.all([
      api("/api/me"),
      api("/api/me/tokens"),
    ]);
    const meUser = meData.user;
    state.currentUser = meUser;
    // 実値を表示（空なら空のまま）。空のときは権限名をプレースホルダーでヒント表示するだけで、
    // 値としては入れない（空のまま更新しても "管理者" が保存されないように）。
    const dnInput = byId("profileDisplayName")!;
    dnInput.value = meUser.displayName || "";
    dnInput.placeholder = meUser.displayName
      ? ""
      : meUser.isAdmin
        ? t("adminRole")
        : t("authorRole");
    // ユーザID（= author_id）。GET /api/me が未設定なら自動付番して返す（遅延補完はこの1箇所のみ）。
    byId("profileAuthorId")!.textContent = meUser.authorId || "-";
    byId("profileEmail")!.value = meUser.email || "";
    // 単一ロール表示（ユーザ管理画面と統一）。admin は author 権限を内包するため「管理者」のみ表示。
    byId("profileRoles")!.textContent = meUser.isAdmin
      ? t("adminRole")
      : meUser.isAuthor
        ? t("authorRole")
        : "-";
    byId("tokenHistory")!.innerHTML =
      (tokenData.tokens || [])
        .map((token: Dynamic) => {
          const revoked = Boolean(token.revokedAt);
          const btn = revoked
            ? "<button class='danger' data-delete-token='" +
              escapeHtml(token.tokenId) +
              "'>&#128465; " +
              escapeHtml(t("delete")) +
              "</button>"
            : "<button class='danger' data-revoke-token='" +
              escapeHtml(token.tokenId) +
              "'>&#128465; " +
              escapeHtml(t("revoke")) +
              "</button>";
          const label = revoked
            ? "<span class='tokenMeta' style='color:var(--danger)'>" +
              escapeHtml(t("revoked")) +
              "</span> "
            : "";
          return (
            "<div class='tokenRow'><div>" +
            label +
            "<b>" +
            escapeHtml(token.name || t("patManager")) +
            "</b><div class='tokenMeta'>" +
            escapeHtml(formatDateTime(token.createdAt)) +
            "</div></div>" +
            btn +
            "</div>"
          );
        })
        .join("") ||
      "<div class='tokenMeta'>" + escapeHtml(t("noDocuments")) + "</div>";
  }
  bindLocaleSelect(() => profile());
  byId("darkModeToggle")!.addEventListener("change", (event: Dynamic) => {
    applyColorMode(event.target.checked ? "dark" : "light");
  });
  byId("accountForm")!.addEventListener("submit", async (event: Dynamic) => {
    event.preventDefault();
    const btn =
      event.submitter || event.target.querySelector("button[type=submit]");
    if (state.preview) {
      toast(t("previewReadOnly"), false, btn);
      return;
    }
    try {
      await api("/api/me", {
        method: "PUT",
        body: JSON.stringify({
          displayName: byId("profileDisplayName")!.value.trim(),
          email: byId("profileEmail")!.value.trim(),
        }),
      });
      toast(t("profileSaved"), false, btn);
      await loadProfileAndTokens();
    } catch (error) {
      toast(errorMessage(error), true, btn);
    }
  });
  byId("tokenForm")!.addEventListener("submit", async (event: Dynamic) => {
    event.preventDefault();
    const btn =
      event.submitter || event.target.querySelector("button[type=submit]");
    if (state.preview) {
      toast(t("previewReadOnly"), false, btn);
      return;
    }
    try {
      const result = await api("/api/me/tokens", {
        method: "POST",
        body: JSON.stringify({ name: "Personal token" }),
      });
      generatedToken = result.token || "";
      byId("generatedToken")!.textContent = generatedToken || "";
      toast(t("tokenGenerated"), false, btn);
      await loadProfileAndTokens();
    } catch (error) {
      toast(errorMessage(error), true, btn);
    }
  });
  byId("copyToken")!.addEventListener("click", async (event: Dynamic) => {
    if (!generatedToken) return;
    try {
      await navigator.clipboard.writeText(generatedToken);
      toast(t("copySuccess"), false, event.currentTarget);
    } catch {
      toast(t("copyFailed"), true, event.currentTarget);
    }
  });
  byId("copyAuthorId")?.addEventListener("click", async (event: Dynamic) => {
    const value = byId("profileAuthorId")?.textContent || "";
    if (!value || value === "-") return;
    try {
      await navigator.clipboard.writeText(value);
      toast(t("copySuccess"), false, event.currentTarget);
    } catch {
      toast(t("copyFailed"), true, event.currentTarget);
    }
  });
  byId("tokenHistory")!.addEventListener("click", async (event: Dynamic) => {
    const copyButton = event.target.closest("[data-copy-token]");
    if (copyButton) {
      const tokenId = copyButton.getAttribute("data-copy-token") || "";
      if (!tokenId) return;
      try {
        await navigator.clipboard.writeText(tokenId);
        toast(t("copySuccess"), false, copyButton);
      } catch {
        toast(t("copyFailed"), true, copyButton);
      }
      return;
    }
    const deleteButton = event.target.closest("[data-delete-token]");
    if (deleteButton) {
      const tokenId = deleteButton.getAttribute("data-delete-token");
      if (!tokenId || state.preview) return;
      openEntryDialog(
        t("delete") + " — Personal Access Token",
        "<p class='muted'>" + escapeHtml(t("tokenDeleteConfirm")) + "</p>",
        t("delete"),
        async (form: Dynamic, close: Dynamic) => {
          try {
            await api(
              "/api/me/tokens/" + encodeURIComponent(tokenId) + "/delete",
              { method: "DELETE" },
            );
            close();
            toast(t("deleteDone"), false, deleteButton);
            await loadProfileAndTokens();
          } catch (error) {
            toast(errorMessage(error), true, deleteButton);
          }
        },
      );
      return;
    }
    const revokeButton = event.target.closest("[data-revoke-token]");
    if (!revokeButton) return;
    const tokenId = revokeButton.getAttribute("data-revoke-token");
    if (!tokenId || state.preview) return;
    try {
      await api("/api/me/tokens/" + encodeURIComponent(tokenId) + "/revoke", {
        method: "POST",
      });
      toast(t("tokenRevoked"), false, revokeButton);
      await loadProfileAndTokens();
    } catch (error) {
      toast(errorMessage(error), true, revokeButton);
    }
  });
  await loadProfileAndTokens();
}
