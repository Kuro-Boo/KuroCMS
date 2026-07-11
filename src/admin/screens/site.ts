// KuroCMS admin screen module. Concatenated by scripts/build-admin.js.

async function siteManagement() {
  function switchSiteTab(tab: Dynamic) {
    document.querySelectorAll<AdminElement>(".siteTab").forEach(function (
      b: Dynamic,
    ) {
      b.classList.toggle("active", b.dataset.stab === tab);
    });
    const panel = byId("siteTabPanel");
    if (!panel) return;
    if (tab === "tmpl-view") loadTemplatesViewPanel(panel);
    else if (tab === "tmpl-select") loadTemplateSelectPanel(panel);
    else if (tab === "tmpl-edit") loadTemplateEditPanel(panel);
    else if (tab === "font-manage") loadFontPanel(panel);
    else if (tab === "analytics") loadAnalyticsPanel(panel);
    else loadContentPanel(panel);
  }

  // ── Static Tailwind CSS compile (Play-CDN JIT in a hidden iframe) ────────
  // The JIT engine only needs the class NAMES: the server extracts them from
  // the template source (GET /tw-tokens), we render them as bare divs in an
  // iframe that loads the template's own Tailwind CDN URL (same plugins), and
  // harvest the generated <style> content. Runs after template save/activate
  // and self-heals when the site screen opens; failures are non-fatal because
  // public pages fall back to the CDN script until a compile succeeds.
  function compileTwCss(tokens: Dynamic, cdnUrl: string): Promise<string> {
    return new Promise(function (resolve) {
      const iframe = document.createElement("iframe");
      iframe.style.cssText =
        "position:fixed;width:10px;height:10px;left:-9999px;top:0;visibility:hidden";
      let bodyHtml = "";
      for (let i = 0; i < tokens.length; i += 200) {
        const chunk = tokens
          .slice(i, i + 200)
          .join(" ")
          .replace(new RegExp("&", "g"), "&amp;")
          .replace(new RegExp("<", "g"), "&lt;")
          .replace(new RegExp('"', "g"), "&quot;");
        bodyHtml += '<div class="' + chunk + '"></div>';
      }
      // "</script>" is split so this file stays safe even if it is ever
      // inlined into an HTML <script> block.
      iframe.srcdoc =
        '<!doctype html><html><head><script src="' +
        cdnUrl.replace(new RegExp('"', "g"), "&quot;") +
        '"></scr' +
        "ipt></head><body>" +
        bodyHtml +
        "</body></html>";
      document.body.appendChild(iframe);
      const started = Date.now();
      let lastLen = -1;
      let stablePolls = 0;
      const timer = setInterval(function () {
        let css = "";
        try {
          iframe.contentDocument?.querySelectorAll("style").forEach(function (
            st: Dynamic,
          ) {
            css += st.textContent || "";
          });
        } catch {
          /* ignore */
        }
        // The JIT is done when the output is non-trivial and stable. A single
        // stable sample (2 polls / 300ms) can fire BETWEEN JIT passes and save
        // an INCOMPLETE stylesheet — which then serves with a token list that
        // claims full coverage, so the coverage check can't catch it and the
        // public page silently loses rules. Require 3 consecutive stable
        // samples AND a minimum elapsed time before accepting.
        if (css.length > 1000 && css.length === lastLen) {
          stablePolls++;
          if (stablePolls >= 3 && Date.now() - started > 1500) {
            clearInterval(timer);
            iframe.remove();
            resolve(css);
            return;
          }
        } else {
          stablePolls = 0;
        }
        lastLen = css.length;
        if (Date.now() - started > 15000) {
          clearInterval(timer);
          iframe.remove();
          resolve("");
        }
      }, 300);
    });
  }

  // Pin a Tailwind Play-CDN URL to a specific version so a recompile uses the
  // SAME Tailwind that produced the current CSS. cdn.tailwindcss.com[/x.y.z]
  // → cdn.tailwindcss.com/{version}, preserving any ?plugins= query.
  function pinTwCdnVersion(url: Dynamic, version: Dynamic): string {
    return String(url).replace(
      new RegExp("(cdn\\.tailwindcss\\.com)(/[0-9][0-9.]*)?", "i"),
      "$1/" + version,
    );
  }
  // Read the Tailwind version from a compiled stylesheet's banner comment.
  function readTwVersion(css: Dynamic): string {
    const m = String(css || "").match(
      new RegExp("tailwindcss\\s+v([0-9]+\\.[0-9]+\\.[0-9]+)", "i"),
    );
    return m ? m[1] : "";
  }

  async function ensureTwCss(tmplId: Dynamic) {
    if (!tmplId) return;
    try {
      const info = await api(
        "/api/v1/templates/" + encodeURIComponent(tmplId) + "/tw-tokens",
      );
      // Already covered, or the template doesn't use the Tailwind CDN at all.
      if (!info || info.covered || !info.cdnUrl) return;
      const tokens = info.tokens || [];
      if (!tokens.length) return;
      // Pin the recompile to the recorded baseline version so a Play-CDN
      // version bump can't silently change how OTHER (unedited) classes
      // render. First-ever compile has no baseline → template's URL (latest).
      const cdnUrl = info.compiledTwVersion
        ? pinTwCdnVersion(info.cdnUrl, info.compiledTwVersion)
        : info.cdnUrl;
      const css = await compileTwCss(tokens, cdnUrl);
      if (!css) return;
      const twVersion = readTwVersion(css);
      await api(
        "/api/v1/templates/" + encodeURIComponent(tmplId) + "/compiled-css",
        { method: "PUT", body: JSON.stringify({ css, tokens, twVersion }) },
      );
      // Surface a drift the pin couldn't prevent (e.g. baseline version no
      // longer served by the CDN) so the admin can review the site.
      if (
        info.compiledTwVersion &&
        twVersion &&
        twVersion !== info.compiledTwVersion
      ) {
        toast(
          t("twVersionChanged")
            .replace("{from}", info.compiledTwVersion)
            .replace("{to}", twVersion),
          true,
        );
      } else {
        toast(t("twCssCompiled"), false);
      }
    } catch {
      /* non-fatal: public pages keep the CDN script fallback */
    }
  }

  shell(
    t("siteManagement"),
    "<div class='settingsTabBar'>" +
      "<button type='button' class='siteTab settingsTab active' data-stab='tmpl-view'>" +
      escapeHtml(t("tmplTabView")) +
      "</button>" +
      "<button type='button' class='siteTab settingsTab' data-stab='tmpl-select'>" +
      escapeHtml(t("tmplTabSelect")) +
      "</button>" +
      "<button type='button' class='siteTab settingsTab' data-stab='tmpl-edit'>" +
      escapeHtml(t("tmplTabEdit")) +
      "</button>" +
      "<button type='button' class='siteTab settingsTab' data-stab='tmpl-content'>" +
      escapeHtml(t("tmplTabContent")) +
      "</button>" +
      "<button type='button' class='siteTab settingsTab' data-stab='font-manage'>" +
      escapeHtml(t("fontTab")) +
      "</button>" +
      "<button type='button' class='siteTab settingsTab' data-stab='analytics'>" +
      escapeHtml(t("analyticsTab")) +
      "</button>" +
      "</div>" +
      "<div id='siteTabPanel' style='border:1px solid var(--line);border-top:none;border-radius:0 0 var(--radius) var(--radius);padding:16px'></div>",
  );

  document.querySelectorAll<AdminElement>(".siteTab").forEach(function (btn) {
    btn.addEventListener("click", function () {
      switchSiteTab(btn.dataset.stab);
    });
  });

  // ── テンプレート表示 panel ──────────────────────────────────────────
  function loadTemplatesViewPanel(panel: Dynamic) {
    let tmplMode = "pc";

    function tmplTabStyle(active: Dynamic) {
      return active
        ? "padding:6px 16px;font-size:13px;font-weight:700;border:none;border-radius:20px;background:var(--accent);color:#fff;cursor:pointer;white-space:nowrap"
        : "padding:6px 16px;font-size:13px;font-weight:600;border:1px solid var(--line);border-radius:20px;background:var(--bg);color:var(--muted);cursor:pointer;white-space:nowrap";
    }

    let communityPublished = false;
    let communityId: Dynamic = null;
    let activeTmplId: Dynamic = null;
    let activeTmplName = "";

    function renderPublishToggle() {
      const btn = byId("tmplPublishBtn");
      if (!btn) return;
      if (communityPublished) {
        // 公開済み → 「公開テンプレートを更新」
        btn.textContent = t("communityUpdateBtn");
        btn.style.cssText =
          "padding:6px 16px;font-size:13px;font-weight:700;border:none;border-radius:20px;background:#1a8a6e;color:#fff;cursor:pointer;white-space:nowrap";
        btn.title = t("communityUpdateConfirm");
      } else {
        // 未公開 → 「コミュニティに公開」（同名チェックは公開クリック時に行う）
        btn.textContent = t("communityUnpublishedBtn");
        btn.style.cssText =
          "padding:6px 16px;font-size:13px;font-weight:700;border:1px solid var(--line);border-radius:20px;background:var(--bg);color:var(--muted);cursor:pointer;white-space:nowrap";
        btn.title = t("communityPublishHint");
      }
      btn.disabled = false;
    }

    panel.innerHTML =
      "<div style='display:flex;align-items:center;gap:8px;margin-bottom:16px'>" +
      "<button type='button' class='tmplModeTab' data-tmode='pc' style='" +
      tmplTabStyle(true) +
      "'>&#128187; " +
      escapeHtml(t("pcMode")) +
      "</button>" +
      "<button type='button' class='tmplModeTab' data-tmode='sp' style='" +
      tmplTabStyle(false) +
      "'>&#128241; " +
      escapeHtml(t("spMode")) +
      "</button>" +
      "<div style='margin-left:auto;display:flex;align-items:center;gap:8px'>" +
      "<button type='button' id='tmplRenameBtn' style='padding:6px 14px;font-size:13px;font-weight:600;border:1px solid var(--line);border-radius:20px;background:var(--bg);color:var(--muted);cursor:pointer;white-space:nowrap'>&#9998; " +
      escapeHtml(t("tmplRenameBtn")) +
      "</button>" +
      "<button type='button' id='tmplPublishBtn' style='padding:6px 16px;font-size:13px;font-weight:700;border:1px solid var(--line);border-radius:20px;background:var(--bg);color:var(--muted);cursor:pointer;white-space:nowrap'>" +
      escapeHtml(t("communityUnpublishedBtn")) +
      "</button>" +
      "</div>" +
      "</div>" +
      "<div id='tmplList'></div>";

    function refreshViewPublishBtn() {
      /* kept for compatibility */
    }

    api("/api/v1/templates")
      .then(function (d) {
        const active = (d.templates || []).find(function (t: Dynamic) {
          return t.is_active;
        });
        communityPublished = !!(active && active.community_published);
        communityId = (active && active.community_id) || null;
        activeTmplId = (active && active.id) || null;
        activeTmplName = (active && active.name) || "";
        renderPublishToggle();
        // Self-heal: compile the static Tailwind CSS if the active template
        // has none yet (or a REST-side edit added new classes).
        ensureTwCss(activeTmplId);
      })
      .catch(function () {});

    // 名前変更ボタン（コピー時に名前入力を省いた分、ここで変更できる）
    byId("tmplRenameBtn")?.addEventListener("click", async function () {
      if (!activeTmplId) {
        toast(t("tmplNotLoaded"), true);
        return;
      }
      const next = prompt(t("tmplRenamePrompt"), activeTmplName);
      if (next === null) return;
      const name = String(next).trim();
      if (!name || name === activeTmplName) return;
      try {
        await api("/api/v1/templates/" + encodeURIComponent(activeTmplId), {
          method: "PUT",
          body: JSON.stringify({ name }),
        });
        activeTmplName = name;
        toast(t("tmplRenamed"));
      } catch (err) {
        toast(errorMessage(err), true);
      }
    });

    byId("tmplPublishBtn")?.addEventListener("click", async function () {
      const btn = byId("tmplPublishBtn");
      if (!btn) return;
      if (!activeTmplId) {
        toast(t("tmplNotLoaded"), true);
        return;
      }
      const isUpdate = communityPublished;
      if (
        !confirm(
          isUpdate ? t("communityUpdateConfirm") : t("communityPublishConfirm"),
        )
      )
        return;
      btn.disabled = true;
      btn.textContent = t("processing");
      try {
        // 正規ルート: source_html + meta + 画像(D1) をまとめて Community へ upsert。
        // 同名チェックはサーバー側（publish）が行い、衝突時は name_conflict を返す。
        const res = await api(
          "/api/v1/templates/" + encodeURIComponent(activeTmplId) + "/publish",
          { method: "POST" },
        );
        communityPublished = true;
        communityId = (res && res.communityId) || activeTmplId;
        renderPublishToggle();
        toast(
          isUpdate ? t("communityUpdateSuccess") : t("communityPublishSuccess"),
        );
      } catch (err) {
        const code = (err as Dynamic) && (err as Dynamic).code;
        toast(
          code === "name_conflict"
            ? t("communityNameConflictHint")
            : errorMessage(err),
          true,
        );
        renderPublishToggle();
      }
    });

    panel.querySelectorAll(".tmplModeTab").forEach(function (btn: Dynamic) {
      btn.addEventListener("click", function () {
        const mode = btn.dataset.tmode;
        tmplMode = mode;
        panel.querySelectorAll(".tmplModeTab").forEach(function (b: Dynamic) {
          b.style.cssText = tmplTabStyle(b.dataset.tmode === mode);
        });
        loadTemplateList(mode);
      });
    });

    refreshViewPublishBtn();
    loadTemplateList(tmplMode);
  }

  // ── テンプレートプレビューを JPEG blob としてキャプチャ ──────────────
  async function captureTemplateBlob(id: Dynamic): Promise<Blob | null> {
    const authHeaders: Record<string, string> = state.token
      ? { Authorization: "Bearer " + state.token }
      : {};
    const previewRes = await fetch(
      withBase("/api/v1/templates/" + encodeURIComponent(id) + "/preview"),
      { headers: authHeaders },
    );
    if (!previewRes.ok) return null;
    const html = await previewRes.text();
    const iframe = document.createElement("iframe");
    // visibility:hidden は html2canvas が画像を読み込まない原因になるため opacity:0 を使う
    iframe.style.cssText =
      "position:fixed;left:-9999px;top:0;width:1280px;height:800px;border:none;opacity:0;pointer-events:none";
    // sandbox を付けると srcdoc iframe でリソース読み込みが阻害されるため付けない
    document.body.appendChild(iframe);
    iframe.srcdoc = html;
    // iframe load + 画像・フォント読み込み待ち（最大 8 秒）
    await new Promise(function (resolve) {
      iframe.onload = resolve;
      setTimeout(resolve, 8000);
    });
    await new Promise(function (resolve) {
      setTimeout(resolve, 1500);
    });
    if (!browserWindow.html2canvas) {
      await new Promise(function (resolve, reject) {
        const s = document.createElement("script");
        s.src =
          "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
    }
    const canvas = await html2canvas(iframe.contentDocument!.body, {
      scale: 0.5,
      useCORS: true,
      logging: false,
      width: 1280,
      height: 800,
    });
    document.body.removeChild(iframe);
    return await new Promise<Blob | null>(function (resolve) {
      canvas.toBlob(
        function (blob) {
          resolve(blob || null);
        },
        "image/jpeg",
        0.85,
      );
    });
  }

  // ── テンプレートを html2canvas でキャプチャし、ローカル D1 (thumbnail_blob) に保存 ──
  // Community への反映は publish フロー（/publish）が D1 画像を読んで送る。ここでは常にローカル保存。
  async function captureAndSaveThumbnail(id: Dynamic): Promise<void> {
    const blob = await captureTemplateBlob(id);
    if (!blob || blob.size === 0)
      throw new Error(
        t("thumbnailCaptureFailed") || "サムネイルのキャプチャに失敗しました",
      );
    const imgHeaders: Record<string, string> = { "Content-Type": "image/jpeg" };
    if (state.token) imgHeaders.Authorization = "Bearer " + state.token;
    const uploadRes = await fetch(
      withBase("/api/v1/templates/" + encodeURIComponent(id) + "/thumbnail"),
      {
        method: "POST",
        body: blob,
        headers: imgHeaders,
        credentials: "include",
      },
    );
    if (!uploadRes.ok) {
      const errText = await uploadRes.text().catch(() => "");
      throw new Error("HTTP " + uploadRes.status + " " + errText.slice(0, 100));
    }
  }

  // ── テンプレート選択 panel ──────────────────────────────────────────
  function loadTemplateSelectPanel(panel: Dynamic) {
    panel.innerHTML =
      "<div id='tmplSelectList'>" + escapeHtml(t("loading")) + "</div>";
    const communityBase = "https://kuro.boo/kurocms";
    let templatePage = 1;
    let lastRenderArgs: Dynamic = null;

    function communityUrl(path: Dynamic) {
      const value = String(path || "");
      if (!value) return "";
      try {
        return new URL(value, communityBase + "/").toString();
      } catch {
        return value;
      }
    }

    function templateColumns(list: HTMLElement) {
      const gap = 16;
      const minWidth = 260;
      return Math.max(
        1,
        Math.floor((list.clientWidth + gap) / (minWidth + gap)),
      );
    }

    function renderTemplatePager(
      page: number,
      totalPages: number,
      total: number,
    ) {
      if (totalPages <= 1) {
        return (
          "<div class='tokenMeta' style='margin-bottom:10px'>" +
          total +
          "</div>"
        );
      }
      return (
        "<div style='display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;flex-wrap:wrap'>" +
        "<div class='tokenMeta'>" +
        escapeHtml(t("templatePageInfo")) +
        " " +
        page +
        " / " +
        totalPages +
        " (" +
        total +
        ")</div>" +
        "<div style='display:flex;gap:6px'>" +
        "<button type='button' class='secondary small' data-tmpl-page='" +
        (page - 1) +
        "' " +
        (page <= 1 ? "disabled" : "") +
        ">&lt;</button>" +
        "<button type='button' class='secondary small' data-tmpl-page='" +
        (page + 1) +
        "' " +
        (page >= totalPages ? "disabled" : "") +
        ">&gt;</button>" +
        "</div></div>"
      );
    }

    function renderLastTemplateList() {
      if (!lastRenderArgs) return;
      renderList(
        lastRenderArgs.communityItems,
        lastRenderArgs.localItems,
        lastRenderArgs.currentUser,
        lastRenderArgs.siteIsPublished,
        lastRenderArgs.communityError,
      );
    }

    function renderList(
      communityItems: Dynamic,
      localItems: Dynamic,
      currentUser: Dynamic,
      siteIsPublished: Dynamic,
      communityError?: Dynamic,
    ) {
      const list = byId("tmplSelectList");
      if (!list) return;
      lastRenderArgs = {
        communityItems,
        localItems,
        currentUser,
        siteIsPublished,
        communityError,
      };
      const localMap: Record<string, Dynamic> = {};
      localItems.forEach(function (t: Dynamic) {
        localMap[t.id] = t;
      });
      const localCards = localItems.map(function (t: Dynamic) {
        return {
          id: t.id,
          name: t.name,
          description: t.description || "",
          preview_url: t.preview_url || "",
          source_url: t.source_url || "",
          isLocalItem: true,
          version: t.version || "",
          author: t.author || "",
          author_id: t.author_id || t.authorId || "",
          apiVersion: t.apiVersion || 1,
          contentKeys: t.contentKeys || [],
        };
      });
      const communityCards = communityItems
        .filter(function (t: Dynamic) {
          return !localMap[t.id];
        })
        .map(function (t: Dynamic) {
          return {
            id: t.id,
            name: t.name,
            description: t.description || "",
            preview_url: communityUrl(t.preview_url || ""),
            source_url: communityUrl(t.source_url || ""),
            isLocalItem: false,
            version: t.version || "",
            author: t.author || "",
            author_id: t.author_id || t.authorId || "",
            apiVersion: t.apiVersion || 1,
            contentKeys: t.contentKeys || [],
            bg: t.bg || "",
          };
        });
      const allItems = localCards.concat(communityCards);
      const communityErrorHtml = communityError
        ? "<div class='notice' style='margin-bottom:10px;color:var(--danger)'>" +
          escapeHtml(t("templateCommunityLoadFailed")) +
          " " +
          escapeHtml(String(communityError)) +
          "</div>"
        : "";
      if (!allItems.length) {
        list.innerHTML =
          communityErrorHtml +
          "<div class='emptyState'>" +
          escapeHtml(t("noTemplates")) +
          "</div>";
        return;
      }
      const cols = templateColumns(list);
      const pageSize = cols * 10;
      const totalPages = Math.max(1, Math.ceil(allItems.length / pageSize));
      templatePage = Math.min(Math.max(1, templatePage), totalPages);
      const start = (templatePage - 1) * pageSize;
      const pageItems = allItems.slice(start, start + pageSize);
      const pagerHtml = renderTemplatePager(
        templatePage,
        totalPages,
        allItems.length,
      );
      list.innerHTML =
        communityErrorHtml +
        pagerHtml +
        "<div style='display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px'>" +
        pageItems
          .map(function (tm: Dynamic) {
            const local = localMap[tm.id];
            const isActive = local && local.is_active;
            const isLoaded = !!tm.isLocalItem;
            const isCommunityItem = !tm.isLocalItem;
            const templateAuthorId = tm.author_id || tm.authorId || "";
            const currentAuthorId =
              (currentUser &&
                (currentUser.authorId || currentUser.author_id)) ||
              "";
            const isCommunityOwner =
              isCommunityItem &&
              templateAuthorId &&
              currentAuthorId &&
              templateAuthorId === currentAuthorId;
            const hasUpdate =
              isLoaded &&
              tm.version &&
              local.version &&
              tm.version !== local.version;
            // "自分" badge: only for templates that exist locally but not in Community.
            const localSourceUrl = local ? local.source_url || "" : "";
            const isCustom =
              tm.isLocalItem &&
              !localSourceUrl.includes("/kurocms/api/v1/get/");
            const ownBadge = isCustom
              ? "<span class='badge' style='background:var(--accent);color:#fff;margin-left:6px;font-size:10px;vertical-align:middle'>" +
                escapeHtml(t("customBadge")) +
                "</span>"
              : "";
            const activeBadge = isActive
              ? siteIsPublished
                ? "<span class='badge' style='background:#1a8a6e;color:#fff;margin-left:4px;font-size:10px;vertical-align:middle'>" +
                  escapeHtml(t("communityActiveBadge")) +
                  "</span>"
                : "<span class='badge' style='background:var(--muted);color:#fff;margin-left:4px;font-size:10px;vertical-align:middle'>" +
                  escapeHtml(t("inUseBadge")) +
                  "</span>"
              : "";
            const greenBtn =
              "width:100%;background:var(--accent,#1a8a6e);color:#fff;border:none;border-radius:var(--radius);padding:7px 0;font-size:13px;font-weight:700;cursor:pointer";
            const blueBtn =
              "width:100%;background:#2563eb;color:#fff;border:none;border-radius:var(--radius);padding:7px 0;font-size:13px;font-weight:700;cursor:pointer";
            const grayBtn = "width:100%;opacity:0.35;cursor:not-allowed";
            let selectBtn;
            if (isActive) {
              selectBtn =
                "<button type='button' class='small' style='" +
                grayBtn +
                "' disabled>" +
                escapeHtml(t("inUseBadge")) +
                "</button>";
            } else if (isLoaded && !hasUpdate) {
              selectBtn =
                "<button type='button' class='small' style='" +
                greenBtn +
                "' data-tmpl-activate='" +
                escapeHtml(tm.id) +
                "'>" +
                escapeHtml(t("selectTmpl")) +
                "</button>";
            } else {
              selectBtn =
                "<button type='button' class='small' style='" +
                (isCommunityItem && !hasUpdate ? blueBtn : greenBtn) +
                "' data-tmpl-select='" +
                escapeHtml(tm.id) +
                "'" +
                " data-tmpl-name='" +
                escapeHtml(tm.name || "") +
                "'" +
                " data-tmpl-author='" +
                escapeHtml(tm.author || "") +
                "'" +
                " data-tmpl-author-id='" +
                escapeHtml(templateAuthorId || "") +
                "'" +
                " data-tmpl-version='" +
                escapeHtml(tm.version || "1.0.0") +
                "'" +
                " data-tmpl-desc='" +
                escapeHtml(tm.description || "") +
                "'" +
                " data-tmpl-preview='" +
                escapeHtml(tm.preview_url || "") +
                "'" +
                " data-tmpl-source='" +
                escapeHtml(tm.source_url || "") +
                "'" +
                " data-tmpl-api-version='" +
                escapeHtml(String(tm.apiVersion || 1)) +
                "'" +
                " data-tmpl-content-keys='" +
                escapeHtml(JSON.stringify(tm.contentKeys || [])) +
                "'>" +
                escapeHtml(
                  hasUpdate
                    ? t("updateTmpl")
                    : isCommunityItem
                      ? t("publicSelectTmpl")
                      : t("selectTmpl"),
                ) +
                "</button>";
            }
            let thumb;
            if (local && local.preview_url) {
              // locally captured thumbnail (most recent manual capture)
              // Absolute URLs (e.g. community preview images) stay as-is.
              // Local thumbnails are served from D1 via /api/v1/templates/{id}/thumbnail
              // (admin base path), so relative paths go through withBase().
              const thumbSrc = /^https?:\/\//.test(local.preview_url)
                ? local.preview_url
                : withBase(local.preview_url);
              thumb =
                "<img src='" +
                escapeHtml(thumbSrc) +
                "' style='width:100%;height:160px;object-fit:cover;display:block' />";
            } else if (local) {
              // installed template — always show live preview (always reflects current code)
              const previewSrc = withBase(
                "/api/v1/templates/" + encodeURIComponent(tm.id) + "/preview",
              );
              thumb =
                "<div style='width:100%;height:160px;overflow:hidden;position:relative;background:var(--surface-2)'>" +
                "<iframe src='" +
                escapeHtml(previewSrc) +
                "' loading='lazy' sandbox='allow-same-origin allow-scripts' style='width:1000px;height:615px;transform:scale(0.26);transform-origin:top left;border:none;pointer-events:none'></iframe>" +
                "</div>";
            } else if (tm.preview_url) {
              // not installed — show community gallery image as preview
              thumb =
                "<img src='" +
                escapeHtml(tm.preview_url) +
                "' style='width:100%;height:160px;object-fit:cover;display:block' />";
            } else {
              // no preview_url — use bg color/gradient from template metadata
              const bgStyle = tm.bg ? escapeHtml(tm.bg) : "var(--surface-2)";
              const label = (tm.name || tm.id).slice(0, 3).toUpperCase();
              thumb =
                "<div style='width:100%;height:160px;background:" +
                bgStyle +
                ";display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:900;font-family:monospace;letter-spacing:-1px;color:#fff;text-shadow:0 1px 6px rgba(0,0,0,0.5)'>" +
                label +
                "</div>";
            }
            const localCommunityId =
              local && local.community_id ? local.community_id : "";
            const refreshBtn = isLoaded
              ? "<button type='button' class='secondary small' data-tmpl-refresh='" +
                escapeHtml(tm.id) +
                "' data-tmpl-community-id='" +
                escapeHtml(localCommunityId) +
                "' style='flex-shrink:0;font-size:11px;padding:4px 8px' title='" +
                escapeHtml(t("refreshThumbnailHint")) +
                "'>&#8635;</button>"
              : "";
            const deleteBtn =
              tm.isLocalItem && isLoaded
                ? "<button type='button' class='secondary small' data-tmpl-local-delete='" +
                  escapeHtml(tm.id) +
                  "' data-tmpl-active='" +
                  (isActive ? "1" : "0") +
                  "' style='flex-shrink:0;font-size:11px;padding:4px 8px;color:var(--danger)' title='" +
                  escapeHtml(t("delete")) +
                  "'>&#128465;</button>"
                : isCommunityOwner
                  ? "<button type='button' class='secondary small' data-tmpl-community-delete='" +
                    escapeHtml(tm.id) +
                    "' data-tmpl-name='" +
                    escapeHtml(tm.name || "") +
                    "' style='flex-shrink:0;font-size:11px;padding:4px 8px;color:var(--danger)' title='" +
                    escapeHtml(t("delete")) +
                    "'>&#128465;</button>"
                  : isCommunityItem
                    ? "<span class='secondary small' style='flex-shrink:0;font-size:11px;padding:4px 8px;display:inline-flex;align-items:center;justify-content:center' title='" +
                      escapeHtml(t("publicLibraryTemplate")) +
                      "'>&#127758;</span>"
                    : "";
            const border = isActive
              ? "2px solid var(--accent)"
              : "1px solid var(--line-strong)";
            return (
              "<div style='border:" +
              border +
              ";border-radius:var(--radius);background:var(--bg);overflow:hidden;display:flex;flex-direction:column'>" +
              "<div style='overflow:hidden'>" +
              thumb +
              "</div>" +
              "<div style='padding:10px 12px;flex:1;display:flex;flex-direction:column;gap:6px'>" +
              "<div style='font-size:13px;font-weight:700;line-height:1.3'>" +
              escapeHtml(tm.name || "") +
              ownBadge +
              activeBadge +
              "</div>" +
              "<div style='font-size:11px;color:var(--muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.5;flex:1'>" +
              escapeHtml(tm.description || "") +
              "</div>" +
              (selectBtn
                ? "<div style='margin-top:4px;display:flex;gap:4px;align-items:center'>" +
                  selectBtn +
                  refreshBtn +
                  deleteBtn +
                  "</div>"
                : refreshBtn || deleteBtn
                  ? "<div style='margin-top:4px;display:flex;gap:4px'>" +
                    refreshBtn +
                    deleteBtn +
                    "</div>"
                  : "") +
              "</div>" +
              "</div>"
            );
          })
          .join("") +
        "</div>";

      list
        .querySelectorAll<AdminElement>("[data-tmpl-page]")
        .forEach(function (btn) {
          btn.addEventListener("click", function () {
            const nextPage = Number(btn.dataset.tmplPage || "1");
            if (!Number.isFinite(nextPage)) return;
            templatePage = nextPage;
            renderLastTemplateList();
          });
        });

      list
        .querySelectorAll<AdminElement>("[data-tmpl-activate]")
        .forEach(function (btn) {
          btn.addEventListener("click", async function () {
            const tmplId = btn.dataset.tmplActivate;
            if (!tmplId) return;
            const origText = btn.textContent;
            btn.disabled = true;
            btn.textContent = t("selectingTmpl");
            try {
              await api(
                "/api/v1/templates/" + encodeURIComponent(tmplId) + "/activate",
                { method: "PUT" },
              );
              toast(t("templateSelected"));
              ensureTwCss(tmplId);
              loadAll();
            } catch (err) {
              btn.disabled = false;
              btn.textContent = origText;
              toast(errorMessage(err), true, btn);
            }
          });
        });

      list
        .querySelectorAll<AdminElement>("[data-tmpl-refresh]")
        .forEach(function (btn) {
          btn.addEventListener("click", async function () {
            const tmplId = btn.dataset.tmplRefresh;
            btn.disabled = true;
            btn.innerHTML = "…";
            try {
              await captureAndSaveThumbnail(tmplId);
              toast(t("thumbnailRefreshed"));
              loadAll();
            } catch (e) {
              toast(
                t("thumbnailUpdateFailed") ||
                  "サムネイルの更新に失敗しました。",
                true,
              );
              console.warn("[thumbnail refresh]", e);
            }
            btn.disabled = false;
            btn.innerHTML = "&#8635;";
          });
        });

      list
        .querySelectorAll<AdminElement>("[data-tmpl-local-delete]")
        .forEach(function (btn) {
          btn.addEventListener("click", async function () {
            const tmplId = btn.dataset.tmplLocalDelete;
            if (!tmplId) return;
            if (!confirm(t("tmplDeleteConfirm"))) return;
            try {
              await api("/api/v1/templates/" + encodeURIComponent(tmplId), {
                method: "DELETE",
              });
              toast(t("deleteDone"));
              loadAll();
            } catch (err) {
              toast(errorMessage(err), true);
            }
          });
        });

      list
        .querySelectorAll<AdminElement>("[data-tmpl-community-delete]")
        .forEach(function (btn) {
          btn.addEventListener("click", async function () {
            const tmplId = btn.dataset.tmplCommunityDelete;
            if (!tmplId) return;
            if (!confirm(t("communityDeleteConfirm"))) return;
            try {
              await api(
                "/api/v1/templates/" +
                  encodeURIComponent(tmplId) +
                  "/community",
                { method: "DELETE" },
              );
              toast(t("communityDeleteSuccess"));
              loadAll();
            } catch (err) {
              toast(errorMessage(err), true);
            }
          });
        });

      list
        .querySelectorAll<AdminElement>("[data-tmpl-select]")
        .forEach(function (btn) {
          btn.addEventListener("click", async function () {
            const tmplId = btn.dataset.tmplSelect;
            const origText = btn.textContent;
            const suggestedName = btn.dataset.tmplName || tmplId || "";
            const sourceUrl = btn.dataset.tmplSource || "";
            // コピー時は名前を入力させず、元の名前のまま保存する。
            // 名前変更はテンプレート表示画面の「名前変更」ボタンで行う。
            btn.disabled = true;
            btn.textContent = t("loadingTmpl");
            const body = {
              id: tmplId,
              sourceUrl,
              name: suggestedName,
              author: btn.dataset.tmplAuthor || "",
              authorId: btn.dataset.tmplAuthorId || "",
              version: btn.dataset.tmplVersion || "1.0.0",
              description: btn.dataset.tmplDesc || "",
              previewUrl: btn.dataset.tmplPreview || "",
              apiVersion: Number(btn.dataset.tmplApiVersion || "1"),
              contentKeys: (() => {
                try {
                  return JSON.parse(btn.dataset.tmplContentKeys || "[]");
                } catch {
                  return [];
                }
              })(),
            };
            try {
              const result = await api("/api/v1/templates", {
                method: "POST",
                body: JSON.stringify(body),
              });
              toast(t("templateSelected"));
              // コピー直後はまだ community_id がないためローカル保存
              captureAndSaveThumbnail(result.id || tmplId).catch(() => {});
              loadAll();
            } catch (err) {
              btn.disabled = false;
              btn.textContent = origText;
              toast(errorMessage(err), true, btn);
            }
          });
        });
    }

    function loadAll() {
      const p1 = fetch(communityBase + "/api/v1/list", {
        headers: { Accept: "application/json" },
      })
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        })
        .catch(function (err) {
          return { templates: [], error: errorMessage(err) };
        });
      const p2 = api("/api/v1/templates").catch(function () {
        return { templates: [], capturePending: false, captureTid: null };
      });
      const p3 = api("/api/me").catch(function () {
        return { user: state.currentUser || {} };
      });
      Promise.all([p1, p2, p3]).then(function (results) {
        const localData = results[1];
        state.currentUser = results[2].user || state.currentUser;
        const localTemplates = localData.templates || [];
        const active = localTemplates.find(function (t: Dynamic) {
          return t.is_active;
        });
        const isPub = !!(active && active.community_published);
        renderList(
          results[0].templates || [],
          localTemplates,
          state.currentUser || {},
          isPub,
          results[0].error || "",
        );
      });
    }

    loadAll();

    window.addEventListener("resize", renderLastTemplateList);
    panel.addEventListener(
      "remove",
      function () {
        window.removeEventListener("resize", renderLastTemplateList);
      },
      { once: true },
    );
  }

  // ── テンプレート編集 panel ──────────────────────────────────────────
  function loadTemplateEditPanel(panel: Dynamic) {
    panel.innerHTML =
      "<div style='display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:8px;align-items:end;margin-bottom:10px'>" +
      "<label style='display:flex;flex-direction:column;gap:3px'>" +
      "<span style='font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)'>" +
      escapeHtml(t("tmplEditorName")) +
      "</span>" +
      "<input id='tmplEditNameInput' placeholder='" +
      escapeHtml(t("tmplEditorName")) +
      "' style='font-size:14px;font-weight:700' />" +
      "</label>" +
      "<label style='display:flex;flex-direction:column;gap:3px'>" +
      "<span style='font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)'>" +
      escapeHtml(t("tmplEditorAuthor")) +
      "</span>" +
      "<input id='tmplEditAuthorInput' placeholder='" +
      escapeHtml(t("tmplEditorAuthor")) +
      "' />" +
      "</label>" +
      "<div style='display:flex;align-items:center;gap:10px;padding-bottom:2px'>" +
      "<span id='tmplEditStatus' style='font-size:12px;color:var(--accent);font-weight:600;opacity:0;transition:opacity 0.3s'></span>" +
      "<button type='button' id='tmplEditSaveBtn' class='small' disabled style='opacity:0.4;cursor:not-allowed'>" +
      escapeHtml(t("tmplEditorSaveBtn")) +
      "</button>" +
      "</div>" +
      "</div>" +
      "<p style='font-size:12px;color:var(--muted);margin-bottom:8px'>" +
      escapeHtml(t("tmplEditorPreviewNote")) +
      "</p>" +
      "<div id='tmplEditWrap' style='position:relative'>" +
      "<textarea id='tmplEditArea' spellcheck='false' style='width:100%;box-sizing:border-box;height:calc(100vh - 340px);min-height:400px;background:#1e293b;color:#e2e8f0;font-family:Menlo,Monaco,Consolas,monospace;font-size:12px;line-height:1.6;padding:12px 16px;border:1px solid #334155;border-radius:var(--radius);resize:vertical;outline:none;tab-size:2;white-space:pre;overflow:auto' placeholder='" +
      escapeHtml(t("tmplEditorPlaceholder")) +
      "'></textarea>" +
      "</div>";

    let currentTmplId: Dynamic = null;
    let originalHtml = "";
    let originalName = "";
    let originalAuthor = "";

    function setSaveEnabled(enabled: Dynamic) {
      const btn = byId("tmplEditSaveBtn");
      if (!btn) return;
      btn.disabled = !enabled;
      btn.style.opacity = enabled ? "1" : "0.4";
      btn.style.cursor = enabled ? "pointer" : "not-allowed";
    }

    function checkDirty() {
      const area = byId("tmplEditArea");
      const nameEl = byId("tmplEditNameInput");
      const authEl = byId("tmplEditAuthorInput");
      setSaveEnabled(
        (area && area.value !== originalHtml) ||
          (nameEl && nameEl.value !== originalName) ||
          (authEl && authEl.value !== originalAuthor),
      );
    }

    function loadActiveTemplate() {
      api("/api/v1/templates")
        .then(function (d) {
          const active = (d.templates || []).find(function (t: Dynamic) {
            return t.is_active;
          });
          if (!active) {
            const nameEl = byId("tmplEditNameInput");
            if (nameEl) {
              nameEl.placeholder = t("tmplEditorNotSelected");
              nameEl.disabled = true;
            }
            const authEl = byId("tmplEditAuthorInput");
            if (authEl) authEl.disabled = true;
            return;
          }
          currentTmplId = active.id;
          originalName = active.name || "";
          originalAuthor = active.author || "";
          const nameEl = byId("tmplEditNameInput");
          if (nameEl) nameEl.value = originalName;
          const authEl = byId("tmplEditAuthorInput");
          if (authEl) authEl.value = originalAuthor;

          api(
            "/api/v1/templates/" +
              encodeURIComponent(active.id) +
              "/source-html",
          )
            .then(function (s) {
              if (s.html) {
                originalHtml = s.html;
                byId("tmplEditArea")!.value = s.html;
                setSaveEnabled(false);
              } else {
                loadPreviewHtml(active.id);
              }
            })
            .catch(function () {
              loadPreviewHtml(active.id);
            });
        })
        .catch(function (err) {
          toast(errorMessage(err), true);
        });
    }

    function loadPreviewHtml(id: Dynamic) {
      fetch(
        withBase("/api/v1/templates/" + encodeURIComponent(id) + "/preview"),
      )
        .then(function (r) {
          return r.text();
        })
        .then(function (html) {
          originalHtml = html;
          byId("tmplEditArea")!.value = html;
          setSaveEnabled(false);
        })
        .catch(function (err) {
          toast(t("previewFetchFailed") + errorMessage(err), true);
        });
    }

    byId("tmplEditArea")?.addEventListener("input", checkDirty);
    byId("tmplEditNameInput")?.addEventListener("input", checkDirty);
    byId("tmplEditAuthorInput")?.addEventListener("input", checkDirty);

    function setEditStatus(msg: Dynamic, autoClear: Dynamic) {
      const el = byId("tmplEditStatus");
      if (!el) return;
      el.textContent = msg;
      el.style.opacity = "1";
      if (autoClear) {
        clearTimeout(el._t);
        el._t = setTimeout(function () {
          el.style.opacity = "0";
        }, 4000);
      }
    }

    byId("tmplEditSaveBtn")?.addEventListener("click", async function () {
      if (!currentTmplId) return;
      const html = byId("tmplEditArea")?.value || "";
      const name = (byId("tmplEditNameInput")?.value || "").trim();
      const author = (byId("tmplEditAuthorInput")?.value || "").trim();
      if (!name) {
        toast(t("tmplNameRequired"), true, byId("tmplEditNameInput"));
        return;
      }
      const htmlChanged = html !== originalHtml;
      const metaChanged = name !== originalName || author !== originalAuthor;
      try {
        await Promise.all([
          htmlChanged
            ? api(
                "/api/v1/templates/" +
                  encodeURIComponent(currentTmplId) +
                  "/source-html",
                {
                  method: "PUT",
                  body: JSON.stringify({ html }),
                },
              )
            : Promise.resolve(),
          metaChanged
            ? api("/api/v1/templates/" + encodeURIComponent(currentTmplId), {
                method: "PUT",
                body: JSON.stringify({ name, author }),
              })
            : Promise.resolve(),
        ]);
        originalHtml = html;
        originalName = name;
        originalAuthor = author;
        setSaveEnabled(false);
        setEditStatus(t("tmplSaved"), !htmlChanged);
        if (htmlChanged) {
          ensureTwCss(currentTmplId);
          captureAndSaveThumbnail(currentTmplId)
            .then(function () {
              setEditStatus(t("tmplSavedAndPreview"), true);
            })
            .catch(function () {});
        }
      } catch (err) {
        toast(errorMessage(err), true);
      }
    });

    byId("tmplEditArea")?.addEventListener("keydown", function (e) {
      if (e.key === "Tab") {
        e.preventDefault();
        const el = byId("tmplEditArea")!;
        const s = el.selectionStart ?? 0;
        const end = el.selectionEnd ?? s;
        el.value = el.value.slice(0, s) + "  " + el.value.slice(end);
        el.selectionStart = el.selectionEnd = s + 2;
      }
    });

    loadActiveTemplate();

    api("/api/v1/templates")
      .then(function (d) {
        const active = (d.templates || []).find(function (t: Dynamic) {
          return t.is_active;
        });
        if (active && active.community_published) {
          const wrap = byId("tmplEditWrap");
          if (!wrap) return;
          const overlay = document.createElement("div");
          overlay.id = "tmplEditOverlay";
          overlay.style.cssText =
            "position:absolute;inset:0;background:rgba(0,0,0,0.6);border-radius:var(--radius);display:flex;align-items:center;justify-content:center;z-index:10;pointer-events:all";
          overlay.innerHTML =
            "<div style='color:#fff;font-size:18px;font-weight:700;text-align:center;line-height:1.6;text-shadow:0 2px 8px rgba(0,0,0,.5)'>" +
            escapeHtml(t("tmplCommunityLocked")) +
            "<br><span style='font-size:13px;font-weight:400;opacity:0.8'>" +
            escapeHtml(t("tmplCommunityUnlockHint")) +
            "</span></div>";
          wrap.appendChild(overlay);
          byId("tmplEditSaveBtn")!.disabled = true;
          byId("tmplEditSaveBtn")!.style.opacity = "0.4";
          byId("tmplEditSaveBtn")!.style.cursor = "not-allowed";
        }
      })
      .catch(function () {});
  }

  function loadTemplateList(mode: Dynamic) {
    const isPC = mode !== "sp";
    api("/api/v1/templates")
      .then(function (d) {
        const list = byId("tmplList");
        if (!list) return;
        const items = d.templates || [];
        const tm = items.find(function (t: Dynamic) {
          return t.is_active;
        });
        if (!tm) {
          list.innerHTML =
            "<div class='emptyState'>" +
            escapeHtml(t("tmplEmptyState")) +
            "</div>";
          return;
        }
        const pubDate = tm.installed_at ? tm.installed_at.slice(0, 10) : "";
        const previewSrc = withBase(
          "/api/v1/templates/" + encodeURIComponent(tm.id) + "/preview",
        );
        const previewBlock = isPC
          ? "<div style='width:100%;height:1024px;overflow:hidden;background:var(--surface-2)'>" +
            "<iframe src='" +
            escapeHtml(previewSrc) +
            "' style='width:125%;height:1280px;transform:scale(0.8);transform-origin:top left;border:none;pointer-events:none' loading='lazy' sandbox='allow-same-origin allow-scripts'></iframe>" +
            "</div>"
          : "<div style='display:flex;justify-content:center;padding:20px 0;background:var(--surface-2)'>" +
            "<div style='width:390px;height:813px;overflow:hidden;border-radius:12px;border:1px solid var(--line);box-shadow:0 4px 20px rgba(0,0,0,.18)'>" +
            "<iframe src='" +
            escapeHtml(previewSrc) +
            "' style='width:488px;height:1016px;transform:scale(0.8);transform-origin:top left;border:none;pointer-events:none' loading='lazy' sandbox='allow-same-origin allow-scripts'></iframe>" +
            "</div>" +
            "</div>";
        list.innerHTML =
          "<div class='panel' style='padding:0;overflow:hidden'>" +
          "<div style='display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--line);flex-wrap:wrap'>" +
          "<span style='font-size:12px;color:var(--muted);font-weight:600'>" +
          escapeHtml(t("tmplCurrentTemplate")) +
          "</span>" +
          "<strong style='font-size:14px'>" +
          escapeHtml(tm.name) +
          "</strong>" +
          "<span style='color:var(--muted);font-size:12px'>" +
          escapeHtml(tm.author || "") +
          "</span>" +
          (pubDate
            ? "<span style='color:var(--muted);font-size:12px;margin-left:auto'>" +
              escapeHtml(pubDate) +
              "</span>"
            : "") +
          "</div>" +
          previewBlock +
          "<div style='display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid var(--line);flex-wrap:wrap'>" +
          "<button type='button' class='secondary small' data-tmpl-detail='" +
          escapeHtml(tm.id) +
          "'>" +
          escapeHtml(t("tmplDetailInfo")) +
          "</button>" +
          "</div>" +
          "</div>";
        list
          .querySelectorAll<AdminElement>("[data-tmpl-detail]")
          .forEach(function (btn) {
            btn.addEventListener("click", function () {
              showTemplateDetail(btn.dataset.tmplDetail);
            });
          });
      })
      .catch(function (err) {
        const list = byId("tmplList");
        if (list)
          list.innerHTML =
            "<div class='emptyState'>" +
            escapeHtml(errorMessage(err)) +
            "</div>";
      });
  }

  function showTemplateDetail(id: Dynamic) {
    api("/api/v1/templates/" + id)
      .then(function (d) {
        const tm = d.template || {};
        openEntryDialog(
          t("tmplDetailDialog") + (tm.name || ""),
          "<div class='stack'>" +
            (tm.preview_url
              ? "<img src='" +
                escapeHtml(tm.preview_url) +
                "' style='max-width:100%;border-radius:8px;border:1px solid var(--line)' />"
              : "") +
            "<table style='width:100%;border-collapse:collapse;font-size:13px'><tbody>" +
            "<tr style='border-bottom:1px solid var(--line)'><th style='padding:8px 10px;text-align:left;white-space:nowrap;background:var(--surface-2);width:1%'>" +
            escapeHtml(t("tmplDetailAuthorLabel")) +
            "</th><td style='padding:8px 10px;word-break:break-word'>" +
            escapeHtml(tm.author || "—") +
            "</td></tr>" +
            "<tr style='border-bottom:1px solid var(--line)'><th style='padding:8px 10px;text-align:left;white-space:nowrap;background:var(--surface-2)'>" +
            escapeHtml(t("tmplDetailVersionLabel")) +
            "</th><td style='padding:8px 10px'>" +
            escapeHtml(tm.version || "—") +
            "</td></tr>" +
            "<tr style='border-bottom:1px solid var(--line)'><th style='padding:8px 10px;text-align:left;white-space:nowrap;background:var(--surface-2)'>" +
            escapeHtml(t("tmplDetailDescLabel")) +
            "</th><td style='padding:8px 10px;word-break:break-word'>" +
            escapeHtml(tm.description || "—") +
            "</td></tr>" +
            "<tr><th style='padding:8px 10px;text-align:left;white-space:nowrap;background:var(--surface-2)'>" +
            escapeHtml(t("tmplDetailDownloadLabel")) +
            "</th><td style='padding:8px 10px'><a href='" +
            escapeHtml(tm.source_url || "#") +
            "' target='_blank' rel='noopener' style='word-break:break-all'>" +
            escapeHtml(tm.source_url || "—") +
            "</a></td></tr>" +
            "</tbody></table>" +
            "</div>",
          t("tmplDetailClose"),
          function (_: Dynamic, close: Dynamic) {
            close();
          },
        );
      })
      .catch(function (err) {
        toast(errorMessage(err), true);
      });
  }

  // ── Content panel ──────────────────────────────────────────────────
  let _contentActiveLang = ""; // active language code (e.g. "ja", "en")
  let _contentDefaultLang = ""; // site default language code

  // ── フォント管理 panel ─────────────────────────────────────────────
  function loadFontPanel(panel: Dynamic) {
    panel.innerHTML =
      "<div style='display:flex;align-items:flex-start;gap:12px;margin-bottom:12px'>" +
      "<div style='flex:1;min-width:0'>" +
      "<h3 style='margin:0 0 4px'>" +
      escapeHtml(t("fontEditorTitle")) +
      "</h3>" +
      "<p class='categoryHint' style='margin:0'>" +
      escapeHtml(t("fontEditorHint")) +
      "</p>" +
      "</div>" +
      "<label style='display:flex;align-items:center;gap:6px;flex-shrink:0;font-size:12px;color:var(--muted)'>" +
      escapeHtml(t("fontLanguage")) +
      "<select id='fontLangSelect' disabled style='min-width:120px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)'></select>" +
      "</label>" +
      "<button type='button' id='fontSaveBtn' style='flex-shrink:0'>" +
      escapeHtml(t("fontSaveBtn")) +
      "</button>" +
      "</div>" +
      "<div id='fontStatus' class='muted' style='font-size:12px;margin-bottom:10px;min-height:16px'></div>" +
      "<div id='fontShuttle' class='emptyState'>" +
      escapeHtml(t("loading")) +
      "</div>";

    let catalog: Dynamic[] = [];
    let systemFonts: Dynamic[] = [];
    let loaded: Dynamic[] = [];
    let base = "";
    let fontLang = "";
    let fontLangs: Dynamic[] = [];
    let selLeft = "";
    let selRight = "";

    byId("fontSaveBtn")?.addEventListener("click", save);

    Promise.all([api("/api/settings"), api("/api/languages")])
      .then(function (results: Dynamic[]) {
        const defaultLang = results[0]?.settings?.defaultLang || "en";
        fontLangs = (results[1].languages || []).map(function (l: Dynamic) {
          return {
            code: l.lang,
            label: localeNames[l.lang] || l.displayName || l.lang,
          };
        });
        if (
          !fontLangs.some(function (l: Dynamic) {
            return l.code === defaultLang;
          })
        ) {
          fontLangs.unshift({
            code: defaultLang,
            label: localeNames[defaultLang] || defaultLang,
          });
        }
        fontLangs.sort(function (a: Dynamic, b: Dynamic) {
          if (a.code === defaultLang) return -1;
          if (b.code === defaultLang) return 1;
          return a.code.localeCompare(b.code);
        });
        fontLang = fontLang || defaultLang || fontLangs[0]?.code || "en";
        renderLangSelect();
        return loadConfig(fontLang);
      })
      .catch(function () {
        const s = byId("fontShuttle");
        if (s) s.textContent = t("apiFailed") || "Failed";
      });

    function loadConfig(lang: Dynamic) {
      const s = byId("fontShuttle");
      if (s) {
        s.className = "emptyState";
        s.textContent = t("loading");
      }
      selLeft = "";
      selRight = "";
      return api("/api/fonts?lang=" + encodeURIComponent(lang || ""))
        .then(function (d: Dynamic) {
          catalog = d.catalog || [];
          systemFonts = d.systemFonts || [];
          loaded = (d.loaded || []).filter(function (f: Dynamic) {
            return catalog.some(function (c: Dynamic) {
              return c.family === f.family;
            });
          });
          // A base font must always be marked. When the site has no saved setting,
          // default the ★ to the first system font (machine-dependent default) so
          // one is selected from the start.
          base =
            d.base || (systemFonts[0] && systemFonts[0].id) || "__sys_sans__";
          injectPreviewFonts();
          render();
        })
        .catch(function () {
          const s = byId("fontShuttle");
          if (s) s.textContent = t("apiFailed") || "Failed";
        });
    }

    function renderLangSelect() {
      const select = byId("fontLangSelect") as HTMLSelectElement | null;
      if (!select) return;
      select.innerHTML = fontLangs
        .map(function (l: Dynamic) {
          return (
            "<option value='" +
            escapeHtml(l.code) +
            "'" +
            (l.code === fontLang ? " selected" : "") +
            ">" +
            escapeHtml(l.label || l.code) +
            "</option>"
          );
        })
        .join("");
      select.disabled = fontLangs.length === 0;
      select.onchange = function () {
        fontLang = select.value || fontLang;
        setStatus("");
        loadConfig(fontLang);
      };
    }

    // Load all catalog families (regular weight) into the admin document so each
    // row previews in its own font. The admin page may depend on Google Fonts —
    // the public site does not (those are self-hosted).
    function injectPreviewFonts() {
      if (byId("fontPreviewLink")) return;
      const fams = catalog
        .map(function (c: Dynamic) {
          return "family=" + encodeURIComponent(c.family).replace(/%20/g, "+");
        })
        .join("&");
      const link = document.createElement("link");
      link.id = "fontPreviewLink";
      link.rel = "stylesheet";
      link.href = "https://fonts.googleapis.com/css2?" + fams + "&display=swap";
      document.head.appendChild(link);
    }

    function isLoaded(fam: Dynamic) {
      return loaded.some(function (f: Dynamic) {
        return f.family === fam;
      });
    }

    function rowStyle(selected: Dynamic, locked: Dynamic) {
      return (
        "padding:8px 10px;border:1px solid " +
        (selected ? "var(--accent)" : "var(--line)") +
        ";border-radius:8px;margin-bottom:6px;cursor:" +
        (locked ? "default" : "pointer") +
        ";background:" +
        (selected ? "rgba(21,122,110,.06)" : "var(--bg)") +
        (locked ? ";opacity:.92" : "")
      );
    }

    // Header line of a row: [★] name … [right control]. The name cell shrinks
    // (min-width:0) so long names ellipsize instead of overflowing the column.
    function languageFontScript(lang: Dynamic) {
      const code = String(lang || "en").toLowerCase();
      if (code === "ja" || code.startsWith("ja-")) return "japanese";
      if (code === "ko" || code.startsWith("ko-")) return "korean";
      if (
        code === "zh-tw" ||
        code === "zh-hk" ||
        code === "zh-hant" ||
        code.startsWith("zh-hant")
      )
        return "chinese-traditional";
      if (code === "zh" || code.startsWith("zh-")) return "chinese-simplified";
      if (
        ["ar", "fa", "ur", "ps", "sd", "ug", "ku", "ckb", "dv"].some(
          function (prefix) {
            return code === prefix || code.startsWith(prefix + "-");
          },
        )
      )
        return "arabic";
      if (
        ["ru", "uk", "bg", "be", "mk", "sr", "kk", "ky", "mn", "tg"].some(
          function (prefix) {
            return code === prefix || code.startsWith(prefix + "-");
          },
        )
      )
        return "cyrillic";
      return "latin";
    }

    function previewTextForLang(lang: Dynamic) {
      const code = String(lang || "en").toLowerCase();
      const base = code.split("-")[0];
      const samples: Record<string, string> = {
        en: "Aa The quick brown",
        ja: t("fontPreviewText"),
        zh:
          code === "zh-tw" || code === "zh-hk" || code.includes("hant")
            ? "Aa 中文 漢字"
            : "Aa 中文 汉字",
        ko: "Aa 한글 가나다",
        de: "Aa Ää Öö Üü ß",
        fr: "Aa Éé Èè Çç Œœ",
        es: "Aa Ññ ¿Qué tal?",
        it: "Aa Èè Perché città",
        pt: "Aa Ãã Çç São João",
        nl: "Aa Ĳssel café",
        pl: "Aa Ąą Łł Źź Żż",
        tr: "Aa Çç Ğğ İı Şş",
        ru: "Aa Привет Жж Яя",
        uk: "Aa Україна їієґ",
        ar: "Aa العربية",
        fa: "Aa فارسی گچپژ",
        hi: "Aa नमस्ते भारत",
        th: "Aa สวัสดี ไทย",
        vi: "Aa Tiếng Việt ăâđêôơư",
        id: "Aa Bahasa Indonesia",
      };
      if (samples[code]) return samples[code];
      if (samples[base]) return samples[base];
      switch (languageFontScript(lang)) {
        case "japanese":
          return t("fontPreviewText");
        case "chinese-simplified":
          return "Aa 中文 汉字";
        case "chinese-traditional":
          return "Aa 中文 漢字";
        case "korean":
          return "Aa 한글 가나";
        case "cyrillic":
          return "Aa Бб Україна";
        case "arabic":
          return "Aa العربية";
        default:
          return "Aa The quick brown";
      }
    }

    function isRecommendedFont(c: Dynamic) {
      const scripts = Array.isArray(c.scripts) ? c.scripts : [];
      return scripts.includes(languageFontScript(fontLang));
    }

    function rowHead(
      starHtml: Dynamic,
      name: Dynamic,
      rightHtml: Dynamic,
      recommended?: Dynamic,
    ) {
      return (
        "<div style='display:flex;align-items:center;gap:8px'>" +
        (starHtml || "") +
        "<div style='flex:1;min-width:0;font-size:12px;font-weight:600;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap'>" +
        escapeHtml(name) +
        "</div>" +
        (recommended
          ? "<span style='flex-shrink:0;font-size:10px;font-weight:700;color:#fff;background:var(--accent);border-radius:999px;padding:2px 7px'>" +
            escapeHtml(t("fontRecommended")) +
            "</span>"
          : "") +
        (rightHtml || "") +
        "</div>"
      );
    }

    // Big sample line rendered in the given CSS font-family value. Clipped with
    // ellipsis so it never widens the column.
    function previewLine(ffCss: Dynamic) {
      return (
        "<div style='font-family:" +
        ffCss +
        ";font-size:34px;line-height:1.2;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'>" +
        escapeHtml(previewTextForLang(fontLang)) +
        "</div>"
      );
    }

    function removeBtn(fam: Dynamic) {
      return (
        "<button type='button' data-frem='" +
        escapeHtml(fam) +
        "' style='flex-shrink:0;padding:3px 12px;font-size:12px;border:1px solid var(--line);border-radius:6px;background:var(--bg);cursor:pointer;white-space:nowrap'>" +
        escapeHtml(t("fontRemoveBtn")) +
        "</button>"
      );
    }

    function baseBtn(id: Dynamic) {
      const on = base === id;
      return (
        "<button type='button' data-fbase='" +
        escapeHtml(id) +
        "' title='" +
        escapeHtml(t("fontBaseMark")) +
        "' style='padding:2px 8px;font-size:13px;border:1px solid " +
        (on ? "#f59e0b" : "var(--line)") +
        ";border-radius:6px;background:" +
        (on ? "#f59e0b" : "var(--bg)") +
        ";color:" +
        (on ? "#fff" : "var(--muted)") +
        ";cursor:pointer'>" +
        (on ? "★" : "☆") +
        "</button>"
      );
    }

    function render() {
      const shuttle = byId("fontShuttle");
      if (!shuttle) return;
      shuttle.className = "";

      const available = catalog
        .filter(function (c: Dynamic) {
          return !isLoaded(c.family);
        })
        .slice()
        .sort(function (a: Dynamic, b: Dynamic) {
          const ar = isRecommendedFont(a);
          const br = isRecommendedFont(b);
          if (ar !== br) return ar ? -1 : 1;
          return String(a.label || a.family).localeCompare(
            String(b.label || b.family),
          );
        });

      // Available catalog fonts (right column): name line + preview, selectable.
      const leftRows = available.length
        ? available
            .map(function (c: Dynamic) {
              return (
                "<div class='fontAvail' data-fam='" +
                escapeHtml(c.family) +
                "' style='" +
                rowStyle(selLeft === c.family, false) +
                "'>" +
                rowHead("", c.label, "", isRecommendedFont(c)) +
                previewLine('"' + c.family + '",sans-serif') +
                "</div>"
              );
            })
            .join("")
        : "<p class='muted' style='font-size:12px'>—</p>";

      // Loaded column (left): system fonts (locked) first, then catalog fonts.
      // System fonts can be the base (★) but never removed/reordered — no remove
      // button. Catalog fonts show the remove button at the right of the name line.
      const sysRows = systemFonts
        .map(function (sf: Dynamic) {
          return (
            "<div style='" +
            rowStyle(false, true) +
            "'>" +
            rowHead(
              baseBtn(sf.id),
              sf.label,
              "<span style='flex-shrink:0;font-size:10px;color:var(--muted)'>" +
                escapeHtml(t("fontSystemLocked")) +
                "</span>",
            ) +
            previewLine(sf.stack) +
            "</div>"
          );
        })
        .join("");

      const loadedRows = loaded
        .map(function (f: Dynamic) {
          const c =
            catalog.find(function (x: Dynamic) {
              return x.family === f.family;
            }) || {};
          return (
            "<div class='fontLoaded' data-fam='" +
            escapeHtml(f.family) +
            "' style='" +
            rowStyle(selRight === f.family, false) +
            "'>" +
            rowHead(
              baseBtn(f.family),
              c.label || f.family,
              removeBtn(f.family),
              isRecommendedFont(c),
            ) +
            previewLine('"' + f.family + '",sans-serif') +
            "</div>"
          );
        })
        .join("");

      shuttle.innerHTML =
        // minmax(0,1fr) lets the side columns shrink so the big previews clip
        // with ellipsis instead of overflowing the panel.
        "<div style='display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:12px;align-items:start'>" +
        // left — fonts loaded on the site (system fonts first, then catalog)
        "<div><div style='font-size:12px;font-weight:700;margin-bottom:6px'>" +
        escapeHtml(t("fontLoaded")) +
        "</div>" +
        sysRows +
        loadedRows +
        "</div>" +
        // middle move buttons. "← 読み込む" moves a right (available) selection
        // into the left (loaded) list; "外す →" moves a left selection back out.
        "<div style='display:flex;flex-direction:column;gap:8px;padding-top:26px'>" +
        "<button type='button' id='fontAdd' style='padding:6px 10px;font-size:12px' " +
        (selLeft ? "" : "disabled") +
        ">" +
        escapeHtml(t("fontAddBtn")) +
        "</button>" +
        "<button type='button' id='fontRem' style='padding:6px 10px;font-size:12px' " +
        (selRight ? "" : "disabled") +
        ">" +
        escapeHtml(t("fontRemoveBtn")) +
        "</button>" +
        "</div>" +
        // right — available catalog fonts (not yet loaded)
        "<div><div style='font-size:12px;font-weight:700;margin-bottom:6px'>" +
        escapeHtml(t("fontAvailable")) +
        "</div>" +
        leftRows +
        "</div>" +
        "</div>";

      bindRows();
    }

    function bindRows() {
      const shuttle = byId("fontShuttle");
      if (!shuttle) return;
      shuttle
        .querySelectorAll<AdminElement>(".fontAvail")
        .forEach(function (el) {
          el.addEventListener("click", function () {
            selLeft = el.dataset.fam || "";
            selRight = "";
            render();
          });
        });
      shuttle
        .querySelectorAll<AdminElement>(".fontLoaded")
        .forEach(function (el) {
          el.addEventListener("click", function (ev: Dynamic) {
            // ignore clicks on the inline control buttons
            if (ev.target && ev.target.closest("button")) return;
            selRight = el.dataset.fam || "";
            selLeft = "";
            render();
          });
        });
      byId("fontAdd")?.addEventListener("click", addSelected);
      byId("fontRem")?.addEventListener("click", removeSelected);
      shuttle
        .querySelectorAll<AdminElement>("[data-fbase]")
        .forEach(function (b) {
          b.addEventListener("click", function () {
            // A base font must always stay selected: set the clicked one, never
            // toggle back to none.
            base = b.dataset.fbase || base;
            render();
          });
        });
      shuttle
        .querySelectorAll<AdminElement>("[data-frem]")
        .forEach(function (b) {
          b.addEventListener("click", function () {
            removeFamily(b.dataset.frem || "");
          });
        });
    }

    function addSelected() {
      if (!selLeft || isLoaded(selLeft)) return;
      const c = catalog.find(function (x: Dynamic) {
        return x.family === selLeft;
      });
      if (!c) return;
      loaded.push({
        family: c.family,
        weights: (c.defaultWeights || [400, 700]).slice(),
      });
      selRight = c.family;
      selLeft = "";
      render();
    }

    function removeSelected() {
      if (selRight) removeFamily(selRight);
    }

    function removeFamily(fam: Dynamic) {
      loaded = loaded.filter(function (f: Dynamic) {
        return f.family !== fam;
      });
      // The base font must always be set: if the removed font was the base,
      // fall back to the default system font.
      if (base === fam) {
        base = (systemFonts[0] && systemFonts[0].id) || "__sys_sans__";
      }
      if (selRight === fam) selRight = "";
      render();
    }

    function setStatus(msg: Dynamic) {
      const s = byId("fontStatus");
      if (s) s.textContent = msg;
    }

    function save() {
      // Enforce that a base font (★) is always selected.
      if (!base) {
        setStatus(t("fontBaseRequired"));
        return;
      }
      const btn = byId("fontSaveBtn") as HTMLButtonElement | null;
      if (btn) btn.disabled = true;
      setStatus(t("fontSaving"));
      api("/api/fonts", {
        method: "PUT",
        body: JSON.stringify({
          fonts: loaded.map(function (f: Dynamic) {
            return { family: f.family, weights: f.weights };
          }),
          base: base,
          lang: fontLang,
        }),
      })
        .then(function () {
          setStatus(t("fontSaved"));
          // Re-apply so the editor body reflects the new base font immediately.
          applyEditorFont(fontLang);
        })
        .catch(function (e: Dynamic) {
          setStatus((e && e.message) || t("apiFailed") || "Failed");
        })
        .then(function () {
          if (btn) btn.disabled = false;
        });
    }
  }

  // ── 計測・SEO panel (GA4 ID + site description) ──────────────────────
  function loadAnalyticsPanel(panel: Dynamic) {
    panel.innerHTML =
      "<div style='display:flex;align-items:flex-start;gap:12px;margin-bottom:12px'>" +
      "<div style='flex:1;min-width:0'>" +
      "<h3 style='margin:0 0 4px'>" +
      escapeHtml(t("analyticsTitle")) +
      "</h3>" +
      "<p class='categoryHint' style='margin:0'>" +
      escapeHtml(t("analyticsHint")) +
      "</p>" +
      "</div>" +
      "<button type='button' id='analyticsSaveBtn' style='flex-shrink:0' disabled>" +
      escapeHtml(t("analyticsSaveBtn")) +
      "</button>" +
      "</div>" +
      "<div id='analyticsStatus' class='muted' style='font-size:12px;margin-bottom:14px;min-height:16px'></div>" +
      "<div style='max-width:520px'>" +
      "<label style='display:block;font-size:13px;font-weight:700;margin-bottom:4px'>" +
      escapeHtml(t("analyticsGa4Label")) +
      "</label>" +
      "<input type='text' id='analyticsGa4' placeholder='G-XXXXXXXXXX' autocomplete='off' spellcheck='false' style='width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px;font-family:monospace;box-sizing:border-box'>" +
      "<p class='categoryHint' style='margin:4px 0 16px'>" +
      escapeHtml(t("analyticsGa4Hint")) +
      "</p>" +
      "<label style='display:block;font-size:13px;font-weight:700;margin-bottom:4px'>" +
      escapeHtml(t("analyticsDescLabel")) +
      "</label>" +
      "<textarea id='analyticsDesc' rows='3' maxlength='500' style='width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px;resize:vertical;box-sizing:border-box'></textarea>" +
      "<p class='categoryHint' style='margin:4px 0 0'>" +
      escapeHtml(t("analyticsDescHint")) +
      "</p>" +
      "</div>";

    let cur: Dynamic = null;
    const saveBtn = byId("analyticsSaveBtn") as HTMLButtonElement | null;
    function setStatus(m: Dynamic) {
      const s = byId("analyticsStatus");
      if (s) s.textContent = m || "";
    }

    api("/api/settings")
      .then(function (d: Dynamic) {
        cur = (d && d.settings) || {};
        const ga = byId("analyticsGa4") as HTMLInputElement | null;
        const de = byId("analyticsDesc") as HTMLTextAreaElement | null;
        if (ga) ga.value = cur.ga4MeasurementId || "";
        if (de) de.value = cur.siteDescription || "";
        if (saveBtn) saveBtn.disabled = false;
      })
      .catch(function () {
        setStatus(t("apiFailed") || "Failed");
      });

    saveBtn?.addEventListener("click", function () {
      if (!cur) return;
      const ga = (
        (byId("analyticsGa4") as HTMLInputElement | null)?.value || ""
      ).trim();
      const de =
        (byId("analyticsDesc") as HTMLTextAreaElement | null)?.value || "";
      if (ga && !new RegExp("^G-[A-Z0-9]+$").test(ga)) {
        setStatus(t("analyticsGa4Invalid"));
        return;
      }
      if (saveBtn) saveBtn.disabled = true;
      setStatus(t("analyticsSaving"));
      // Echo every field the settings PUT validates so only GA4/description change.
      api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          siteName: cur.siteName,
          siteDescription: de,
          ga4MeasurementId: ga,
          publicDomain: cur.publicDomain || "",
          defaultLang: cur.defaultLang,
          initialLang: cur.defaultLang,
          enabledLanguages: cur.enabledLanguages || [cur.defaultLang],
          adminLogo: cur.adminLogo || "",
          themeAccent: cur.themeAccent,
          themeSidebar: cur.themeSidebar,
          themeMainPane: cur.themeMainPane,
          blueskyHandle: cur.blueskyHandle || "",
          blueskyShowFeed: cur.blueskyShowFeed,
          blueskyFeedPosition: cur.blueskyFeedPosition,
          blueskySid: cur.blueskySid || "",
          threadsHandle: cur.threadsHandle || "",
          threadsShowFeed: cur.threadsShowFeed,
        }),
      })
        .then(function () {
          cur.ga4MeasurementId = ga;
          cur.siteDescription = de;
          setStatus(t("analyticsSaved"));
        })
        .catch(function (e: Dynamic) {
          setStatus((e && e.message) || t("apiFailed") || "Failed");
        })
        .then(function () {
          if (saveBtn) saveBtn.disabled = false;
        });
    });
  }

  // Populate + save the site-name field. Saves through /api/settings by echoing
  // every validated field (so only site_name changes) — same approach as the
  // Analytics save, avoiding a partial PUT that would reset other settings.
  function bindSiteNameField(cur: Dynamic) {
    const input = byId("siteNameField") as HTMLInputElement | null;
    const status = byId("siteNameStatus");
    const btn = byId("siteNameSaveBtn") as Dynamic;
    if (input) input.value = cur.siteName || "";
    btn?.addEventListener("click", async function () {
      const v = (input?.value || "").trim();
      if (!v) {
        if (status) status.textContent = t("siteNameHelp");
        input?.focus();
        return;
      }
      if (btn) btn.disabled = true;
      if (status) status.textContent = t("analyticsSaving") || "";
      try {
        await api("/api/settings", {
          method: "PUT",
          body: JSON.stringify({
            siteName: v,
            publicDomain: cur.publicDomain || "",
            defaultLang: cur.defaultLang,
            initialLang: cur.defaultLang,
            enabledLanguages: cur.enabledLanguages || [cur.defaultLang],
            adminLogo: cur.adminLogo || "",
            themeAccent: cur.themeAccent,
            themeSidebar: cur.themeSidebar,
            themeMainPane: cur.themeMainPane,
            blueskyHandle: cur.blueskyHandle || "",
            blueskyShowFeed: cur.blueskyShowFeed,
            blueskyFeedPosition: cur.blueskyFeedPosition,
            blueskySid: cur.blueskySid || "",
            threadsHandle: cur.threadsHandle || "",
            threadsShowFeed: cur.threadsShowFeed,
          }),
        });
        cur.siteName = v;
        if (status) status.textContent = "";
        toast(t("siteSettingsSaved"), false, btn);
      } catch (err) {
        if (status) status.textContent = errorMessage(err);
        toast(errorMessage(err), true, btn);
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }

  function loadContentPanel(panel: Dynamic) {
    panel.innerHTML =
      // Site name (the browser-tab <title> / [[site.name]] source). Moved here
      // from the Settings screen so all site-content fields live together.
      "<div style='margin-bottom:18px;padding-bottom:18px;border-bottom:1px solid var(--line)'>" +
      "<div style='font-weight:700;margin-bottom:2px'>" +
      escapeHtml(t("siteName")) +
      "</div>" +
      "<p class='categoryHint' style='margin:0 0 8px'>" +
      escapeHtml(t("siteNameHelp")) +
      "</p>" +
      "<div style='display:flex;gap:8px;align-items:flex-start'>" +
      "<input id='siteNameField' style='flex:1;min-width:0' />" +
      "<button type='button' id='siteNameSaveBtn' style='flex-shrink:0'>" +
      escapeHtml(t("save")) +
      "</button>" +
      "</div>" +
      "<div id='siteNameStatus' class='muted' style='font-size:12px;margin-top:6px;min-height:1em'></div>" +
      "</div>" +
      "<div style='display:flex;align-items:flex-start;gap:12px;margin-bottom:8px'>" +
      "<div style='flex:1;min-width:0'>" +
      "<h3 style='margin:0 0 4px'>" +
      escapeHtml(t("contentEditorTitle")) +
      "</h3>" +
      "<p class='categoryHint' style='margin:0'>" +
      escapeHtml(t("contentEditorHint")) +
      "</p>" +
      "</div>" +
      "<button type='button' id='contentAddBtn' style='flex-shrink:0'>" +
      escapeHtml(t("contentAddBtn")) +
      "</button>" +
      "</div>" +
      "<div id='contentLangBar' style='display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px'></div>" +
      "<div id='contentList' class='emptyState'>" +
      escapeHtml(t("loading")) +
      "</div>";
    byId("contentAddBtn")?.addEventListener("click", function () {
      showContentDialog(null);
    });
    // Fetch settings (for defaultLang) and registered languages in parallel
    Promise.all([api("/api/settings"), api("/api/languages")])
      .then(function (results) {
        const defaultLang = results[0]?.settings?.defaultLang || "en";
        _contentDefaultLang = defaultLang;
        bindSiteNameField(results[0]?.settings || {});
        const langs = (results[1].languages || []).map(function (l: Dynamic) {
          return {
            code: l.lang,
            label: localeNames[l.lang] || l.displayName || l.lang,
          };
        });
        // Sort: default language first, rest alphabetically
        langs.sort(function (a: Dynamic, b: Dynamic) {
          if (a.code === defaultLang) return -1;
          if (b.code === defaultLang) return 1;
          return a.code.localeCompare(b.code);
        });
        // If active lang is unset OR the previously-selected lang no longer exists, reset to default
        const validCodes = langs.map(function (l: Dynamic) {
          return l.code;
        });
        if (!_contentActiveLang || !validCodes.includes(_contentActiveLang)) {
          _contentActiveLang =
            defaultLang || (langs.length > 0 ? langs[0].code : "");
        }
        const bar = byId("contentLangBar");
        if (!bar) return;
        if (!langs.length) {
          bar.style.display = "none";
          loadContentList();
          return;
        }
        function applyLangBarActive(bar: Dynamic) {
          bar.querySelectorAll("[data-clang]").forEach(function (b: Dynamic) {
            const bActive = b.dataset.clang === _contentActiveLang;
            const bIsDefault = b.dataset.clang === _contentDefaultLang;
            // active class controls opacity via .settingsTab.active — always apply it
            b.classList.toggle("active", bActive);
            // default language gets blue border + color to distinguish from others
            if (bIsDefault) {
              b.style.borderColor = "#2563eb";
              b.style.background = bActive ? "#2563eb" : "rgba(37,99,235,.08)";
              b.style.color = bActive ? "#fff" : "#2563eb";
            } else {
              b.style.borderColor = "";
              b.style.background = "";
              b.style.color = "";
            }
          });
        }
        bar.innerHTML = langs
          .map(function (tab: Dynamic) {
            const isDefault = tab.code === defaultLang;
            const label = isDefault
              ? t("contentBaseLang") + "：" + escapeHtml(tab.label)
              : escapeHtml(tab.label);
            return (
              "<button type='button' class='settingsTab' style='padding:5px 14px;font-size:13px' data-clang='" +
              escapeHtml(tab.code) +
              "'>" +
              label +
              "</button>"
            );
          })
          .join("");
        applyLangBarActive(bar);
        bar
          .querySelectorAll<AdminElement>("[data-clang]")
          .forEach(function (btn) {
            btn.addEventListener("click", function () {
              _contentActiveLang = btn.dataset.clang || "";
              applyLangBarActive(bar);
              loadContentList();
            });
          });
        loadContentList();
      })
      .catch(function () {
        loadContentList();
      });
  }

  function loadContentList() {
    const langParam = _contentActiveLang
      ? "?lang=" + encodeURIComponent(_contentActiveLang)
      : "";
    Promise.all([
      api("/api/v1/content" + langParam),
      api("/api/media/images").catch(() => ({ items: [] })),
      api("/api/media/videos").catch(() => ({ items: [] })),
      api("/api/media/audios").catch(() => ({ items: [] })),
    ])
      .then(function (results: Dynamic[]) {
        const d = results[0];
        // Set of valid media IDs (img_/vid_/aud_) to validate [[...]] refs against.
        const validMediaIds = new Set<string>();
        [results[1], results[2], results[3]].forEach(function (mr: Dynamic) {
          (mr.items || []).forEach(function (mi: Dynamic) {
            if (mi && mi.id) validMediaIds.add(mi.id);
          });
        });
        // Find single-token media refs that point to a non-existent media asset.
        // Single-bracket [[slug]] tokens in site text are media/lang/sns only
        // (data refs use ":", template bindings use ".") — so any [a-z0-9_-]+
        // token that is not lang / an SNS SID / a known media ID is a broken ref.
        const badMediaRefs = function (value: string): string[] {
          const out: string[] = [];
          const re = new RegExp("\\[\\[([a-z0-9_-]+)\\]\\]", "gi");
          let m: RegExpExecArray | null;
          while ((m = re.exec(value || "")) !== null) {
            const slug = m[1];
            if (slug === "lang") continue;
            if (/^sns-/i.test(slug)) continue;
            if (validMediaIds.has(slug)) continue;
            out.push("[[" + slug + "]]");
          }
          return out;
        };
        const list = byId("contentList");
        if (!list) return;
        const items = d.items || [];
        if (!items.length) {
          list.innerHTML =
            "<div class='emptyState'>" +
            escapeHtml(t("noneRegistered")) +
            "</div>";
          return;
        }
        list.innerHTML =
          "<div class='tableScroll'><table class='tableCompact'><thead><tr><th>" +
          escapeHtml(t("contentKeyLabel")) +
          "</th><th class='flexible'>" +
          escapeHtml(t("contentValueLabel")) +
          "</th><th>" +
          escapeHtml(t("contentUpdatedLabel")) +
          "</th><th></th></tr></thead><tbody>" +
          items
            .map(function (it: Dynamic) {
              const inherited = !!it.is_inherited;
              const preview = inherited
                ? ""
                : (it.name || "").length > 60
                  ? (it.name || "").slice(0, 60) + "…"
                  : it.name || "";
              // Untranslated (inherited) rows get a darker background so they
              // visually read as "not created yet for this language".
              const rowStyle = inherited ? "background:var(--surface-3)" : "";
              const badRefs = inherited ? [] : badMediaRefs(it.name || "");
              return (
                "<tr style='" +
                rowStyle +
                "'>" +
                "<td style='white-space:nowrap'><code>" +
                escapeHtml(it.id) +
                "</code>" +
                (it.is_system
                  ? " <span class='badge' style='font-size:10px'>" +
                    escapeHtml(t("contentSystemBadge")) +
                    "</span>"
                  : "") +
                (inherited
                  ? " <span class='badge' style='font-size:10px;background:var(--surface-3);color:var(--muted)'>" +
                    escapeHtml(t("contentNotTranslated")) +
                    "</span>"
                  : "") +
                "</td>" +
                "<td class='flexible' style='font-style:" +
                (inherited ? "italic" : "normal") +
                ";color:" +
                (inherited ? "var(--muted)" : "inherit") +
                "'>" +
                escapeHtml(inherited ? t("contentInheritedValue") : preview) +
                (badRefs.length
                  ? "<div class='mediaRefError'>" +
                    "<strong>&#9888; " +
                    escapeHtml(t("contentMediaNotFound")) +
                    "</strong>: <code>" +
                    escapeHtml(badRefs.join(" ")) +
                    "</code>" +
                    "<div class='mediaRefHint'>" +
                    escapeHtml(t("contentMediaRefHint")) +
                    "</div></div>"
                  : "") +
                "</td>" +
                "<td>" +
                (inherited ? "—" : escapeHtml(formatDateTime(it.updated_at))) +
                "</td>" +
                "<td><div class='rowActions'>" +
                "<button type='button' class='secondary small' data-content-edit='" +
                escapeHtml(it.id) +
                "'>" +
                (inherited ? "&#10133; " : "&#9998; ") +
                escapeHtml(inherited ? t("contentCreateBtn") : t("edit")) +
                "</button>" +
                "<button type='button' class='danger small' data-content-delete='" +
                escapeHtml(it.id) +
                "'>&#128465; " +
                escapeHtml(t("delete")) +
                "</button>" +
                "</div></td>" +
                "</tr>"
              );
            })
            .join("") +
          "</tbody></table></div>";
        list
          .querySelectorAll<AdminElement>("[data-content-edit]")
          .forEach(function (btn) {
            btn.addEventListener("click", function () {
              const item = items.find(function (i: Dynamic) {
                return i.id === btn.dataset.contentEdit;
              });
              showContentDialog(item);
            });
          });
        list
          .querySelectorAll<AdminElement>("[data-content-delete]")
          .forEach(function (btn) {
            btn.addEventListener("click", function () {
              openEntryDialog(
                t("deleteConfirmTitle"),
                "<p>" +
                  escapeHtml(t("contentDeleteConfirm")) +
                  "</p>" +
                  "<p style='font-size:12px;color:var(--danger);margin-top:6px'>" +
                  escapeHtml(t("contentDeleteAllLangsNote")) +
                  "</p>",
                t("delete"),
                async function (_: Dynamic, close: Dynamic) {
                  try {
                    await api("/api/v1/content/" + btn.dataset.contentDelete, {
                      method: "DELETE",
                    });
                    close();
                    loadContentList();
                  } catch (err) {
                    toast(errorMessage(err), true);
                  }
                },
              );
            });
          });
      })
      .catch(function (err) {
        const list = byId("contentList");
        if (list)
          list.innerHTML =
            "<div class='emptyState'>" +
            escapeHtml(errorMessage(err)) +
            "</div>";
      });
  }

  function showContentDialog(item: Dynamic) {
    const isEdit = !!item;
    if (!isEdit) {
      // ADD: key name only — value is filled per language tab after creation
      openEntryDialog(
        t("contentAddEditTitle"),
        "<div class='stack'>" +
          "<label>" +
          escapeHtml(t("contentKeyHint")) +
          "<input id='dlgCKey' placeholder='top-hero-title / about-body …' /></label>" +
          "<p style='font-size:12px;color:var(--muted);margin:0'>" +
          escapeHtml(t("contentAddKeyNote")) +
          "</p>" +
          "</div>",
        t("addRegister"),
        async function (form: Dynamic, close: Dynamic) {
          const key = form.querySelector("#dlgCKey")?.value.trim();
          if (!key) {
            toast(
              t("contentKeyRequired"),
              true,
              form.querySelector("#dlgCKey"),
            );
            return;
          }
          try {
            await api("/api/v1/content", {
              method: "POST",
              body: JSON.stringify({ id: key }),
            });
            close();
            loadContentList();
          } catch (err) {
            toast(errorMessage(err), true);
          }
        },
      );
      return;
    }
    // EDIT: value only for the active language — edited with KuroEditor.
    let dlgKe: Dynamic = null;
    const destroyDlgKe = () => {
      if (dlgKe) {
        try {
          dlgKe.destroy();
        } catch {
          /* editor already released */
        }
        dlgKe = null;
      }
    };
    openEntryDialog(
      t("contentEditTitle") + " — " + escapeHtml(item.id),
      "<div class='stack'>" +
        "<span style='font-size:12px;font-weight:700;color:var(--muted)'>" +
        escapeHtml(t("contentValueHint")) +
        "</span>" +
        "<textarea id='dlgCName' rows='6' placeholder='<h1>Title</h1>'>" +
        escapeHtml(item?.name || "") +
        "</textarea>" +
        "<div style='font-size:11px;color:var(--muted);background:var(--surface-2);border-radius:6px;padding:6px 10px;line-height:1.7'>" +
        t("contentMediaHint") +
        "</div>" +
        "</div>",
      t("update"),
      async function (form: Dynamic, close: Dynamic) {
        const name = dlgKe
          ? dlgKe.getContent()
          : form.querySelector("#dlgCName")?.value;
        if (name === undefined || name === null) return;
        try {
          await api(
            "/api/v1/content/" +
              item.id +
              "?lang=" +
              encodeURIComponent(_contentActiveLang),
            {
              method: "PUT",
              body: JSON.stringify({ name, lang: _contentActiveLang }),
            },
          );
          destroyDlgKe();
          close();
          loadContentList();
        } catch (err) {
          toast(errorMessage(err), true);
        }
      },
      destroyDlgKe, // onCancel: release the editor
    );
    // Mount KuroEditor on the value textarea — rich editing for EVERY content
    // key. The stored value keeps [[mid-xxx]] refs; expansion happens only at
    // build/render time (expandContentRefs), same path as the article body.
    const KE = adminWindow.KuroEditor;
    const ta = byId("dlgCName");
    if (KE && ta) {
      // Enlarge this dialog to near-fullscreen so KuroEditor's native top
      // toolbar is visible and the editing area scrolls (no modal/floating bar).
      ta.closest(".popupCard")?.classList.add("kuroDlg");
      const midUrlCache: Record<string, string> = {};
      dlgKe = new KE(ta, {
        // このダイアログは自前の保存/キャンセルボタンを持ち、KuroEditor の
        // 下部モーダルメニューも上部の保存 UI も不要 (onSave も渡していない)。
        // KuroEditor v2.3.0+ のホスト設定でどちらもマウント自体を止める。
        modalMenu: false,
        saveUi: false,
        // サイトテキスト編集も通常モードのキャンバスを実サイト配色に合わせる
        canvasColors: state.editorCanvasColors || undefined,
        // ダークモードもテンプレート配色から自動決定（記事エディタと同じ）
        canvasDark: editorCanvasDark(),
        urlResolver: function (slug: string) {
          return slug.startsWith("http") ? slug : midUrlCache[slug] || slug;
        },
        onMediaUpload: async function (file: File) {
          const fd = new FormData();
          const mime = file.type || "";
          if (mime.startsWith("image/")) {
            const prepared = await prepareImageForUpload(file);
            fd.append("file", prepared.file);
            fd.append("width", String(prepared.width));
            fd.append("height", String(prepared.height));
          } else {
            fd.append("file", file);
          }
          const endpoint = mime.startsWith("video/")
            ? "/api/media/videos/upload"
            : mime.startsWith("audio/")
              ? "/api/media/audios/upload"
              : "/api/media/images/upload";
          const resp = await fetch(withBase(endpoint), {
            method: "POST",
            headers: { Authorization: "Bearer " + state.token },
            body: fd,
          });
          const data = await resp.json();
          if (!resp.ok)
            throw new Error(
              data.error?.message ||
                data.error?.code ||
                (typeof data.error === "string" ? data.error : "") ||
                resp.statusText,
            );
          midUrlCache[data.mid] = publicBase + data.publicPath;
          return data.mid;
        },
      });
      // Fallback for a stale bundled KuroEditor (< v2.3.0, before the
      // modalMenu option): the old bundle ignores the option and still mounts
      // mmenu to document.body, so drop it here too. No-op on v2.3.0+.
      dlgKe.mmenu?.remove();
      const initial = item?.name || "";
      // Preload media → fill the URL cache → render so [[mid]] refs show images.
      Promise.all([
        api("/api/media/images").catch(() => ({ items: [] })),
        api("/api/media/videos").catch(() => ({ items: [] })),
        api("/api/media/audios").catch(() => ({ items: [] })),
      ])
        .then(function (results: Array<{ items?: Array<Dynamic> }>) {
          results.forEach(function (d) {
            (d.items || []).forEach(function (it: Dynamic) {
              if (it.id && it.publicPath)
                midUrlCache[it.id] = publicBase + it.publicPath;
            });
          });
          dlgKe.setContent(initial);
        })
        .catch(function () {
          dlgKe.setContent(initial);
        });
    }
  }

  // initial panel load
  const panel = byId("siteTabPanel");
  if (panel) loadTemplatesViewPanel(panel);
}
