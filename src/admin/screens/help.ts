// KuroCMS admin screen module. Concatenated by scripts/build-admin.js.

function showHelpDialog(key: Dynamic) {
  const existing = byId("helpFloatDlg");
  if (existing) {
    if (existing.dataset.key === key) {
      existing.remove();
      return;
    }
    existing.remove();
  }
  const _hc = state.uiLang === "ja" ? helpContent : helpContentEn;
  const c = _hc[key] || _hc.basic;
  const dlg = document.createElement("div");
  dlg.id = "helpFloatDlg";
  dlg.className = "helpDialog";
  dlg.dataset.key = key;
  dlg.innerHTML =
    "<div class='helpDialogHead' id='helpDlgHead'>" +
    "<span class='helpDialogTitle'>&#10067; " +
    escapeHtml(c.title) +
    "</span>" +
    "<button class='helpDialogClose' id='helpDlgClose'>&#x2715;</button>" +
    "</div>" +
    "<div class='helpDialogBody'>" +
    "<div class='helpSection'><div class='helpSectionTitle'>" +
    escapeHtml(t("helpRoleLabel")) +
    "</div><div>" +
    escapeHtml(c.role) +
    "</div></div>" +
    "<div class='helpSection'><div class='helpSectionTitle'>" +
    escapeHtml(t("helpCanDoLabel")) +
    "</div><div>" +
    escapeHtml(c.canDo)
      .split(" / ")
      .map(function (s) {
        return "・" + s;
      })
      .join("<br>") +
    "</div></div>" +
    "<div class='helpSection'><div class='helpSectionTitle'>" +
    escapeHtml(t("helpNotesLabel")) +
    "</div><div>" +
    (function () {
      const sep = state.uiLang === "ja" ? "。" : ". ";
      return escapeHtml(c.notes)
        .split(sep)
        .filter(function (s) {
          return s.trim();
        })
        .map(function (s) {
          return "・" + s.trim() + (state.uiLang === "ja" ? "。" : ".");
        })
        .join("<br>");
    })() +
    "</div></div>" +
    "</div>";
  document.body.appendChild(dlg);
  byId("helpDlgClose")!.addEventListener("click", function () {
    dlg.remove();
  });

  // Draggable via mouse — transform-based so we never touch left/right/top.
  // The CSS right/top anchoring stays intact, so grabbing the bar does not
  // re-anchor the dialog (no flicker / no jump), and dragging is GPU-smooth.
  const head = byId("helpDlgHead")!;
  let drag = false,
    lastX = 0,
    lastY = 0,
    tx = 0,
    ty = 0;
  head.addEventListener("mousedown", function (e) {
    // Clicking the close button must NOT start a drag (its click must land).
    if ((e.target as Dynamic)?.closest("#helpDlgClose")) return;
    drag = true;
    lastX = e.clientX;
    lastY = e.clientY;
    e.preventDefault(); // avoid text selection while dragging
  });
  document.addEventListener("mousemove", function mv(e) {
    if (!drag) return;
    if (!byId("helpFloatDlg")) {
      document.removeEventListener("mousemove", mv);
      return;
    }
    tx += e.clientX - lastX;
    ty = Math.max(-60, ty + (e.clientY - lastY)); // keep the bar on screen
    lastX = e.clientX;
    lastY = e.clientY;
    dlg.style.transform = "translate(" + tx + "px," + ty + "px)";
  });
  document.addEventListener("mouseup", function () {
    drag = false;
  });
}

async function help() {
  const sections = [
    { key: "basic", label: t("helpBasic"), divider: false },
    { key: "dashboard", label: t("dashboard"), divider: true },
    { key: "newArticle", label: t("newArticle"), divider: false },
    { key: "articles", label: t("articles"), divider: false },
    { key: "images", label: t("images"), divider: true },
    { key: "videos", label: t("videos"), divider: false },
    { key: "audios", label: t("audios"), divider: false },
    { key: "categories", label: t("categories"), divider: true },
    { key: "languages", label: t("languageManager"), divider: false },
    { key: "types", label: t("types"), divider: false },
    { key: "siteManagement", label: t("siteManagement"), divider: true },
    { key: "settings", label: t("settings"), divider: false },
    { key: "users", label: t("userManager"), divider: false },
    { key: "backup", label: t("backup"), divider: false },
    { key: "profile", label: t("profile"), divider: false },
    { key: "faq", label: "Q&A", divider: true },
  ];

  function renderHelpContent(key: Dynamic) {
    const _hc = state.uiLang === "ja" ? helpContent : helpContentEn;
    const c = _hc[key] || _hc.basic;
    if (c.faqs) {
      return (
        "<div class='stack' style='gap:10px'>" +
        "<h2 style='margin:0 0 4px;color:var(--heading);font-size:16px'>" +
        escapeHtml(c.title) +
        "</h2>" +
        c.faqs
          .map(function (item: Dynamic) {
            return (
              "<details style='border:1px solid var(--line);border-radius:8px;overflow:hidden'>" +
              "<summary style='padding:11px 14px;font-size:13px;font-weight:700;cursor:pointer;list-style:none;display:flex;align-items:flex-start;gap:8px;color:var(--ink)'>" +
              "<span style='color:var(--accent);font-weight:900;flex-shrink:0'>Q</span>" +
              "<span>" +
              escapeHtml(item.q) +
              "</span>" +
              "</summary>" +
              "<div style='padding:10px 14px 12px 34px;border-top:1px solid var(--line);background:var(--surface-2);font-size:13px;line-height:1.8;color:var(--ink)'>" +
              "<span style='color:rgb(185,50,80);font-weight:700;margin-right:6px'>A</span>" +
              escapeHtml(item.a) +
              "</div>" +
              "</details>"
            );
          })
          .join("") +
        "</div>"
      );
    }
    return (
      "<div class='stack' style='gap:14px'>" +
      "<h2 style='margin:0 0 4px;color:var(--heading);font-size:16px'>" +
      escapeHtml(c.title) +
      "</h2>" +
      "<div>" +
      "<div style='font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:rgb(185,50,80);margin-bottom:6px'>" +
      escapeHtml(t("helpRoleLabel")) +
      "</div>" +
      "<p style='line-height:1.8;margin:0;font-size:13px'>" +
      escapeHtml(c.role) +
      "</p>" +
      "</div>" +
      "<div>" +
      "<div style='font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);margin-bottom:6px'>" +
      escapeHtml(t("helpCanDoLabel")) +
      "</div>" +
      "<ul style='padding-left:1.2em;line-height:1.9;margin:0;font-size:13px'>" +
      c.canDo
        .split(" / ")
        .map(function (s: Dynamic) {
          return "<li>" + escapeHtml(s.trim()) + "</li>";
        })
        .join("") +
      "</ul>" +
      "</div>" +
      "<div>" +
      "<div style='font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:var(--danger);margin-bottom:6px'>" +
      escapeHtml(t("helpNotesLabel")) +
      "</div>" +
      "<ul style='padding-left:1.2em;line-height:1.9;margin:0;font-size:13px'>" +
      (function () {
        const sep = state.uiLang === "ja" ? "。" : ". ";
        return c.notes
          .split(sep)
          .filter(function (s: Dynamic) {
            return s.trim();
          })
          .map(function (s: Dynamic) {
            return (
              "<li>" +
              escapeHtml(s.trim()) +
              (state.uiLang === "ja" ? "。" : ".") +
              "</li>"
            );
          })
          .join("");
      })() +
      "</ul>" +
      "</div>" +
      "</div>"
    );
  }

  const navHtml = sections
    .map(function (s) {
      return (
        (s.divider ? "<div class='helpNavDivider'></div>" : "") +
        "<button type='button' class='helpNavItem" +
        (s.key === "basic" ? " active" : "") +
        "' data-hkey='" +
        escapeHtml(s.key) +
        "'>" +
        escapeHtml(s.label) +
        "</button>"
      );
    })
    .join("");

  app.innerHTML =
    (state.preview ? previewNoticeHtml() : "") +
    "<header><div><h2>" +
    escapeHtml(t("help")) +
    "</h2><p class='pageLead'>" +
    escapeHtml(t("helpPageLead")) +
    "</p></div></header>" +
    "<div class='helpLayout'>" +
    "<nav class='helpNav'>" +
    navHtml +
    "</nav>" +
    "<div class='helpContent' id='helpContent'>" +
    renderHelpContent("basic") +
    "</div>" +
    "</div>" +
    "<div class='credit'>©2026 <a href='https://kuro.boo/' target='_blank' rel='noopener' style='color:inherit;text-decoration:none'>Kuro.boo</a> All Rights Reserved.</div>";

  setSidebarMode("normal");
  setActiveNav();

  document
    .querySelector<AdminElement>(".helpNav")!
    .addEventListener("click", function (e: Dynamic) {
      const btn = e.target.closest("[data-hkey]");
      if (!btn) return;
      document
        .querySelectorAll<AdminElement>(".helpNavItem")
        .forEach(function (b) {
          b.classList.toggle("active", b === btn);
        });
      const content = byId("helpContent");
      if (content) content.innerHTML = renderHelpContent(btn.dataset.hkey);
    });
}
