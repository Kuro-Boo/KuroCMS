// KuroCMS admin screen module. Concatenated by scripts/build-admin.js.

async function profile() {
  // MCP endpoint for THIS instance. withBase() yields the same base the admin
  // uses for its own API calls, so this is correct regardless of basePath.
  const mcpUrl = new URL(withBase("/api/mcp"), location.origin).href;
  const mcpCmd =
    "claude mcp add --transport http kurocms " +
    mcpUrl +
    ' --header "Authorization: Bearer kuro_<PAT>"';
  shell(
    t("profile"),
    "<div class='grid two profileGrid'><div class='stack'><div class='panel stack'><h3 style='display:flex;align-items:baseline;gap:10px;flex-wrap:wrap'>" +
      escapeHtml(t("profileIdentity")) +
      // 匿名アカウント。問い合わせのときに「どの導入か」を伝える唯一の手がかり。
      // **install_id は出さない**（あれはなりすましに使える鍵）。
      "<span id='installIdBadge' style='font-size:10px;font-weight:400;font-family:ui-monospace,monospace;opacity:.55;letter-spacing:.02em'></span>" +
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
      "</p>" +
      // ── MCP connect (endpoint URL + copy-paste client config) ──────────
      "<div class='stack' style='gap:6px;margin:2px 0 12px;padding:10px 12px;border:1px solid var(--border,#2a2f3a);border-radius:8px'><div class='tokenMeta'><b>" +
      escapeHtml(t("mcpConnectTitle")) +
      "</b></div><div class='tokenHelp'>" +
      escapeHtml(t("mcpConnectLead")) +
      "</div><div class='tokenLabel'>" +
      escapeHtml(t("mcpEndpointLabel")) +
      "</div><div class='tokenOutputRow'><div id='mcpEndpoint' class='tokenBox' style='font-size:11px;font-family:ui-monospace,monospace;word-break:break-all'>" +
      escapeHtml(mcpUrl) +
      "</div><button type='button' class='secondary' id='copyMcpUrl'>" +
      escapeHtml(t("copy")) +
      "</button></div><div class='tokenLabel'>" +
      escapeHtml(t("mcpConfigLabel")) +
      "</div><div class='tokenOutputRow'><div id='mcpConfig' class='tokenBox' style='font-size:11px;font-family:ui-monospace,monospace;white-space:pre-wrap;word-break:break-all'>" +
      escapeHtml(mcpCmd) +
      "</div><button type='button' class='secondary' id='copyMcpConfig'>" +
      escapeHtml(t("copy")) +
      "</button></div></div>" +
      "<form class='toolbar' id='tokenForm'><button>" +
      escapeHtml(t("createPatAction")) +
      "</button></form><div class='stack' style='gap:8px'><div class='tokenLabel'>" +
      escapeHtml(t("generatedToken")) +
      "</div><div class='tokenHelp'>" +
      escapeHtml(t("patScopeNote")) +
      "</div><div class='tokenOutputRow'><div id='generatedToken' class='tokenBox'></div><button class='secondary' id='copyToken'>" +
      escapeHtml(t("copy")) +
      "</button></div></div><div class='stack' style='gap:8px'><div class='tokenMeta'>" +
      escapeHtml(t("tokenHistory")) +
      "</div><div id='tokenHistory' class='tokenList'></div></div></div>" +
      // ── Passkey (device) management ──────────────────────────────────
      "<div class='panel stack'><h3>" +
      escapeHtml(t("passkeyDevices")) +
      "</h3><p class='muted' style='margin:-4px 0 2px'>" +
      escapeHtml(t("passkeyDevicesLead")) +
      "</p><form class='toolbar' id='addPasskeyForm'><button>" +
      escapeHtml(t("addPasskey")) +
      "</button></form><div id='passkeyList' class='tokenList'></div></div>" +
      "</div></div>",
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

    // 匿名アカウントの表示。**取れなくても画面は壊さない** ——
    // まだ一度も名乗っていない導入や、送信を止めてある導入では空になる。
    void (async () => {
      const badge = byId("installIdBadge");
      if (!badge) return;
      try {
        const info = (await api("/api/system/install-id")) as {
          accountId?: string | null;
          optedOut?: boolean;
        };
        // 送信を止めてある導入は、そもそも名乗らないので ID を持たない。
        // **持っていない理由が違う**ので、同じ表示で片付けない。
        if (info.optedOut) {
          badge.textContent = "INSTALL-ID : 送信停止中";
        } else if (info.accountId) {
          badge.textContent = "INSTALL-ID : " + info.accountId;
        } else {
          // cron は毎分動くので、この状態が続くのは導入直後か、
          // 既存の導入がこの版に上がった直後の1分ほど。
          badge.textContent = "INSTALL-ID : 取得中";
        }
      } catch {
        badge.textContent = "";
      }
    })();
    const meUser = meData.user;
    state.currentUser = meUser;
    // タブタイトル "KuroCMS <ユーザー名>" を実値に追随させる（改名直後もここで反映）。
    setAdminDocumentTitle(meUser.displayName);
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
  byId("copyMcpUrl")?.addEventListener("click", async (event: Dynamic) => {
    try {
      await navigator.clipboard.writeText(mcpUrl);
      toast(t("copySuccess"), false, event.currentTarget);
    } catch {
      toast(t("copyFailed"), true, event.currentTarget);
    }
  });
  byId("copyMcpConfig")?.addEventListener("click", async (event: Dynamic) => {
    try {
      await navigator.clipboard.writeText(mcpCmd);
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
  // ── Passkey (device) management ────────────────────────────────────────
  async function loadPasskeys() {
    const listEl = byId("passkeyList");
    if (!listEl) return;
    if (state.preview) {
      listEl.innerHTML =
        "<div class='tokenRow'><div><b>This device</b><div class='tokenMeta'>" +
        formatDateTime(new Date().toISOString()) +
        "</div></div></div>";
      return;
    }
    const data = await api("/api/me/passkeys");
    const items = data.passkeys || [];
    listEl.innerHTML =
      items
        .map(function (pk: Dynamic) {
          const meta =
            escapeHtml(t("passkeyCreated")) +
            " " +
            escapeHtml(formatDateTime(pk.created_at)) +
            (pk.last_used_at
              ? " · " +
                escapeHtml(t("passkeyLastUsed")) +
                " " +
                escapeHtml(formatDateTime(pk.last_used_at))
              : "");
          return (
            "<div class='tokenRow'><div><b>" +
            escapeHtml(pk.display_name || t("passkeyDevices")) +
            "</b>" +
            (pk.current
              ? " <span class='tokenMeta' style='color:var(--brand,#157a6e);font-weight:600'>（" +
                escapeHtml(t("passkeyCurrent")) +
                "）</span>"
              : "") +
            "<div class='tokenMeta'>" +
            meta +
            "</div></div><div style='display:flex;gap:6px'>" +
            "<button class='secondary' data-rename-passkey='" +
            escapeHtml(pk.credential_id) +
            "' data-name='" +
            escapeHtml(pk.display_name || "") +
            "'>&#9998; " +
            escapeHtml(t("rename")) +
            "</button><button class='danger' data-delete-passkey='" +
            escapeHtml(pk.credential_id) +
            "'>&#128465; " +
            escapeHtml(t("delete")) +
            "</button></div></div>"
          );
        })
        .join("") ||
      "<div class='tokenMeta'>" + escapeHtml(t("noDocuments")) + "</div>";
  }

  // Register a passkey for THIS device on the already-signed-in account.
  async function addThisDevice(deviceName: string, btn: Dynamic) {
    const beginData = await api("/api/auth/passkey/register/begin", {
      method: "POST",
      body: "{}",
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
        deviceName: deviceName,
        credential: serializeCredentialForRegistration(
          credential as PublicKeyCredential,
        ),
      }),
    });
    toast(t("passkeyAdded"), false, btn);
    await loadPasskeys();
  }

  byId("addPasskeyForm")!.addEventListener("submit", function (event: Dynamic) {
    event.preventDefault();
    const btn =
      event.submitter || event.target.querySelector("button[type=submit]");
    if (state.preview) {
      toast(t("previewReadOnly"), false, btn);
      return;
    }
    openEntryDialog(
      t("addPasskey"),
      "<label>" +
        escapeHtml(t("passkeyNameLabel")) +
        "<input id='newPasskeyName' placeholder='" +
        escapeHtml(t("passkeyNamePlaceholder")) +
        "' /></label>",
      t("addPasskey"),
      async function (form: Dynamic, close: Dynamic) {
        const name = (
          form.querySelector("#newPasskeyName")?.value || ""
        ).trim();
        try {
          await addThisDevice(name, btn);
          close();
        } catch (error) {
          toast(errorMessage(error), true, btn);
        }
      },
    );
  });

  byId("passkeyList")!.addEventListener("click", async function (e: Dynamic) {
    const renameBtn = e.target.closest("[data-rename-passkey]");
    if (renameBtn) {
      if (state.preview) return;
      const credentialId = renameBtn.getAttribute("data-rename-passkey");
      const current = renameBtn.getAttribute("data-name") || "";
      openEntryDialog(
        t("rename"),
        "<label>" +
          escapeHtml(t("passkeyNameLabel")) +
          "<input id='renamePasskeyName' value='" +
          escapeHtml(current) +
          "' /></label>",
        t("save"),
        async function (form: Dynamic, close: Dynamic) {
          const name = (
            form.querySelector("#renamePasskeyName")?.value || ""
          ).trim();
          if (!name) return;
          try {
            await api("/api/me/passkeys/" + encodeURIComponent(credentialId), {
              method: "PATCH",
              body: JSON.stringify({ displayName: name }),
            });
            close();
            toast(t("passkeyRenamed"), false, renameBtn);
            await loadPasskeys();
          } catch (error) {
            toast(errorMessage(error), true, renameBtn);
          }
        },
      );
      return;
    }
    const deleteBtn = e.target.closest("[data-delete-passkey]");
    if (!deleteBtn || state.preview) return;
    const credentialId = deleteBtn.getAttribute("data-delete-passkey");
    openEntryDialog(
      t("delete") + " — " + t("passkeyDevices"),
      "<p class='muted'>" + escapeHtml(t("passkeyDeleteConfirm")) + "</p>",
      t("delete"),
      async function (_: Dynamic, close: Dynamic) {
        try {
          await api("/api/me/passkeys/" + encodeURIComponent(credentialId), {
            method: "DELETE",
          });
          close();
          toast(t("passkeyRemoved"), false, deleteBtn);
          await loadPasskeys();
        } catch (error) {
          toast(errorMessage(error), true, deleteBtn);
        }
      },
    );
  });

  await loadProfileAndTokens();
  await loadPasskeys();
}
