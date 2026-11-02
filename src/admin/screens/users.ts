// KuroCMS admin screen module. Concatenated by scripts/build-admin.js.

async function loadUsersPanel() {
  shell(
    t("userManager"),
    "<div class='panel stack'>" +
      "<div class='panelHead'>" +
      "<h3>" +
      escapeHtml(t("userManager")) +
      "</h3>" +
      "<button type='button' id='inviteUserBtn'>" +
      escapeHtml(t("inviteUser")) +
      "</button>" +
      "</div>" +
      "<div id='userList'><div style='padding:24px;text-align:center;color:var(--muted);font-size:13px'>" +
      escapeHtml(t("loading")) +
      "</div></div>" +
      "</div>",
  );

  async function renderUsers() {
    // 自分(ログイン中のアカウント)を引いて、一覧の行に札を付ける。引けなくても一覧は出す。
    const [d, me] = await Promise.all([
      api("/api/users"),
      api("/api/me").catch(() => null),
    ]);
    const users = d.users || [];
    const list = byId("userList");
    if (!list) return;
    if (!users.length) {
      list.innerHTML =
        "<div style='padding:24px;text-align:center;color:var(--muted);font-size:13px'>" +
        escapeHtml(t("noUsers")) +
        "</div>";
      return;
    }
    // 1 人を 2 行で見せる(2026-11-02)。1 行目はメールアドレス(長くても折り返さず読める)と「ログイン中」の札、
    // 2 行目は表示名・権限・状態・登録日・最終ログイン。表の列ではメールアドレスの枠が狭く、途中で折り返していた。
    const meUid = me?.user?.uid ?? null;
    const sep = "<span style='color:var(--line-strong)'>·</span>";
    list.innerHTML =
      "<div style='display:flex;flex-direction:column'>" +
      users
        .map(function (u: Dynamic) {
          const role = u.is_admin
            ? t("adminRole")
            : u.is_author
              ? t("authorRole")
              : "—";
          const roleColor = u.is_admin
            ? "color:#f97316;font-weight:700"
            : "color:var(--muted)";
          const disabled = !!u.disabled_at;
          const statusBadge = disabled
            ? "<span style='font-size:10px;background:#fee2e2;color:#b91c1c;border:1px solid #fca5a5;border-radius:4px;padding:1px 6px'>" +
              escapeHtml(t("disabled")) +
              "</span>"
            : "<span style='font-size:10px;background:#dcfce7;color:#15803d;border:1px solid #86efac;border-radius:4px;padding:1px 6px'>" +
              escapeHtml(t("active")) +
              "</span>";
          const date = u.created_at ? u.created_at.slice(0, 10) : "—";
          const lastLogin = u.last_login_at
            ? u.last_login_at.slice(0, 10)
            : "—";
          const isMe = meUid !== null && u.uid === meUid;
          return (
            "<div style='display:flex;align-items:center;gap:16px;padding:14px 4px;border-bottom:1px solid var(--line)'>" +
            "<div style='flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:6px'>" +
            // 1 行目: メールアドレスと「ログイン中」
            "<div style='display:flex;align-items:center;gap:8px;flex-wrap:wrap'>" +
            "<span style='font-weight:700;font-size:14px;overflow-wrap:anywhere'>" +
            escapeHtml(u.email) +
            "</span>" +
            (isMe
              ? "<span style='font-size:10px;font-weight:700;background:var(--accent-soft);color:var(--accent);border:1px solid var(--accent);border-radius:999px;padding:1px 8px'>" +
                escapeHtml(t("currentAccountBadge")) +
                "</span>"
              : "") +
            "</div>" +
            // 2 行目: 表示名・権限・状態・登録日・最終ログイン
            "<div style='display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--muted)'>" +
            (u.display_name
              ? "<span>" + escapeHtml(u.display_name) + "</span>" + sep
              : "") +
            "<span style='" +
            roleColor +
            "'>" +
            role +
            "</span>" +
            sep +
            statusBadge +
            sep +
            "<span>" +
            escapeHtml(t("registeredDate")) +
            " " +
            date +
            "</span>" +
            sep +
            "<span>" +
            escapeHtml(t("lastLoginDate")) +
            " " +
            lastLogin +
            "</span>" +
            "</div>" +
            "</div>" +
            "<div style='flex:0 0 auto;display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap'>" +
            "<button type='button' class='secondary' style='font-size:11px;padding:4px 10px' data-uid='" +
            escapeHtml(u.uid) +
            "' data-email='" +
            escapeHtml(u.email) +
            "' data-is-admin='" +
            (u.is_admin ? "1" : "0") +
            "' data-is-author='" +
            (u.is_author ? "1" : "0") +
            "' data-disabled='" +
            (disabled ? "1" : "0") +
            "' data-action='edit'>&#9998; " +
            escapeHtml(t("edit")) +
            "</button>" +
            "<button type='button' class='danger-soft' style='font-size:11px;padding:4px 10px' data-uid='" +
            escapeHtml(u.uid) +
            "' data-email='" +
            escapeHtml(u.email) +
            "' data-action='delete'>&#128465; " +
            escapeHtml(t("delete")) +
            "</button>" +
            "</div>" +
            "</div>"
          );
        })
        .join("") +
      "</div>";

    byId("userList")?.addEventListener("click", async function (e: Dynamic) {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const uid = btn.dataset.uid;
      const email = btn.dataset.email;
      const action = btn.dataset.action;

      if (action === "edit") {
        const isAdmin = btn.dataset.isAdmin === "1";
        const isAuthor = btn.dataset.isAuthor === "1";
        const disabled = btn.dataset.disabled === "1";
        openEntryDialog(
          t("editUserTitle") + email,
          // メールは【本人以外は誰も直せない】状態だった（プロフィール画面に
          // しか変更手段が無い）。⚠ メールはパスキー復旧の宛先（recoverRequest
          // が email で本人を引く）なので、打ち間違えたまま本人がログイン
          // できなくなると復旧不能になる。管理者が直せるようにする。
          "<label style='margin-bottom:8px'>" +
            escapeHtml(t("email")) +
            "<input id='editUserEmail' type='email' style='width:100%' value='" +
            escapeHtml(email || "") +
            "' />" +
            "</label>" +
            "<label style='margin-bottom:8px'>" +
            escapeHtml(t("roles")) +
            "<select id='editUserRole' style='width:100%'>" +
            "<option value='admin'" +
            (isAdmin ? " selected" : "") +
            ">" +
            escapeHtml(t("adminRole")) +
            "</option>" +
            "<option value='author'" +
            (!isAdmin && isAuthor ? " selected" : "") +
            ">" +
            escapeHtml(t("authorRole")) +
            "</option>" +
            "<option value='none'" +
            (!isAdmin && !isAuthor ? " selected" : "") +
            ">" +
            escapeHtml(t("noRole")) +
            "</option>" +
            "</select>" +
            "</label>" +
            "<label style='display:flex;align-items:center;gap:8px;margin-top:8px'><input type='checkbox' id='editUserDisabled'" +
            (disabled ? " checked" : "") +
            "> " +
            escapeHtml(t("disableAccount")) +
            "</label>",
          t("save"),
          async function (form: Dynamic, close: Dynamic) {
            const role = form.querySelector("#editUserRole")?.value || "author";
            const newDisabled =
              form.querySelector("#editUserDisabled")?.checked || false;
            const newEmail = (
              form.querySelector("#editUserEmail")?.value || ""
            ).trim();
            try {
              await api("/api/users/" + uid, {
                method: "PUT",
                body: JSON.stringify({
                  isAdmin: role === "admin",
                  isAuthor: role === "admin" || role === "author",
                  disabled: newDisabled,
                  // 変わっていないときは送らない（no_changes 判定を汚さない）
                  ...(newEmail && newEmail !== email
                    ? { email: newEmail }
                    : {}),
                }),
              });
              close();
              toast(t("userUpdated"), false);
              await renderUsers();
            } catch (err) {
              toast(errorMessage(err), true);
            }
          },
        );
      }

      if (action === "delete") {
        openEntryDialog(
          t("deleteUserTitle"),
          "<p>" +
            escapeHtml(email) +
            escapeHtml(t("confirmDeleteUserPost")) +
            "</p>",
          t("delete"),
          async function (_: Dynamic, close: Dynamic) {
            try {
              await api("/api/users/" + uid, { method: "DELETE" });
              close();
              toast(t("userDeletedToast"), false);
              await renderUsers();
            } catch (err) {
              toast(errorMessage(err), true);
            }
          },
        );
      }
    });
  }

  byId("inviteUserBtn")?.addEventListener("click", function () {
    openEntryDialog(
      t("inviteUser"),
      "<label>" +
        escapeHtml(t("email")) +
        "<input id='inviteEmail' type='email' placeholder='user@example.com' /></label>" +
        "<label style='margin-top:8px'>" +
        escapeHtml(t("roles")) +
        "<select id='inviteRole' style='width:100%'><option value='author'>" +
        escapeHtml(t("authorRole")) +
        "</option><option value='admin'>" +
        escapeHtml(t("adminRole")) +
        "</option></select></label>",
      t("inviteSubmit"),
      async function (form: Dynamic, close: Dynamic) {
        const email = form.querySelector("#inviteEmail")?.value?.trim() || "";
        const role = form.querySelector("#inviteRole")?.value || "author";
        if (!email) {
          toast(t("emailRequired"), true);
          return;
        }
        try {
          const d = await api("/api/invitations", {
            method: "POST",
            body: JSON.stringify({
              email,
              isAdmin: role === "admin",
              isAuthor: true,
            }),
          });
          close();
          // ⚠ withBase() は既にベースパス（/kurocms 等）を前置する。そこへ
          //   "/kurocms/admin/" を重ねていたため /kurocms/kurocms/admin/ という
          //   404 の URL が出来ていた（招待リンクが常に無効だった）。
          //   管理画面の入口は adminHref("/") が正しく返す（legacy = /base/admin、
          //   それ以外 = /base）。
          const inviteUrl =
            window.location.origin +
            adminHref("/") +
            "?invite=" +
            encodeURIComponent(d.token);
          openEntryDialog(
            t("inviteLink"),
            "<p style='font-size:13px;margin-bottom:10px'>" +
              escapeHtml(email) +
              escapeHtml(t("inviteExpiryMsg")) +
              "</p>" +
              "<div style='font-family:monospace;font-size:12px;background:var(--surface-2,#f7f8fb);border:1px solid var(--line);border-radius:8px;padding:12px;word-break:break-all'>" +
              escapeHtml(inviteUrl) +
              "</div>",
            t("copyAndClose"),
            async function (_: Dynamic, close2: Dynamic) {
              try {
                await navigator.clipboard.writeText(inviteUrl);
                toast(t("copySuccess"), false);
              } catch {
                toast(t("copyFailed"), true);
              }
              close2();
            },
          );
        } catch (err) {
          toast(errorMessage(err), true);
        }
      },
    );
  });

  try {
    await renderUsers();
  } catch (err) {
    toast(errorMessage(err), true);
  }
}
