// KuroCMS admin screen module. Concatenated by scripts/build-admin.js.

async function dashboard() {
  shell(
    t("dashboard"),
    "<div class='stack' style='gap:20px'>" +
      // Top row: compact stats + version card
      "<div class='split' style='align-items:start'>" +
      // Stats grid
      "<div class='panel'>" +
      "<div class='sectionLabel' style='margin-bottom:14px'>" +
      escapeHtml(t("overview")) +
      "</div>" +
      "<div class='grid'>" +
      "<div style='background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius);padding:20px 16px;text-align:center'>" +
      "<div style='font-size:48px;font-weight:800;color:var(--accent);line-height:1' id='statDocs'>…</div>" +
      "<div style='font-size:12px;color:var(--muted);font-weight:600;margin-top:10px'>" +
      escapeHtml(t("registeredDocuments")) +
      "</div>" +
      "</div>" +
      "<div style='background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius);padding:20px 16px;text-align:center'>" +
      "<div style='font-size:48px;font-weight:800;color:var(--accent);line-height:1' id='statPub'>…</div>" +
      "<div style='font-size:12px;color:var(--muted);font-weight:600;margin-top:10px'>" +
      escapeHtml(t("publishedDocuments")) +
      "</div>" +
      "</div>" +
      "<div style='background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius);padding:20px 16px;text-align:center'>" +
      "<div style='font-size:48px;font-weight:800;color:var(--accent);line-height:1' id='statMedia'>…</div>" +
      "<div style='font-size:12px;color:var(--muted);font-weight:600;margin-top:10px'>" +
      escapeHtml(t("mediaLabel")) +
      "</div>" +
      "</div>" +
      "</div>" +
      "</div>" +
      // Version card
      "<div class='panel'>" +
      // flex-wrap: the panel's own width is a CSS grid track (minmax(0,1fr))
      // that shrinks with the viewport/sidebar state — "KuroCMS" + the button
      // can outgrow it well before the .split column collapses to 1 row. Let
      // the button drop to its own line instead of overflowing the card.
      "<div style='display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px'>" +
      "<span style='font-weight:700;font-size:14px'>KuroCMS</span>" +
      // updateBtnWrap normally stretches full-width (block layout below the
      // header); override that here so it shrinks to the button's own size —
      // otherwise it fights "KuroCMS" for space in this flex row and never
      // reaches the right edge.
      "<div class='updateBtnWrap' style='width:auto;flex-shrink:0'>" +
      "<button id='btnUpdate' style='font-size:12px;padding:5px 12px'>" +
      escapeHtml(t("checkForUpdate")) +
      "</button>" +
      "<span class='updateBadge' id='updateBadge' style='display:none'></span>" +
      "</div>" +
      "</div>" +
      "<div style='border-top:1px solid var(--line);padding-top:10px;display:flex;flex-direction:column;gap:6px'>" +
      "<div class='versionRow'><span class='versionLabel'>" +
      escapeHtml(t("installedVersionLabel")) +
      "</span><span class='versionVal' id='versionCurrent'>v—</span></div>" +
      "<div class='versionRow'><span class='versionLabel'>" +
      escapeHtml(t("stableVersionLabel")) +
      "</span><span class='versionVal' id='versionStable'>v—</span></div>" +
      "<div class='versionRow'><span class='versionLabel'>" +
      escapeHtml(t("latestVersionLabel")) +
      "</span><span class='versionVal' id='versionLatest'>" +
      escapeHtml(t("checking")) +
      "</span></div>" +
      "<div class='versionRow' style='margin-top:2px'>" +
      "<span class='versionLabel'>" +
      escapeHtml(t("updateChannelLabel")) +
      "</span>" +
      "<label class='toggleSwitch' title='" +
      escapeHtml(t("updateChannelHint")) +
      "'>" +
      "<input type='checkbox' id='updateChannelToggle' />" +
      "<span class='toggleSlider'></span>" +
      "</label>" +
      "</div>" +
      "</div>" +
      "</div>" + // closes version .panel
      "</div>" + // closes .split — was missing: the storage panel below was
      // silently becoming .split's 3rd grid item (auto-flowing into row 2 of
      // its 2-column track) instead of a normal sibling block. That's what
      // made the layout misbehave differently at different widths.
      // Storage gauges
      "<div class='panel stack'>" +
      "<h3>" +
      escapeHtml(t("storageFreeUsage")) +
      "</h3>" +
      "<div class='storageGrid' id='storageGrid'><div class='muted' style='font-size:12px'>" +
      escapeHtml(t("loading")) +
      "</div></div>" +
      "</div>" +
      "</div>",
  );

  // Article stats
  try {
    const data = await api(
      "/api/documents?lang=" + encodeURIComponent(state.uiLang),
    );
    const docs = data.documents || [];
    const published = docs.filter((d: Dynamic) => d.mode === 1);
    if (byId("statDocs")) byId("statDocs")!.textContent = String(docs.length);
    if (byId("statPub"))
      byId("statPub")!.textContent = String(published.length);
  } catch (err) {
    toast(errorMessage(err), true);
  }

  // Storage stats
  try {
    const s = await api("/api/system/storage");
    const imgCount = s.media?.image?.count || 0;
    const vidCount = s.media?.video?.count || 0;
    const audCount = s.media?.audio?.count || 0;
    const mediaTotal = Object.values(
      (s.media || {}) as Record<string, { bytes?: number }>,
    ).reduce((sum, m) => sum + (m.bytes || 0), 0);
    // s.docs is keyed by tid (per-collection counts) plus a "total" entry, so
    // sum only the per-collection values to avoid double-counting "total".
    const docCount = Object.entries(
      (s.docs || {}) as Record<string, number>,
    ).reduce((sum, [k, c]) => (k === "total" ? sum : sum + c), 0);
    // Per-language document counts for the article card detail line.
    let langDocsHtml = "";
    try {
      const langData = await api("/api/languages");
      // Show every registered language (including those with 0 documents) so the
      // breakdown reflects all configured languages, not only the ones in use.
      const langRows = (langData.languages || []) as Dynamic[];
      if (langRows.length) {
        langDocsHtml =
          "<br>" +
          langRows
            .map(
              (l: Dynamic) =>
                escapeHtml(l.displayName || l.lang) +
                " " +
                (l.usage?.documents || 0),
            )
            .join(" / ");
      }
    } catch {
      /* languages optional */
    }
    if (byId("statMedia"))
      byId("statMedia")!.textContent = String(imgCount + vidCount + audCount);
    const grid = byId("storageGrid");
    if (grid) {
      const r2Avail = !!s.r2Available;
      const unavailWrap = function (inner: Dynamic) {
        return (
          "<div style='display:flex;flex-direction:column;gap:6px'>" +
          "<div class='storageUnavailable'>" +
          escapeHtml(t("r2Unavailable")) +
          "</div>" +
          inner +
          "</div>"
        );
      };
      const r2Card = r2Avail
        ? makePieChart(
            s.r2.pct,
            t("r2Media"),
            fmtBytes(s.r2.usedBytes),
            "10 GB",
          )
        : unavailWrap(
            "<div class='storageCard unavailable'>" +
              "<div class='storageCardTitle'>" +
              escapeHtml(t("r2Media")) +
              "</div>" +
              "<div class='pieWrap'><svg viewBox='0 0 100 100'><circle class='pieBg' cx='50' cy='50' r='36'/></svg>" +
              "<div class='piePct' style='color:var(--muted)'>—</div></div>" +
              "<div class='storageDetail'>" +
              escapeHtml(t("freeLimitLabel")) +
              "10 GB</div></div>",
          );
      const mediaCard = r2Avail
        ? "<div class='storageCard'><div class='storageCardTitle'>" +
          escapeHtml(t("mediaLabel")) +
          "</div>" +
          "<div style='font-size:32px;font-weight:800;color:var(--accent)'>" +
          (imgCount + vidCount + audCount) +
          "</div>" +
          "<div class='storageDetail'>" +
          escapeHtml(t("imageTypeLabel")) +
          " " +
          imgCount +
          " / " +
          escapeHtml(t("videoTypeLabel")) +
          " " +
          vidCount +
          " / " +
          escapeHtml(t("audioTypeLabel")) +
          " " +
          audCount +
          "<br>" +
          fmtBytes(mediaTotal) +
          "</div>" +
          "</div>"
        : unavailWrap(
            "<div class='storageCard unavailable'><div class='storageCardTitle'>" +
              escapeHtml(t("mediaLabel")) +
              "</div>" +
              "<div style='font-size:32px;font-weight:800;color:var(--muted)'>—</div>" +
              "<div class='storageDetail'>" +
              t("r2MediaUnavailMsg") +
              "</div></div>",
          );
      // KV daily operations (writes are the constrained Free-plan resource).
      const ops = s.kvOps as
        | {
            available: boolean;
            writes: number;
            reads: number;
            maxWrites: number;
            maxReads: number;
            writesPct: number;
            resetUtc: string;
          }
        | undefined;
      const fmtReset = function (iso: Dynamic) {
        if (!iso) return "";
        try {
          return new Date(iso).toLocaleString(undefined, {
            month: "numeric",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          });
        } catch {
          return "";
        }
      };
      let kvOpsCard = "";
      if (ops) {
        const wpct = Math.min(100, ops.writesPct || 0);
        const cls = wpct < 70 ? "ok" : wpct < 90 ? "warn" : "danger";
        const color =
          wpct < 70
            ? "var(--accent)"
            : wpct < 90
              ? "var(--accent-3)"
              : "var(--danger)";
        const r = 36,
          circ = 2 * Math.PI * r,
          filled = Math.min(1, wpct / 100) * circ;
        const pieVal = ops.available
          ? wpct.toFixed(1) + "<span style='font-size:10px'>%</span>"
          : "—";
        const sub = ops.available
          ? ops.writes + " / " + ops.maxWrites
          : escapeHtml(t("kvOpsUnavailable"));
        kvOpsCard =
          "<div class='storageCard" +
          (wpct >= 50 ? " storage-alert" : "") +
          "'><div class='storageCardTitle'>" +
          escapeHtml(t("kvWritesToday")) +
          "</div><div class='pieWrap'><svg viewBox='0 0 100 100'>" +
          "<circle class='pieBg' cx='50' cy='50' r='" +
          r +
          "'/>" +
          (ops.available
            ? "<circle class='pieArc " +
              cls +
              "' cx='50' cy='50' r='" +
              r +
              "' stroke-dasharray='" +
              filled.toFixed(1) +
              " " +
              circ.toFixed(1) +
              "'/>"
            : "") +
          "</svg><div class='piePct' style='color:" +
          color +
          "'>" +
          pieVal +
          "<div class='piePctSub'>" +
          sub +
          "</div></div></div><div class='storageDetail'>" +
          (ops.available
            ? escapeHtml(t("kvReadsLabel")) +
              " " +
              ops.reads +
              " / " +
              ops.maxReads +
              "<br>"
            : "") +
          escapeHtml(t("kvResetLabel")) +
          " " +
          escapeHtml(fmtReset(ops.resetUtc)) +
          "</div></div>";
      }
      grid.innerHTML =
        makePieChart(
          s.d1.pct,
          t("d1Database"),
          fmtBytes(s.d1.usedBytes),
          "5 GB",
        ) +
        r2Card +
        makePieChart(s.kv.pct, t("kvPages"), fmtBytes(s.kv.usedBytes), "1 GB") +
        kvOpsCard +
        "<div class='storageCard'><div class='storageCardTitle'>" +
        escapeHtml(t("articleCountTitle")) +
        "</div>" +
        "<div style='font-size:32px;font-weight:800;color:var(--accent)'>" +
        docCount +
        "</div>" +
        "<div class='storageDetail'>" +
        escapeHtml(t("collectionArticleCount")) +
        langDocsHtml +
        "</div>" +
        "</div>" +
        mediaCard;
    }
    setStorageAlertBadge(
      s.d1.pct >= 50 || (s.r2Available && s.r2.pct >= 50) || s.kv.pct >= 50,
    );
  } catch {
    /* storage API optional */
  }

  // Version card setup. "stable" only advances when the maintainer explicitly
  // promotes a release (see VERSION's KUROCMS_STABLE_VERSION / --promote-stable
  // in github_release_update.sh); "latest" is the rolling channel that every
  // release lands on immediately. The toggle picks which one btnUpdate targets.
  function applyVersionResult(v: Dynamic) {
    const cur = byId("versionCurrent");
    const stab = byId("versionStable");
    const lat = byId("versionLatest");
    const badge = byId("updateBadge");
    const toggle = byId("updateChannelToggle") as HTMLInputElement | null;
    if (cur) cur.textContent = "v" + v.current;
    if (stab) {
      stab.textContent = "v" + v.stable;
      stab.className =
        "versionVal" +
        (v.channel === "stable" && v.hasUpdate ? " has-update" : "");
    }
    if (lat) {
      lat.textContent = "v" + v.latest;
      lat.className =
        "versionVal" +
        (v.channel === "latest" && v.hasUpdate ? " has-update" : "");
    }
    if (toggle) toggle.checked = v.channel === "latest";
    if (badge) badge.style.display = v.hasUpdate ? "" : "none";
    const btn = byId("btnUpdate");
    if (btn)
      btn.textContent = v.hasUpdate ? t("updateNow") : t("checkForUpdate");
  }

  async function checkVersion() {
    try {
      applyVersionResult(await api("/api/system/version"));
    } catch {
      /* ignore */
    }
  }

  // Check the version once when the dashboard opens (result is only shown here;
  // background polling would be pointless). Manual re-check via the button.
  checkVersion();

  const channelToggle = byId("updateChannelToggle") as HTMLInputElement | null;
  if (channelToggle) {
    channelToggle.addEventListener("change", async () => {
      const nextChannel = channelToggle.checked ? "latest" : "stable";
      channelToggle.disabled = true;
      try {
        await api("/api/system/update-channel", {
          method: "PUT",
          body: JSON.stringify({ channel: nextChannel }),
        });
        applyVersionResult(await api("/api/system/version"));
      } catch (err) {
        channelToggle.checked = !channelToggle.checked; // revert on failure
        toast(errorMessage(err), true);
      }
      channelToggle.disabled = false;
    });
  }

  const btnUpdate = byId("btnUpdate");
  if (btnUpdate) {
    // Always allow manual check/update click
    btnUpdate.addEventListener("click", async () => {
      // If no update info yet, just check version first
      const badge = byId("updateBadge");
      const hasUpdate = badge && badge.style.display !== "none";
      if (!hasUpdate) {
        // First click = "check for update". Runs the version check; if an update
        // is found, applyVersionResult flips the label to "今すぐ更新" so the next
        // click performs the update.
        btnUpdate.disabled = true;
        btnUpdate.textContent = t("checking");
        let ok = false;
        try {
          applyVersionResult(await api("/api/system/version"));
          ok = true;
        } catch {
          /* ignore */
        }
        btnUpdate.disabled = false;
        if (!ok) {
          btnUpdate.textContent = t("checkForUpdate");
        } else {
          const after = byId("updateBadge");
          if (!after || after.style.display === "none")
            toast(t("alreadyLatest"));
        }
        return;
      }
      if (!confirm(t("updateConfirm"))) return;
      btnUpdate.disabled = true;
      btnUpdate.textContent = t("updating");
      try {
        await api("/api/system/update", { method: "POST" });
        toast(t("updateSuccessReload"));
        setTimeout(() => location.reload(), 2000);
      } catch (err) {
        toast(errorMessage(err), true, btnUpdate);
        btnUpdate.disabled = false;
        btnUpdate.textContent = t("updateNow");
      }
    });
  }
}

async function articles() {
  shell(
    t("articles"),
    "<div class='artsToolbar' style='margin-bottom:12px'>" +
      "<label style='display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:var(--muted);flex-shrink:0'>" +
      escapeHtml(t("sortOrder")) +
      "<select id='sortOrder' style='width:auto;max-width:180px;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--surface-2);color:var(--ink);font:inherit;font-size:13px'>" +
      "<option value='publish_desc' selected>" +
      escapeHtml(t("sortPublishDesc")) +
      "</option>" +
      "<option value='updated_desc'>" +
      escapeHtml(t("sortUpdatedDesc")) +
      "</option>" +
      "<option value='updated_asc'>" +
      escapeHtml(t("sortUpdatedAsc")) +
      "</option>" +
      "<option value='publish_asc'>" +
      escapeHtml(t("sortPublishAsc")) +
      "</option>" +
      "<option value='title_asc'>" +
      escapeHtml(t("sortTitleAsc")) +
      "</option>" +
      "</select>" +
      "</label>" +
      "<label style='display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:var(--muted);flex-shrink:0'>" +
      escapeHtml(t("categoryFilter")) +
      "<select id='catFilter' style='width:auto;max-width:180px;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--surface-2);color:var(--ink);font:inherit;font-size:13px'>" +
      "<option value=''>" +
      escapeHtml(t("allCategories")) +
      "</option>" +
      "</select>" +
      "</label>" +
      "<input id='q' placeholder='" +
      escapeHtml(t("searchPlaceholder")) +
      "' style='flex:1;min-width:120px' />" +
      "<button id='searchBtn' style='flex-shrink:0;white-space:nowrap'>" +
      escapeHtml(t("search")) +
      "</button>" +
      "</div>" +
      "<div id='list'>" +
      escapeHtml(t("loading")) +
      "</div>" +
      "<div id='listPager'></div>",
  );

  // Build bar (fixed bottom)
  const buildBar = document.createElement("div");
  buildBar.className = "articleBottomBar";
  buildBar.id = "artsBuildBar";
  buildBar.innerHTML =
    "<div style='display:flex;align-items:center;gap:8px;min-width:0'>" +
    "<label for='artsBuildMode' style='font-size:12px;font-weight:700;color:var(--muted);white-space:nowrap'>" +
    escapeHtml(t("buildModeLabel")) +
    "</label>" +
    // .buildModeSelect opts out of the global select{width:100%} and the native
    // arrow so the box auto-sizes to its widest option in any language.
    "<select id='artsBuildMode' class='buildModeSelect'>" +
    "<option value='manual'>" +
    escapeHtml(t("buildModeManual")) +
    "</option>" +
    "<option value='auto'>" +
    escapeHtml(t("buildModeAuto")) +
    "</option>" +
    "<option value='always'>" +
    escapeHtml(t("buildModeAlways")) +
    "</option>" +
    "<option value='forceAll'>" +
    escapeHtml(t("buildModeForceAll")) +
    "</option>" +
    "</select>" +
    "</div>" +
    "<div style='display:flex;align-items:center;gap:12px'>" +
    "<button type='button' id='artsBuildBtn'>&#9654; " +
    escapeHtml(t("buildNow")) +
    "</button>" +
    "<a id='artsOpenPublicBtn' target='_blank' rel='noopener' style='padding:6px 14px;font-size:12px;font-weight:600;border:1px solid var(--line);border-radius:8px;color:var(--muted);text-decoration:none;white-space:nowrap;opacity:0.4;pointer-events:none'>&#8594; " +
    escapeHtml(t("openPublicPage")) +
    "</a>" +
    "</div>";
  document.body.appendChild(buildBar);
  byId("artsBuildBtn")?.addEventListener("click", function () {
    // "forceAll" is not a persisted scheduling mode — it is a one-shot directive
    // to rebuild every page (ignore the build cache). Any other selection builds
    // incrementally as before.
    const sel = byId("artsBuildMode") as HTMLSelectElement | null;
    runBuildWithProgress(sel?.value === "forceAll");
  });
  // Build scheduling mode selector (manual / auto / always), persisted in KV.
  const buildModeSel = byId("artsBuildMode") as HTMLSelectElement | null;
  if (buildModeSel) {
    let lastMode = "manual";
    api("/api/build/mode")
      .then(function (d) {
        if (d && typeof d.mode === "string") {
          lastMode = d.mode;
          buildModeSel.value = d.mode;
        }
      })
      .catch(function () {});
    buildModeSel.addEventListener("change", function () {
      const mode = buildModeSel.value;
      // "forceAll" is a one-shot build directive, not a scheduling mode — never
      // persist it (the server only accepts manual/auto/always). Leave the real
      // scheduling mode untouched; the build button reads this selection to force.
      if (mode === "forceAll") return;
      const prev = lastMode;
      buildModeSel.disabled = true;
      // Only persist the mode. Building always happens via the build button —
      // changing the selector never triggers a build on its own.
      api("/api/build/mode", {
        method: "PUT",
        body: JSON.stringify({ mode }),
      })
        .then(function () {
          lastMode = mode;
        })
        .catch(function () {
          buildModeSel.value = prev; // revert on failure
        })
        .finally(function () {
          buildModeSel.disabled = false;
        });
    });
  }
  api("/api/settings")
    .then(function (d) {
      const url = (d && d.settings && d.settings.publicDomain) || "";
      const a = byId("artsOpenPublicBtn");
      if (a && url) {
        a.setAttribute("href", url);
        a.style.opacity = "1";
        a.style.pointerEvents = "";
        a.style.color = "var(--accent)";
      }
      const templateId = (d && d.settings && d.settings.templateId) || "";
      const buildBtn = byId("artsBuildBtn") as HTMLButtonElement | null;
      if (!templateId && buildBtn) {
        buildBtn.disabled = true;
        buildBtn.style.opacity = "0.45";
        buildBtn.style.cursor = "not-allowed";
        const wrapper = document.createElement("span");
        wrapper.title =
          t("buildNoTemplateHint") || "テンプレートを選択してください。";
        wrapper.style.cssText = "display:inline-block;cursor:not-allowed";
        buildBtn.parentNode?.insertBefore(wrapper, buildBtn);
        wrapper.appendChild(buildBtn);
      }
    })
    .catch(function () {});
  function sortDocs(docs: Dynamic, order: Dynamic) {
    const arr = [...docs];
    switch (order) {
      case "updated_asc":
        return arr.sort((a, b) =>
          (a.updated_at || "").localeCompare(b.updated_at || ""),
        );
      case "publish_desc":
        return arr.sort((a, b) =>
          (b.publish_at || "").localeCompare(a.publish_at || ""),
        );
      case "publish_asc":
        return arr.sort((a, b) =>
          (a.publish_at || "").localeCompare(b.publish_at || ""),
        );
      case "title_asc":
        return arr.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
      default:
        return arr.sort((a, b) =>
          (b.updated_at || "").localeCompare(a.updated_at || ""),
        );
    }
  }
  let allDocs: Dynamic[] = [];
  // Strapi-style pagination: configurable "entries per page" (persisted) + page
  // navigation. Pure client-side over the loaded set (server returns up to 1000).
  const PAGE_SIZE_KEY = "kurocms_list_page_size";
  const PAGE_SIZE_OPTS = [10, 20, 50, 100];
  let pageSize = 50;
  try {
    const saved = parseInt(localStorage.getItem(PAGE_SIZE_KEY) || "", 10);
    if (PAGE_SIZE_OPTS.indexOf(saved) !== -1) pageSize = saved;
  } catch {
    /* localStorage unavailable */
  }
  let currentPage = 1;

  async function load() {
    const q = byId("q")?.value.trim();
    const data = await api(
      "/api/documents?lang=" +
        encodeURIComponent(state.uiLang) +
        (q ? "&q=" + encodeURIComponent(q) : ""),
    );
    allDocs = data.documents || [];
    currentPage = 1;
    renderList();
  }
  function renderPager(total: Dynamic, page: Dynamic, size: Dynamic) {
    const pages = Math.max(1, Math.ceil(total / size));
    const sizeOpts = PAGE_SIZE_OPTS.map(function (n) {
      return (
        "<option value='" +
        n +
        "'" +
        (n === size ? " selected" : "") +
        ">" +
        n +
        "</option>"
      );
    }).join("");
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
        "'" +
        (n === page ? " disabled" : "") +
        ">" +
        n +
        "</button>";
      last = n;
    });
    return (
      "<div class='listPager'>" +
      "<label class='pageSizeWrap'>" +
      "<select id='pageSizeSel'>" +
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
      "</div>" +
      "</div>"
    );
  }
  function renderList() {
    const order = byId("sortOrder")?.value || "publish_desc";
    const cat = (byId("catFilter") as Dynamic)?.value || "";
    const base = cat
      ? allDocs.filter(function (d: Dynamic) {
          return (
            String(d.category_ids || "")
              .split(",")
              .indexOf(cat) !== -1
          );
        })
      : allDocs;
    const sorted = sortDocs(base, order);
    const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
    if (currentPage > pages) currentPage = pages;
    if (currentPage < 1) currentPage = 1;
    const start = (currentPage - 1) * pageSize;
    const el = byId("list");
    if (el)
      el.innerHTML = renderArticleTable(sorted.slice(start, start + pageSize));
    const pager = byId("listPager");
    if (pager)
      pager.innerHTML = sorted.length
        ? renderPager(sorted.length, currentPage, pageSize)
        : "";
  }
  byId("searchBtn")?.addEventListener("click", () =>
    load().catch((err) => toast(errorMessage(err), true)),
  );
  byId("sortOrder")?.addEventListener("change", function () {
    currentPage = 1;
    renderList();
  });
  byId("catFilter")?.addEventListener("change", function () {
    currentPage = 1;
    renderList();
  });
  // Populate the category filter from the category list (client-side filter).
  api("/api/categories")
    .then(function (d: Dynamic) {
      const sel = byId("catFilter") as Dynamic;
      if (!sel || !d || !Array.isArray(d.categories)) return;
      sel.insertAdjacentHTML(
        "beforeend",
        d.categories
          .map(function (c: Dynamic) {
            return (
              "<option value='" +
              escapeHtml(c.cid) +
              "'>" +
              escapeHtml(c.name || c.cid) +
              "</option>"
            );
          })
          .join(""),
      );
    })
    .catch(function () {});
  byId("listPager")?.addEventListener("click", function (e: Dynamic) {
    const btn = e.target.closest(".pagerBtn[data-page]");
    if (!btn || btn.disabled) return;
    const p = parseInt(btn.dataset.page, 10);
    if (!isNaN(p)) {
      currentPage = p;
      renderList();
    }
  });
  byId("listPager")?.addEventListener("change", function (e: Dynamic) {
    const sel = e.target.closest("#pageSizeSel");
    if (!sel) return;
    pageSize = parseInt(sel.value, 10) || 50;
    try {
      localStorage.setItem(PAGE_SIZE_KEY, String(pageSize));
    } catch {
      /* ignore */
    }
    currentPage = 1;
    renderList();
  });
  let resizeTimer: Dynamic = null;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderList, 150);
  });
  byId("list")?.addEventListener("click", async function (e: Dynamic) {
    const slugButton = e.target.closest("[data-copy-slug]");
    if (slugButton) {
      try {
        await navigator.clipboard.writeText(slugButton.dataset.copySlug || "");
        toast(t("copySuccess"), false, slugButton);
      } catch {
        toast(t("copyFailed"), true, slugButton);
      }
      return;
    }
    // Service helpers: "bsky" | "x" share the same flag/post plumbing.
    function snsServiceLabel(service: string) {
      if (service === "x") return "X";
      if (service === "threads") return "Threads";
      return "Bluesky";
    }
    function snsDocField(service: string) {
      if (service === "x") return "sns_x_posted_at";
      if (service === "threads") return "sns_threads_posted_at";
      return "sns_bsky_posted_at";
    }
    const snsClearEl = e.target.closest("[data-sns-clear]");
    if (snsClearEl) {
      if (state.preview) return;
      const clearDid = snsClearEl.dataset.snsClear;
      const clearSvc = snsClearEl.dataset.snsService || "bsky";
      if (!clearDid) return;
      openEntryDialog(
        t("snsClearTitle") + " — " + snsServiceLabel(clearSvc),
        "<p class='muted'>" + escapeHtml(t("snsClearConfirm")) + "</p>",
        t("snsClearBtn"),
        async function (_: Dynamic, close: Dynamic) {
          try {
            const body: Dynamic = {};
            body[clearSvc] = false;
            await api("/api/documents/" + clearDid + "/sns", {
              method: "PUT",
              body: JSON.stringify(body),
            });
            const doc: Dynamic = allDocs.find(function (d) {
              return d.did === clearDid;
            });
            if (doc) doc[snsDocField(clearSvc)] = null;
            close();
            renderList();
            toast(t("snsClearDone"), false);
          } catch (err) {
            toast(errorMessage(err), true);
          }
        },
      );
      return;
    }
    const snsBtn = e.target.closest("[data-sns-post]");
    if (snsBtn) {
      if (state.preview) return;
      const snsDid = snsBtn.dataset.snsPost;
      const snsSvc = snsBtn.dataset.snsService || "bsky";
      if (!snsDid) return;
      openEntryDialog(
        t("snsPostBtn") + " — " + snsServiceLabel(snsSvc),
        "<p class='muted'>" +
          escapeHtml(
            t(
              snsSvc === "x"
                ? "snsPostConfirmX"
                : snsSvc === "threads"
                  ? "snsPostConfirmThreads"
                  : "snsPostConfirm",
            ),
          ) +
          "</p>",
        t("snsPostBtn"),
        async function (_: Dynamic, close: Dynamic) {
          snsBtn.disabled = true;
          try {
            const res = await api(
              "/api/documents/" + snsDid + "/sns/" + snsSvc + "/post",
              { method: "POST" },
            );
            // Threads runs in the background (Meta-side image processing takes
            // tens of seconds): close now and poll the flag until it lands.
            if (res[snsSvc] && res[snsSvc].queued) {
              // Mark in-flight BEFORE closing/re-rendering: the list keeps the
              // button as a disabled 投稿中… until the poll resolves, so the
              // background job can't be triggered twice from the UI.
              snsPosting.add(snsDid + ":" + snsSvc);
              close();
              renderList();
              toast(t("snsPostQueued"), false);
              let tries = 18; // ~90s at 5s intervals
              const poll = function () {
                tries--;
                setTimeout(async function () {
                  try {
                    const st = await api("/api/documents/" + snsDid + "/sns");
                    if (st[snsSvc] && st[snsSvc].posted) {
                      snsPosting.delete(snsDid + ":" + snsSvc);
                      const doc: Dynamic = allDocs.find(function (d) {
                        return d.did === snsDid;
                      });
                      if (doc) doc[snsDocField(snsSvc)] = st[snsSvc].postedAt;
                      renderList();
                      toast(
                        t("snsPostDone").replace(
                          "{service}",
                          snsServiceLabel(snsSvc),
                        ),
                        false,
                      );
                      return;
                    }
                  } catch {
                    /* transient poll error — keep trying */
                  }
                  if (tries > 0) poll();
                  else {
                    // Give the button back on timeout — the server-side
                    // already_queued guard still blocks a real double post.
                    snsPosting.delete(snsDid + ":" + snsSvc);
                    renderList();
                    toast(t("snsPostQueueTimeout"), true);
                  }
                }, 5000);
              };
              poll();
              return;
            }
            const doc: Dynamic = allDocs.find(function (d) {
              return d.did === snsDid;
            });
            if (doc)
              doc[snsDocField(snsSvc)] =
                (res[snsSvc] && res[snsSvc].postedAt) ||
                new Date().toISOString();
            close();
            renderList();
            toast(
              t("snsPostDone").replace("{service}", snsServiceLabel(snsSvc)),
              false,
            );
          } catch (err) {
            toast(errorMessage(err), true);
            snsBtn.disabled = false;
          }
        },
      );
      // "Mark done without posting": sets the posted flag via PUT /sns without
      // actually posting — for articles already announced on that SNS (e.g.
      // after re-creating/swapping an article under a new did). Inserted into
      // the dialog's action row so all three choices sit side by side
      // (mark-only | cancel | post), with only "post" as the accent button.
      const dlgForm = byId("entryDialogForm");
      const dlgCancel = byId("entryDialogCancel");
      if (dlgForm && dlgCancel) {
        const markBtn = document.createElement("button");
        markBtn.type = "button";
        markBtn.className = "secondary";
        markBtn.textContent = t("snsMarkOnlyBtn");
        dlgCancel.parentNode?.insertBefore(markBtn, dlgCancel);
        markBtn.addEventListener("click", async function () {
          markBtn.disabled = true;
          try {
            const body: Dynamic = {};
            body[snsSvc] = true;
            const res = await api("/api/documents/" + snsDid + "/sns", {
              method: "PUT",
              body: JSON.stringify(body),
            });
            const doc: Dynamic = allDocs.find(function (d) {
              return d.did === snsDid;
            });
            if (doc)
              doc[snsDocField(snsSvc)] =
                (res[snsSvc] && res[snsSvc].postedAt) ||
                new Date().toISOString();
            const backdrop = dlgForm.closest(".popupBackdrop");
            if (backdrop) backdrop.remove();
            renderList();
            toast(t("snsMarkOnlyDone"), false);
          } catch (err) {
            toast(errorMessage(err), true);
            markBtn.disabled = false;
          }
        });
      }
      return;
    }
    const btn = e.target.closest("[data-did][data-mode]");
    if (!btn) return;
    const did = btn.dataset.did;
    const mode = parseInt(btn.dataset.mode, 10);
    if (!did || isNaN(mode)) return;
    btn.disabled = true;
    try {
      await api("/api/documents/" + did, {
        method: "PUT",
        body: JSON.stringify({ mode }),
      });
      const doc: Dynamic = allDocs.find(function (d) {
        return d.did === did;
      });
      if (doc) doc.mode = mode;
      renderList();
      toast(mode === 1 ? t("publishedToast") : t("unpublishedToast"), false);
    } catch (err) {
      toast(errorMessage(err), true);
      btn.disabled = false;
    }
  });
  await load().catch((err) => toast(errorMessage(err), true));
}

function formatDateShort(value: Dynamic) {
  if (!value) return "-";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString();
}

// In-flight background SNS posts ("did:service"). While a did is here the
// list renders its 投稿 button as a disabled 投稿中… — a re-render would
// otherwise recreate the button enabled and allow a double post while the
// Threads background job (≤90s) is still running. Module-level so the state
// survives a screen remount too (the server's already_queued guard is the
// final backstop either way).
const snsPosting = new Set<string>();

function renderArticleTable(documents: Dynamic) {
  if (!documents || !documents.length)
    return "<div class='emptyState'>" + escapeHtml(t("noDocuments")) + "</div>";
  const isMobile = window.innerWidth <= 860;

  const items = documents.map(function (doc: Dynamic) {
    const modeClass =
      doc.mode === 1
        ? "statusPublished"
        : doc.mode === 2
          ? "statusHidden"
          : "statusDraft";
    const modeLbl = modeLabel(doc.mode);
    const isPublished = doc.mode === 1;
    const actionLabel = isPublished ? t("unpublishAction") : t("publishAction");
    const nextMode = isPublished ? 0 : 1;
    const langs = (doc.languages || "")
      .split(",")
      .map(function (l: Dynamic) {
        return l.trim();
      })
      .filter(Boolean);
    const baseLang = doc.initial_lang || langs[0] || "-";
    const otherCount = langs.filter(function (l: Dynamic) {
      return l !== baseLang;
    }).length;
    const langExtra =
      otherCount > 0
        ? " <span class='artMeta2'>+" +
          otherCount +
          escapeHtml(t("langsSuffix")) +
          "</span>"
        : "";
    const pubDate = formatDateShort(doc.publish_at);
    const updText = doc.updated_at
      ? "<span class='artMeta2'>(" +
        formatDateShort(doc.updated_at) +
        " " +
        escapeHtml(t("updatedSuffix")) +
        ")</span>"
      : "";
    const categoryNames = String(doc.category_names || "")
      .split(",")
      .map(function (name: Dynamic) {
        return String(name || "").trim();
      })
      .filter(Boolean);
    const categoryHtml = categoryNames.length
      ? categoryNames
          .map(function (name: Dynamic) {
            return "<span class='artListCat'>" + escapeHtml(name) + "</span>";
          })
          .join("")
      : "<span class='artMeta2'>-</span>";
    const typeCategoryHtml =
      "<div class='artTypeCats'><span class='artListType'>" +
      escapeHtml(doc.tid) +
      "</span>" +
      categoryHtml +
      "</div>";
    // canPost: only Bluesky has a real posting integration. Unposted + postable
    // shows a green "投稿" button; other services stay as an unposted label.
    function snsLine(
      label: string,
      postedAt: Dynamic,
      canPost: boolean,
      service?: string,
    ) {
      const posted = Boolean(postedAt);
      // A posted (and postable) line is clickable: it opens the clear-flag
      // dialog (PUT /sns {bsky/x:false}) so the "投稿" button can come back.
      const clearable = posted && canPost && !state.preview && !!service;
      const posting = !!service && snsPosting.has(doc.did + ":" + service);
      const value =
        !posted && canPost && service
          ? "<button type='button' class='snsPostBtn' data-sns-post='" +
            escapeHtml(doc.did) +
            "' data-sns-service='" +
            escapeHtml(service) +
            "'" +
            (state.preview || posting ? " disabled" : "") +
            ">" +
            escapeHtml(posting ? t("snsPostingBtn") : t("snsPostBtn")) +
            "</button>"
          : "<span class='snsStatusValue" +
            (clearable ? " snsClearable" : "") +
            "'" +
            (clearable
              ? " data-sns-clear='" +
                escapeHtml(doc.did) +
                "' data-sns-service='" +
                escapeHtml(service || "") +
                "' title='" +
                escapeHtml(t("snsClearHint")) +
                "'"
              : "") +
            ">" +
            escapeHtml(posted ? t("snsPublished") : t("snsUnpublished")) +
            "</span>";
      return (
        "<div class='snsStatusLine " +
        (posted ? "posted" : "unposted") +
        "'><span class='snsStatusName'>" +
        escapeHtml(label) +
        "</span>" +
        value +
        "</div>"
      );
    }
    const snsStatusHtml =
      "<div class='snsStatusList'>" +
      snsLine("BSKY", doc.sns_bsky_posted_at, true, "bsky") +
      snsLine("THREADS", doc.sns_threads_posted_at, true, "threads") +
      snsLine("X", doc.sns_x_posted_at, true, "x") +
      "</div>";
    const editHref = adminHref("/articles/" + escapeHtml(doc.did));
    const modeBtnStyle = isPublished
      ? "background:rgba(120,120,120,.1);color:var(--muted);border:1px solid var(--line)"
      : "";

    if (isMobile) {
      // Card layout for mobile
      return (
        "<div class='artCard' style='border-bottom:1px solid var(--line);padding:12px;background:var(--surface)'>" +
        // Title (wrap OK)
        "<a href='" +
        editHref +
        "' style='font-weight:700;font-size:14px;color:var(--ink);text-decoration:none;display:block;line-height:1.4;margin-bottom:3px'>" +
        escapeHtml(doc.title || t("untitled")) +
        "</a>" +
        "<button type='button' class='artSlugCode' data-copy-slug='" +
        escapeHtml(doc.slug) +
        "' title='" +
        escapeHtml(t("copy")) +
        "' style='margin-bottom:8px;white-space:normal;word-break:break-all'>" +
        escapeHtml(doc.slug) +
        "</button>" +
        // Meta row: type / categories / lang / date
        "<div style='display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:8px;font-size:12px'>" +
        typeCategoryHtml +
        "<span style='color:var(--muted)'>" +
        escapeHtml(baseLang) +
        langExtra +
        "</span>" +
        "<span style='color:var(--muted)'>" +
        escapeHtml(pubDate) +
        "</span>" +
        (updText ? "<span class='artMeta2'>" + updText + "</span>" : "") +
        "</div>" +
        "<div class='snsStatusMobile'>" +
        "<div class='artMeta2' style='font-weight:700;margin-bottom:3px'>" +
        escapeHtml(t("snsPublishStatus")) +
        "</div>" +
        snsStatusHtml +
        "</div>" +
        // Status + action
        "<div style='display:flex;align-items:center;gap:8px'>" +
        "<span class='badge " +
        modeClass +
        "'>" +
        escapeHtml(modeLbl) +
        "</span>" +
        "<button class='artModeBtn' data-did='" +
        escapeHtml(doc.did) +
        "' data-mode='" +
        nextMode +
        "' style='" +
        modeBtnStyle +
        "'>" +
        escapeHtml(actionLabel) +
        "</button>" +
        "</div>" +
        "</div>"
      );
    }

    // Table row for desktop
    return (
      "<tr>" +
      "<td class='flexible'>" +
      "<a href='" +
      editHref +
      "' class='artTitleLink'>" +
      escapeHtml(doc.title || t("untitled")) +
      "</a>" +
      "<button type='button' class='artSlugCode' data-copy-slug='" +
      escapeHtml(doc.slug) +
      "' title='" +
      escapeHtml(t("copy")) +
      "'>" +
      escapeHtml(doc.slug) +
      "</button>" +
      typeCategoryHtml +
      "</td>" +
      "<td>" +
      snsStatusHtml +
      "</td>" +
      "<td>" +
      "<span class='badge " +
      modeClass +
      "' style='display:block;margin-bottom:3px'>" +
      escapeHtml(modeLbl) +
      "</span>" +
      "<button class='artModeBtn' data-did='" +
      escapeHtml(doc.did) +
      "' data-mode='" +
      nextMode +
      "' style='width:100%" +
      (isPublished ? ";" + modeBtnStyle : "") +
      "'>" +
      escapeHtml(actionLabel) +
      "</button>" +
      "</td>" +
      "<td>" +
      escapeHtml(baseLang) +
      (otherCount > 0
        ? "<br><span class='artMeta2'>+" +
          otherCount +
          " " +
          escapeHtml(t("langsSuffix")) +
          "</span>"
        : "") +
      "</td>" +
      "<td>" +
      escapeHtml(pubDate) +
      (updText ? "<br>" + updText : "") +
      "</td>" +
      "</tr>"
    );
  });

  if (isMobile) {
    return (
      "<div style='border:1px solid var(--line);border-radius:var(--radius);overflow:hidden'>" +
      items.join("") +
      "</div>"
    );
  }
  return (
    "<div class='tableScroll'><table class='tableCompact'><thead><tr>" +
    "<th class='flexible'>" +
    escapeHtml(t("titleSlugHeader")) +
    "</th><th>" +
    escapeHtml(t("snsPublishStatus")) +
    "</th><th>" +
    escapeHtml(t("statusActionsHeader")) +
    "</th><th>" +
    escapeHtml(t("languages")) +
    "</th><th>" +
    escapeHtml(t("publishAt")) +
    "</th>" +
    "</tr></thead><tbody>" +
    items.join("") +
    "</tbody></table></div>"
  );
}
