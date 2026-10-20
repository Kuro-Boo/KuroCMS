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
  // Pager HTML for an import list. `pfx` namespaces the page-size select id
  // (e.g. "strapi" → #strapi-size).
  function importPagerHtml(pfx: string, total: number, page: number) {
    return listPagerHtml(pfx + "-size", total, page, importPageSize);
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

  /**
   * サイトの時計の選択肢。値 "" = UTC（既定）。
   * ⚠ ここで選んだ TZ が「月アーカイブの区切り」と「公開ページに出る日付」の
   *   両方を決める。以前はこの 2 つが別々の時計（UTC とブラウザ）で動いていて、
   *   8 月のアーカイブに 9/1 の記事が混ざっていた。
   */
  function renderTimezoneSelect(current: string) {
    const select = byId("siteTimezone");
    if (!select) return;
    let zones: string[] = [];
    try {
      const supported = (Intl as Dynamic).supportedValuesOf;
      if (typeof supported === "function")
        zones = supported.call(Intl, "timeZone") as string[];
    } catch {
      zones = [];
    }
    const browserZone = detectBrowserTimezone();
    // supportedValuesOf が無いブラウザでも、少なくとも今の値とこの端末の TZ は
    // 選べるようにする（選択肢に無い値を保存で失うのが一番まずい）。
    const list = Array.from(
      new Set([...zones, browserZone, current].filter(Boolean)),
    ).sort();
    select.innerHTML =
      "<option value=''>" +
      escapeHtml(t("siteTimezoneUtc")) +
      "</option>" +
      list
        .map(
          (z) =>
            "<option value='" +
            escapeHtml(z) +
            "'>" +
            escapeHtml(z) +
            "</option>",
        )
        .join("");
    // ⚠ ここでは検出値を当てない。初期設定は管理画面の起動時に 1 回だけ走る
    // （initSiteTimezoneOnce → POST /api/settings/timezone-init）ので、この
    // 画面は**保存されている値をそのまま映す**だけでよい。2 箇所で決めると
    // 「設定したのに別の値に戻る」が生まれる。
    select.value = list.includes(current) ? current : "";
    const note = byId("siteTimezoneNote");
    if (note)
      note.textContent = browserZone
        ? t("siteTimezoneDetected").replace("{tz}", browserZone)
        : "";
  }

  const tabBar = [
    "basic",
    "sns",
    "mobile",
    "import",
    "ipgate",
    "region",
    "contract",
  ]
    .map((id) => {
      const labels: Record<string, string> = {
        basic: t("settingsTabBasic"),
        sns: t("settingsTabSns"),
        mobile: t("settingsTabMobile"),
        import: t("settingsTabImport"),
        ipgate: t("settingsTabIpGate"),
        region: t("settingsTabRegion"),
        contract: t("settingsTabContract"),
      };
      return (
        "<button type='button' class='settingsTab" +
        (id === "basic" ? " active" : "") +
        "' data-tab='" +
        id +
        "'" +
        // 契約情報は委託だけ(設定を読んでから出す)。
        (id === "contract" ? " id='contractTabBtn' style='display:none'" : "") +
        ">" +
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
      "</div><div style='display:flex;align-items:center;gap:8px'>" +
      "<input id='publicDomain' required placeholder='https://kuro.boo/' style='flex:1;min-width:0' />" +
      "<a id='openPublicDomainBtn' class='secondary' target='_blank' rel='noopener' title='" +
      escapeHtml(t("openPublicPage")) +
      "' aria-label='" +
      escapeHtml(t("openPublicPage")) +
      "' style='display:none;align-items:center;justify-content:center;padding:3px 8px;text-decoration:none;font-size:14px;line-height:1;white-space:nowrap'>&#8599;</a>" +
      "</div></label>" +
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
      "<a id='openWorkerOriginBtn' class='secondary' target='_blank' rel='noopener' title='" +
      escapeHtml(t("openPublicPage")) +
      "' aria-label='" +
      escapeHtml(t("openPublicPage")) +
      "' style='display:inline-flex;align-items:center;justify-content:center;padding:3px 8px;text-decoration:none;font-size:14px;line-height:1;white-space:nowrap'>&#8599;</a>" +
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
      // サイトの時計。月アーカイブの区切りと公開ページの日付表示の両方が
      // これで決まる（未設定 = UTC）。ビルド出力を変えるので再ビルドが要る。
      "<label>" +
      escapeHtml(t("siteTimezone")) +
      "<div class='muted'>" +
      escapeHtml(t("siteTimezoneHelp")) +
      "</div><select id='siteTimezone'></select></label>" +
      "<div class='muted' id='siteTimezoneNote' style='font-size:12px'></div>" +
      // 記事末尾の「筆者: 表示名」。会社・製品紹介のサイトなど不要なら外す。
      // 切り替えの行は部品(.toggleRow)を使う。label は display:grid なので、チェックが文字の上に載る。
      "<div class='toggleRow'><div><div><b>" +
      escapeHtml(t("showByline")) +
      "</b></div><div class='tokenMeta'>" +
      escapeHtml(t("showBylineHelp")) +
      "</div></div><input id='showByline' type='checkbox' class='toggle' /></div>" +
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
      "<button type='button' class='secondary snsSvcTab' data-sns-svc-tab='threads' style='padding:5px 14px;font-size:13px;font-weight:700'>@ Threads</button>" +
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
      "<div style='margin-top:14px;padding-top:10px;border-top:1px solid var(--line)'>" +
      "<div class='muted' style='font-size:11px;margin-bottom:6px'>" +
      escapeHtml(t("snsBulkTitle")) +
      "</div>" +
      "<div style='display:flex;gap:8px;flex-wrap:wrap'>" +
      "<button type='button' class='secondary' data-sns-bulk='bsky' data-sns-bulk-posted='1' style='font-size:12px;padding:5px 12px;border:1px solid var(--line);border-radius:8px'>" +
      escapeHtml(t("snsBulkSetBtn")) +
      "</button>" +
      "<button type='button' class='secondary' data-sns-bulk='bsky' data-sns-bulk-posted='0' style='font-size:12px;padding:5px 12px;border:1px solid var(--line);border-radius:8px'>" +
      escapeHtml(t("snsBulkClearBtn")) +
      "</button>" +
      "</div>" +
      "</div>" +
      // Console link goes where THIS card's credential lives (app password page),
      // not the public profile — that is what the operator needs to re-issue it.
      "<div style='margin-top:16px;display:flex;justify-content:flex-end;align-items:center;gap:8px;flex-wrap:wrap'>" +
      "<a id='bskyConsoleLink' class='secondary' target='_blank' rel='noopener' href='https://bsky.app/settings/app-passwords' title='https://bsky.app/settings/app-passwords' style='display:inline-flex;align-items:center;gap:6px;padding:6px 14px;font-size:12px;text-decoration:none;white-space:nowrap'>" +
      escapeHtml(t("openSnsConsole")) +
      " &#8599;</a>" +
      "<button type='submit'>" +
      escapeHtml(t("saveSnsSettings")) +
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
      "<div style='margin-top:14px;padding-top:10px;border-top:1px solid var(--line)'>" +
      "<div class='muted' style='font-size:11px;margin-bottom:6px'>" +
      escapeHtml(t("snsBulkTitle")) +
      "</div>" +
      "<div style='display:flex;gap:8px;flex-wrap:wrap'>" +
      "<button type='button' class='secondary' data-sns-bulk='x' data-sns-bulk-posted='1' style='font-size:12px;padding:5px 12px;border:1px solid var(--line);border-radius:8px'>" +
      escapeHtml(t("snsBulkSetBtn")) +
      "</button>" +
      "<button type='button' class='secondary' data-sns-bulk='x' data-sns-bulk-posted='0' style='font-size:12px;padding:5px 12px;border:1px solid var(--line);border-radius:8px'>" +
      escapeHtml(t("snsBulkClearBtn")) +
      "</button>" +
      "</div>" +
      "</div>" +
      // X: the four keys above are issued per app in the developer portal.
      "<div style='margin-top:16px;display:flex;justify-content:flex-end;align-items:center;gap:8px;flex-wrap:wrap'>" +
      "<a id='xConsoleLink' class='secondary' target='_blank' rel='noopener' href='https://developer.x.com/en/portal/projects-and-apps' title='https://developer.x.com/en/portal/projects-and-apps' style='display:inline-flex;align-items:center;gap:6px;padding:6px 14px;font-size:12px;text-decoration:none;white-space:nowrap'>" +
      escapeHtml(t("openSnsConsole")) +
      " &#8599;</a>" +
      "<button type='submit'>" +
      escapeHtml(t("saveSnsSettings")) +
      "</button></div>" +
      "</form>" +
      // ── Threads (Meta) auto-post card: one long-lived access token ──
      // Hidden until the Threads switcher tab is selected.
      "<form class='snsCard' id='threadsAutoPostForm' style='display:none'>" +
      "<div class='snsCardHead'>" +
      "<div class='snsCardTitle'><span style='font-size:18px'>@</span> " +
      escapeHtml(t("threadsSettingsTitle")) +
      "</div>" +
      "</div>" +
      "<div class='muted' style='margin-bottom:10px'>" +
      escapeHtml(t("threadsCredsHelp")) +
      "</div>" +
      "<label style='margin-bottom:10px'>" +
      escapeHtml(t("snsAccessToken")) +
      "<input id='threadsToken' type='password' autocomplete='off' /></label>" +
      "<div style='display:grid;grid-template-columns:minmax(140px,auto) 1fr;gap:5px 12px;margin:0 0 10px;font-size:12px'>" +
      "<span class='muted'>" +
      escapeHtml(t("threadsTokenUpdatedAt")) +
      "</span><span id='threadsTokenUpdatedAt'>—</span>" +
      "<span class='muted'>" +
      escapeHtml(t("threadsTokenNextRefreshAt")) +
      "</span><span id='threadsTokenNextRefreshAt'>—</span>" +
      "</div>" +
      "<div class='muted' style='margin-bottom:10px;font-size:11px'>" +
      escapeHtml(t("threadsTokenRefreshHelp")) +
      "</div>" +
      "<div class='muted' style='margin-bottom:6px'>" +
      escapeHtml(t("threadsPostNote")) +
      "</div>" +
      "<div style='margin-top:14px;padding-top:10px;border-top:1px solid var(--line)'>" +
      "<div class='muted' style='font-size:11px;margin-bottom:6px'>" +
      escapeHtml(t("snsBulkTitle")) +
      "</div>" +
      "<div style='display:flex;gap:8px;flex-wrap:wrap'>" +
      "<button type='button' class='secondary' data-sns-bulk='threads' data-sns-bulk-posted='1' style='font-size:12px;padding:5px 12px;border:1px solid var(--line);border-radius:8px'>" +
      escapeHtml(t("snsBulkSetBtn")) +
      "</button>" +
      "<button type='button' class='secondary' data-sns-bulk='threads' data-sns-bulk-posted='0' style='font-size:12px;padding:5px 12px;border:1px solid var(--line);border-radius:8px'>" +
      escapeHtml(t("snsBulkClearBtn")) +
      "</button>" +
      "</div>" +
      "</div>" +
      // Threads: the long-lived token comes from a Meta app, so link the app list.
      "<div style='margin-top:16px;display:flex;justify-content:flex-end;align-items:center;gap:8px;flex-wrap:wrap'>" +
      "<a id='threadsConsoleLink' class='secondary' target='_blank' rel='noopener' href='https://developers.facebook.com/apps/' title='https://developers.facebook.com/apps/' style='display:inline-flex;align-items:center;gap:6px;padding:6px 14px;font-size:12px;text-decoration:none;white-space:nowrap'>" +
      escapeHtml(t("openSnsConsole")) +
      " &#8599;</a>" +
      "<button type='submit'>" +
      escapeHtml(t("saveSnsSettings")) +
      "</button></div>" +
      "</form>" +
      "<div id='extraSnsCards'></div>" +
      "</div>" +
      "</div>" +
      "</div>" +
      // ── スマホ設定 ───────────────────────────────────────────────────
      "<div id='panel-mobile' class='settingsPanel' style='display:none'>" +
      "<div class='panel stack'>" +
      "<div class='panelHead'><h3>" +
      escapeHtml(t("mobileTitle")) +
      "</h3></div>" +
      "<div class='muted' style='font-size:12px'>" +
      escapeHtml(t("mobileIntro")) +
      "</div>" +
      "<label style='flex-direction:row;align-items:center;gap:8px;cursor:pointer'>" +
      "<input id='mobileMediaFullWidth' type='checkbox' style='width:auto;margin:0' />" +
      escapeHtml(t("mobileMediaFullWidth")) +
      "</label>" +
      "<div class='muted' style='font-size:12px'>" +
      escapeHtml(t("mobileMediaFullWidthHelp")) +
      "</div>" +
      "<div class='muted' style='font-size:12px'>" +
      escapeHtml(t("mobileMediaFullWidthVideo")) +
      "</div>" +
      "<div style='font-size:12px;padding:8px 10px;border-radius:8px;background:rgba(128,128,128,.12)'>" +
      escapeHtml(t("mobileBuildNote")) +
      "</div>" +
      "<div class='toolbar'><button type='button' id='saveMobileBtn'>" +
      escapeHtml(t("save")) +
      "</button></div>" +
      "<div id='mobileStatus' class='muted' style='font-size:12px'></div>" +
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

  // ── IP 制限(接続元の登録・ip-gate.ts) ────────────────────────────────
  // 登録は全自動。ここで決めるのは入・切と、PAT を縛るか、期限の日数だけ。
  byId("panel-import")?.insertAdjacentHTML(
    "afterend",
    (() => {
      const box =
        "border:1px solid var(--line);border-radius:10px;background:var(--surface-2);padding:12px 14px";
      const toggle = (id: string) =>
        "<label class='toggleSwitch'><input type='checkbox' id='" +
        id +
        "' /><span class='toggleSlider'></span></label>";
      const step = (n: string, title: string, body: string) =>
        "<div style='" +
        box +
        "'><div style='display:flex;align-items:center;gap:8px;margin-bottom:6px'>" +
        "<span style='display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:var(--theme-accent,#0f766e);color:#fff;font-size:12px;font-weight:700'>" +
        n +
        "</span><b style='font-size:13px'>" +
        escapeHtml(title) +
        "</b></div><div class='muted' style='font-size:12px;line-height:1.7'>" +
        escapeHtml(body) +
        "</div></div>";
      const ttl = (id: string, label: string) =>
        "<div style='" +
        box +
        "'><span class='fieldLabel'>" +
        escapeHtml(label) +
        "</span><div style='display:flex;align-items:center;gap:8px'>" +
        "<input id='" +
        id +
        "' type='number' min='1' max='90' style='width:110px' />" +
        "<span class='muted' style='font-size:13px'>" +
        escapeHtml(t("ipGateDays")) +
        "</span></div></div>";
      return (
        "<div id='panel-ipgate' class='settingsPanel' style='display:none'>" +
        "<form class='stack' id='ipGateForm' style='gap:16px'>" +
        // ① 状態
        "<div class='panel stack' style='gap:12px'>" +
        "<div class='panelHead'><h3>" +
        escapeHtml(t("ipGateTitle")) +
        "</h3>" +
        "<div style='display:flex;align-items:center;gap:10px'><span id='ipGateState' style='font-size:13px;font-weight:700'></span>" +
        toggle("ipGateEnabled") +
        "</div></div>" +
        "<div class='muted' style='font-size:13px;line-height:1.7'>" +
        escapeHtml(t("ipGateHelp")) +
        "</div>" +
        "<div style='" +
        box +
        ";display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px'>" +
        "<span class='fieldLabel' style='margin:0'>" +
        escapeHtml(t("ipGateCurrentLabel")) +
        "</span><code id='ipGateCurrentNet' style='font-size:13px'></code>" +
        "<span id='ipGateCurrentLine' class='muted' style='font-size:12px'></span></div>" +
        "</div>" +
        // ①' 登録 IPv6(自分の回線)。手で足す prefix は固定(期限なし)。
        //     ipGateForm の中にあるので、追加は submit ではなくボタンの click で送る。
        "<div class='panel stack' style='gap:12px'>" +
        "<div class='panelHead'><h3>" +
        escapeHtml(t("ipV6Title")) +
        "</h3></div>" +
        "<div class='muted' style='font-size:13px;line-height:1.7'>" +
        escapeHtml(t("ipV6Lead")) +
        "</div>" +
        "<div id='ipV6List' class='stack' style='gap:8px'></div>" +
        "<div style='" +
        box +
        ";display:flex;flex-wrap:wrap;align-items:center;gap:8px'>" +
        "<input id='ipV6Net' placeholder='" +
        escapeHtml(t("ipV6Placeholder")) +
        "' style='flex:2;min-width:220px;font-family:ui-monospace,Menlo,monospace' />" +
        "<input id='ipV6Note' maxlength='100' placeholder='" +
        escapeHtml(t("ipV6NotePlaceholder")) +
        "' style='flex:1;min-width:140px' />" +
        "<button type='button' id='ipV6AddBtn'>" +
        escapeHtml(t("ipV6Add")) +
        "</button>" +
        "<button type='button' id='ipV6UseCurrentBtn' class='secondary' style='display:none'>" +
        escapeHtml(t("ipV6UseCurrent")) +
        "</button>" +
        "</div>" +
        "</div>" +
        // ② 仕組み
        "<div class='panel stack' style='gap:12px'>" +
        "<div class='panelHead'><h3>" +
        escapeHtml(t("ipGateHowTitle")) +
        "</h3></div>" +
        "<div style='display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px'>" +
        step("1", t("ipGateHow1t"), t("ipGateHow1b")) +
        step("2", t("ipGateHow2t"), t("ipGateHow2b")) +
        step("3", t("ipGateHow3t"), t("ipGateHow3b")) +
        "</div></div>" +
        // ③ 詳しい設定
        "<div class='panel stack' style='gap:12px'>" +
        "<div class='panelHead'><h3>" +
        escapeHtml(t("ipGateDetailTitle")) +
        "</h3></div>" +
        "<div style='" +
        box +
        ";display:flex;align-items:center;justify-content:space-between;gap:14px'>" +
        "<div><b style='font-size:13px'>" +
        escapeHtml(t("ipGatePat")) +
        "</b><div class='muted' style='font-size:12px;margin-top:2px'>" +
        escapeHtml(t("ipGatePatHelp")) +
        "</div></div>" +
        toggle("ipGatePat") +
        "</div>" +
        "<div style='display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px'>" +
        ttl("ipGateTtlV6", t("ipGateTtlV6")) +
        ttl("ipGateTtlV4", t("ipGateTtlV4")) +
        "</div>" +
        "<div class='muted' style='font-size:12px'>" +
        escapeHtml(t("ipGateTtlHelp")) +
        "</div>" +
        // 保存は SNS 連動のカードと同じく、カードの右下に普通の大きさで置く。
        "<div style='margin-top:16px;display:flex;justify-content:flex-end;align-items:center;gap:8px;flex-wrap:wrap'>" +
        "<button type='submit'>" +
        escapeHtml(t("save")) +
        "</button></div>" +
        "</div>" +
        "</form></div>"
      );
    })(),
  );

  // ── 稼働地域(Worker と D1 がいまどこで動いているか・/api/system/region) ──
  // 地名はサーバーが管理画面の言語で付ける。表に無い拠点は名前が無く、コードを添え書きにする。
  byId("panel-ipgate")?.insertAdjacentHTML(
    "afterend",
    "<div id='panel-region' class='settingsPanel' style='display:none'>" +
      "<div class='panel stack' style='gap:12px'>" +
      "<div class='panelHead'><h3>" +
      escapeHtml(t("regionTitle")) +
      "</h3><button type='button' id='regionMeasureBtn' class='secondary'>" +
      escapeHtml(t("regionMeasure")) +
      "</button></div>" +
      "<div class='muted' style='font-size:13px;line-height:1.7'>" +
      escapeHtml(t("regionHelp")) +
      "</div>" +
      "<div id='regionRows' style='display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;font-size:14px'></div>" +
      "</div></div>",
  );
  let regionMeasured = false;
  async function loadRegion() {
    const rows = byId("regionRows");
    if (!rows) return;
    rows.innerHTML = "<span class='muted'>…</span>";
    try {
      const r: Dynamic = await api(
        "/api/system/region?lang=" + encodeURIComponent(state.uiLang),
      );
      const place = (code: string | null, name: string | null) =>
        name ||
        (code
          ? t("regionOtherPlace").replace("{code}", code)
          : t("regionUnknown"));
      const line = (label: string, value: string) =>
        "<span class='fieldLabel' style='margin:0'>" +
        escapeHtml(label) +
        "</span><span>" +
        escapeHtml(value) +
        "</span>";
      const db =
        r.d1_region || r.d1_colo
          ? (r.names.d1_region || r.d1_region || t("regionUnknown")) +
            " · " +
            place(r.d1_colo, r.names.d1_colo)
          : t("regionUnknown");
      let html =
        line(t("regionDb"), db) +
        line(t("regionWorker"), place(r.worker_colo, r.names.worker));
      // 入口(要求が入った拠点)は Worker の場所と違うときだけ出す。
      if (r.entry_colo && r.entry_colo !== r.worker_colo)
        html += line(t("regionEntry"), place(r.entry_colo, r.names.entry));
      if (r.rtt_ms !== null)
        html += line(
          t("regionRtt"),
          r.rtt_ms + " ms · " + (r.same ? t("regionSame") : t("regionApart")),
        );
      rows.innerHTML = html;
      regionMeasured = true;
    } catch (err) {
      rows.innerHTML = "";
      toast(errorMessage(err), true);
    }
  }
  byId("regionMeasureBtn")?.addEventListener("click", () => void loadRegion());

  // ── 契約情報(委託だけ・/api/system/contract・cms-pricing「契約情報」) ──
  // 受付が毎時 Entamy(Admin の導入の記録・Entamy ID)から引いて書いた 1 行を出す。
  // 無料期間が終わった後(契約なし)は、データを消すまでの待機期間・最終日・消す日を足す。
  byId("panel-region")?.insertAdjacentHTML(
    "afterend",
    "<div id='panel-contract' class='settingsPanel' style='display:none'>" +
      "<div class='panel stack' style='gap:12px'>" +
      "<div class='panelHead'><h3>" +
      escapeHtml(t("contractTitle")) +
      "</h3></div>" +
      "<div class='muted' style='font-size:13px;line-height:1.7'>" +
      escapeHtml(t("contractHelp")) +
      "</div>" +
      "<div id='contractRows' style='display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;font-size:14px'></div>" +
      "<div id='contractNote' class='readonlyBanner' style='display:none;margin:0;flex-wrap:wrap'></div>" +
      "<div id='contractSynced' class='muted' style='font-size:12px'></div>" +
      "</div></div>",
  );
  let contractLoaded = false;
  async function loadContract() {
    const rows = byId("contractRows");
    const note = byId("contractNote");
    const synced = byId("contractSynced");
    if (!rows || !note || !synced) return;
    rows.innerHTML = "<span class='muted'>…</span>";
    note.textContent = "";
    note.style.display = "none";
    synced.textContent = "";
    try {
      const r: Dynamic = await api("/api/system/contract");
      const c: Dynamic = r.contract;
      if (!c) {
        rows.innerHTML = "";
        synced.textContent = t("contractPending");
        return;
      }
      const DAY = 86_400_000;
      // 期限は Entamy ID が「その日の終わり(UTC)」で持つ。手元の時刻帯で出すと、日本では
      // 3 月 31 日までの延長が「4 月 1 日」に見える(23:59 UTC = 翌朝 8:59 JST)。日は UTC で出す。
      const date = (ms: number | null) =>
        ms == null
          ? "—"
          : new Date(ms).toLocaleDateString(state.uiLang, {
              year: "numeric",
              month: "long",
              day: "numeric",
              timeZone: "UTC",
            });
      const line = (label: string, value: string, strong = false) =>
        "<span class='fieldLabel' style='margin:0'>" +
        escapeHtml(label) +
        "</span><span" +
        (strong ? " style='font-weight:700'" : "") +
        ">" +
        escapeHtml(value) +
        "</span>";
      const sub =
        c.subscription === "active"
          ? t("contractSubActive").replace("{date}", date(c.subscription_until))
          : c.subscription === "cancelled"
            ? t("contractSubCancelled").replace(
                "{date}",
                date(c.subscription_until),
              )
            : t("contractSubNone");
      let html =
        line(t("contractAt"), date(c.contract_at)) +
        line(t("contractTrialEnds"), date(c.trial_ends_at)) +
        line(
          t("contractTrialExtended"),
          c.trial_extended_until
            ? date(c.trial_extended_until) +
                (c.trial_extension_note ? " · " + c.trial_extension_note : "")
            : t("contractTrialExtendedNone"),
        ) +
        line(t("contractTrialFinal"), date(c.trial_final_at), true) +
        line(t("contractSubscription"), sub);
      // 無料期間が終わり、契約が無い: データを消すまでの日付を足す。
      const ended =
        c.delete_at != null &&
        c.trial_final_at != null &&
        r.now > c.trial_final_at;
      if (ended) {
        const left = Math.max(0, Math.ceil((c.delete_at - r.now) / DAY));
        html +=
          line(
            t("contractGrace"),
            t("contractRange")
              .replace("{from}", date(c.trial_final_at))
              .replace("{to}", date(c.delete_at))
              .replace("{n}", String(c.delete_after_days)),
          ) +
          line(t("contractLastDay"), date(c.delete_at - DAY), true) +
          line(t("contractDeleteAt"), date(c.delete_at)) +
          line(
            t("contractDaysLeft"),
            t("contractDays").replace("{n}", String(left)),
            true,
          );
        note.style.display = "";
        note.textContent = t("contractEndedNote") + " ";
        const move = document.createElement("a");
        move.href = "https://kuro.boo/kurocms/?pick=move#install";
        move.target = "_blank";
        move.rel = "noopener";
        move.textContent = t("moveToSelfLink");
        note.appendChild(move);
      }
      rows.innerHTML = html;
      if (c.synced_at)
        synced.textContent = t("contractSynced").replace(
          "{date}",
          new Date(c.synced_at).toLocaleString(state.uiLang),
        );
      contractLoaded = true;
    } catch (err) {
      rows.innerHTML = "";
      toast(errorMessage(err), true);
    }
  }
  function renderIpGateState() {
    const on = (byId("ipGateEnabled") as Dynamic)?.checked;
    const el = byId("ipGateState");
    if (el) {
      el.textContent = on ? t("ipGateOn") : t("ipGateOff");
      el.style.color = on ? "var(--theme-accent,#0f766e)" : "var(--muted)";
    }
  }
  byId("ipGateEnabled")?.addEventListener("change", renderIpGateState);
  async function loadIpGate() {
    try {
      const r = await api("/api/system/ip-gate");
      const c = r.config || {};
      (byId("ipGateEnabled") as Dynamic).checked = c.enabled !== false;
      (byId("ipGatePat") as Dynamic).checked = c.pat === true;
      (byId("ipGateTtlV6") as Dynamic).value = String(c.ttl_v6_days ?? 30);
      (byId("ipGateTtlV4") as Dynamic).value = String(c.ttl_v4_days ?? 7);
      const net = byId("ipGateCurrentNet");
      const line = byId("ipGateCurrentLine");
      if (net) net.textContent = r.current ? r.current.net : "—";
      if (line)
        line.textContent = r.current && r.current.label ? r.current.label : "";
      renderIpGateState();
    } catch (err) {
      toast(errorMessage(err), true);
    }
  }
  // ── 登録 IPv6(自分の回線の一覧・固定の prefix を足す・外す) ──
  async function loadIpV6() {
    const listEl = byId("ipV6List");
    if (!listEl) return;
    let data: Dynamic;
    try {
      data = await api("/api/auth/networks");
    } catch (err) {
      toast(errorMessage(err), true);
      return;
    }
    const cur = data.current ? String(data.current.net) : "";
    const useCur = byId("ipV6UseCurrentBtn");
    if (useCur) {
      useCur.style.display = cur.includes(":") ? "" : "none";
      useCur.dataset.net = cur;
    }
    const rows = (data.networks || []).filter(
      (n: Dynamic) => n.family === "v6",
    );
    listEl.innerHTML =
      rows
        .map(function (n: Dynamic) {
          const badge =
            "<span class='tokenMeta' style='font-weight:700;" +
            (n.pinned ? "color:var(--theme-accent,#0f766e)" : "") +
            "'>" +
            escapeHtml(n.pinned ? t("ipV6Pinned") : t("ipV6Auto")) +
            "</span>";
          const meta = n.pinned
            ? escapeHtml(t("ipV6NoExpiry"))
            : escapeHtml(t("networkLastUsed")) +
              " " +
              escapeHtml(
                formatDateTime(new Date(n.last_seen_at).toISOString()),
              ) +
              " · " +
              escapeHtml(t("networkExpires")) +
              " " +
              escapeHtml(formatDateTime(new Date(n.expires_at).toISOString()));
          const desc = n.note || n.label;
          return (
            "<div class='tokenRow'><div><code style='font-size:13px'>" +
            escapeHtml(n.net) +
            "</code> " +
            badge +
            (desc
              ? " <span class='tokenMeta'>" + escapeHtml(desc) + "</span>"
              : "") +
            (n.net === cur
              ? " <span class='tokenMeta' style='color:var(--theme-accent,#0f766e);font-weight:600'>（" +
                escapeHtml(t("networkCurrent")) +
                "）</span>"
              : "") +
            "<div class='tokenMeta'>" +
            meta +
            "</div></div><div><button type='button' class='danger' data-remove-v6='" +
            escapeHtml(n.id) +
            "'>&#128465; " +
            escapeHtml(t("delete")) +
            "</button></div></div>"
          );
        })
        .join("") ||
      "<div class='tokenMeta'>" + escapeHtml(t("ipV6Empty")) + "</div>";
    listEl.querySelectorAll<AdminElement>("[data-remove-v6]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm(t("networkRemoveConfirm"))) return;
        try {
          await api(
            "/api/auth/networks/" +
              encodeURIComponent(btn.dataset.removeV6 || ""),
            { method: "DELETE" },
          );
          await loadIpV6();
        } catch (err) {
          toast(errorMessage(err), true, btn);
        }
      });
    });
  }
  async function addIpV6() {
    const btn = byId("ipV6AddBtn") as Dynamic;
    const netEl = byId("ipV6Net") as Dynamic;
    const noteEl = byId("ipV6Note") as Dynamic;
    if (state.preview) {
      toast(t("previewReadOnly"), false, btn);
      return;
    }
    const net = String(netEl?.value || "").trim();
    if (!net) {
      netEl?.focus();
      return;
    }
    btn.disabled = true;
    try {
      await api("/api/auth/networks", {
        method: "POST",
        body: JSON.stringify({ net, note: String(noteEl?.value || "") }),
      });
      netEl.value = "";
      noteEl.value = "";
      toast(t("ipV6Added"), false, btn);
      await loadIpV6();
    } catch (err) {
      toast(errorMessage(err), true, btn);
    }
    btn.disabled = false;
  }
  byId("ipV6AddBtn")?.addEventListener("click", addIpV6);
  // ipGateForm の中の入力なので、Enter で設定の保存が走らないよう、ここで受ける。
  ["ipV6Net", "ipV6Note"].forEach((id) =>
    byId(id)?.addEventListener("keydown", (e: Dynamic) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      void addIpV6();
    }),
  );
  byId("ipV6UseCurrentBtn")?.addEventListener("click", () => {
    const netEl = byId("ipV6Net") as Dynamic;
    const cur = byId("ipV6UseCurrentBtn")?.dataset.net || "";
    if (netEl && cur) {
      netEl.value = cur;
      netEl.focus();
    }
  });
  byId("ipGateForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = (e.target as Dynamic).querySelector("button");
    if (state.preview) {
      toast(t("previewReadOnly"), false, btn);
      return;
    }
    const enabled = (byId("ipGateEnabled") as Dynamic).checked;
    if (!enabled && !confirm(t("ipGateOffConfirm"))) return;
    try {
      await api("/api/system/ip-gate", {
        method: "PUT",
        body: JSON.stringify({
          enabled,
          pat: (byId("ipGatePat") as Dynamic).checked,
          ttl_v6_days: Number((byId("ipGateTtlV6") as Dynamic).value),
          ttl_v4_days: Number((byId("ipGateTtlV4") as Dynamic).value),
        }),
      });
      toast(t("saved"), false, btn);
      await loadIpGate();
    } catch (err) {
      toast(errorMessage(err), true, btn);
    }
  });
  loadIpGate();
  loadIpV6();

  // Tab switching
  document.querySelectorAll<AdminElement>(".settingsTab").forEach((btn) => {
    btn.addEventListener("click", () => {
      switchTab(btn.dataset.tab);
      if (btn.dataset.tab === "region" && !regionMeasured) void loadRegion();
      if (btn.dataset.tab === "contract" && !contractLoaded)
        void loadContract();
    });
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

    if (!languageOptions.length) languageOptions = [s.defaultLang || "en"];
    renderLanguageSelects(languageOptions, s.defaultLang);

    // Basic (siteName moved to the Site Management screen)
    const publicDomainInput = byId("publicDomain")!;
    const openPublicDomainBtn = byId("openPublicDomainBtn")!;
    publicDomainInput.value = s.publicDomain || "";
    const syncPublicDomainOpenButton = function () {
      const value = publicDomainInput.value.trim();
      try {
        const url = new URL(value);
        if (url.protocol !== "https:" && url.protocol !== "http:") {
          throw new Error("unsupported protocol");
        }
        openPublicDomainBtn.href = url.href;
        openPublicDomainBtn.style.display = "inline-flex";
      } catch {
        openPublicDomainBtn.removeAttribute("href");
        openPublicDomainBtn.style.display = "none";
      }
    };
    syncPublicDomainOpenButton();
    publicDomainInput.addEventListener("input", syncPublicDomainOpenButton);

    // 委託: アドレスは受付が決めたもの({導入ID}.kurocms.site)。表示だけにし、
    // workers.dev・独自ドメイン・R2 の枠は出さない(鍵も持たない・重複する表示も出さない)。
    if (s.managedHosting) {
      const contractTab = byId("contractTabBtn");
      if (contractTab) contractTab.style.display = "";
      (publicDomainInput as unknown as HTMLInputElement).readOnly = true;
      const help = publicDomainInput
        .closest("label")
        ?.querySelector<HTMLElement>(".muted");
      if (help) {
        help.textContent = t("publicDomainManagedHelp") + " ";
        // 顧客導入への引っ越し(仕様 cms-move-to-self)。受付の引っ越しの頁(kuro.boo の導入の節)へ。
        const move = document.createElement("a");
        move.href = "https://kuro.boo/kurocms/?pick=move#install";
        move.target = "_blank";
        move.rel = "noopener";
        move.textContent = t("moveToSelfLink");
        help.appendChild(move);
      }
      // 空の枠を残すと、枠の間(stack の gap)だけが空く。
      for (const id of [
        "workerOriginSection",
        "customDomainSection",
        "r2SetupSection",
      ])
        byId(id)?.remove();
    }

    // Worker origin URL + CNAME guide
    (function () {
      if (s.managedHosting) return;
      const devDomain = (s.developmentDomain || "").trim();
      const pubDomain = (s.publicDomain || "").trim();
      if (!devDomain) return;

      const originSection = byId("workerOriginSection");
      const originDisplay = byId("workerOriginDisplay");
      const copyBtn = byId("copyWorkerOriginBtn");
      const openBtn = byId("openWorkerOriginBtn");
      if (originSection && originDisplay) {
        originSection.style.display = "";
        originDisplay.textContent = devDomain;
      }
      if (openBtn) openBtn.href = devDomain;
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
      // R2 はお客様が自分の Cloudflare で始めて繋ぐ(KuroCMS は作らない・鍵に R2 の権限を持たせない)。
      section.innerHTML =
        "<div style='" +
        box +
        "'><div style='font-weight:700;font-size:13px;margin-bottom:6px'>🪣 " +
        esc(t("r2SetupTitle")) +
        "</div><p style='font-size:12px;color:var(--muted);line-height:1.7;margin:0 0 10px'>" +
        esc(t("r2SetupHelp").replace("{worker}", s.workerName || "KuroCMS")) +
        "</p><div style='display:flex;gap:8px;flex-wrap:wrap'>" +
        "<a class='secondary' target='_blank' rel='noopener' href='https://dash.cloudflare.com/?to=/:account/r2/overview' style='font-size:12px;padding:6px 14px;text-decoration:none'>" +
        esc(t("r2SetupDashboard")) +
        "</a></div></div>";
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
    byId("mobileMediaFullWidth")!.checked = s.mobileMediaFullWidth === true;
    renderTimezoneSelect(String(s.siteTimezone || ""));
    byId("showByline")!.checked = s.showByline !== false;
    if (s.threadsTokenSet) {
      byId("threadsToken")!.placeholder =
        "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 \u2713";
    }
    const threadsTokenPendingText = s.threadsTokenSet
      ? t("threadsTokenUpdatePending")
      : "—";
    byId("threadsTokenUpdatedAt")!.textContent = s.threadsTokenUpdatedAt
      ? formatDateTime(s.threadsTokenUpdatedAt)
      : threadsTokenPendingText;
    byId("threadsTokenNextRefreshAt")!.textContent = s.threadsTokenNextRefreshAt
      ? formatDateTime(s.threadsTokenNextRefreshAt)
      : threadsTokenPendingText;
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
          const tc = byId("threadsAutoPostForm");
          if (bc) bc.style.display = svc === "bsky" ? "" : "none";
          if (xc) xc.style.display = svc === "x" ? "" : "none";
          if (tc) tc.style.display = svc === "threads" ? "" : "none";
        });
      });

    // Bulk posted-flag buttons (one pair per SNS card). openEntryDialog shows
    // a spinner on the confirm button while the API call runs.
    document
      .querySelectorAll<AdminElement>("[data-sns-bulk]")
      .forEach(function (bulkBtn) {
        bulkBtn.addEventListener("click", function () {
          const svc = bulkBtn.dataset.snsBulk || "";
          const posted = bulkBtn.dataset.snsBulkPosted === "1";
          const label =
            svc === "x" ? "X" : svc === "threads" ? "Threads" : "Bluesky";
          openEntryDialog(
            t("snsBulkTitle") + " — " + label,
            "<p class='muted'>" +
              escapeHtml(
                t(posted ? "snsBulkSetConfirm" : "snsBulkClearConfirm").replace(
                  "{service}",
                  label,
                ),
              ) +
              "</p>",
            t(posted ? "snsBulkSetBtn" : "snsBulkClearBtn"),
            async function (_: Dynamic, close: Dynamic) {
              try {
                const res = await api("/api/documents/sns/bulk-flag", {
                  method: "POST",
                  body: JSON.stringify({ service: svc, posted }),
                });
                close();
                toast(
                  t("snsBulkDone").replace("{count}", fmtNum(res.changed ?? 0)),
                  false,
                );
              } catch (err) {
                toast(errorMessage(err), true);
              }
            },
          );
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
            (svc === "x" || svc === "threads"
              ? "<p class='muted' style='font-size:11px;margin-top:4px'>" +
                escapeHtml(
                  t(svc === "x" ? "snsXUseAutoPost" : "snsThreadsUseAutoPost"),
                ) +
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
                fmtNum(strapiAllArticles.length) +
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
            "（" + fmtNum(sorted.length) + t("importCountSuffix") + "）";
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
                    ? fmtNum(processed) +
                      " / " +
                      fmtNum(total) +
                      t("importCountSuffix")
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
            // スマホ設定（サイトビルドの出力を変える設定）。設定 PUT は
            // siteName 等を必須にしているので、この 1 項目だけを送る部分更新は
            // できない。他タブと同じ saveAll に相乗りさせる。
            mobileMediaFullWidth: !!byId("mobileMediaFullWidth")?.checked,
            // サイトの時計。ビルド出力を変えるので、保存後は全ページの再ビルドが要る。
            siteTimezone: byId("siteTimezone")?.value ?? "",
            // 筆者表示もビルド出力を変えるので、保存後は全ページの再ビルドが要る。
            showByline: byId("showByline")?.checked !== false,
            xLinkInReply: !!byId("xLinkInReply")?.checked,
            threadsToken: (byId("threadsToken")?.value || "").trim(),
            ...extraFields,
          }),
        });
        toast(t("siteSettingsSaved"), false, btn);
      } catch (error) {
        toast(errorMessage(error), true, btn);
        await reportClientError("settings.save", error);
      }
    }

    // スマホ設定の保存。サイトビルドの出力を変える設定なので、保存しただけでは
    // 公開ページは変わらない（再ビルドが要る）ことを保存後にも伝える。
    byId("saveMobileBtn")?.addEventListener("click", async (event: Dynamic) => {
      await saveAll(event.currentTarget);
      const out = byId("mobileStatus");
      if (out) out.textContent = t("mobileSavedNeedsBuild");
    });

    for (const formId of [
      "siteForm",
      "snsForm",
      "xAutoPostForm",
      "threadsAutoPostForm",
    ]) {
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
