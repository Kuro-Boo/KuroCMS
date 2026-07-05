// KuroCMS admin screen module. Concatenated by scripts/build-admin.js.

async function settings() {
  // Import article-list sort order (shared by the Strapi / KuroCMS lists).
  // Default: publish date, newest first.
  let importSortOrder = "publish_desc";
  // Sort <select> for the import lists (hoisted → usable in the shell() string).
  function importSortSelect(selId: Dynamic) {
    const opt = function (v: Dynamic, label: Dynamic) {
      return (
        "<option value='" +
        v +
        "'" +
        (v === importSortOrder ? " selected" : "") +
        ">" +
        escapeHtml(label) +
        "</option>"
      );
    };
    return (
      "<select id='" +
      selId +
      "' style='width:auto;max-width:190px;padding:5px 8px;border-radius:8px;border:1px solid var(--line);background:var(--surface-2);color:var(--ink);font:inherit;font-size:12px'>" +
      opt("publish_desc", t("sortPublishDesc")) +
      opt("publish_asc", t("sortPublishAsc")) +
      opt("updated_desc", t("sortUpdatedDesc")) +
      opt("title_asc", t("sortTitleAsc")) +
      "</select>"
    );
  }
  function sortImportArticles(arr: Dynamic) {
    const a2 = (arr || []).slice();
    const pub = function (x: Dynamic) {
      return x.publishedAt || x.displayPublishedAt || "";
    };
    if (importSortOrder === "publish_asc")
      return a2.sort(function (x: Dynamic, y: Dynamic) {
        return pub(x).localeCompare(pub(y));
      });
    if (importSortOrder === "updated_desc")
      return a2.sort(function (x: Dynamic, y: Dynamic) {
        return (y.updatedAt || "").localeCompare(x.updatedAt || "");
      });
    if (importSortOrder === "title_asc")
      return a2.sort(function (x: Dynamic, y: Dynamic) {
        return (x.title || x.slug || "").localeCompare(y.title || y.slug || "");
      });
    return a2.sort(function (x: Dynamic, y: Dynamic) {
      return pub(y).localeCompare(pub(x)); // publish_desc (default)
    });
  }

  // Import list pagination (shared default; the article management list uses 50,
  // but the import list defaults to 20). Page state is per-list.
  let importPageSize = 20;
  // Strapi-style pager HTML (entries-per-page select + windowed page nav).
  // `pfx` namespaces the control ids (e.g. "strapi" → #strapi-size). Reuses the
  // .listPager / .pagerBtn CSS already defined for the article-management list.
  function importPagerHtml(pfx: Dynamic, total: Dynamic, page: Dynamic) {
    const pages = Math.max(1, Math.ceil(total / importPageSize));
    const sizeOpts = [10, 20, 50, 100]
      .map(function (n) {
        return (
          "<option value='" +
          n +
          "'" +
          (n === importPageSize ? " selected" : "") +
          ">" +
          n +
          "</option>"
        );
      })
      .join("");
    function pagerPages(totalPages: number, current: number): number[] {
      const count = Math.min(4, totalPages);
      let start = Math.max(1, current - Math.floor((count - 1) / 2));
      let end = start + count - 1;
      if (end > totalPages) {
        end = totalPages;
        start = Math.max(1, end - count + 1);
      }
      const out: number[] = [];
      for (let n = start; n <= end; n++) out.push(n);
      return out;
    }
    let nums = "";
    let last = 0;
    pagerPages(pages, page).forEach(function (n) {
      if (n - last > 1) nums += "<span class='pagerEllipsis'>…</span>";
      nums +=
        "<button type='button' class='pagerBtn" +
        (n === page ? " active" : "") +
        "' data-page='" +
        n +
        "'>" +
        n +
        "</button>";
      last = n;
    });
    return (
      "<div class='listPager' style='margin-top:10px'>" +
      "<label class='pageSizeWrap'><select id='" +
      pfx +
      "-size'>" +
      sizeOpts +
      "</select>" +
      escapeHtml(t("entriesPerPage")) +
      "</label>" +
      "<div class='pagerNav'>" +
      "<button type='button' class='pagerBtn' data-page='" +
      (page - 1) +
      "'" +
      (page <= 1 ? " disabled" : "") +
      ">&#8249;</button>" +
      nums +
      "<button type='button' class='pagerBtn' data-page='" +
      (page + 1) +
      "'" +
      (page >= pages ? " disabled" : "") +
      ">&#8250;</button>" +
      "</div></div>"
    );
  }

  // ── Tab helpers ───────────────────────────────────────────────────────
  function switchTab(tabId: Dynamic) {
    document
      .querySelectorAll<AdminElement>(".settingsTab")
      .forEach((el: Dynamic) => {
        el.classList.toggle("active", el.dataset.tab === tabId);
      });
    document
      .querySelectorAll<AdminElement>(".settingsPanel")
      .forEach((el: Dynamic) => {
        el.style.display = el.id === "panel-" + tabId ? "" : "none";
      });
  }

  // Single site language select (基本言語). The former separate "初期作成言語"
  // (initial_lang) is unified into this one — the editor / import default
  // authoring language now follows default_lang.
  function renderLanguageSelects(languages: string[], defaultLang: string) {
    const defaultSelect = byId("defaultLang");
    if (!defaultSelect) return;
    const list: string[] = Array.from(
      new Set(
        (languages || [])
          .map((l) =>
            String(l || "")
              .trim()
              .toLowerCase(),
          )
          .filter(Boolean),
      ),
    );
    if (!list.length) list.push("en");
    const optHtml = list
      .map(
        (l) =>
          "<option value='" +
          escapeHtml(l) +
          "'>" +
          escapeHtml((localeNames[l] || l) + " (" + l + ")") +
          "</option>",
      )
      .join("");
    defaultSelect.innerHTML = optHtml;
    const nd = String(defaultLang || "")
      .trim()
      .toLowerCase();
    defaultSelect.value = list.includes(nd) ? nd : list[0];
  }

  const tabBar = ["basic", "sns", "license", "import"]
    .map((id) => {
      const labels: Record<string, string> = {
        basic: t("settingsTabBasic"),
        sns: t("settingsTabSns"),
        license: t("settingsTabLicense"),
        import: t("settingsTabImport"),
      };
      return (
        "<button type='button' class='settingsTab" +
        (id === "basic" ? " active" : "") +
        "' data-tab='" +
        id +
        "'>" +
        escapeHtml(labels[id] || id) +
        "</button>"
      );
    })
    .join("");

  shell(
    t("settings"),
    "<div class='settingsTabBar'>" +
      tabBar +
      "</div>" +
      // ── Basic ────────────────────────────────────────────────────────
      "<div id='panel-basic' class='settingsPanel'>" +
      "<form class='panel stack' id='siteForm'>" +
      "<div id='siteFormStatus'></div>" +
      // サイト名はサイト管理（サイト情報）画面に移設。設定フォーム保存時は読込済みの
      // 値をそのままエコーして消えないようにする（saveAll 参照）。
      "<label>" +
      escapeHtml(t("publicDomain")) +
      "<div class='muted'>" +
      escapeHtml(t("publicDomainHelp")) +
      "</div><input id='publicDomain' required placeholder='https://kuro.boo/' /></label>" +
      "<div id='workerOriginSection' style='display:none'>" +
      "<div class='fieldLabel'>" +
      escapeHtml(t("workerOriginUrl")) +
      "</div>" +
      "<div class='muted' style='margin-bottom:6px;font-size:12px'>" +
      escapeHtml(t("workerOriginHelp")) +
      "</div>" +
      "<div style='display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--surface-2);border-radius:8px;font-size:13px'>" +
      "<code id='workerOriginDisplay' style='flex:1;font-size:12px;color:var(--fg);word-break:break-all'></code>" +
      "<button type='button' id='copyWorkerOriginBtn' class='secondary' style='font-size:11px;padding:3px 8px;white-space:nowrap'>" +
      escapeHtml(t("copy")) +
      "</button>" +
      "</div>" +
      "</div>" +
      // Cloudflare-native custom domain manager (populated by JS from
      // /api/system/custom-domains; falls back to manual dashboard steps).
      "<div id='customDomainSection' style='margin-top:4px'></div>" +
      "<div id='r2SetupSection' style='margin-top:4px'></div>" +
      "<label>" +
      escapeHtml(t("defaultLanguage")) +
      "<div class='muted'>" +
      escapeHtml(t("defaultLanguageHelp")) +
      "</div><select id='defaultLang' required></select></label>" +
      "<button>" +
      escapeHtml(t("saveSiteSettings")) +
      "</button>" +
      "</form>" +
      "</div>" +
      // ── SNS ──────────────────────────────────────────────────────────
      "<div id='panel-sns' class='settingsPanel' style='display:none'>" +
      "<div class='panel stack'>" +
      // Head: no redundant "SNS連動" heading (the tab above already says it);
      // instead a small Bluesky/X switcher so only one card shows at a time
      // (stacked cards get missed when the page grows long).
      "<div class='panelHead'>" +
      "<div class='toolbar' style='gap:6px'>" +
      "<button type='button' class='secondary snsSvcTab active' data-sns-svc-tab='bsky' style='padding:5px 14px;font-size:13px;font-weight:700'>🦋 Bluesky</button>" +
      "<button type='button' class='secondary snsSvcTab' data-sns-svc-tab='x' style='padding:5px 14px;font-size:13px;font-weight:700'>𝕏 X (Twitter)</button>" +
      "</div>" +
      "<div class='toolbar'><button type='button' id='addSnsBtn'>" +
      escapeHtml(t("addRegister")) +
      "</button></div></div>" +
      "<div id='snsList'>" +
      // Bluesky card — always shown as initial registration
      "<div id='blueskyCard'>" +
      "<form class='snsCard' id='snsForm'>" +
      "<div class='snsCardHead'>" +
      "<div class='snsCardTitle'><span style='font-size:18px'>🦋</span> Bluesky</div>" +
      "<div class='toolbar' style='gap:6px'>" +
      "<button type='button' class='danger' id='bskyDisconnectBtn' style='padding:5px 10px;font-size:12px'>&#128465; " +
      escapeHtml(t("delete")) +
      "</button>" +
      "</div>" +
      "</div>" +
      "<div style='display:flex;align-items:center;gap:8px;margin-bottom:12px;padding:8px 10px;background:var(--surface-2);border-radius:8px;font-size:12px'>" +
      "<span class='fieldLabel' style='margin:0;white-space:nowrap'>SID</span>" +
      "<code id='blueskySidDisplay' style='flex:1;font-size:11px;color:var(--fg)'>-</code>" +
      "<button type='button' id='bskyCopySidBtn' class='secondary' style='font-size:11px;padding:3px 8px'>[[sid]] " +
      escapeHtml(t("copy")) +
      "</button>" +
      "</div>" +
      "<label style='margin-bottom:10px'>" +
      escapeHtml(t("blueskyHandle")) +
      "<div class='muted'>" +
      escapeHtml(t("blueskyHandleHelp")) +
      "</div><input id='blueskyHandle' placeholder='yourname.bsky.social' /></label>" +
      "<label style='margin-bottom:10px'>" +
      escapeHtml(t("blueskyAppPassword")) +
      "<div class='muted'>" +
      escapeHtml(t("blueskyAppPasswordHelp")) +
      "</div><input id='blueskyToken' type='password' placeholder='xxxx-xxxx-xxxx-xxxx' /></label>" +
      "<div style='margin-top:16px;display:flex;justify-content:flex-end'><button type='submit'>" +
      escapeHtml(t("saveSiteSettings")) +
      "</button></div>" +
      "</form>" +
      "</div>" +
      // ── X (Twitter) auto-post card: OAuth 1.0a credentials + link mode.
      // Hidden until the 𝕏 switcher tab is selected. ──
      "<form class='snsCard' id='xAutoPostForm' style='display:none'>" +
      "<div class='snsCardHead'>" +
      "<div class='snsCardTitle'><span style='font-size:18px'>𝕏</span> " +
      escapeHtml(t("xSettingsTitle")) +
      "</div>" +
      "</div>" +
      "<div class='muted' style='margin-bottom:10px'>" +
      escapeHtml(t("xCredsHelp")) +
      "</div>" +
      "<label style='margin-bottom:10px'>" +
      escapeHtml(t("xApiKey")) +
      "<input id='xApiKey' type='password' autocomplete='off' /></label>" +
      "<label style='margin-bottom:10px'>" +
      escapeHtml(t("xApiSecret")) +
      "<input id='xApiSecret' type='password' autocomplete='off' /></label>" +
      "<label style='margin-bottom:10px'>" +
      escapeHtml(t("xAccessToken")) +
      "<input id='xAccessToken' type='password' autocomplete='off' /></label>" +
      "<label style='margin-bottom:10px'>" +
      escapeHtml(t("xAccessSecret")) +
      "<input id='xAccessSecret' type='password' autocomplete='off' /></label>" +
      "<label style='display:flex;align-items:center;gap:8px;margin:12px 0 4px;cursor:pointer'>" +
      "<input id='xLinkInReply' type='checkbox' checked style='width:auto;margin:0' />" +
      "<span>" +
      escapeHtml(t("xLinkInReply")) +
      "</span></label>" +
      "<div class='muted' style='margin-bottom:6px'>" +
      escapeHtml(t("xLinkInReplyHelp")) +
      "</div>" +
      "<div style='margin-top:16px;display:flex;justify-content:flex-end'><button type='submit'>" +
      escapeHtml(t("saveSiteSettings")) +
      "</button></div>" +
      "</form>" +
      "<div id='extraSnsCards'></div>" +
      "</div>" +
      "</div>" +
      "</div>" +
      // ── License ──────────────────────────────────────────────────────
      "<div id='panel-license' class='settingsPanel' style='display:none'>" +
      "<div class='panel stack'>" +
      "<table><tbody>" +
      "<tr><th>" +
      escapeHtml(t("license")) +
      "</th><td id='licenseName'>Kuro License</td></tr>" +
      "<tr><th>" +
      escapeHtml(t("licenseAttributionPhrase")) +
      "</th><td id='licenseAttribution'>with KuroCMS</td></tr>" +
      "<tr><th>" +
      escapeHtml(t("acceptedAt")) +
      "</th><td id='licenseAcceptedAt'>-</td></tr>" +
      "</tbody></table>" +
      "<div style='margin-top:12px'><span class='sectionLabel'>" +
      escapeHtml(t("licenseText")) +
      "</span><pre class='licenseBox' id='licenseText' style='margin-top:8px'></pre></div>" +
      "</div>" +
      "</div>" +
      // ── Import ───────────────────────────────────────────────────────
      "<div id='panel-import' class='settingsPanel' style='display:none'>" +
      "<div class='panel stack'>" +
      // Switcher
      "<div class='importSwitcher'>" +
      "<button type='button' class='importSwitch active' data-import='strapi'>" +
      escapeHtml(t("importFromStrapi")) +
      "</button>" +
      "<button type='button' class='importSwitch' data-import='kurocms'>" +
      escapeHtml(t("importFromKurocms")) +
      "</button>" +
      "</div>" +
      // ── Strapi sub-section ──────────────────────────────────────────
      "<div id='importSectionStrapi'>" +
      "<div class='muted' style='font-size:13px;margin-bottom:4px'>" +
      escapeHtml(t("importStrapiDesc")) +
      "</div>" +
      "<div style='border:1px solid var(--line);border-radius:10px;padding:16px'>" +
      "<div style='font-size:13px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px'>" +
      escapeHtml(t("importConnectionSettings")) +
      "</div>" +
      "<label>Strapi URL<div class='muted'>" +
      escapeHtml(t("strapiUrlHelp")) +
      "</div><input id='strapiUrl' placeholder='https://your-strapi.com' /></label>" +
      "<label>" +
      escapeHtml(t("strapiApiToken")) +
      "<div class='muted'>" +
      escapeHtml(t("strapiApiTokenHelp")) +
      "</div><input id='strapiToken' type='password' placeholder='API token (Full access / Read-only)' /></label>" +
      "<label>" +
      escapeHtml(t("strapiContentType")) +
      "<div class='muted'>" +
      escapeHtml(t("strapiContentTypeHelp")) +
      "</div><input id='strapiContentType' placeholder='articles' /></label>" +
      "</div>" +
      "<details style='border:1px solid var(--line);border-radius:10px;padding:14px'>" +
      "<summary style='font-size:13px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;cursor:pointer'>" +
      escapeHtml(t("importFieldMapping")) +
      "</summary>" +
      "<div style='margin-top:12px;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px'>" +
      "<label style='margin:0'>" +
      escapeHtml(t("strapiFieldTitle")) +
      "<input id='strapiFieldTitle' placeholder='title' /></label>" +
      "<label style='margin:0'>" +
      escapeHtml(t("strapiFieldSlug")) +
      "<input id='strapiFieldSlug' placeholder='slug' /></label>" +
      "<label style='margin:0'>" +
      escapeHtml(t("strapiFieldSummary")) +
      "<input id='strapiFieldSummary' placeholder='description' /></label>" +
      "<label style='margin:0'>" +
      escapeHtml(t("strapiFieldBody")) +
      "<input id='strapiFieldBody' placeholder='content' /></label>" +
      "<label style='margin:0'>" +
      escapeHtml(t("strapiFieldCategories")) +
      "<input id='strapiFieldCategories' placeholder='categories' /></label>" +
      "</div>" +
      "</details>" +
      "<div id='strapiRawFieldsHint' style='display:none;font-size:12px;color:var(--muted);background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:8px 12px;line-height:1.8'></div>" +
      "<div style='display:flex;align-items:center;gap:8px;flex-wrap:wrap'>" +
      "<button type='button' id='strapiTestBtn'>" +
      escapeHtml(t("importConnect")) +
      "</button>" +
      "<span id='strapiConnStatus' style='font-size:12px;color:var(--muted);flex:1'></span>" +
      "<button type='button' id='strapiImportAllBtn'>" +
      escapeHtml(t("importAll")) +
      "</button>" +
      "</div>" +
      "<div id='strapiImportSection' style='display:none;width:100%;box-sizing:border-box'>" +
      "<div style='border:1px solid var(--line);border-radius:10px;padding:16px;box-sizing:border-box'>" +
      "<div style='font-size:13px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px'>" +
      escapeHtml(t("importSettingsSection")) +
      "</div>" +
      "<div style='display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px'>" +
      "<label style='margin:0'>" +
      escapeHtml(t("importDestType")) +
      "<select id='strapiTid' style='width:100%'><option value=''>" +
      escapeHtml(t("loading")) +
      "</option></select></label>" +
      "<label style='margin:0'>" +
      escapeHtml(t("importLangLabel")) +
      "<select id='strapiLang' style='width:100%'><option value=''>" +
      escapeHtml(t("loading")) +
      "</option></select></label>" +
      "</div>" +
      "<div class='toolbar' style='gap:8px;flex-wrap:wrap'>" +
      "<button type='button' id='strapiImportSelBtn'>" +
      escapeHtml(t("importSelected")) +
      "</button>" +
      "<span id='strapiImportStatus' style='font-size:12px;color:var(--muted);flex:1'></span>" +
      "</div>" +
      "</div>" +
      "<div style='margin-top:12px;width:100%;box-sizing:border-box'>" +
      "<div style='display:flex;align-items:center;justify-content:space-between;margin-bottom:8px'>" +
      "<span style='font-size:13px;font-weight:600'>" +
      escapeHtml(t("importArticleList")) +
      " <span id='strapiArticleCount' style='color:var(--muted);font-weight:400'></span></span>" +
      "<div style='display:flex;align-items:center;gap:8px;flex-shrink:0'>" +
      importSortSelect("strapiSort") +
      "<button type='button' id='strapiSelectAllBtn' class='secondary' style='font-size:12px;padding:4px 10px;flex-shrink:0'>" +
      escapeHtml(t("selectAllToggle")) +
      "</button>" +
      "</div>" +
      "</div>" +
      "<div id='strapiArticleList' style='max-height:420px;overflow-y:auto;overflow-x:hidden;border:1px solid var(--line);border-radius:8px;width:100%;box-sizing:border-box'></div>" +
      "<div id='strapiPager'></div>" +
      "</div>" +
      "</div>" +
      "</div>" +
      // ── KuroCMS sub-section ─────────────────────────────────────────
      "<div id='importSectionKurocms' style='display:none'>" +
      "<div class='muted' style='font-size:13px;margin-bottom:4px'>" +
      escapeHtml(t("importKurocmsDesc")) +
      "</div>" +
      "<div style='border:1px solid var(--line);border-radius:10px;padding:16px'>" +
      "<div style='font-size:13px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px'>" +
      escapeHtml(t("importConnectionSettings")) +
      "</div>" +
      "<label>KuroCMS URL<div class='muted'>" +
      escapeHtml(t("kurocmsUrlHelp")) +
      "</div><input id='kurocmsUrl' placeholder='https://your-kurocms.com' /></label>" +
      "<label>" +
      escapeHtml(t("kurocmsPatLabel")) +
      "<div class='muted'>" +
      escapeHtml(t("kurocmsPatHelp")) +
      "</div><input id='kurocmsPat' type='password' placeholder='kuro_...' /></label>" +
      "</div>" +
      "<div style='display:flex;align-items:center;gap:8px;flex-wrap:wrap'>" +
      "<button type='button' id='kurocmsTestBtn'>" +
      escapeHtml(t("importConnectAndShow")) +
      "</button>" +
      "<span id='kurocmsConnStatus' style='font-size:12px;color:var(--muted);flex:1'></span>" +
      "<button type='button' id='kurocmsSaveBtn'>" +
      escapeHtml(t("importSaveConfig")) +
      "</button>" +
      "</div>" +
      "<div id='kurocmsImportSection' style='display:none;width:100%;box-sizing:border-box'>" +
      "<div style='border:1px solid var(--line);border-radius:10px;padding:16px;box-sizing:border-box'>" +
      "<div style='font-size:13px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px'>" +
      escapeHtml(t("importSettingsSection")) +
      "</div>" +
      "<div style='display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px'>" +
      "<label style='margin:0'>" +
      escapeHtml(t("importDestType")) +
      "<select id='kurocmsTid' style='width:100%'><option value=''>" +
      escapeHtml(t("loading")) +
      "</option></select></label>" +
      "<label style='margin:0'>" +
      escapeHtml(t("importLangLabel")) +
      "<select id='kurocmsLang' style='width:100%'><option value=''>" +
      escapeHtml(t("loading")) +
      "</option></select></label>" +
      "</div>" +
      "<div class='toolbar' style='gap:8px;flex-wrap:wrap'>" +
      "<button type='button' id='kurocmsImportSelBtn'>" +
      escapeHtml(t("importSelected")) +
      "</button>" +
      "<span id='kurocmsImportStatus' style='font-size:12px;color:var(--muted);flex:1'></span>" +
      "<button type='button' id='kurocmsImportAllBtn' class='danger-soft'>" +
      escapeHtml(t("importAll")) +
      "</button>" +
      "</div>" +
      "</div>" +
      "<div style='margin-top:12px;width:100%;box-sizing:border-box'>" +
      "<div style='display:flex;align-items:center;justify-content:space-between;margin-bottom:8px'>" +
      "<span style='font-size:13px;font-weight:600'>" +
      escapeHtml(t("importArticleList")) +
      " <span id='kurocmsArticleCount' style='color:var(--muted);font-weight:400'></span></span>" +
      "<div style='display:flex;align-items:center;gap:8px;flex-shrink:0'>" +
      importSortSelect("kurocmsSort") +
      "<button type='button' id='kurocmsSelectAllBtn' class='secondary' style='font-size:12px;padding:4px 10px;flex-shrink:0'>" +
      escapeHtml(t("selectAllToggle")) +
      "</button>" +
      "</div>" +
      "<div id='kurocmsArticleList' style='max-height:420px;overflow-y:auto;overflow-x:hidden;border:1px solid var(--line);border-radius:8px;width:100%;box-sizing:border-box'></div>" +
      "<div id='kurocmsPager'></div>" +
      "</div>" +
      "</div>" +
      "</div>" +
      "</div>" +
      "</div>",
  );

  // Tab switching
  document.querySelectorAll<AdminElement>(".settingsTab").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  // Import section switcher
  document.querySelectorAll<AdminElement>(".importSwitch").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll<AdminElement>(".importSwitch")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const target = btn.dataset.import;
      byId("importSectionStrapi")!.style.display =
        target === "strapi" ? "" : "none";
      byId("importSectionKurocms")!.style.display =
        target === "kurocms" ? "" : "none";
    });
  });

  try {
    let s: Dynamic;
    let languageOptions = [];
    if (state.preview) {
      s = {
        siteName: "KuroCMS",
        publicDomain: "https://kuro.boo/",
        defaultLang: "en",
        initialLang: "en",
        themeAccent: "#06b6d4",
        themeSidebar: "#ffffff",
        themeMainPane: "#ffffff",
        blueskyHandle: "kuroboo.bsky.social",
        blueskyShowFeed: true,
        blueskyFeedPosition: "left",
        threadsHandle: "",
        threadsShowFeed: false,
        licenseName: "Kuro License",
        licenseAttributionPhrase: "with KuroCMS",
        licenseAcceptedAt: new Date().toISOString(),
      };
      languageOptions = ["en", "ja", "de", "fr"];
    } else {
      const [settingsData, langData] = await Promise.all([
        api("/api/settings"),
        api("/api/languages").catch(() => ({ languages: [] })),
      ]);
      s = settingsData.settings;
      applyTheme(s);
      languageOptions = (langData.languages || []).map((r: Dynamic) => r.lang);
    }

    if (!languageOptions.length)
      languageOptions = normalizeLanguages(s.enabledLanguages, [
        s.defaultLang || "en",
      ]);
    renderLanguageSelects(languageOptions, s.defaultLang);

    // Basic (siteName moved to the Site Management screen)
    byId("publicDomain")!.value = s.publicDomain || "";

    // Worker origin URL + CNAME guide
    (function () {
      const devDomain = (s.developmentDomain || "").trim();
      const pubDomain = (s.publicDomain || "").trim();
      if (!devDomain) return;

      const originSection = byId("workerOriginSection");
      const originDisplay = byId("workerOriginDisplay");
      const copyBtn = byId("copyWorkerOriginBtn");
      if (originSection && originDisplay) {
        originSection.style.display = "";
        originDisplay.textContent = devDomain;
      }
      if (copyBtn) {
        copyBtn.addEventListener("click", async function (e: Dynamic) {
          try {
            await navigator.clipboard.writeText(devDomain);
            toast(t("copySuccess"), false, e.currentTarget);
          } catch {
            toast(t("copyFailed"), true);
          }
        });
      }

      // Cloudflare-native custom domains (Custom Domains API; CF auto-creates
      // DNS + SSL). Falls back to manual dashboard steps when CF lacks perms.
      const cdSection = byId("customDomainSection");
      if (cdSection) void renderCustomDomains(cdSection);
      const r2Section = byId("r2SetupSection");
      if (r2Section) void renderR2Setup(r2Section);
    })();

    async function renderR2Setup(section: Dynamic) {
      const esc = escapeHtml;
      const box =
        "padding:12px 14px;background:var(--surface-2);border-radius:10px;border:1px solid var(--border);margin-top:4px";
      let storage: Dynamic;
      try {
        storage = await api("/api/system/storage");
      } catch {
        storage = { r2Available: false };
      }
      if (storage?.r2Available) {
        section.innerHTML =
          "<div style='" +
          box +
          "'><div style='font-weight:700;font-size:13px'>🪣 " +
          esc(t("r2SetupTitle")) +
          "</div><p style='font-size:12px;color:var(--muted);margin:6px 0 0'>✅ " +
          esc(t("r2SetupReady")) +
          "</p></div>";
        return;
      }
      section.innerHTML =
        "<div style='" +
        box +
        "'><div style='font-weight:700;font-size:13px;margin-bottom:6px'>🪣 " +
        esc(t("r2SetupTitle")) +
        "</div><p style='font-size:12px;color:var(--muted);line-height:1.7;margin:0 0 10px'>" +
        esc(t("r2SetupHelp")) +
        "</p><div style='display:flex;gap:8px;flex-wrap:wrap'>" +
        "<a class='secondary' target='_blank' rel='noopener' href='https://dash.cloudflare.com/?to=/:account/r2/overview' style='font-size:12px;padding:6px 14px;text-decoration:none'>" +
        esc(t("r2SetupDashboard")) +
        "</a><button type='button' id='enableR2Btn' style='font-size:12px;padding:6px 14px'>" +
        esc(t("r2SetupButton")) +
        "</button></div><div id='r2SetupResult' style='font-size:12px;margin-top:8px'></div></div>";
      const button = byId("enableR2Btn");
      const result = byId("r2SetupResult");
      if (!button) return;
      button.addEventListener("click", async function () {
        button.disabled = true;
        if (result) result.textContent = t("r2SetupWorking");
        try {
          await api("/api/system/r2/enable", { method: "POST" });
          if (result) result.textContent = "✅ " + t("r2SetupDone");
          setTimeout(() => location.reload(), 1200);
        } catch (err) {
          button.disabled = false;
          if (result) result.textContent = "⚠️ " + errorMessage(err);
        }
      });
    }

    // Cloudflare-native custom domain manager. Reads /api/system/custom-domains:
    // when CF creds/permissions allow, shows attached domains + a "set" form;
    // otherwise shows manual Cloudflare dashboard steps.
    async function renderCustomDomains(section: Dynamic) {
      const esc = escapeHtml;
      const box =
        "padding:12px 14px;background:var(--surface-2);border-radius:10px;border:1px solid var(--border);margin-top:4px";
      const title =
        "<div style='font-weight:700;font-size:13px;margin-bottom:6px'>🌐 " +
        esc(t("customDomainTitle")) +
        "</div>";
      let data: Dynamic;
      try {
        data = await api("/api/system/custom-domains");
      } catch {
        data = { available: false };
      }
      if (!data || !data.available) {
        section.innerHTML =
          "<div style='" +
          box +
          "'>" +
          title +
          "<p style='font-size:12px;margin:0;line-height:1.8;white-space:pre-line'>" +
          esc(t("cfManualSteps")) +
          "</p></div>";
        return;
      }
      const domains = data.domains || [];
      const list = domains.length
        ? "<ul style='margin:6px 0 10px;padding-left:18px;font-size:12px'>" +
          domains
            .map(function (d: Dynamic) {
              return (
                "<li style='margin:2px 0'><code>" +
                esc(d.hostname) +
                "</code> <span style='color:var(--muted)'>(" +
                esc(d.zoneName || "") +
                ")</span></li>"
              );
            })
            .join("") +
          "</ul>"
        : "<p style='font-size:12px;color:var(--muted);margin:6px 0 10px'>" +
          esc(t("noCustomDomains")) +
          "</p>";
      section.innerHTML =
        "<div style='" +
        box +
        "'>" +
        title +
        "<div style='font-size:12px;font-weight:600;margin-bottom:2px'>" +
        esc(t("currentCustomDomains")) +
        "</div>" +
        list +
        "<p style='font-size:11px;color:var(--muted);margin:0 0 8px;line-height:1.6'>" +
        esc(t("customDomainHelp")) +
        "</p>" +
        "<div style='display:flex;gap:8px;flex-wrap:wrap'>" +
        "<input id='newCustomDomain' placeholder='blog.example.com' style='flex:1;min-width:180px;font-size:13px;padding:6px 10px' />" +
        "<button type='button' id='addCustomDomainBtn' class='secondary' style='font-size:12px;padding:6px 14px;white-space:nowrap'>" +
        esc(t("setCustomDomain")) +
        "</button></div>" +
        "<div id='customDomainResult' style='font-size:12px;margin-top:6px'></div>" +
        "</div>";
      const addBtn = byId("addCustomDomainBtn");
      const input = byId("newCustomDomain");
      const result = byId("customDomainResult");
      if (addBtn && input) {
        addBtn.addEventListener("click", async function () {
          const hostname = (input.value || "").trim();
          if (!hostname) {
            input.focus();
            return;
          }
          if (result) result.textContent = t("checking");
          try {
            await api("/api/system/custom-domains", {
              method: "POST",
              body: JSON.stringify({ hostname }),
            });
            if (result) result.innerHTML = "✅ " + esc(t("customDomainAdded"));
            const pd = byId("publicDomain");
            if (pd && !pd.value) pd.value = "https://" + hostname + "/";
            await renderCustomDomains(section);
          } catch (err) {
            if (result)
              result.innerHTML =
                "⚠️ " +
                esc(errorMessage(err)) +
                "<br><span style='color:var(--muted)'>" +
                esc(t("customDomainPermNote")) +
                "</span>";
          }
        });
      }
    }

    // SNS – Bluesky card: show only if handle is already set
    byId("blueskyHandle")!.value = s.blueskyHandle || "";
    if (s.blueskyTokenSet) {
      byId("blueskyToken")!.placeholder = "•••••••••••• ✓";
    }
    // X credentials: never echoed back; show a "set" placeholder instead.
    for (const [flag, inputId] of [
      [s.xApiKeySet, "xApiKey"],
      [s.xApiSecretSet, "xApiSecret"],
      [s.xAccessTokenSet, "xAccessToken"],
      [s.xAccessSecretSet, "xAccessSecret"],
    ] as Array<[boolean, string]>) {
      if (flag) byId(inputId)!.placeholder = "•••••••••••• ✓";
    }
    byId("xLinkInReply")!.checked = s.xLinkInReply !== false;
    // Auto-generate Bluesky SID if not set
    if (!s.blueskySid && s.blueskyHandle) {
      s.blueskySid = "sns-001";
    }
    const bSid = s.blueskySid || "sns-001";
    const bSidEl = byId("blueskySidDisplay");
    if (bSidEl) bSidEl.textContent = "[[" + bSid + "]]";
    byId("bskyCopySidBtn")?.addEventListener(
      "click",
      async function (e: Dynamic) {
        try {
          await navigator.clipboard.writeText("[[" + bSid + "]]");
          toast(t("copySuccess"), false, e.currentTarget);
        } catch {
          toast(t("copyFailed"), true);
        }
      },
    );
    // Bluesky is always shown as initial registration

    // Bluesky / X card switcher (one card visible at a time).
    document
      .querySelectorAll<AdminElement>("[data-sns-svc-tab]")
      .forEach(function (tabBtn) {
        tabBtn.addEventListener("click", function () {
          const svc = tabBtn.dataset.snsSvcTab;
          document
            .querySelectorAll<AdminElement>("[data-sns-svc-tab]")
            .forEach(function (o) {
              o.classList.toggle("active", o === tabBtn);
            });
          const bc = byId("blueskyCard");
          const xc = byId("xAutoPostForm");
          if (bc) bc.style.display = svc === "bsky" ? "" : "none";
          if (xc) xc.style.display = svc === "x" ? "" : "none";
        });
      });

    // Add SNS button — includes Bluesky when not already shown
    byId("addSnsBtn")?.addEventListener("click", () => {
      openEntryDialog(
        escapeHtml(t("addSnsTitle")),
        "<label>" +
          escapeHtml(t("snsServiceLabel")) +
          "<select id='dialogSnsService'><option value='threads'>Threads</option><option value='x'>X (Twitter)</option><option value='mastodon'>Mastodon</option><option value='facebook'>Facebook</option></select></label>",
        t("addRegister"),
        async (form: Dynamic, close: Dynamic) => {
          const svc = form.querySelector("#dialogSnsService")?.value || "";
          const svcLabels: Record<string, string> = {
            threads: "Threads",
            x: "X (Twitter)",
            mastodon: "Mastodon",
            facebook: "Facebook",
          };
          const svcLabel = svcLabels[svc] || svc;
          const cardId = "snsCard_" + svc;
          if (byId(cardId)) {
            close();
            return;
          }
          const card = document.createElement("div");
          card.className = "snsCard";
          card.id = cardId;
          // Auto-generate sequential SID for this card
          const existingCards =
            document.querySelectorAll<AdminElement>(".snsCard").length;
          const autoSid = "sns-" + String(existingCards + 1).padStart(3, "0");
          card.innerHTML =
            "<div class='snsCardHead'>" +
            "<div class='snsCardTitle'>" +
            escapeHtml(svcLabel) +
            "</div>" +
            "<div class='toolbar' style='gap:6px'>" +
            "<button type='button' class='danger' data-delete-sns='" +
            escapeHtml(svc) +
            "' style='padding:5px 10px;font-size:12px'>&#128465; " +
            escapeHtml(t("delete")) +
            "</button>" +
            "<button type='button' class='secondary' data-save-sns='" +
            escapeHtml(svc) +
            "' style='padding:5px 10px;font-size:12px'>" +
            escapeHtml(t("save")) +
            "</button>" +
            "</div>" +
            "</div>" +
            "<div style='display:flex;align-items:center;gap:8px;margin-bottom:12px;padding:8px 10px;background:var(--surface-2);border-radius:8px;font-size:12px'>" +
            "<span class='fieldLabel' style='margin:0;white-space:nowrap'>SID</span>" +
            "<code style='flex:1;font-size:11px;color:var(--fg)'>[[" +
            escapeHtml(autoSid) +
            "]]</code>" +
            "<button type='button' class='secondary sns-copy-sid' data-sid='" +
            escapeHtml(autoSid) +
            "' style='font-size:11px;padding:3px 8px'>" +
            escapeHtml(t("copy")) +
            "</button>" +
            "</div>" +
            "<label style='margin-bottom:8px'><div class='muted' style='margin-bottom:4px'>" +
            escapeHtml(t("snsHandleLabel")) +
            "</div><input id='snsHandle_" +
            escapeHtml(svc) +
            "' placeholder='@yourname' /></label>" +
            // X: posting credentials live in the "X (Twitter) Auto-Post"
            // section of the SNS form above — no token input here.
            (svc === "x"
              ? "<p class='muted' style='font-size:11px;margin-top:4px'>" +
                escapeHtml(t("snsXUseAutoPost")) +
                "</p>"
              : "<label style='margin-bottom:8px'><div class='muted' style='margin-bottom:4px'>" +
                escapeHtml(t("snsAccessToken")) +
                "</div><input id='snsToken_" +
                escapeHtml(svc) +
                "' type='password' placeholder='API token / App Password' /></label>" +
                (svc === "mastodon"
                  ? "<label style='margin-bottom:8px'><div class='muted' style='margin-bottom:4px'>" +
                    escapeHtml(t("snsInstanceUrl")) +
                    "</div><input id='snsEndpoint_" +
                    escapeHtml(svc) +
                    "' placeholder='https://mastodon.social' /></label>"
                  : "") +
                "<p class='muted' style='font-size:11px;margin-top:4px'>" +
                escapeHtml(t("snsApiComingSoon")) +
                "</p>");
          card
            .querySelector<AdminElement>(".sns-copy-sid")
            ?.addEventListener("click", async function (e: Dynamic) {
              const sid = e.currentTarget.dataset.sid;
              try {
                await navigator.clipboard.writeText("[[" + sid + "]]");
                toast(t("copySuccess"), false, e.currentTarget);
              } catch {
                toast(t("copyFailed"), true);
              }
            });
          card
            .querySelector<AdminElement>("[data-delete-sns]")
            ?.addEventListener("click", () => {
              openEntryDialog(
                t("deleteServiceTitle").replace(
                  "{service}",
                  escapeHtml(svcLabel),
                ),
                "<p class='muted'>" +
                  escapeHtml(t("snsDeleteMsgPre")) +
                  escapeHtml(svcLabel) +
                  escapeHtml(t("snsDeleteMsgSuf")) +
                  "</p>",
                t("delete"),
                (form: Dynamic, close: Dynamic) => {
                  close();
                  card.remove();
                },
              );
            });
          card
            .querySelector<AdminElement>("[data-save-sns]")
            ?.addEventListener("click", (e: Dynamic) => {
              toast(t("snsSavePending"), false, e.currentTarget);
            });
          byId("extraSnsCards")?.appendChild(card);
          close();
        },
      );
    });
    // Bluesky disconnect / delete
    byId("bskyDisconnectBtn")?.addEventListener("click", (e) => {
      const btn = e.currentTarget;
      openEntryDialog(
        t("deleteServiceTitle").replace("{service}", "Bluesky"),
        "<p class='muted'>" + escapeHtml(t("bskyDisconnectConfirm")) + "</p>",
        t("delete"),
        async (form: Dynamic, close: Dynamic) => {
          close();
          byId("blueskyHandle")!.value = "";
          await saveAll(btn, {});
          toast(t("bskyConnectionCleared"), false, btn);
          const card = byId("blueskyCard");
          if (card) card.style.display = "none";
        },
      );
    });
    // License
    byId("licenseName")!.textContent = s.licenseName || "Kuro License";
    byId("licenseAttribution")!.textContent =
      s.licenseAttributionPhrase || "with KuroCMS";
    byId("licenseAcceptedAt")!.textContent = formatDateTime(
      s.licenseAcceptedAt,
    );
    byId("licenseText")!.textContent = kuroLicenseText();

    // ── Import tab ─────────────────────────────────────────────────────
    (async function initImportTab() {
      // Store fetched articles for filtering
      let strapiAllArticles: Dynamic[] = [];
      // Selected article ids — kept across pages (paginated rendering only puts
      // the current page's checkboxes in the DOM, so a Set is the source of truth
      // for selection and the import, not a DOM `:checked` query).
      const strapiSelected = new Set<string>();
      let strapiPage = 1;

      // Load saved settings
      try {
        const cfg = await api("/api/import/strapi/settings");
        const setVal = function (id: Dynamic, val: Dynamic) {
          const el = byId(id);
          if (el) el.value = val || "";
        };
        setVal("strapiUrl", cfg.strapiUrl);
        setVal("strapiToken", cfg.strapiToken);
        setVal("strapiContentType", cfg.strapiContentType || "articles");
        setVal("strapiFieldTitle", cfg.strapiFieldTitle || "title");
        setVal("strapiFieldSlug", cfg.strapiFieldSlug || "slug");
        setVal("strapiFieldSummary", cfg.strapiFieldSummary || "description");
        setVal("strapiFieldBody", cfg.strapiFieldBody || "content");
        setVal(
          "strapiFieldCategories",
          cfg.strapiFieldCategories || "categories",
        );
      } catch {
        /* ignore */
      }

      // Load types (default = first) and languages (default = site base language)
      const [typesData, langsData, settingsData] = await Promise.all([
        api("/api/types").catch(function () {
          return { types: [] };
        }),
        api("/api/languages").catch(function () {
          return { languages: [] };
        }),
        api("/api/settings").catch(function () {
          return { settings: {} };
        }),
      ]);
      const initialLang =
        settingsData?.settings?.defaultLang ||
        settingsData?.settings?.initialLang ||
        "";

      const tidSel = byId("strapiTid");
      if (tidSel) {
        const types = typesData.types || [];
        tidSel.innerHTML =
          "<option value='__all__'>" +
          escapeHtml(t("importDestTypeAll")) +
          "</option>" +
          types
            .map(function (tp: Dynamic) {
              const v = tp.tid || tp.id || "";
              return (
                "<option value='" +
                escapeHtml(v) +
                "'>" +
                escapeHtml(tp.name || v) +
                "</option>"
              );
            })
            .join("");
        tidSel.value = "__all__";
      }

      const langSel = byId("strapiLang");
      if (langSel) {
        const langs = langsData.languages || [];
        langSel.innerHTML = langs
          .map(function (lg: Dynamic) {
            const code = lg.lang || lg.id || "";
            const label = lg.displayName || lg.name || code;
            return (
              "<option value='" +
              escapeHtml(code) +
              "'>" +
              escapeHtml(label) +
              "</option>"
            );
          })
          .join("");
        if (initialLang) langSel.value = initialLang;
        else if (langs.length)
          langSel.value = langs[0].lang || langs[0].id || "";
      }

      // Type change → re-fetch exists status from API with new tid
      tidSel?.addEventListener("change", async function () {
        if (!strapiAllArticles.length) return;
        const selectedTid = tidSel.value;
        try {
          const qs = selectedTid
            ? "?tid=" + encodeURIComponent(selectedTid)
            : "";
          const result = await api("/api/import/strapi/preview" + qs);
          strapiAllArticles = result.articles || [];
          renderStrapiArticleList(strapiAllArticles);
        } catch (err) {
          toast(t("refetchError") + errorMessage(err), true);
        }
      });

      // Save settings
      function getStrapiSettings() {
        return {
          strapiUrl: (byId("strapiUrl")?.value || "").trim(),
          strapiToken: (byId("strapiToken")?.value || "").trim(),
          strapiContentType: (
            byId("strapiContentType")?.value || "articles"
          ).trim(),
          strapiFieldTitle: (byId("strapiFieldTitle")?.value || "title").trim(),
          strapiFieldSlug: (byId("strapiFieldSlug")?.value || "slug").trim(),
          strapiFieldSummary: (
            byId("strapiFieldSummary")?.value || "description"
          ).trim(),
          strapiFieldBody: (byId("strapiFieldBody")?.value || "content").trim(),
          strapiFieldCategories: (
            byId("strapiFieldCategories")?.value || "categories"
          ).trim(),
        };
      }

      // Connect & show (auto-saves settings)
      byId("strapiTestBtn")?.addEventListener(
        "click",
        async function (e: Dynamic) {
          const btn = e.currentTarget;
          const status = byId("strapiConnStatus");
          if (status) status.textContent = t("importing");
          btn.disabled = true;
          try {
            await api("/api/import/strapi/settings", {
              method: "PUT",
              body: JSON.stringify(getStrapiSettings()),
            });
            const currentTid = byId("strapiTid")?.value || "";
            const previewQs = currentTid
              ? "?tid=" + encodeURIComponent(currentTid)
              : "";
            const result = await api("/api/import/strapi/preview" + previewQs);
            strapiAllArticles = result.articles || [];
            if (status)
              status.textContent =
                t("importConnectSuccessPre") +
                strapiAllArticles.length +
                t("importCountSuffix");
            const rawFields: string[] = result.rawFields || [];
            const hint = byId("strapiRawFieldsHint");
            if (hint && rawFields.length) {
              const catLike = rawFields.filter((f) =>
                /categor|tag|label/i.test(f),
              );
              const highlighted = rawFields
                .map((f) =>
                  catLike.includes(f)
                    ? "<strong style='color:var(--accent);background:var(--accent-soft);border-radius:4px;padding:0 4px'>" +
                      escapeHtml(f) +
                      "</strong>"
                    : escapeHtml(f),
                )
                .join(", ");
              hint.innerHTML =
                "<span style='font-weight:600'>" +
                escapeHtml(t("strapiFieldsLabel")) +
                "</span> " +
                highlighted;
              hint.style.display = "";
            }
            renderStrapiArticleList(strapiAllArticles);
            const section = byId("strapiImportSection");
            if (section) section.style.display = "";
          } catch (err) {
            if (status)
              status.textContent = t("error") + ": " + errorMessage(err);
            toast(t("connectError") + errorMessage(err), true);
          } finally {
            btn.disabled = false;
          }
        },
      );

      // Render article list
      function renderStrapiArticleList(articles: Dynamic) {
        const list = byId("strapiArticleList");
        const count = byId("strapiArticleCount");
        const pager = byId("strapiPager");
        if (!list) return;
        const sorted = sortImportArticles(articles);
        // Drop any tracked selection that's no longer in the current set
        // (e.g. after re-connecting to a different Strapi).
        if (strapiSelected.size) {
          const present = new Set(
            sorted.map(function (a: Dynamic) {
              return String(a.id);
            }),
          );
          strapiSelected.forEach(function (id) {
            if (!present.has(id)) strapiSelected.delete(id);
          });
        }
        if (count)
          count.textContent =
            "（" + sorted.length + t("importCountSuffix") + "）";
        if (!sorted.length) {
          list.innerHTML =
            "<p style='padding:16px;color:var(--muted);text-align:center'>" +
            escapeHtml(t("articlesNotFound")) +
            "</p>";
          if (pager) pager.innerHTML = "";
          return;
        }
        const pages = Math.max(1, Math.ceil(sorted.length / importPageSize));
        if (strapiPage > pages) strapiPage = pages;
        if (strapiPage < 1) strapiPage = 1;
        const start = (strapiPage - 1) * importPageSize;
        const pageItems = sorted.slice(start, start + importPageSize);
        list.style.width = "100%";
        list.style.boxSizing = "border-box";
        list.innerHTML = pageItems
          .map(function (a: Dynamic) {
            const existsBadge = a.modifiedSinceImport
              ? "<span style='font-size:10px;background:#fee2e2;color:#991b1b;border-radius:4px;padding:1px 5px;margin-left:6px'>" +
                escapeHtml(t("modifiedBadge")) +
                "</span>"
              : a.exists
                ? "<span style='font-size:10px;background:#fef3c7;color:#92400e;border-radius:4px;padding:1px 5px;margin-left:6px'>" +
                  escapeHtml(t("alreadyImportedBadge")) +
                  "</span>"
                : "";
            const pubAt = a.publishedAt
              ? new Date(a.publishedAt).toLocaleDateString(state.uiLang)
              : "-";
            const slugText = escapeHtml(a.slug || "");
            const summaryText = a.summary ? escapeHtml(a.summary) : "";
            return (
              "<label class='strapiRow' style='display:block;padding:8px 12px;border-bottom:1px solid var(--line);cursor:pointer;width:100%;box-sizing:border-box'>" +
              "<div style='display:flex;align-items:center;gap:8px;width:100%;min-width:0;box-sizing:border-box'>" +
              "<input type='checkbox' data-strapi-id='" +
              escapeHtml(String(a.id)) +
              "' style='width:auto;flex-shrink:0'" +
              (a.exists
                ? " disabled"
                : strapiSelected.has(String(a.id))
                  ? " checked"
                  : "") +
              " />" +
              "<span style='font-size:13px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'>" +
              escapeHtml(a.title || a.slug) +
              existsBadge +
              "</span>" +
              "<span style='font-size:11px;color:var(--muted);flex-shrink:0;white-space:nowrap'>" +
              pubAt +
              "</span>" +
              "</div>" +
              (slugText
                ? "<div style='font-size:11px;color:var(--muted);padding-left:24px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'>" +
                  slugText +
                  "</div>"
                : "") +
              (summaryText
                ? "<div style='font-size:12px;color:var(--muted);padding-left:24px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'>" +
                  summaryText +
                  "</div>"
                : "") +
              "</label>"
            );
          })
          .join("");
        if (pager)
          pager.innerHTML = importPagerHtml(
            "strapi",
            sorted.length,
            strapiPage,
          );
      }

      // Sort / select-all / pagination — all driven through strapiSelected so
      // selection survives page changes.
      byId("strapiSort")?.addEventListener("change", function (e: Dynamic) {
        importSortOrder = e.target.value;
        strapiPage = 1;
        renderStrapiArticleList(strapiAllArticles);
      });
      // Track per-row selection (delegated; the list re-renders each page).
      byId("strapiArticleList")?.addEventListener(
        "change",
        function (e: Dynamic) {
          const cb = e.target;
          if (!cb || !cb.dataset || !cb.dataset.strapiId) return;
          const id = String(cb.dataset.strapiId);
          if (cb.checked) strapiSelected.add(id);
          else strapiSelected.delete(id);
        },
      );
      byId("strapiSelectAllBtn")?.addEventListener("click", function () {
        // Toggle ALL selectable (non-existing) articles, across every page.
        const selectable = strapiAllArticles
          .filter(function (a: Dynamic) {
            return !a.exists;
          })
          .map(function (a: Dynamic) {
            return String(a.id);
          });
        const allChecked =
          selectable.length > 0 &&
          selectable.every(function (id: Dynamic) {
            return strapiSelected.has(id);
          });
        selectable.forEach(function (id: Dynamic) {
          if (allChecked) strapiSelected.delete(id);
          else strapiSelected.add(id);
        });
        renderStrapiArticleList(strapiAllArticles);
      });
      byId("strapiPager")?.addEventListener("click", function (e: Dynamic) {
        const btn = e.target.closest ? e.target.closest(".pagerBtn") : null;
        if (!btn || btn.disabled) return;
        const p = parseInt(btn.dataset.page, 10);
        if (!isNaN(p)) {
          strapiPage = p;
          renderStrapiArticleList(strapiAllArticles);
        }
      });
      byId("strapiPager")?.addEventListener("change", function (e: Dynamic) {
        if (e.target && e.target.id === "strapi-size") {
          importPageSize = parseInt(e.target.value, 10) || 20;
          strapiPage = 1;
          renderStrapiArticleList(strapiAllArticles);
        }
      });

      // Execute import
      async function doImport(
        ids: Dynamic,
        opts: {
          overwriteIds?: string[];
          overwriteAll?: boolean;
          protectIds?: string[];
        } = {},
      ) {
        const overwriteIds = opts.overwriteIds || [];
        const overwriteAll = opts.overwriteAll === true;
        const protectIds = opts.protectIds || [];
        const tid = byId("strapiTid")?.value;
        const lang = byId("strapiLang")?.value;
        if (!tid) {
          toast(t("selectImportType"), true);
          return;
        }
        if (!lang) {
          toast(t("selectImportLang"), true);
          return;
        }

        // Progress overlay (page-by-page so large imports stay within Worker limits)
        const overlay = document.createElement("div");
        overlay.className = "buildProgress";
        overlay.innerHTML =
          "<div class='buildProgressCard'>" +
          "<div style='font-weight:700;font-size:15px' id='impTitle'>" +
          escapeHtml(t("importProgressTitle")) +
          "</div>" +
          "<div class='buildProgressBar'><div class='buildProgressFill' id='impFill' style='width:0%'></div></div>" +
          "<div id='impStatus' style='font-size:13px;color:var(--muted);line-height:1.7'></div>" +
          "<div id='impActions' style='display:flex;justify-content:flex-end;gap:8px'></div>" +
          "</div>";
        document.body.appendChild(overlay);
        const fill = overlay.querySelector<AdminElement>("#impFill");
        const statusEl = overlay.querySelector<AdminElement>("#impStatus");
        const actions = overlay.querySelector<AdminElement>("#impActions");
        const setBar = (pct: number) => {
          if (fill) fill.style.width = Math.max(0, Math.min(100, pct)) + "%";
        };
        const acc = {
          imported: 0,
          overwritten: 0,
          skipped: 0,
          imagesDownloaded: 0,
          errors: [] as string[],
        };
        const counts = () =>
          acc.imported +
          t("importResultImported") +
          " / " +
          acc.overwritten +
          t("importResultOverwritten") +
          " / " +
          acc.skipped +
          t("importResultSkipped") +
          (acc.imagesDownloaded ? " / 🖼 " + acc.imagesDownloaded : "") +
          (acc.errors.length ? " / ⚠ " + acc.errors.length : "");
        const accumulate = (r: Dynamic) => {
          acc.imported += r.imported || 0;
          acc.overwritten += r.overwritten || 0;
          acc.skipped += r.skipped || 0;
          acc.imagesDownloaded += r.imagesDownloaded || 0;
          if (Array.isArray(r.errors)) acc.errors.push(...r.errors);
        };

        let hadError = false;
        try {
          if (ids === "all") {
            let page = 1;
            let pageCount = 1;
            let total = 0;
            if (statusEl) statusEl.innerHTML = t("importing");
            do {
              const r = await api("/api/import/strapi/execute", {
                method: "POST",
                body: JSON.stringify({
                  ids: "all",
                  tid,
                  lang,
                  overwriteIds,
                  overwriteAll,
                  protectIds,
                  page,
                  pageSize: 10,
                }),
              });
              accumulate(r);
              pageCount = r.pageCount || 1;
              total = r.total || total;
              const processed = acc.imported + acc.overwritten + acc.skipped;
              setBar(
                total ? (processed / total) * 100 : (page / pageCount) * 100,
              );
              if (statusEl)
                statusEl.innerHTML =
                  (total
                    ? processed + " / " + total + t("importCountSuffix")
                    : "") +
                  "<br>" +
                  counts();
              page++;
            } while (page <= pageCount);
          } else {
            if (statusEl) statusEl.innerHTML = t("importing");
            const r = await api("/api/import/strapi/execute", {
              method: "POST",
              body: JSON.stringify({
                ids,
                tid,
                lang,
                overwriteIds,
                overwriteAll,
                protectIds,
              }),
            });
            accumulate(r);
          }
        } catch (err) {
          hadError = true;
          acc.errors.push(errorMessage(err));
        }
        setBar(100);

        const title = overlay.querySelector<AdminElement>("#impTitle");
        if (title)
          title.textContent = hadError ? t("error") : t("importComplete");
        const errList = acc.errors.length
          ? "<div style='margin-top:8px;max-height:160px;overflow:auto;font-size:11px;color:var(--danger);text-align:left'>" +
            "<div style='font-weight:600'>" +
            escapeHtml(t("importErrorsLabel")) +
            "</div>" +
            acc.errors
              .map((e) => "<div>" + escapeHtml(String(e)) + "</div>")
              .join("") +
            "</div>"
          : "";
        if (statusEl) statusEl.innerHTML = counts() + errList;
        if (actions) {
          const btn = document.createElement("button");
          btn.textContent = t("close");
          btn.addEventListener("click", async function () {
            overlay.remove();
            const refreshTid = byId("strapiTid")?.value || "";
            const refreshQs = refreshTid
              ? "?tid=" + encodeURIComponent(refreshTid)
              : "";
            try {
              const preview = await api(
                "/api/import/strapi/preview" + refreshQs,
              );
              strapiAllArticles = preview.articles || [];
              renderStrapiArticleList(strapiAllArticles);
            } catch {
              /* refresh best-effort */
            }
          });
          actions.appendChild(btn);
        }
        const inlineStatus = byId("strapiImportStatus");
        if (inlineStatus) inlineStatus.textContent = counts();
      }

      byId("strapiImportAllBtn")?.addEventListener("click", async function () {
        // Fetch fresh preview to detect conflicts
        const currentTid = byId("strapiTid")?.value || "";
        const previewQs = currentTid
          ? "?tid=" + encodeURIComponent(currentTid)
          : "";
        let allArticles;
        try {
          const result = await api("/api/import/strapi/preview" + previewQs);
          allArticles = result.articles || [];
          strapiAllArticles = allArticles;
          renderStrapiArticleList(allArticles);
        } catch (err) {
          toast(t("previewFetchError") + errorMessage(err), true);
          return;
        }
        const conflicts = allArticles.filter(function (a: Dynamic) {
          return a.modifiedSinceImport;
        });
        if (conflicts.length > 0) {
          const conflictRows = conflicts
            .map(function (a: Dynamic) {
              const updAt = a.kurocmsUpdatedAt
                ? new Date(a.kurocmsUpdatedAt).toLocaleDateString(state.uiLang)
                : "-";
              return (
                "<label style='display:block;padding:8px 12px;border-bottom:1px solid var(--line);cursor:pointer'>" +
                "<div style='display:flex;align-items:center;gap:8px'>" +
                "<input type='checkbox' name='overwriteId' checked value='" +
                escapeHtml(String(a.id)) +
                "' style='width:auto;flex-shrink:0'>" +
                "<span style='font-size:13px;font-weight:600'>" +
                escapeHtml(a.title || a.slug) +
                "</span>" +
                "</div>" +
                "<div style='font-size:11px;color:var(--muted);padding-left:24px'>" +
                escapeHtml(t("kurocmsLastUpdated")) +
                ": " +
                updAt +
                "</div>" +
                "</label>"
              );
            })
            .join("");
          const conflictHtml =
            "<p>" +
            escapeHtml(t("strapiConflictWarning")) +
            "</p>" +
            "<div style='margin:8px 0;display:flex;justify-content:flex-end'>" +
            "<button type='button' id='overwriteCheckAll' class='secondary' style='font-size:12px;padding:5px 12px'>" +
            escapeHtml(t("selectAllToggle")) +
            "</button>" +
            "</div>" +
            "<div style='max-height:300px;overflow-y:auto;border:1px solid var(--line);border-radius:4px'>" +
            conflictRows +
            "</div>" +
            "<p style='margin-top:8px;font-size:12px;color:var(--muted)'>" +
            escapeHtml(t("strapiConflictNoCheck")) +
            "</p>";
          openEntryDialog(
            t("importAllConflictTitle"),
            conflictHtml,
            t("runImport"),
            async function (form: Dynamic, close: Dynamic) {
              close();
              // 全件 overwrites every existing doc; UNchecked locally-modified
              // ones are protected (kept, not overwritten).
              const unchecked = Array.from(
                form.querySelectorAll(
                  "input[name='overwriteId']:not(:checked)",
                ),
              ) as HTMLInputElement[];
              const protectIds = unchecked.map(function (cb) {
                return cb.value;
              });
              await doImport("all", { overwriteAll: true, protectIds });
            },
          );
          // "Select all / deselect" toggle for the overwrite checkboxes.
          byId("overwriteCheckAll")?.addEventListener("click", function () {
            const boxes = Array.from(
              document.querySelectorAll<AdminElement>(
                "input[name='overwriteId']",
              ),
            );
            const allChecked =
              boxes.length > 0 && boxes.every((b) => b.checked);
            boxes.forEach((b) => {
              b.checked = !allChecked;
            });
          });
        } else {
          openEntryDialog(
            t("importConfirmAll"),
            "<p>" + escapeHtml(t("importConfirmAllMsg")) + "</p>",
            t("runImport"),
            async function (form: Dynamic, close: Dynamic) {
              close();
              await doImport("all", { overwriteAll: true });
            },
          );
        }
      });

      byId("strapiImportSelBtn")?.addEventListener("click", async function () {
        // Selection is tracked across pages in strapiSelected (the DOM only has
        // the current page's checkboxes).
        const selected = Array.from(strapiSelected);
        if (!selected.length) {
          toast(t("selectArticlesForImport"), true);
          return;
        }
        await doImport(selected);
      });
    })();

    // ── KuroCMS import JS ───────────────────────────────────────────────
    (function () {
      let kurocmsAllArticles: Dynamic[] = [];
      // Selection kept across pages (see strapiSelected for rationale).
      const kurocmsSelected = new Set<string>();
      let kurocmsPage = 1;

      // Load saved settings
      api("/api/import/kurocms/settings")
        .then(function (d) {
          if (d.kurocmsUrl) byId("kurocmsUrl")!.value = d.kurocmsUrl;
          if (d.kurocmsPat) byId("kurocmsPat")!.value = d.kurocmsPat;
        })
        .catch(function () {});

      function getKurocmsSettings() {
        return {
          kurocmsUrl: byId("kurocmsUrl")?.value?.trim() || "",
          kurocmsPat: byId("kurocmsPat")?.value?.trim() || "",
        };
      }

      function renderKurocmsArticleList(articles: Dynamic) {
        kurocmsAllArticles = articles;
        const count = byId("kurocmsArticleCount");
        const list = byId("kurocmsArticleList");
        const pager = byId("kurocmsPager");
        if (!list) return;
        const sorted = sortImportArticles(articles);
        if (kurocmsSelected.size) {
          const present = new Set(
            sorted.map(function (a: Dynamic) {
              return String(a.id);
            }),
          );
          kurocmsSelected.forEach(function (id) {
            if (!present.has(id)) kurocmsSelected.delete(id);
          });
        }
        if (count) count.textContent = sorted.length + t("importCountSuffix");
        if (!sorted.length) {
          list.innerHTML =
            "<div style='padding:20px;text-align:center;color:var(--muted);font-size:13px'>" +
            escapeHtml(t("articleNotFound")) +
            "</div>";
          if (pager) pager.innerHTML = "";
          return;
        }
        const pages = Math.max(1, Math.ceil(sorted.length / importPageSize));
        if (kurocmsPage > pages) kurocmsPage = pages;
        if (kurocmsPage < 1) kurocmsPage = 1;
        const start = (kurocmsPage - 1) * importPageSize;
        const pageItems = sorted.slice(start, start + importPageSize);
        list.innerHTML = pageItems
          .map(function (a: Dynamic) {
            const badge = a.exists
              ? a.modifiedSinceImport
                ? "<span style='font-size:10px;background:#fef3c7;color:#b45309;border:1px solid #fde68a;border-radius:4px;padding:1px 5px;margin-left:6px'>" +
                  escapeHtml(t("modifiedBadge")) +
                  "</span>"
                : "<span style='font-size:10px;background:#f0f9ff;color:#0369a1;border:1px solid #bae6fd;border-radius:4px;padding:1px 5px;margin-left:6px'>" +
                  escapeHtml(t("importedBadge")) +
                  "</span>"
              : "";
            return (
              "<label style='display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--line);cursor:pointer;min-width:0'>" +
              "<input type='checkbox' data-kurocms-id='" +
              a.id +
              "' style='flex-shrink:0'" +
              (kurocmsSelected.has(String(a.id)) ? " checked" : "") +
              ">" +
              "<span style='flex:1;min-width:0'><span style='font-size:13px;font-weight:600;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'>" +
              escapeHtml(a.title) +
              badge +
              "</span>" +
              "<span style='font-size:11px;color:var(--muted)'>" +
              escapeHtml(a.slug) +
              (a.languages?.length ? " · " + a.languages.join(", ") : "") +
              "</span></span>" +
              "</label>"
            );
          })
          .join("");
        if (pager)
          pager.innerHTML = importPagerHtml(
            "kurocms",
            sorted.length,
            kurocmsPage,
          );
      }

      byId("kurocmsSaveBtn")?.addEventListener(
        "click",
        async function (e: Dynamic) {
          try {
            await api("/api/import/kurocms/settings", {
              method: "PUT",
              body: JSON.stringify(getKurocmsSettings()),
            });
            toast(t("connectionSettingsSaved"), false, e.currentTarget);
          } catch (err) {
            toast(errorMessage(err), true);
          }
        },
      );

      byId("kurocmsTestBtn")?.addEventListener("click", async function () {
        const status = byId("kurocmsConnStatus");
        if (status) status.textContent = t("importing");
        try {
          await api("/api/import/kurocms/settings", {
            method: "PUT",
            body: JSON.stringify(getKurocmsSettings()),
          });
          const tid = byId("kurocmsTid")?.value || "";
          const d = await api(
            "/api/import/kurocms/preview" +
              (tid ? "?tid=" + encodeURIComponent(tid) : ""),
          );
          renderKurocmsArticleList(d.articles || []);
          const section = byId("kurocmsImportSection");
          if (section) section.style.display = "";
          if (status)
            status.textContent = d.total + t("kurocmsRetrievedSuffix");

          // Populate type/lang selects
          const [typesData, langData] = await Promise.all([
            api("/api/types"),
            api("/api/languages").catch(() => ({ languages: [] })),
          ]);
          const tidSel = byId("kurocmsTid");
          const langSel = byId("kurocmsLang");
          if (tidSel) {
            tidSel.innerHTML = (typesData.types || [])
              .map(function (t: Dynamic) {
                return (
                  "<option value='" +
                  escapeHtml(t.tid) +
                  "'>" +
                  escapeHtml(t.name || t.tid) +
                  "</option>"
                );
              })
              .join("");
          }
          if (langSel) {
            langSel.innerHTML = (langData.languages || [])
              .map(function (l: Dynamic) {
                return (
                  "<option value='" +
                  escapeHtml(l.lang) +
                  "'>" +
                  escapeHtml(l.lang) +
                  "</option>"
                );
              })
              .join("");
          }
        } catch (err) {
          if (status)
            status.textContent = t("error") + ": " + errorMessage(err);
          toast(errorMessage(err), true);
        }
      });

      // Sort / select-all / pagination — all driven through kurocmsSelected so
      // selection survives page changes (mirrors the Strapi import list).
      byId("kurocmsSort")?.addEventListener("change", function (e: Dynamic) {
        importSortOrder = e.target.value;
        kurocmsPage = 1;
        renderKurocmsArticleList(kurocmsAllArticles);
      });
      // Track per-row selection (delegated; the list re-renders each page).
      byId("kurocmsArticleList")?.addEventListener(
        "change",
        function (e: Dynamic) {
          const cb = e.target;
          if (!cb || !cb.dataset || !cb.dataset.kurocmsId) return;
          const id = String(cb.dataset.kurocmsId);
          if (cb.checked) kurocmsSelected.add(id);
          else kurocmsSelected.delete(id);
        },
      );
      byId("kurocmsSelectAllBtn")?.addEventListener("click", function () {
        // Toggle ALL articles, across every page.
        const selectable = kurocmsAllArticles.map(function (a: Dynamic) {
          return String(a.id);
        });
        const allChecked =
          selectable.length > 0 &&
          selectable.every(function (id: Dynamic) {
            return kurocmsSelected.has(id);
          });
        selectable.forEach(function (id: Dynamic) {
          if (allChecked) kurocmsSelected.delete(id);
          else kurocmsSelected.add(id);
        });
        renderKurocmsArticleList(kurocmsAllArticles);
      });
      byId("kurocmsPager")?.addEventListener("click", function (e: Dynamic) {
        const btn = e.target.closest ? e.target.closest(".pagerBtn") : null;
        if (!btn || btn.disabled) return;
        const p = parseInt(btn.dataset.page, 10);
        if (!isNaN(p)) {
          kurocmsPage = p;
          renderKurocmsArticleList(kurocmsAllArticles);
        }
      });
      byId("kurocmsPager")?.addEventListener("change", function (e: Dynamic) {
        if (e.target && e.target.id === "kurocms-size") {
          importPageSize = parseInt(e.target.value, 10) || 20;
          kurocmsPage = 1;
          renderKurocmsArticleList(kurocmsAllArticles);
        }
      });

      async function doKurocmsImport(ids: Dynamic) {
        const tid = byId("kurocmsTid")?.value || "";
        const lang = byId("kurocmsLang")?.value || "";
        if (!tid || !lang) {
          toast(t("selectTypeAndLang"), true);
          return;
        }
        const status = byId("kurocmsImportStatus");

        // Conflict check
        const conflictIds: Dynamic = (
          ids === "all"
            ? kurocmsAllArticles
            : kurocmsAllArticles.filter(function (a) {
                return ids.includes(String(a.id));
              })
        )
          .filter(function (a) {
            return a.modifiedSinceImport;
          })
          .map(function (a) {
            return a.id;
          });

        let overwriteIds: Dynamic[] = [];
        if (conflictIds.length) {
          const conflictHtml =
            "<p>" +
            escapeHtml(t("kurocmsConflictWarning")) +
            "</p>" +
            conflictIds
              .map(function (id: Dynamic) {
                const a: Dynamic = kurocmsAllArticles.find(function (x) {
                  return x.id === id;
                });
                return (
                  "<label style='display:flex;gap:8px;align-items:center;padding:6px 0'><input type='checkbox' value='" +
                  id +
                  "'>" +
                  escapeHtml(a ? a.title : id) +
                  "</label>"
                );
              })
              .join("");
          const confirmed = await new Promise(function (resolve) {
            openEntryDialog(
              t("overwriteConfirmTitle"),
              conflictHtml,
              t("runImport"),
              function (form: Dynamic, close: Dynamic) {
                overwriteIds = (
                  Array.from(
                    form.querySelectorAll("input[type=checkbox]:checked"),
                  ) as HTMLInputElement[]
                ).map(function (cb) {
                  return cb.value;
                });
                close();
                resolve(true);
              },
              function () {
                resolve(false);
              },
            );
          });
          if (!confirmed) return;
        }

        const importMsg =
          ids === "all"
            ? "<p>" + escapeHtml(t("importConfirmAllMsg")) + "</p>"
            : "<p>" +
              escapeHtml(
                t("importConfirmSelMsgPre") +
                  (Array.isArray(ids) ? ids.length : "?") +
                  t("importConfirmSelMsgSuf"),
              ) +
              "</p>";
        const go = await new Promise(function (resolve) {
          openEntryDialog(
            t("importConfirmAll"),
            importMsg,
            t("execute"),
            function (_: Dynamic, close: Dynamic) {
              close();
              resolve(true);
            },
            function () {
              resolve(false);
            },
          );
        });
        if (!go) return;

        if (status) status.textContent = t("importing");
        try {
          const result: Dynamic = await api("/api/import/kurocms/execute", {
            method: "POST",
            body: JSON.stringify({ ids, overwriteIds, tid, lang }),
          });
          if (status)
            status.textContent =
              t("importResultPre") +
              result.imported +
              t("importResultImported") +
              " / " +
              result.overwritten +
              t("importResultOverwritten") +
              " / " +
              result.skipped +
              t("importResultSkipped");
          if (result.imagesDownloaded)
            toast(
              result.imagesDownloaded + t("imagesDownloadedToR2Suf"),
              false,
            );
          if (result.errors?.length)
            toast(
              t("error") + ": " + result.errors.slice(0, 3).join(" / "),
              true,
            );
          const d = await api(
            "/api/import/kurocms/preview" +
              (tid ? "?tid=" + encodeURIComponent(tid) : ""),
          );
          renderKurocmsArticleList(d.articles || []);
        } catch (err) {
          if (status)
            status.textContent = t("error") + ": " + errorMessage(err);
          toast(errorMessage(err), true);
        }
      }

      byId("kurocmsImportAllBtn")?.addEventListener("click", async function () {
        await doKurocmsImport("all");
      });

      byId("kurocmsImportSelBtn")?.addEventListener("click", async function () {
        // Selection is tracked across pages in kurocmsSelected (the DOM only has
        // the current page's checkboxes).
        const selected = Array.from(kurocmsSelected);
        if (!selected.length) {
          toast(t("selectArticlesForImport"), true);
          return;
        }
        await doKurocmsImport(selected);
      });
    })();

    async function saveAll(btn: Dynamic = null, extraFields: Dynamic = {}) {
      if (state.preview) {
        toast(t("previewReadOnly"), false, btn);
        return;
      }
      try {
        // siteName is edited on the Site Management screen now; echo the loaded
        // value so saving this form does not blank it.
        const siteName = (s?.siteName || "KuroCMS").trim();
        await api("/api/settings", {
          method: "PUT",
          body: JSON.stringify({
            siteName,
            publicDomain: byId("publicDomain")!.value,
            defaultLang: byId("defaultLang")!.value,
            // initial_lang は基本言語に一本化（UIから廃止）。default_lang をエコー。
            initialLang: byId("defaultLang")!.value,
            blueskyHandle: (byId("blueskyHandle")?.value || "").trim(),
            blueskySid: bSid,
            blueskyToken: (byId("blueskyToken")?.value || "").trim(),
            xApiKey: (byId("xApiKey")?.value || "").trim(),
            xApiSecret: (byId("xApiSecret")?.value || "").trim(),
            xAccessToken: (byId("xAccessToken")?.value || "").trim(),
            xAccessSecret: (byId("xAccessSecret")?.value || "").trim(),
            xLinkInReply: !!byId("xLinkInReply")?.checked,
            ...extraFields,
          }),
        });
        toast(t("siteSettingsSaved"), false, btn);
      } catch (error) {
        toast(errorMessage(error), true, btn);
        await reportClientError("settings.save", error);
      }
    }

    for (const formId of ["siteForm", "snsForm", "xAutoPostForm"]) {
      byId(formId)?.addEventListener("submit", async (event: Dynamic) => {
        event.preventDefault();
        const btn =
          event.submitter || event.target.querySelector("button[type=submit]");
        await saveAll(btn);
      });
    }
  } catch (error) {
    toast(errorMessage(error), true);
    await reportClientError("settings.load", error);
  }
}
