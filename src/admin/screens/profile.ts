// KuroCMS admin screen module. Concatenated by scripts/build-admin.js.

/**
 * メールの「確認済み / 未確認」(そのアドレスに届いたリンクを開けたか・招待・パスキーの再設定・確認メール)。
 * 未確認なら「確認メールを送る」を出す。アドレスを変えて保存すると未確認に戻る(サーバー)。
 */
function paintEmailVerified(meUser: Dynamic) {
  const badge = byId("profileEmailBadge");
  const area = byId("profileEmailVerify");
  if (!badge || !area) return;
  const ok = !!meUser.emailVerifiedAt;
  badge.innerHTML = ok
    ? "<span class='badge' title='" +
      escapeHtml(formatDateTime(meUser.emailVerifiedAt)) +
      "'>✓ " +
      escapeHtml(t("emailVerified")) +
      "</span>"
    : "<span class='badge' style='background:var(--surface-2);color:var(--muted)'>" +
      escapeHtml(t("emailUnverified")) +
      "</span>";
  area.innerHTML = ok
    ? ""
    : "<button type='button' class='secondary' id='sendEmailVerifyBtn' style='font-size:12px;padding:5px 12px'>" +
      escapeHtml(t("emailVerifySend")) +
      "</button>";
  byId("sendEmailVerifyBtn")?.addEventListener("click", async (e: Dynamic) => {
    const btn = e.currentTarget as HTMLButtonElement;
    if (state.preview) {
      toast(t("previewReadOnly"), false, btn);
      return;
    }
    btn.disabled = true;
    try {
      const res = (await api("/api/me/email/verify", {
        method: "POST",
        body: JSON.stringify({ lang: state.uiLang }),
      })) as { alreadyVerified?: boolean };
      toast(
        res.alreadyVerified ? t("emailVerified") : t("emailVerifySent"),
        false,
        btn,
      );
    } catch (error) {
      toast(errorMessage(error), true, btn);
      btn.disabled = false;
    }
  });
}

async function profile() {
  // MCP endpoint for THIS instance. withBase() yields the same base the admin
  // uses for its own API calls, so this is correct regardless of basePath.
  const mcpUrl = new URL(withBase("/api/mcp"), location.origin).href;
  const mcpCmd =
    "claude mcp add --transport http kurocms " +
    mcpUrl +
    ' --header "Authorization: Bearer kuro_<PAT>"';
  // タブで分ける(アカウント・表示・PAT・パスキー・IP 制限)。部品は設定画面のタブと同じ。
  const profileTabs: Array<[string, string]> = [
    ["account", t("profileTabAccount")],
    ["display", t("profileTabDisplay")],
    ["pat", t("profileTabPat")],
    ["passkey", t("profileTabPasskey")],
    ["network", t("profileTabNetwork")],
  ];
  shell(
    t("profile"),
    "<div class='settingsTabBar'>" +
      profileTabs
        .map(
          ([id, label]) =>
            "<button type='button' class='settingsTab" +
            (id === "account" ? " active" : "") +
            "' data-tab='" +
            id +
            "'>" +
            escapeHtml(label) +
            "</button>",
        )
        .join("") +
      "</div>" +
      "<div id='panel-account' class='settingsPanel stack'><div class='panel stack'><h3>" +
      escapeHtml(t("profileIdentity")) +
      // 管理番号は設定 → 契約の「サイトの持ち主」の枠へ移した(2026-11-02・利用者)。
      "</h3>" +
      // 3 段(2026-11-02・利用者の指示): ユーザー名と権限を 2 列、メールは全幅(入力の右に確認メールのボタン・下に説明)、
      // ユーザー ID は全幅で小さく。メールの説明とボタンが片方の列だけを伸ばして、列の高さが揃わなかった。
      "<form class='stack' id='accountForm'><div class='fieldGrid'><label>" +
      escapeHtml(t("displayName")) +
      "<input id='profileDisplayName' /></label>" +
      "<div><div class='fieldLabel'>" +
      escapeHtml(t("roles")) +
      "</div><div style='padding:10px 0'><span id='profileRoles' class='contractBadge'>-</span></div></div>" +
      "</div>" +
      "<label><span style='display:flex;align-items:center;gap:8px'>" +
      escapeHtml(t("email")) +
      "<span id='profileEmailBadge'></span></span>" +
      "<div style='display:flex;gap:8px;align-items:center;flex-wrap:wrap'>" +
      "<input id='profileEmail' type='email' style='flex:1;min-width:220px' />" +
      "<div id='profileEmailVerify'></div></div>" +
      "<div class='muted' style='font-size:12px;line-height:1.6'>" +
      escapeHtml(t("profileEmailHelp")) +
      "</div></label>" +
      "<div><div class='fieldLabel'>" +
      escapeHtml(t("userIdLabel")) +
      "</div><div style='display:flex;gap:8px;align-items:center'><div id='profileAuthorId' class='tokenBox' style='flex:1;min-width:0;font-size:11px;font-family:ui-monospace,monospace;padding:8px 12px'>-</div><button type='button' class='secondary' id='copyAuthorId' style='font-size:12px;padding:6px 12px'>" +
      escapeHtml(t("copy")) +
      "</button></div></div>" +
      // 更新は左、ログアウトは右(枠の中・区切り線の下)。全幅のボタンにしない。
      "<div style='display:flex;flex-wrap:wrap;gap:10px;align-items:center;border-top:1px solid var(--line);padding-top:14px'><button>" +
      escapeHtml(t("updateAccount")) +
      "</button><button type='button' class='danger' id='logoutBtn' style='margin-left:auto'>" +
      escapeHtml(t("logout")) +
      "</button></div></form></div></div>" +
      "<div id='panel-display' class='settingsPanel stack' style='display:none'><div class='panel stack'><h3>" +
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
      " /></div></div></div>" +
      // PAT とMCP(2026-11-04 に幅を入れ替えた): 左 2/3 に PAT の作成と履歴、右 1/3 に MCP の繋ぎ方。
      // 狭い画面では PAT が上、MCP が下に並ぶ。部品の id は変えない(下のコピー・作成の動きがそのまま効く)。
      "<div id='panel-pat' class='settingsPanel stack' style='display:none'>" +
      "<div style='display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start'>" +
      // ── 左 2/3: Personal Access Token ─────────────────────────────────
      "<div class='panel stack' style='flex:2 1 460px;min-width:0'>" +
      // 追加のボタンは枠の中の右上(仕様 core-style-s3-8)。見出しは 12em を下回らせず、入らなければボタンを見出しの下へ
      // 折り返す(見出しを縮めると 1 文字ずつ縦に割れた)。ボタンは枠より広くならないよう、狭いときは文言を折り返す。
      "<div style='display:flex;flex-wrap:wrap;align-items:center;gap:12px 20px'><h3 style='flex:1 1 12em;margin:0'>" +
      escapeHtml(t("profileApiAccess")) +
      "</h3><form id='tokenForm' style='flex:0 1 auto;max-width:100%;margin:0;display:flex;gap:8px;align-items:center;flex-wrap:wrap'>" +
      // 期限(課題 fbcf9bd6)。期限の無い鍵は作れない。既定は 90 日。
      "<label class='muted' style='font-size:12px;display:flex;gap:6px;align-items:center'>" +
      escapeHtml(t("patExpiry")) +
      "<select id='tokenExpiry'>" +
      [30, 90, 365]
        .map(
          (d) =>
            "<option value='" +
            d +
            "'" +
            (d === 90 ? " selected" : "") +
            ">" +
            escapeHtml(t("patExpiryDays").replace("{n}", String(d))) +
            "</option>",
        )
        .join("") +
      "</select></label><button style='max-width:100%'>" +
      escapeHtml(t("createPatAction")) +
      "</button></form></div><p class='muted' style='margin:-4px 0 2px'>" +
      escapeHtml(t("profileApiAccessLead")) +
      "</p><div class='stack' style='gap:8px'><div class='tokenLabel'>" +
      escapeHtml(t("generatedToken")) +
      "</div><div class='tokenHelp'>" +
      escapeHtml(t("patScopeNote")) +
      "</div><div class='tokenOutputRow'><div id='generatedToken' class='tokenBox'></div><button class='secondary' id='copyToken'>" +
      escapeHtml(t("copy")) +
      "</button></div></div><div class='stack' style='gap:8px'><div class='tokenMeta'>" +
      escapeHtml(t("tokenHistory")) +
      "</div><div id='tokenHistory' class='tokenList'></div></div></div>" +
      // ── 右 1/3: MCP で繋ぐ(接続先の URL とクライアントの設定) ──────────
      "<div class='panel stack' style='flex:1 1 300px;min-width:0'><h3>" +
      escapeHtml(t("mcpConnectTitle")) +
      "</h3><p class='muted' style='margin:-4px 0 2px'>" +
      escapeHtml(t("mcpConnectLead")) +
      "</p><div class='stack' style='gap:8px'><div class='tokenLabel'>" +
      escapeHtml(t("mcpEndpointLabel")) +
      "</div><div class='tokenOutputRow'><div id='mcpEndpoint' class='tokenBox' style='font-size:11px;font-family:ui-monospace,monospace;word-break:break-all'>" +
      escapeHtml(mcpUrl) +
      "</div><button type='button' class='secondary' id='copyMcpUrl'>" +
      escapeHtml(t("copy")) +
      "</button></div></div><div class='stack' style='gap:8px'><div class='tokenLabel'>" +
      escapeHtml(t("mcpConfigLabel")) +
      "</div><div class='tokenOutputRow'><div id='mcpConfig' class='tokenBox' style='font-size:11px;font-family:ui-monospace,monospace;white-space:pre-wrap;word-break:break-all'>" +
      escapeHtml(mcpCmd) +
      "</div><button type='button' class='secondary' id='copyMcpConfig'>" +
      escapeHtml(t("copy")) +
      "</button></div></div></div>" +
      "</div>" +
      "</div>" +
      // ── Passkey (device) management ──────────────────────────────────
      // デバイス(2026-11-02): 左 1/2 にログイン中の端末、右 1/2 にパスキーの管理。狭い画面では縦に並ぶ。
      "<div id='panel-passkey' class='settingsPanel stack' style='display:none'>" +
      "<div style='display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start'>" +
      "<div class='panel stack' style='flex:1 1 360px;min-width:0'><h3 style='margin:0'>" +
      escapeHtml(t("deviceSessionsTitle")) +
      "</h3><p class='muted' style='margin:-4px 0 2px'>" +
      escapeHtml(t("deviceSessionsLead")) +
      "</p><div id='sessionList' class='tokenList'></div></div>" +
      "<div class='panel stack' style='flex:1 1 360px;min-width:0'>" +
      // 追加のボタンは枠の中の右上(仕様 core-style-s3-8)。
      // 見出しとボタンは PAT の枠と同じく、入らなければボタンを見出しの下へ折り返す。
      "<div style='display:flex;flex-wrap:wrap;align-items:center;gap:12px 20px'><h3 style='flex:1 1 12em;margin:0'>" +
      escapeHtml(t("passkeyManageTitle")) +
      "</h3><form id='addPasskeyForm' style='flex:0 1 auto;max-width:100%;margin:0'><button style='max-width:100%'>" +
      escapeHtml(t("addPasskey")) +
      "</button></form></div><p class='muted' style='margin:-4px 0 2px'>" +
      escapeHtml(t("passkeyDevicesLead")) +
      "</p><div id='passkeyList' class='tokenList'></div></div>" +
      "</div>" +
      "</div>" +
      // ── 登録した回線(IP 制限・ip-gate.ts)。登録は全自動で、ここは見て外すだけ ──
      "<div id='panel-network' class='settingsPanel stack' style='display:none'><div class='panel stack' id='networkPanel'><h3>" +
      escapeHtml(t("myNetworks")) +
      "</h3><p class='muted' style='margin:-4px 0 2px'>" +
      escapeHtml(t("myNetworksLead")) +
      "</p><div id='networkList'></div></div></div>",
  );
  document.querySelectorAll<AdminElement>(".settingsTab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.tab;
      document
        .querySelectorAll<AdminElement>(".settingsTab")
        .forEach((el) => el.classList.toggle("active", el === btn));
      document
        .querySelectorAll<AdminElement>(".settingsPanel")
        .forEach((el) => {
          el.style.display = el.id === "panel-" + id ? "" : "none";
        });
    });
  });
  // 確認のリンクから戻ってきた(?emailVerify=ok|expired|invalid|changed)。結果を出して印を外す。
  {
    const params = new URLSearchParams(location.search);
    const r = params.get("emailVerify");
    if (r) {
      const msg: Record<string, string> = {
        ok: t("emailVerifyDone"),
        expired: t("emailVerifyExpired"),
        changed: t("emailVerifyChanged"),
      };
      toast(msg[r] || t("emailVerifyInvalid"), r !== "ok");
      params.delete("emailVerify");
      const q = params.toString();
      history.replaceState(null, "", location.pathname + (q ? "?" + q : ""));
    }
  }
  byId("logoutBtn")?.addEventListener("click", async () => {
    // 鍵になるものを手元から消す(課題 78566a3d)。このタブで覚えた鍵と、前の版が置いた鍵。
    try {
      sessionStorage.clear();
      localStorage.removeItem("kurocms_pat");
      localStorage.removeItem("kurocms_site_move_ops");
    } catch {
      /* 使えない環境では、そもそも置いていない */
    }
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
    paintEmailVerified(meUser);
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
            " · " +
            escapeHtml(
              !token.expiresAt
                ? t("patNoExpiry")
                : Date.parse(token.expiresAt) <= Date.now()
                  ? t("patExpired")
                  : t("patExpiresAt").replace(
                      "{date}",
                      formatDateTime(token.expiresAt),
                    ),
            ) +
            "</div></div>" +
            btn +
            "</div>"
          );
        })
        .join("") ||
      "<div class='tokenMeta'>" + escapeHtml(t("listEmpty")) + "</div>";
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
        body: JSON.stringify({
          name: "Personal token",
          expiresInDays: Number(
            (byId("tokenExpiry") as HTMLSelectElement | null)?.value || 90,
          ),
        }),
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
  // ── 登録した回線(IP 制限) ───────────────────────────────────────────────
  async function loadNetworks() {
    const listEl = byId("networkList");
    if (!listEl || state.preview) return;
    let data: Dynamic;
    try {
      data = await api("/api/auth/networks");
    } catch {
      return;
    }
    const panel = byId("networkPanel");
    if (panel && data.enabled === false) {
      listEl.innerHTML =
        "<div class='tokenMeta'>" + escapeHtml(t("myNetworksOff")) + "</div>";
      return;
    }
    const cur = data.current ? data.current.net : "";
    // 左 1/2 に IPv6、右 1/2 に IPv4(2026-11-02)。狭い画面では縦に並ぶ。
    const row = function (n: Dynamic) {
      // 固定の行(設定の「登録 IPv6」で手で足したもの)は期限が無い。
      const meta = n.pinned
        ? escapeHtml(t("ipV6Pinned")) + " · " + escapeHtml(t("ipV6NoExpiry"))
        : escapeHtml(t("networkLastUsed")) +
          " " +
          escapeHtml(formatDateTime(new Date(n.last_seen_at).toISOString())) +
          " · " +
          escapeHtml(t("networkExpires")) +
          " " +
          escapeHtml(formatDateTime(new Date(n.expires_at).toISOString()));
      return (
        "<div class='tokenRow'><div><b>" +
        escapeHtml(n.net) +
        "</b>" +
        (n.note || n.label
          ? " <span class='tokenMeta'>" +
            escapeHtml(n.note || n.label) +
            "</span>"
          : "") +
        (n.net === cur
          ? " <span class='tokenMeta' style='color:var(--brand,#157a6e);font-weight:600'>（" +
            escapeHtml(t("networkCurrent")) +
            "）</span>"
          : "") +
        "<div class='tokenMeta'>" +
        meta +
        "</div></div><div><button class='danger' data-remove-network='" +
        escapeHtml(n.id) +
        "'>&#128465; " +
        escapeHtml(t("delete")) +
        "</button></div></div>"
      );
    };
    const all = (data.networks || []) as Dynamic[];
    const col = (title: string, items: Dynamic[]) =>
      "<div class='stack' style='flex:1 1 320px;min-width:0;gap:10px'><div class='fieldLabel' style='margin:0'>" +
      escapeHtml(title) +
      "</div><div class='tokenList'>" +
      (items.map(row).join("") ||
        "<div class='tokenMeta'>" + escapeHtml(t("listEmpty")) + "</div>") +
      "</div></div>";
    const v6 = all.filter((n) => String(n.net).includes(":"));
    const v4 = all.filter((n) => !String(n.net).includes(":"));
    listEl.innerHTML =
      "<div style='display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start'>" +
      col("IPv6", v6) +
      col("IPv4", v4) +
      "</div>";
    listEl
      .querySelectorAll<AdminElement>("[data-remove-network]")
      .forEach((btn) => {
        btn.addEventListener("click", async () => {
          if (!confirm(t("networkRemoveConfirm"))) return;
          try {
            await api(
              "/api/auth/networks/" +
                encodeURIComponent(btn.dataset.removeNetwork || ""),
              { method: "DELETE" },
            );
            await loadNetworks();
          } catch (err) {
            toast(errorMessage(err), true, btn);
          }
        });
      });
  }
  loadNetworks();

  // ── Passkey (device) management ────────────────────────────────────────
  /** ログイン中の端末(me-sessions.ts)。名前はログインに使ったパスキーのデバイス名。今の端末には札、ほかはログアウトさせられる。 */
  async function loadSessions() {
    const listEl = byId("sessionList");
    if (!listEl) return;
    if (state.preview) {
      listEl.innerHTML =
        "<div class='tokenRow'><div><b>This device</b></div></div>";
      return;
    }
    const data = await api("/api/me/sessions");
    const items = data.sessions || [];
    listEl.innerHTML =
      items
        .map(function (s: Dynamic) {
          const meta =
            escapeHtml(t("sessionSignedIn")) +
            " " +
            escapeHtml(s.created_at ? formatDateTime(s.created_at) : "—") +
            " · " +
            escapeHtml(t("sessionLastActive")) +
            " " +
            escapeHtml(
              s.last_active_at ? formatDateTime(s.last_active_at) : "—",
            );
          return (
            "<div class='tokenRow stacked'><div class='tokenRowName'><b>" +
            escapeHtml(s.device || t("sessionUnknownDevice")) +
            "</b>" +
            (s.current
              ? " <span style='font-size:10px;font-weight:700;background:var(--accent-soft);color:var(--accent);border:1px solid var(--accent);border-radius:999px;padding:1px 8px'>" +
                escapeHtml(t("sessionThisDevice")) +
                "</span>"
              : "") +
            "</div><div class='tokenRowFoot'><div class='tokenMeta'>" +
            meta +
            "</div>" +
            (s.current
              ? ""
              : "<div class='tokenRowActions'><button class='danger-soft' style='white-space:nowrap' data-revoke-session='" +
                escapeHtml(s.id) +
                "'>" +
                escapeHtml(t("sessionRevoke")) +
                "</button></div>") +
            "</div></div>"
          );
        })
        .join("") ||
      "<div class='tokenMeta'>" + escapeHtml(t("listEmpty")) + "</div>";
  }

  byId("sessionList")?.addEventListener("click", function (e: Dynamic) {
    const btn = e.target.closest("[data-revoke-session]");
    if (!btn || state.preview) return;
    const id = btn.getAttribute("data-revoke-session");
    if (!id) return;
    openEntryDialog(
      t("sessionRevoke"),
      "<p class='muted'>" + escapeHtml(t("sessionRevokeConfirm")) + "</p>",
      t("sessionRevoke"),
      async (_form: Dynamic, close: Dynamic) => {
        try {
          await api("/api/me/sessions/" + encodeURIComponent(id) + "/revoke", {
            method: "POST",
          });
          close();
          toast(t("sessionRevoked"), false, btn);
          await loadSessions();
        } catch (error) {
          toast(errorMessage(error), true, btn);
        }
      },
    );
  });

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
            "<div class='tokenRow stacked'><div class='tokenRowName'><b>" +
            escapeHtml(pk.display_name || t("passkeyDevices")) +
            "</b>" +
            (pk.current
              ? " <span class='tokenMeta' style='color:var(--brand,#157a6e);font-weight:600'>（" +
                escapeHtml(t("passkeyCurrent")) +
                "）</span>"
              : "") +
            "</div><div class='tokenRowFoot'><div class='tokenMeta'>" +
            meta +
            "</div><div class='tokenRowActions'>" +
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
            "</button></div></div></div>"
          );
        })
        .join("") ||
      "<div class='tokenMeta'>" + escapeHtml(t("listEmpty")) + "</div>";
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
  // ログイン中の端末は読めなくても画面は出す(古い版のサーバーには口が無い)。
  await loadSessions().catch(() => {});
}
