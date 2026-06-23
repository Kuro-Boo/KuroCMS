// KuroCMS admin screen module. Concatenated by scripts/build-admin.js.

async function categories() {
  await taxonomyScreen("category");
}

async function languages() {
  shell(
    t("languageManager"),
    "<div class='panel stack'>" +
      "<div class='panelHead'><h3>" +
      escapeHtml(t("registeredLanguagesList")) +
      "</h3><div class='toolbar'><button type='button' id='languageAddButton'>" +
      escapeHtml(t("addRegister")) +
      "</button></div></div>" +
      "<div class='categoryHint'>" +
      escapeHtml(t("languageManagerLead")) +
      "</div>" +
      "<div id='selectedLanguageList' class='emptyState'>" +
      escapeHtml(t("loading")) +
      "</div>" +
      "</div>",
  );
  let registered: Dynamic[] = [];
  let availableLanguageChoices: Dynamic[] = [];

  function allLanguageOptions() {
    const commonLanguages = [
      { code: "en", label: "English" },
      { code: "ja", label: "日本語" },
      { code: "zh", label: "中文" },
      { code: "es", label: "Español" },
      { code: "fr", label: "Français" },
      { code: "de", label: "Deutsch" },
      { code: "it", label: "Italiano" },
      { code: "pt", label: "Português" },
      { code: "ru", label: "Русский" },
      { code: "ko", label: "한국어" },
      { code: "ar", label: "العربية" },
      { code: "hi", label: "हिन्दी" },
      { code: "bn", label: "বাংলা" },
      { code: "pa", label: "ਪੰਜਾਬੀ" },
      { code: "jv", label: "Basa Jawa" },
      { code: "ms", label: "Bahasa Melayu" },
      { code: "te", label: "తెలుగు" },
      { code: "vi", label: "Tiếng Việt" },
      { code: "mr", label: "मराठी" },
      { code: "ta", label: "தமிழ்" },
      { code: "ur", label: "اردو" },
      { code: "tr", label: "Türkçe" },
      { code: "gu", label: "ગુજરાતી" },
      { code: "pl", label: "Polski" },
      { code: "uk", label: "Українська" },
      { code: "kn", label: "ಕನ್ನಡ" },
      { code: "ml", label: "മലയാളം" },
      { code: "th", label: "ไทย" },
      { code: "az", label: "Azərbaycanca" },
      { code: "fa", label: "فارسی" },
    ];
    return commonLanguages.sort((a, b) => a.label.localeCompare(b.label));
  }

  function renderAvailableOptions() {
    const selectedCodes: Dynamic = new Set(registered.map((item) => item.lang));
    availableLanguageChoices = allLanguageOptions().filter(
      (entry) => !selectedCodes.has(entry.code),
    );
  }

  function usageText(usage: Dynamic) {
    const total =
      Number(usage.documents || 0) + Number(usage.searchEntries || 0);
    return (
      t("dataUsage") +
      ": doc=" +
      Number(usage.documents || 0) +
      ", search=" +
      Number(usage.searchEntries || 0) +
      " / total=" +
      total
    );
  }

  function renderRegistered() {
    const el = byId("selectedLanguageList");
    if (!el) return;
    if (!registered.length) {
      el.className = "emptyState";
      el.innerHTML = escapeHtml(t("noRegisteredLanguages"));
      return;
    }
    el.className = "tokenList";
    el.innerHTML = registered
      .map(
        (item) =>
          "<div class='tokenRow'><div><b>" +
          escapeHtml(
            (localeNames[item.lang] || item.displayName || item.lang) +
              " (" +
              item.lang +
              ")",
          ) +
          "</b><div class='tokenMeta'>" +
          escapeHtml(usageText(item.usage || {})) +
          "</div></div><button class='danger' data-remove-language='" +
          escapeHtml(item.lang) +
          "'>&#128465; " +
          escapeHtml(t("removeLanguage")) +
          "</button></div>",
      )
      .join("");
  }

  async function loadRegistered() {
    if (state.preview) {
      registered = [
        {
          lang: "en",
          displayName: "English",
          usage: { documents: 12, searchEntries: 12 },
        },
        {
          lang: "ja",
          displayName: "日本語",
          usage: { documents: 8, searchEntries: 8 },
        },
      ];
    } else {
      const data = await api("/api/languages");
      registered = data.languages || [];
    }
    renderAvailableOptions();
    renderRegistered();
  }

  // Language remove — delegated on the stable container
  byId("selectedLanguageList")!.addEventListener(
    "click",
    async (event: Dynamic) => {
      const button = event.target.closest("[data-remove-language]");
      if (!button) return;
      if (state.preview) {
        toast(t("previewReadOnly"), false, button);
        return;
      }
      const lang = button.dataset.removeLanguage;
      const row: Dynamic = registered.find((item) => item.lang === lang);
      const displayLabel = localeNames[lang] || row?.displayName || lang;
      const usage = row?.usage || {};
      const total =
        Number(usage.documents || 0) + Number(usage.searchEntries || 0);
      openEntryDialog(
        t("removeLanguage") + " — " + escapeHtml(displayLabel),
        "<p class='muted'>" +
          (total > 0
            ? escapeHtml(t("removeLanguageKeepPrompt"))
            : escapeHtml(t("removeLanguageConfirm"))) +
          "</p>" +
          (total > 0
            ? "<label class='checkRow'><input type='checkbox' id='dialogPurgeData' /> <span>" +
              escapeHtml(
                t("dataUsage") + ": " + total + " " + t("purgeDataSuffix"),
              ) +
              "</span></label>"
            : ""),
        t("delete"),
        async (form: Dynamic, close: Dynamic) => {
          const purgeData =
            total > 0 &&
            Boolean(form.querySelector("#dialogPurgeData")?.checked);
          try {
            await api(
              "/api/languages/" +
                encodeURIComponent(lang) +
                "?purgeData=" +
                (purgeData ? "1" : "0"),
              { method: "DELETE" },
            );
            close();
            toast(t("languageRemoved"), false, button);
            await loadRegistered();
          } catch (error) {
            toast(errorMessage(error), true, button);
          }
        },
      );
    },
  );

  byId("languageAddButton")!.addEventListener("click", () => {
    if (state.preview) {
      toast(t("previewReadOnly"));
      return;
    }
    const optionsHtml: Dynamic = availableLanguageChoices
      .map(
        (entry) =>
          "<option value='" +
          escapeHtml(entry.code) +
          "'>" +
          escapeHtml(entry.label + " (" + entry.code + ")") +
          "</option>",
      )
      .join("");
    if (!optionsHtml) {
      toast(t("noRegisteredLanguages"));
      return;
    }
    openEntryDialog(
      t("addLanguage"),
      "<label>" +
        escapeHtml(t("availableLanguages")) +
        "<select id='dialogLanguageCode'>" +
        optionsHtml +
        "</select></label>",
      t("addRegister"),
      async (form: Dynamic, close: Dynamic) => {
        const lang = requireDialogValue(
          form,
          "#dialogLanguageCode",
          "Language selector is missing.",
        );
        if (!lang) return;
        const entry = allLanguageOptions().find((item) => item.code === lang);
        const displayName = entry ? entry.label : lang;
        try {
          await api("/api/languages", {
            method: "POST",
            body: JSON.stringify({
              lang,
              displayName,
            }),
          });
          toast(t("languageAdded"));
          close();
          await loadRegistered();
        } catch (error) {
          toast(errorMessage(error), true);
        }
      },
    );
  });

  try {
    await loadRegistered();
  } catch (error) {
    toast(errorMessage(error), true);
  }
}

async function types() {
  await taxonomyScreen("type");
}

async function taxonomyScreen(kind: Dynamic) {
  const isType = kind === "type";
  const title = isType ? t("types") : t("categories");
  const listTitle = isType
    ? t("registeredTypesList")
    : t("registeredCategoriesList");
  const listId = isType ? "typeList" : "categoryList";
  shell(
    title,
    "<div class='panel stack'>" +
      "<div class='panelHead'><h3>" +
      escapeHtml(listTitle) +
      "</h3><div class='toolbar'><button type='button' id='taxonomyAddButton'>" +
      escapeHtml(t("addRegister")) +
      "</button></div></div>" +
      "<div id='" +
      listId +
      "' class='emptyState'>" +
      escapeHtml(t("loading")) +
      "</div>" +
      "</div>",
  );
  function openEditDialog(row: Dynamic) {
    return new Promise((resolve) => {
      openEntryDialog(
        t("edit") + " — " + escapeHtml(row.name),
        "<label>" +
          escapeHtml(t("name")) +
          "<input id='dialogTaxonomyEditName' value='" +
          escapeHtml(row.name || "") +
          "' /></label>" +
          "<label>" +
          escapeHtml(t("slug")) +
          "<input id='dialogTaxonomyEditSlug' value='" +
          escapeHtml(row.slug || "") +
          "'" +
          // Category slug == cid (stable key); not editable. Change the display
          // name instead. Types keep an editable slug.
          (isType ? "" : " readonly style='opacity:.55;cursor:not-allowed'") +
          " /></label>",
        t("update"),
        async (form: Dynamic, close: Dynamic) => {
          const name = requireDialogValue(
            form,
            "#dialogTaxonomyEditName",
            "Name input is missing.",
          );
          const slug = requireDialogValue(
            form,
            "#dialogTaxonomyEditSlug",
            "Slug input is missing.",
          );
          await api(
            (isType ? "/api/types/" : "/api/categories/") +
              encodeURIComponent(row.id),
            {
              method: "PUT",
              body: JSON.stringify({ name: name.trim(), slug: slug.trim() }),
            },
          );
          close();
          resolve(true);
        },
        () => resolve(false),
      );
    });
  }

  function removeRow(row: Dynamic) {
    return new Promise((resolve) => {
      openEntryDialog(
        t("delete") + " — " + escapeHtml(row.name),
        "<p class='muted'>" +
          escapeHtml(
            isType ? t("confirmDeleteType") : t("confirmDeleteCategory"),
          ) +
          "</p>" +
          "<p><b>" +
          escapeHtml(row.name) +
          "</b> <code>" +
          escapeHtml(row.slug) +
          "</code></p>",
        t("delete"),
        async (form: Dynamic, close: Dynamic) => {
          await api(
            (isType ? "/api/types/" : "/api/categories/") +
              encodeURIComponent(row.id),
            {
              method: "DELETE",
            },
          );
          close();
          resolve(true);
        },
        () => resolve(false),
      );
    });
  }

  function bindListActions() {
    const container = byId(listId);
    if (!container) return;
    container
      .querySelectorAll<AdminElement>("[data-taxonomy-action]")
      .forEach((button) => {
        button.addEventListener("click", async (event: Dynamic) => {
          event.preventDefault();
          const target = event.currentTarget;
          if (state.preview) {
            toast(t("previewReadOnly"), false, target);
            return;
          }
          const action = target.getAttribute("data-taxonomy-action");
          const id = target.getAttribute("data-taxonomy-id") || "";
          const name = target.getAttribute("data-taxonomy-name") || "";
          const slug = target.getAttribute("data-taxonomy-slug") || "";
          if (!id) return;
          try {
            const row = { id, name, slug };
            if (action === "edit") {
              const done = await openEditDialog(row);
              if (done) {
                toast(t("updateDone"), false, target);
                await load();
              }
            } else if (action === "delete") {
              const done = await removeRow(row);
              if (done) {
                toast(t("deleteDone"), false, target);
                await load();
              }
            }
          } catch (error) {
            toast(errorMessage(error), true, target);
          }
        });
      });
  }

  function setListHtml(html: Dynamic) {
    const el = byId(listId);
    if (el) el.innerHTML = html;
  }

  async function load() {
    if (state.preview) {
      setListHtml(
        renderTaxonomyTable(
          isType
            ? [
                { tid: "news", name: "News", slug: "news" },
                { tid: "blog", name: "Blog", slug: "blog" },
              ]
            : [
                { cid: "business", name: "Bussiness", slug: "business" },
                { cid: "hobby", name: "Hobby", slug: "hobby" },
                { cid: "sports", name: "Sports", slug: "sports" },
                { cid: "money", name: "Money", slug: "money" },
                { cid: "life", name: "Life", slug: "life" },
              ],
          isType,
        ),
      );
      bindListActions();
      return;
    }
    const data = await api(isType ? "/api/types" : "/api/categories");
    const rows = isType
      ? (data.types || []).filter(
          (r: Dynamic) => !r.source_type || r.source_type === "collection",
        )
      : data.categories || [];
    setListHtml(renderTaxonomyTable(rows, isType));
    bindListActions();
  }
  byId("taxonomyAddButton")!.addEventListener("click", async () => {
    if (state.preview) {
      toast(t("previewReadOnly"));
      return;
    }
    openEntryDialog(
      isType ? t("newType") : t("newCategory"),
      "<label>" +
        escapeHtml(t("name")) +
        "<input id='dialogTaxonomyName' placeholder='" +
        (isType ? "News" : "Business") +
        "' /></label>" +
        "<label>" +
        escapeHtml(t("slug")) +
        "<input id='dialogTaxonomySlug' placeholder='" +
        (isType ? "news" : "business") +
        "' /></label>",
      t("addRegister"),
      async (form: Dynamic, close: Dynamic) => {
        try {
          const body = {
            name: requireDialogValue(
              form,
              "#dialogTaxonomyName",
              "Name input is missing.",
            ),
            slug: requireDialogValue(
              form,
              "#dialogTaxonomySlug",
              "Slug input is missing.",
            ),
          };
          await api(isType ? "/api/types" : "/api/categories", {
            method: "POST",
            body: JSON.stringify(body),
          });
          toast(isType ? t("typeCreated") : t("categoryCreated"));
          close();
          await load();
        } catch (error) {
          toast(errorMessage(error), true);
        }
      },
    );
  });
  await load();
}

function renderTaxonomyTable(rows: Dynamic, isType: Dynamic) {
  if (!rows.length)
    return (
      "<div class='emptyState'>" +
      escapeHtml(isType ? t("types") : t("categories")) +
      "</div>"
    );
  return (
    "<div class='tableScroll'><table class='tableCompact'><thead><tr><th>" +
    escapeHtml(t("slug")) +
    "</th><th class='flexible'>" +
    escapeHtml(t("name")) +
    "</th>" +
    // Categories get a dedicated article-count column; types do not.
    (isType
      ? ""
      : "<th style='text-align:right'>" +
        escapeHtml(t("articleCountTitle")) +
        "</th>") +
    "<th style='text-align:right'>" +
    escapeHtml(t("actions")) +
    "</th></tr></thead><tbody>" +
    rows
      .map((row: Dynamic) => {
        const id = isType ? row.tid : row.cid;
        return (
          "<tr><td><code>" +
          escapeHtml(row.slug) +
          "</code></td><td class='flexible'>" +
          escapeHtml(row.name) +
          "</td>" +
          // Categories show their article count in its own column.
          (isType
            ? ""
            : "<td style='text-align:right'><span style='display:inline-flex;align-items:center;justify-content:center;min-width:30px;height:22px;padding:0 8px;border-radius:11px;background:var(--surface-2);border:1px solid var(--line);color:var(--muted);font-size:12px;font-weight:600' title='" +
              escapeHtml(t("articleCountTitle")) +
              "'>" +
              escapeHtml(String(row.articleCount ?? 0)) +
              "</span></td>") +
          "<td><div class='rowActions'>" +
          "<button class='secondary' data-taxonomy-action='edit' data-taxonomy-id='" +
          escapeHtml(id) +
          "' data-taxonomy-name='" +
          escapeHtml(row.name) +
          "' data-taxonomy-slug='" +
          escapeHtml(row.slug) +
          "'>&#9998; " +
          escapeHtml(t("edit")) +
          "</button><button class='danger' data-taxonomy-action='delete' data-taxonomy-id='" +
          escapeHtml(id) +
          "' data-taxonomy-name='" +
          escapeHtml(row.name) +
          "' data-taxonomy-slug='" +
          escapeHtml(row.slug) +
          "'>&#128465; " +
          escapeHtml(t("delete")) +
          "</button></div></td></tr>"
        );
      })
      .join("") +
    "</tbody></table></div>"
  );
}
