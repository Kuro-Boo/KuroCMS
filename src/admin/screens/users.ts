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
    const d = await api("/api/users");
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
    list.innerHTML =
      "<table style='width:100%;border-collapse:collapse;font-size:13px'>" +
      "<thead><tr style='border-bottom:2px solid var(--line);text-align:left'>" +
      "<th style='padding:10px 14px;font-weight:700;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em'>" +
      escapeHtml(t("email")) +
      "</th>" +
      "<th style='padding:10px 14px;font-weight:700;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em'>" +
      escapeHtml(t("roles")) +
      "</th>" +
      "<th style='padding:10px 14px;font-weight:700;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em'>" +
      escapeHtml(t("userStatus")) +
      "</th>" +
      "<th style='padding:10px 14px;font-weight:700;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em'>" +
      escapeHtml(t("registeredDate")) +
      "</th>" +
      "<th style='padding:10px 14px;font-weight:700;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em'>" +
      escapeHtml(t("lastLoginDate")) +
      "</th>" +
      "<th style='padding:10px 14px'></th>" +
      "</tr></thead>" +
      "<tbody>" +
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
          return (
            "<tr style='border-bottom:1px solid var(--line)'>" +
            "<td style='padding:12px 14px'><span style='font-weight:600'>" +
            escapeHtml(u.email) +
            "</span>" +
            (u.display_name
              ? "<br><span style='font-size:11px;color:var(--muted)'>" +
                escapeHtml(u.display_name) +
                "</span>"
              : "") +
            "</td>" +
            "<td style='padding:12px 14px;' ><span style='" +
            roleColor +
            "'>" +
            role +
            "</span></td>" +
            "<td style='padding:12px 14px'>" +
            statusBadge +
            "</td>" +
            "<td style='padding:12px 14px;color:var(--muted)'>" +
            date +
            "</td>" +
            "<td style='padding:12px 14px;color:var(--muted)'>" +
            lastLogin +
            "</td>" +
            "<td style='padding:12px 14px;text-align:right'>" +
            "<div style='display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap'>" +
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
            "</td>" +
            "</tr>"
          );
        })
        .join("") +
      "</tbody></table>";

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
            try {
              await api("/api/users/" + uid, {
                method: "PUT",
                body: JSON.stringify({
                  isAdmin: role === "admin",
                  isAuthor: role === "admin" || role === "author",
                  disabled: newDisabled,
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
          const inviteUrl =
            window.location.origin +
            withBase("/kurocms/admin/?invite=" + d.token);
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
