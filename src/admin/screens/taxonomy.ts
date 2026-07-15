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

  // Full ISO 639-1 set (~184 codes). `en` is the English name, kept purely as
  // a search alias (never displayed) so typing "burmese" finds "my" even
  // though its native label is "မြန်မာစာ".
  function allLanguageOptions() {
    const iso6391Languages = [
      { code: "aa", label: "Qafár af", en: "Afar" },
      { code: "ab", label: "аҧсуа бызшәа", en: "Abkhaz" },
      { code: "ae", label: "avesta", en: "Avestan" },
      { code: "af", label: "Afrikaans", en: "Afrikaans" },
      { code: "ak", label: "Akan", en: "Akan" },
      { code: "am", label: "አማርኛ", en: "Amharic" },
      { code: "an", label: "aragonés", en: "Aragonese" },
      { code: "ar", label: "العربية", en: "Arabic" },
      { code: "as", label: "অসমীয়া", en: "Assamese" },
      { code: "av", label: "авар мацӀ", en: "Avaric" },
      { code: "ay", label: "aymar aru", en: "Aymara" },
      { code: "az", label: "Azərbaycanca", en: "Azerbaijani" },
      { code: "ba", label: "башҡорт теле", en: "Bashkir" },
      { code: "be", label: "беларуская", en: "Belarusian" },
      { code: "bg", label: "български", en: "Bulgarian" },
      { code: "bh", label: "भोजपुरी", en: "Bihari" },
      { code: "bi", label: "Bislama", en: "Bislama" },
      { code: "bm", label: "bamanankan", en: "Bambara" },
      { code: "bn", label: "বাংলা", en: "Bengali" },
      { code: "bo", label: "བོད་ཡིག", en: "Tibetan" },
      { code: "br", label: "brezhoneg", en: "Breton" },
      { code: "bs", label: "bosanski", en: "Bosnian" },
      { code: "ca", label: "català", en: "Catalan" },
      { code: "ce", label: "нохчийн мотт", en: "Chechen" },
      { code: "ch", label: "Chamoru", en: "Chamorro" },
      { code: "co", label: "corsu", en: "Corsican" },
      { code: "cr", label: "ᓀᐦᐃᔭᐍᐏᐣ", en: "Cree" },
      { code: "cs", label: "čeština", en: "Czech" },
      { code: "cu", label: "ѩзыкъ словѣньскъ", en: "Church Slavic" },
      { code: "cv", label: "чӑваш чӗлхи", en: "Chuvash" },
      { code: "cy", label: "Cymraeg", en: "Welsh" },
      { code: "da", label: "dansk", en: "Danish" },
      { code: "de", label: "Deutsch", en: "German" },
      { code: "dv", label: "ދިވެހި", en: "Divehi" },
      { code: "dz", label: "རྫོང་ཁ", en: "Dzongkha" },
      { code: "ee", label: "Eʋegbe", en: "Ewe" },
      { code: "el", label: "Ελληνικά", en: "Greek" },
      { code: "en", label: "English", en: "English" },
      { code: "eo", label: "Esperanto", en: "Esperanto" },
      { code: "es", label: "Español", en: "Spanish" },
      { code: "et", label: "eesti", en: "Estonian" },
      { code: "eu", label: "euskara", en: "Basque" },
      { code: "fa", label: "فارسی", en: "Persian" },
      { code: "ff", label: "Fulfulde", en: "Fulah" },
      { code: "fi", label: "suomi", en: "Finnish" },
      { code: "fj", label: "vosa Vakaviti", en: "Fijian" },
      { code: "fo", label: "føroyskt", en: "Faroese" },
      { code: "fr", label: "Français", en: "French" },
      { code: "fy", label: "Frysk", en: "Western Frisian" },
      { code: "ga", label: "Gaeilge", en: "Irish" },
      { code: "gd", label: "Gàidhlig", en: "Scottish Gaelic" },
      { code: "gl", label: "galego", en: "Galician" },
      { code: "gn", label: "Avañe'ẽ", en: "Guarani" },
      { code: "gu", label: "ગુજરાતી", en: "Gujarati" },
      { code: "gv", label: "Gaelg", en: "Manx" },
      { code: "ha", label: "Hausa", en: "Hausa" },
      { code: "he", label: "עברית", en: "Hebrew" },
      { code: "hi", label: "हिन्दी", en: "Hindi" },
      { code: "ho", label: "Hiri Motu", en: "Hiri Motu" },
      { code: "hr", label: "hrvatski", en: "Croatian" },
      { code: "ht", label: "Kreyòl ayisyen", en: "Haitian Creole" },
      { code: "hu", label: "magyar", en: "Hungarian" },
      { code: "hy", label: "Հայերեն", en: "Armenian" },
      { code: "hz", label: "Otjiherero", en: "Herero" },
      { code: "ia", label: "Interlingua", en: "Interlingua" },
      { code: "id", label: "Bahasa Indonesia", en: "Indonesian" },
      { code: "ie", label: "Interlingue", en: "Interlingue" },
      { code: "ig", label: "Asụsụ Igbo", en: "Igbo" },
      { code: "ii", label: "ꆈꌠ꒿ Nuosuhxop", en: "Sichuan Yi" },
      { code: "ik", label: "Iñupiaq", en: "Inupiaq" },
      { code: "io", label: "Ido", en: "Ido" },
      { code: "is", label: "íslenska", en: "Icelandic" },
      { code: "it", label: "Italiano", en: "Italian" },
      { code: "iu", label: "ᐃᓄᒃᑎᑐᑦ", en: "Inuktitut" },
      { code: "ja", label: "日本語", en: "Japanese" },
      { code: "jv", label: "Basa Jawa", en: "Javanese" },
      { code: "ka", label: "ქართული", en: "Georgian" },
      { code: "kg", label: "Kikongo", en: "Kongo" },
      { code: "ki", label: "Gĩkũyũ", en: "Kikuyu" },
      { code: "kj", label: "Kuanyama", en: "Kwanyama" },
      { code: "kk", label: "қазақ тілі", en: "Kazakh" },
      { code: "kl", label: "kalaallisut", en: "Kalaallisut" },
      { code: "km", label: "ខ្មែរ", en: "Khmer" },
      { code: "kn", label: "ಕನ್ನಡ", en: "Kannada" },
      { code: "ko", label: "한국어", en: "Korean" },
      { code: "kr", label: "Kanuri", en: "Kanuri" },
      { code: "ks", label: "كٲشُر", en: "Kashmiri" },
      { code: "ku", label: "Kurdî", en: "Kurdish" },
      { code: "kv", label: "коми кыв", en: "Komi" },
      { code: "kw", label: "Kernewek", en: "Cornish" },
      { code: "ky", label: "Кыргызча", en: "Kyrgyz" },
      { code: "la", label: "Latina", en: "Latin" },
      { code: "lb", label: "Lëtzebuergesch", en: "Luxembourgish" },
      { code: "lg", label: "Luganda", en: "Ganda" },
      { code: "li", label: "Limburgs", en: "Limburgish" },
      { code: "ln", label: "Lingála", en: "Lingala" },
      { code: "lo", label: "ລາວ", en: "Lao" },
      { code: "lt", label: "lietuvių", en: "Lithuanian" },
      { code: "lu", label: "Kiluba", en: "Luba-Katanga" },
      { code: "lv", label: "latviešu", en: "Latvian" },
      { code: "mg", label: "Malagasy", en: "Malagasy" },
      { code: "mh", label: "Kajin M̧ajeļ", en: "Marshallese" },
      { code: "mi", label: "te reo Māori", en: "Maori" },
      { code: "mk", label: "македонски", en: "Macedonian" },
      { code: "ml", label: "മലയാളം", en: "Malayalam" },
      { code: "mn", label: "Монгол", en: "Mongolian" },
      { code: "mr", label: "मराठी", en: "Marathi" },
      { code: "ms", label: "Bahasa Melayu", en: "Malay" },
      { code: "mt", label: "Malti", en: "Maltese" },
      { code: "my", label: "မြန်မာစာ", en: "Burmese" },
      { code: "na", label: "Dorerin Naoero", en: "Nauru" },
      { code: "nb", label: "Norsk Bokmål", en: "Norwegian Bokmål" },
      { code: "nd", label: "isiNdebele (North)", en: "North Ndebele" },
      { code: "ne", label: "नेपाली", en: "Nepali" },
      { code: "ng", label: "Owambo", en: "Ndonga" },
      { code: "nl", label: "Nederlands", en: "Dutch" },
      { code: "nn", label: "Norsk Nynorsk", en: "Norwegian Nynorsk" },
      { code: "no", label: "Norsk", en: "Norwegian" },
      { code: "nr", label: "isiNdebele (South)", en: "South Ndebele" },
      { code: "nv", label: "Diné bizaad", en: "Navajo" },
      { code: "ny", label: "Chichewa", en: "Chichewa" },
      { code: "oc", label: "occitan", en: "Occitan" },
      { code: "oj", label: "ᐊᓂᔑᓈᐯᒧᐎᓐ", en: "Ojibwe" },
      { code: "om", label: "Afaan Oromoo", en: "Oromo" },
      { code: "or", label: "ଓଡ଼ିଆ", en: "Odia" },
      { code: "os", label: "ирон æвзаг", en: "Ossetian" },
      { code: "pa", label: "ਪੰਜਾਬੀ", en: "Punjabi" },
      { code: "pi", label: "पाऴि", en: "Pali" },
      { code: "pl", label: "polski", en: "Polish" },
      { code: "ps", label: "پښتو", en: "Pashto" },
      { code: "pt", label: "Português", en: "Portuguese" },
      { code: "qu", label: "Runa Simi", en: "Quechua" },
      { code: "rm", label: "rumantsch", en: "Romansh" },
      { code: "rn", label: "Ikirundi", en: "Kirundi" },
      { code: "ro", label: "română", en: "Romanian" },
      { code: "ru", label: "Русский", en: "Russian" },
      { code: "rw", label: "Ikinyarwanda", en: "Kinyarwanda" },
      { code: "sa", label: "संस्कृतम्", en: "Sanskrit" },
      { code: "sc", label: "sardu", en: "Sardinian" },
      { code: "sd", label: "سنڌي", en: "Sindhi" },
      { code: "se", label: "Davvisámegiella", en: "Northern Sami" },
      { code: "sg", label: "Sängö", en: "Sango" },
      { code: "si", label: "සිංහල", en: "Sinhala" },
      { code: "sk", label: "slovenčina", en: "Slovak" },
      { code: "sl", label: "slovenščina", en: "Slovenian" },
      { code: "sm", label: "gagana fa'a Samoa", en: "Samoan" },
      { code: "sn", label: "chiShona", en: "Shona" },
      { code: "so", label: "Soomaaliga", en: "Somali" },
      { code: "sq", label: "Shqip", en: "Albanian" },
      { code: "sr", label: "српски", en: "Serbian" },
      { code: "ss", label: "SiSwati", en: "Swati" },
      { code: "st", label: "Sesotho", en: "Southern Sotho" },
      { code: "su", label: "Basa Sunda", en: "Sundanese" },
      { code: "sv", label: "svenska", en: "Swedish" },
      { code: "sw", label: "Kiswahili", en: "Swahili" },
      { code: "ta", label: "தமிழ்", en: "Tamil" },
      { code: "te", label: "తెలుగు", en: "Telugu" },
      { code: "tg", label: "тоҷикӣ", en: "Tajik" },
      { code: "th", label: "ไทย", en: "Thai" },
      { code: "ti", label: "ትግርኛ", en: "Tigrinya" },
      { code: "tk", label: "Türkmen", en: "Turkmen" },
      { code: "tl", label: "Tagalog", en: "Tagalog" },
      { code: "tn", label: "Setswana", en: "Tswana" },
      { code: "to", label: "faka Tonga", en: "Tongan" },
      { code: "tr", label: "Türkçe", en: "Turkish" },
      { code: "ts", label: "Xitsonga", en: "Tsonga" },
      { code: "tt", label: "татар теле", en: "Tatar" },
      { code: "tw", label: "Twi", en: "Twi" },
      { code: "ty", label: "Reo Tahiti", en: "Tahitian" },
      { code: "ug", label: "ئۇيغۇرچە", en: "Uyghur" },
      { code: "uk", label: "Українська", en: "Ukrainian" },
      { code: "ur", label: "اردو", en: "Urdu" },
      { code: "uz", label: "Oʻzbek", en: "Uzbek" },
      { code: "ve", label: "Tshivenḓa", en: "Venda" },
      { code: "vi", label: "Tiếng Việt", en: "Vietnamese" },
      { code: "vo", label: "Volapük", en: "Volapük" },
      { code: "wa", label: "walon", en: "Walloon" },
      { code: "wo", label: "Wolof", en: "Wolof" },
      { code: "xh", label: "isiXhosa", en: "Xhosa" },
      { code: "yi", label: "ייִדיש", en: "Yiddish" },
      { code: "yo", label: "Yorùbá", en: "Yoruba" },
      { code: "za", label: "Vahcuengh", en: "Zhuang" },
      { code: "zh", label: "中文", en: "Chinese" },
      { code: "zu", label: "isiZulu", en: "Zulu" },
    ];
    // Localized language names in the admin UI language (e.g. ja: ar →
    // "アラビア語") via the browser's Intl.DisplayNames — searching by the
    // admin language ("アラビア") found nothing when only the native label
    // (العربية) / English name / code were matchable, so Arabic etc. looked
    // missing from the picker. Shown in the row and matched by the search.
    let displayNames: Dynamic = null;
    try {
      displayNames = new (Intl as Dynamic).DisplayNames(
        [state.uiLang || "en"],
        { type: "language" },
      );
    } catch {
      /* Intl.DisplayNames unsupported — search still matches native/en/code */
    }
    const withLocal = iso6391Languages.map((entry) => {
      let local = "";
      try {
        local = displayNames ? displayNames.of(entry.code) || "" : "";
      } catch {
        /* unknown code in this browser — keep empty */
      }
      // DisplayNames returns the code itself for unknown languages; and a
      // local name identical to the native label adds nothing to the row.
      if (local === entry.code || local === entry.label) local = "";
      return { ...entry, local };
    });
    return withLocal.sort((a, b) => a.label.localeCompare(b.label));
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

  // Renders the filtered result rows for the search-as-you-type language
  // picker below. `selectedCode` highlights the currently chosen row (kept
  // visible even if the query no longer matches it, so re-filtering doesn't
  // silently drop the selection).
  function renderLangPickerResults(query: Dynamic, selectedCode: Dynamic) {
    const list = byId("dialogLanguageResults");
    if (!list) return;
    const q = String(query || "")
      .trim()
      .toLowerCase();
    // entry.code === selectedCode always matches: once a row is picked, the
    // search box is filled with "label (code)" for confirmation, which
    // wouldn't match its own label/code substrings — without this the list
    // would flash "no matches" right after a successful selection.
    const matches = !q
      ? availableLanguageChoices
      : availableLanguageChoices.filter(
          (entry: Dynamic) =>
            entry.code === selectedCode ||
            entry.label.toLowerCase().includes(q) ||
            entry.en.toLowerCase().includes(q) ||
            (entry.local || "").toLowerCase().includes(q) ||
            entry.code.toLowerCase().includes(q),
        );
    if (!matches.length) {
      list.innerHTML =
        "<div class='langPickerEmpty'>" + escapeHtml(t("noMatches")) + "</div>";
      return;
    }
    list.innerHTML = matches
      .map(
        (entry: Dynamic) =>
          "<div class='langPickerRow" +
          (entry.code === selectedCode ? " selected" : "") +
          "' data-lang-code='" +
          escapeHtml(entry.code) +
          "'>" +
          escapeHtml(
            entry.label +
              " (" +
              entry.code +
              ")" +
              (entry.local ? " — " + entry.local : ""),
          ) +
          "</div>",
      )
      .join("");
  }

  byId("languageAddButton")!.addEventListener("click", () => {
    if (state.preview) {
      toast(t("previewReadOnly"));
      return;
    }
    if (!availableLanguageChoices.length) {
      toast(t("noRegisteredLanguages"));
      return;
    }
    let selectedCode = "";
    openEntryDialog(
      t("addLanguage"),
      "<label>" +
        escapeHtml(t("availableLanguages")) +
        "<input type='text' id='dialogLanguageSearch' placeholder='" +
        escapeHtml(t("searchLanguagePlaceholder")) +
        "' autocomplete='off' /></label>" +
        "<input type='hidden' id='dialogLanguageCode' />" +
        "<div id='dialogLanguageResults' class='langPickerResults'></div>",
      t("addRegister"),
      async (form: Dynamic, close: Dynamic) => {
        try {
          const lang = requireDialogValue(
            form,
            "#dialogLanguageCode",
            t("selectLangMsg"),
          );
          const entry = allLanguageOptions().find((item) => item.code === lang);
          const displayName = entry ? entry.label : lang;
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
    renderLangPickerResults("", selectedCode);
    const searchInput = byId("dialogLanguageSearch") as Dynamic;
    const codeInput = byId("dialogLanguageCode") as Dynamic;
    searchInput?.addEventListener("input", () => {
      renderLangPickerResults(searchInput.value, selectedCode);
    });
    byId("dialogLanguageResults")!.addEventListener(
      "click",
      (event: Dynamic) => {
        const row = event.target.closest("[data-lang-code]");
        if (!row) return;
        selectedCode = row.getAttribute("data-lang-code");
        if (codeInput) codeInput.value = selectedCode;
        const entry = availableLanguageChoices.find(
          (item: Dynamic) => item.code === selectedCode,
        );
        if (searchInput && entry)
          searchInput.value = entry.label + " (" + entry.code + ")";
        renderLangPickerResults(searchInput?.value, selectedCode);
      },
    );
    searchInput?.focus();
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
