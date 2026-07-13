// KuroCMS admin screen module. Concatenated by scripts/build-admin.js.

// The most recently mounted article editor's state (or null). Read by
// hasUnsavedArticleEdits() so a background auto-reload can defer while the user
// has unsaved edits open. Concatenated build → this is a shared global.
let activeArticleState: Dynamic = null;

// True only when an article editor is on screen AND has unsaved changes. The
// route check guards against a stale activeArticleState after the user has
// navigated away from a dirty editor without it being cleared.
function hasUnsavedArticleEdits(): boolean {
  return !!(
    activeArticleState &&
    activeArticleState.dirty &&
    routePath().indexOf("/articles/") === 0
  );
}

function padDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

function localDateInputValue(date: Date): string {
  return (
    date.getFullYear() +
    "-" +
    padDatePart(date.getMonth() + 1) +
    "-" +
    padDatePart(date.getDate())
  );
}

function localTimeInputValue(date: Date): string {
  return padDatePart(date.getHours()) + ":" + padDatePart(date.getMinutes());
}

function localDateTimeInputToIso(dateValue: string, timeValue: string): string {
  if (!dateValue) return new Date().toISOString();
  const parts = dateValue.split("-").map(function (part) {
    return parseInt(part, 10);
  });
  if (
    parts.length !== 3 ||
    parts.some(function (part) {
      return !Number.isFinite(part);
    })
  )
    return new Date().toISOString();
  const timeParts = (timeValue || "00:00").split(":").map(function (part) {
    return parseInt(part, 10);
  });
  const local = new Date(
    parts[0],
    parts[1] - 1,
    parts[2],
    Number.isFinite(timeParts[0]) ? timeParts[0] : 0,
    Number.isFinite(timeParts[1]) ? timeParts[1] : 0,
    0,
    0,
  );
  return local.toISOString();
}

// SHA-256 hex of a string — must produce the same digest as the server's
// sha256Hex (src/crypto.ts) because it feeds the translations PUT
// baseBodyHash optimistic lock.
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map(function (b) {
      return b.toString(16).padStart(2, "0");
    })
    .join("");
}

function destroyArticleEditor() {
  if (state.articleEditor) {
    try {
      state.articleEditor.destroy();
    } catch {
      // The editor may already have released its DOM resources.
    }
    state.articleEditor = null;
  }
}

// Cross-call stash for re-loading the editor at a specific language (the
// language switcher / "create translation" flow re-enters newArticle for the
// same did but a different lang, optionally pre-filling from the base language).
let pendingArticleLoad: Dynamic = null;

// Auto-recovery from a transient broken editor load — typically a stale asset
// bundle when a tab was open across a deploy (the cached shell references an
// asset hash that no longer exists, so KuroEditor / init fails). Reload ONCE to
// fetch the fresh shell + bundles. A sessionStorage guard prevents an infinite
// reload loop on a genuinely persistent failure (after 1 retry we give up and
// surface the error instead). The guard is cleared on any successful load.
const EDITOR_RELOAD_GUARD = "kurocms_editor_reload";
function editorAutoRecover(): boolean {
  let tries: number;
  try {
    tries =
      parseInt(sessionStorage.getItem(EDITOR_RELOAD_GUARD) || "0", 10) || 0;
  } catch {
    return false; // storage unavailable → can't guard → don't risk a reload loop
  }
  if (tries >= 1) return false; // already retried once — don't loop
  try {
    sessionStorage.setItem(EDITOR_RELOAD_GUARD, String(tries + 1));
  } catch {
    return false; // couldn't persist the guard → don't reload (avoid loop)
  }
  location.reload();
  return true;
}
function clearEditorReloadGuard() {
  try {
    sessionStorage.removeItem(EDITOR_RELOAD_GUARD);
  } catch {
    /* ignore */
  }
}

async function newArticle(editDid: Dynamic) {
  destroyArticleEditor();
  // The article-list build bar (#artsBuildBar) is appended to <body>, so it can
  // linger over the editor when navigating list → editor (the editor doesn't go
  // through shell(), which is what removes it elsewhere). Build belongs only on
  // the article-management screen, so drop it here.
  document.getElementById("artsBuildBar")?.remove();
  setSidebarMode("normal");
  setActiveNav();
  // Edit mode fetches the document below, which can take ~2s. Render a spinner
  // into the workspace immediately so the list → editor transition shows it is
  // loading instead of leaving the previous screen on screen (looks frozen).
  if (editDid) {
    app.innerHTML =
      "<div class='initialLoader'><div class='initialLoaderSpinner'></div>" +
      "<div class='initialLoaderLabel'>" +
      escapeHtml(t("articleLoading")) +
      "</div></div>";
  }
  // Consume any pending language-switch request for this (re)load.
  const pending = pendingArticleLoad;
  pendingArticleLoad = null;

  const now = new Date();
  now.setSeconds(0, 0);
  const art: Dynamic = {
    did: null,
    mode: 0,
    tid: "",
    slug: "",
    lang: "",
    initialLang: "", // the document's base language (initial_lang)
    existingLangs: [], // languages this document already has a translation in
    pubDate: localDateInputValue(now),
    pubTime: localTimeInputValue(now),
    categories: [],
    hashtag: "",
    coverMid: "",
    coverPath: "",
    // ?v=cache_version 付きのプレビュー用URLパス（セッション内のみ、保存しない）。
    // 素の coverPath は immutable キャッシュに対して無防備なため、分かる場合は
    // こちらを優先して表示する。
    coverVersionedPath: "",
    title: "",
    summary: "",
    body: "",
    dirty: false,
    // dirty is the OR of these two. Split so the periodic autosave can persist
    // metadata without touching the body: the body is saved only when it was
    // edited HERE (bodyDirty), never as a side effect — otherwise a stale local
    // copy would overwrite body edits made by other clients (e.g. AI via
    // REST/MCP) while the article is open.
    bodyDirty: false,
    metaDirty: false,
    // True once a translation row for art.lang exists server-side. The first
    // save of a language must include the body (the API requires it on create).
    hasTranslation: false,
    // body_html as loaded from (or last saved to) the server — the optimistic-
    // lock base for body-including saves. null = nothing loaded/saved yet.
    baseBody: null,
    saving: false,
    // Autosave is gated on `ready`: it stays false from (re)load start until the
    // editor is fully mounted AND the language's content is on screen. While a
    // language switch is in flight `switching` blocks any save outright. Together
    // they stop a pending/periodic autosave from writing the wrong language's (or
    // half-loaded) body during the switch — the critical data-loss bug.
    ready: false,
    switching: false,
  };
  // Expose this editor's state so the version auto-reloader (admin.main) can
  // tell whether it would clobber unsaved article edits. Only meaningful while
  // an article route is on screen — hasUnsavedArticleEdits() re-checks that.
  activeArticleState = art;
  // Map of lang code → display name, filled when the language list loads.
  const langNames: Record<string, string> = {};
  function langLabel(code: Dynamic) {
    return langNames[code] || code;
  }

  // Edit mode: load existing document
  if (editDid) {
    try {
      const docData = await api("/api/documents/" + editDid);
      const doc = docData.document;
      if (!doc) {
        toast(t("articleNotFound"), true);
        return articles();
      }
      const pubDt = doc.publish_at ? new Date(doc.publish_at) : now;
      art.did = doc.did;
      art.mode = doc.mode || 0;
      art.tid = doc.tid || "";
      art.slug = doc.slug || "";
      art.initialLang = doc.initial_lang || "";
      art.pubDate = localDateInputValue(pubDt);
      art.pubTime = localTimeInputValue(pubDt);
      const translations = docData.translations || [];
      art.existingLangs = translations
        .map(function (tr: Dynamic) {
          return tr.lang;
        })
        .filter(Boolean);
      // Which language to open: an explicit switch target, else the BASE
      // language (initial_lang), else the first existing translation.
      art.lang =
        (pending && pending.lang) ||
        doc.initial_lang ||
        (translations[0] && translations[0].lang) ||
        "";

      if (pending && pending.prefill) {
        // Creating a NEW translation: seed from the base-language copy (or blank
        // when the user unchecked "copy from base"). Marked dirty so autosave
        // persists it as a new translation row.
        const pf = pending.prefill;
        art.title = pf.title || "";
        art.summary = pf.summary || "";
        art.body = pf.body || "";
        art.hashtag = pf.hashtag || "";
        art.coverMid = pf.coverMid || "";
        art.coverPath = pf.coverPath || "";
        art.coverVersionedPath = "";
        art.dirty = true;
        art.bodyDirty = true;
        art.metaDirty = true;
      } else if (art.lang) {
        // Load the chosen language's translation (blank if it doesn't exist yet).
        const tData = await api(
          "/api/documents/" + editDid + "/translations/" + art.lang,
        ).catch(function () {
          return null;
        });
        if (tData && tData.translation) {
          art.title = tData.translation.title || "";
          art.summary = tData.translation.summary || "";
          art.body = tData.translation.body_html || "";
          art.hasTranslation = true;
          art.baseBody = art.body;
          try {
            const hj = JSON.parse(tData.translation.hashtag_json || "[]");
            art.hashtag = Array.isArray(hj)
              ? hj
                  .map(function (h) {
                    return "#" + h;
                  })
                  .join(" ")
              : "";
          } catch {
            art.hashtag = "";
          }
          try {
            const sj = JSON.parse(tData.translation.seo_json || "{}");
            if (sj.coverMid) {
              art.coverMid = sj.coverMid;
              art.coverPath = sj.coverPath || "";
              art.coverVersionedPath = "";
            }
          } catch {
            /* ignore */
          }
        }
      }
      // Load categories
      const catData = await api(
        "/api/documents/" + editDid + "/categories",
      ).catch(function () {
        return null;
      });
      if (catData && Array.isArray(catData.categories))
        art.categories = catData.categories;
    } catch (err) {
      toast(t("articleLoadFailed") + errorMessage(err), true);
    }
  }
  let allCategories: Dynamic[] = [];
  let autoSaveTimer: Dynamic = null;
  // Autosave debounce / KuroEditor periodic-autosave interval. The right value
  // differs per app; the article editor uses ~10s and passes the same value to
  // KuroEditor's built-in autosave so the two stay aligned.
  const AUTOSAVE_INTERVAL_MS = 10000;
  // Monotonically tracks edits so a save that started earlier cannot clear a
  // newer category/text edit when its requests finish.
  let editRevision = 0;
  let r2Ok = true;

  // Auto-save on/off. KuroCMS now owns autosaving entirely: KuroEditor's built-in
  // save button + autosave checkbox are disabled (saveUi:false), so the bottom
  // bar carries our own checkbox. Persisted; reuses KuroEditor's legacy pref key
  // so an existing preference carries over. Defaults to ON.
  const AUTOSAVE_PREF_KEY = "kuro-editor-autosave";
  function autoSaveEnabled(): boolean {
    try {
      return localStorage.getItem(AUTOSAVE_PREF_KEY) !== "0";
    } catch {
      return true; // storage disabled → keep the default (on)
    }
  }
  function setAutoSaveEnabled(on: boolean) {
    try {
      localStorage.setItem(AUTOSAVE_PREF_KEY, on ? "1" : "0");
    } catch {
      /* storage unavailable — the preference just won't persist */
    }
  }
  // (Re)arm the periodic autosave, but only while it is enabled. The tick saves
  // metadata AND the body (the body only when it was edited here — see doSave()).
  function scheduleAutoSave() {
    clearTimeout(autoSaveTimer);
    if (!autoSaveEnabled()) return;
    autoSaveTimer = setTimeout(autoSaveTick, AUTOSAVE_INTERVAL_MS);
  }

  function renderCatTags() {
    const wrap = byId("arCatTags");
    if (!wrap) return;
    wrap.innerHTML = art.categories
      .map(function (cid: Dynamic) {
        const cat: Dynamic = allCategories.find(function (c) {
          return c.cid === cid;
        });
        const name = cat ? cat.name || cid : cid;
        return (
          "<span class='catTag'>" +
          escapeHtml(name) +
          "<button type='button' data-remove-cat='" +
          escapeHtml(cid) +
          "'>&#215;</button></span>"
        );
      })
      .join("");
    wrap
      .querySelectorAll<AdminElement>("[data-remove-cat]")
      .forEach(function (btn) {
        btn.addEventListener("click", function () {
          art.categories = art.categories.filter(function (c: Dynamic) {
            return c !== btn.dataset.removeCat;
          });
          markDirty();
          renderCatTags();
        });
      });
  }

  function setSaveStatus(msg: Dynamic, cls = "") {
    const el = byId("arSaveStatus");
    if (el) {
      el.textContent = msg;
      el.className = "autoSaveStatus" + (cls ? " " + cls : "");
    }
  }

  // Save buttons are enabled only while there are unsaved edits (and not mid-
  // save) — after a save they dim out until the next edit. Called after every
  // render and on every dirty/save state change.
  function updateSaveButtons() {
    const btn = byId("arSaveBtn") as Dynamic;
    if (btn) btn.disabled = !art.dirty || art.saving;
  }

  function readFields() {
    art.tid = byId("arType")?.value || "";
    art.slug = (byId("arSlug")?.value || "").trim();
    // CRITICAL: do NOT read art.lang from the #arLang select here. That select is
    // a language SWITCHER — its value flips to the target the instant the user
    // picks it, BEFORE the editor content is reloaded for that language. Reading
    // it during a save (the switch's own save, or a pending autosave) would write
    // the CURRENT (old-language) body under the newly-selected language and
    // overwrite that translation. art.lang is owned by the load flow (newArticle)
    // and always reflects the language of the content currently in the editor.
    art.pubDate = byId("arPubDate")?.value || "";
    art.pubTime = byId("arPubTime")?.value || "";
    art.hashtag = byId("arHashtag")?.value || "";
    // coverMid stays in art.coverMid (set by picker, not a form field)
    art.title = byId("arTitle")?.value || "";
    art.summary = byId("arSummary")?.value || "";
    art.body = state.articleEditor
      ? state.articleEditor.getContent()
      : byId("arBody")?.value || "";
  }

  // includeBody:
  //   undefined → include the body only when it was edited here (art.bodyDirty).
  //               This is what every explicit save path uses, so an untouched
  //               local body can never overwrite server-side (AI) body edits.
  //   false     → metadata-only (the periodic autosave).
  //   true      → force body inclusion (the conflict-overwrite retry).
  // Creating a translation always includes the body (the API requires it).
  async function doSave(includeBody?: boolean) {
    // Never autosave while a switch is in flight or before the editor has fully
    // loaded the current language's content (would persist the wrong language /
    // a half-loaded body). Explicit saves go through here too and are correctly
    // blocked during a switch — switchToLanguage saves BEFORE setting `switching`.
    if (art.saving || art.switching || !art.ready) return;
    readFields();
    const withBody = (includeBody ?? art.bodyDirty) || !art.hasTranslation;
    if (!art.tid) {
      setSaveStatus(t("typeNotSelectedErr"), "err");
      toast(t("selectTypeMsg"), true, byId("arType"));
      return;
    }
    if (!art.slug) {
      setSaveStatus(t("slugEmptyErr"), "err");
      toast(t("enterSlugMsg"), true, byId("arSlug"));
      return;
    }
    if (!art.lang) {
      setSaveStatus(t("langNotSelectedErr"), "err");
      toast(t("selectLangMsg"), true, byId("arLang"));
      return;
    }
    if (!art.title) {
      setSaveStatus(t("titleEmptyErr"), "err");
      toast(t("enterTitleMsg"), true, byId("arTitle"));
      return;
    }
    const saveRevision = editRevision;
    art.saving = true;
    updateSaveButtons();
    setSaveStatus(t("saveStatusSaving"));
    try {
      const publishAt = localDateTimeInputToIso(art.pubDate, art.pubTime);
      // docChanged (with translationChanged below) decides whether the LAST
      // request of this save (the categories PUT) needs to fire a rebuild —
      // see the deferBuild comments server-side (documentDetail/
      // documentTranslations/documentCategories in api.ts). Only the last
      // request builds: this save issues up to three PUTs back to back, and
      // letting each one fire its own immediate build races them against each
      // other (whichever finishes LAST wins in KV, with no guarantee that's
      // the one with the freshest data) — that race could make a just-dropped
      // cover image revert to the old one.
      let docChanged = false;
      if (!art.did) {
        const res = await api("/api/documents", {
          method: "POST",
          body: JSON.stringify({
            tid: art.tid,
            slug: art.slug,
            initialLang: art.lang,
            publishAt,
          }),
        });
        art.did = res.did;
        docChanged = true;
      } else {
        // tid included: the type is changeable on existing articles (draft
        // mode). Server-side it is validated, mirrored to search_entries, and
        // the old type's public pages are cleaned up when it changes.
        const docRes = await api("/api/documents/" + art.did, {
          method: "PUT",
          body: JSON.stringify({
            mode: art.mode,
            publishAt,
            tid: art.tid,
            deferBuild: true,
          }),
        });
        docChanged = docRes.changed !== false;
      }
      const hashtags = art.hashtag
        .split(" ")
        .map(function (h: Dynamic) {
          return h.trim().replace(/^#/, "");
        })
        .filter(Boolean);
      const seo = art.coverMid
        ? { coverMid: art.coverMid, coverPath: art.coverPath }
        : {};
      const payload: Dynamic = {
        title: art.title,
        summary: art.summary,
        hashtags,
        seo,
        deferBuild: true,
      };
      if (withBody) {
        payload.bodyHtml = art.body || "<p></p>";
        // Optimistic lock: hash of the body we loaded / last saved. The server
        // 409s when someone else (e.g. an AI client) changed the body since.
        // baseBody === null means either a fresh translation (nothing to
        // protect) or an explicit overwrite after a conflict prompt.
        if (art.hasTranslation && art.baseBody !== null) {
          payload.baseBodyHash = await sha256Hex(art.baseBody);
        }
      }
      const translationRes = await api(
        "/api/documents/" + art.did + "/translations/" + art.lang,
        { method: "PUT", body: JSON.stringify(payload) },
      );
      const translationChanged = translationRes.changed !== false;
      // categories PUT is the LAST request of this save — it fires the one
      // consolidated build (see the top-of-function comment) once mode/
      // translations are already committed. metaChanged tells it to build
      // even when the category assignment itself didn't change.
      await api("/api/documents/" + art.did + "/categories", {
        method: "PUT",
        body: JSON.stringify({
          categories: art.categories,
          metaChanged: docChanged || translationChanged,
        }),
      });
      art.hasTranslation = true;
      if (withBody) {
        // The server now holds exactly what we sent — update the lock base even
        // when newer local edits arrived while the request was in flight.
        art.baseBody = payload.bodyHtml;
      }
      if (editRevision === saveRevision) {
        // Only clear the flags when nothing changed mid-flight; otherwise the
        // dirty state of those newer edits would be silently dropped.
        art.metaDirty = false;
        if (withBody) art.bodyDirty = false;
        art.dirty = art.bodyDirty;
        // Keep KuroEditor's own dirty state in sync: without this, an
        // admin-side save leaves the editor dirty, its onDirty (false→true
        // only) never re-fires for the NEXT decoration-only edit, and that
        // edit's save gets dropped by the onSave guard.
        if (withBody) state.articleEditor?.clearDirty?.();
        if (art.dirty) {
          // Metadata persisted, body intentionally left out — keep the user
          // aware that their body edits still need an explicit save.
          setSaveStatus(t("saveStatusBodyUnsaved"));
        } else {
          setSaveStatus(t("saveStatusSaved"), "ok");
          toast(t("articleSavedToast"), false);
        }
      } else {
        // A category or field changed while this save was in flight. Keep the
        // buttons active and let the follow-up autosave persist the newer state.
        art.dirty = true;
        setSaveStatus(t("saveStatusUnsaved"));
      }
    } catch (err) {
      if ((err as Dynamic)?.code === "body_conflict") {
        // The server body changed after we loaded it (e.g. an AI client).
        setSaveStatus(t("saveStatusFailed") + t("bodyConflictMsg"), "err");
        if (window.confirm(t("bodyConflictConfirm"))) {
          // Force-overwrite: drop the lock base and retry once with the body.
          // The server snapshots the other version into revision history
          // before overwriting, so nothing is lost irrecoverably.
          art.baseBody = null;
          art.saving = false;
          updateSaveButtons();
          return doSave(true);
        }
      } else {
        setSaveStatus(
          t("saveStatusFailed") + (errorMessage(err) || t("error")),
          "err",
        );
      }
    }
    art.saving = false;
    updateSaveButtons();
    if (art.dirty && editRevision !== saveRevision) {
      scheduleAutoSave();
    }
  }

  // The periodic autosave persists metadata AND the body — doSave() (no arg)
  // includes the body exactly when it was edited here (art.bodyDirty), so an
  // untouched local body still never overwrites server-side (AI) body edits.
  // KuroEditor's own autosave is off (saveUi:false), so this is the sole path.
  function autoSaveTick() {
    if (!autoSaveEnabled()) return; // toggled off after this tick was armed
    doSave();
  }

  // Metadata edits (title/summary/dates/hashtags/cover/categories) — arm the
  // periodic autosave (which now persists metadata AND the body, see autoSaveTick).
  function markDirty() {
    // Suppressed until the editor is ready / not mid-switch, so the programmatic
    // setContent() that loads a language (which fires the editor's input event)
    // can't schedule a save before the content is actually the current language.
    if (!art.ready || art.switching) return;
    editRevision += 1;
    art.metaDirty = true;
    art.dirty = true;
    setSaveStatus(t("saveStatusUnsaved"));
    updateSaveButtons();
    scheduleAutoSave();
  }

  // Body edits — mark unsaved and arm the periodic autosave. KuroCMS now owns
  // body autosave too (KuroEditor's built-in one is disabled via saveUi:false).
  // doSave() only writes the body when it was edited here (bodyDirty) and uses an
  // optimistic lock, so a background edit by another client (e.g. AI via
  // REST/MCP) is never silently overwritten.
  function markBodyDirty() {
    if (!art.ready || art.switching) return;
    editRevision += 1;
    art.bodyDirty = true;
    art.dirty = true;
    setSaveStatus(t("saveStatusUnsaved"));
    updateSaveButtons();
    scheduleAutoSave();
  }

  // Called once the editor is mounted AND the language's content is on screen:
  // the autosave counter starts fresh from here (a prefilled new translation is
  // dirty, so kick off its first autosave now).
  function markReady() {
    art.switching = false;
    art.ready = true;
    clearTimeout(autoSaveTimer);
    if (art.dirty) {
      editRevision += 1;
      scheduleAutoSave();
    }
  }

  function renderPage() {
    const ro = art.mode !== 0;
    const dis = ro ? " disabled" : "";
    app.innerHTML =
      "<div class='articleEditorPage'>" +
      "<header>" +
      "<a href='" +
      escapeHtml(adminHref("/articles")) +
      "' title='" +
      escapeHtml(t("backToArticles")) +
      "' style='flex-shrink:0;display:flex;align-items:center;justify-content:center;width:40px;height:40px;font-size:26px;color:var(--ink);text-decoration:none;border-radius:50%;transition:background 0.15s' onmouseenter=\"this.style.background='var(--surface-2)'\" onmouseleave=\"this.style.background=''\">&#8592;</a>" +
      "<div><h2>" +
      escapeHtml(art.did ? art.title || t("newArticle") : t("newArticle")) +
      "</h2><p class='pageLead'>" +
      escapeHtml(t("newArticleLead")) +
      "</p></div>" +
      "<div class='editorHeadActions'>" +
      "<div class='editorHeadTools'>" +
      "<button class='helpBtn' data-help-key='newArticle'>&#10067; " +
      escapeHtml(t("help")) +
      "</button>" +
      headerLocaleSelectHtml() +
      "</div>" +
      // Saved-article actions only. New articles are created solely from the
      // sidebar "新規記事作成" entry, so no ＋ button here. Publish-state toggle
      // and delete sit side by side:
      // published → "下書きに切り替え"（編集可能）, draft → "公開に切り替え".
      (art.did
        ? "<div class='editorHeadBtnRow'>" +
          "<button type='button' id='arDraftBtn' class='editorDraftBtn'>" +
          (ro
            ? "&#9998; " + escapeHtml(t("changeToDraftEditable"))
            : "&#10003; " + escapeHtml(t("changeToPublished"))) +
          "</button>" +
          "<button type='button' id='arDeleteBtn' class='editorHeadBtn editorDelBtn'>&#128465; " +
          escapeHtml(t("delete")) +
          "</button>" +
          "</div>"
        : "") +
      "</div>" +
      "</header>" +
      "<div class='editorBody'>" +
      (ro
        ? "<div class='editorLockOverlay'><span>" +
          escapeHtml(t("editLockedHint")) +
          "</span></div>"
        : "") +
      // TOP GRID: 2fr cover image | 1fr meta panel
      "<div class='articleTopGrid'>" +
      // Left: Cover image + Title + Summary
      "<div class='articleCoverArea'>" +
      "<div style='display:flex;align-items:center;justify-content:space-between;margin-bottom:6px'>" +
      "<span class='fieldLabel' style='margin:0'>" +
      escapeHtml(t("coverImageLabel")) +
      "</span>" +
      (r2Ok
        ? "<div style='display:flex;gap:6px;align-items:center'>" +
          "<button type='button' id='arCoverPickBtn' style='font-size:12px;padding:4px 12px'" +
          dis +
          ">&#128444; " +
          escapeHtml(t("selectCoverBtn")) +
          "</button>" +
          // Specify a cover by image id ([[img-xxx]]); resolves on blur.
          "<input id='arCoverMidInput' placeholder='[[img-xxx]]' value='" +
          escapeHtml(art.coverMid) +
          "'" +
          dis +
          " title='" +
          escapeHtml(t("coverMidHint")) +
          "' style='font-size:12px;padding:4px 8px;width:150px;font-family:ui-monospace,monospace' />" +
          "</div>"
        : "") +
      "</div>" +
      "<div id='arCoverPreview' class='articleCoverBox" +
      (!r2Ok ? " r2Disabled" : "") +
      "'>" +
      (!r2Ok
        ? "<span style='font-size:12px;color:var(--muted);text-align:center;padding:8px'>" +
          escapeHtml(t("r2CoverUnavail")) +
          "</span>"
        : art.coverMid
          ? "<img src='" +
            escapeHtml(publicBase + (art.coverVersionedPath || art.coverPath)) +
            "' style='width:100%;height:100%;object-fit:cover' />"
          : "<span style='font-size:36px;color:var(--muted)'>&#128444;</span><span style='font-size:11px;color:var(--muted)'>" +
            escapeHtml(t("coverDropHint")) +
            "</span>") +
      "</div>" +
      "<input id='arCoverFileInput' type='file' accept='image/*' style='display:none' />" +
      (art.coverMid
        ? "<div class='articleCoverActions'>" +
          "<code style='font-size:13px;background:var(--surface-2);padding:2px 7px;border-radius:5px'>[[" +
          escapeHtml(art.coverMid) +
          "]]</code>" +
          "<button type='button' id='arCoverClearBtn' class='secondary' style='font-size:12px;padding:4px 10px'" +
          dis +
          ">&#215; " +
          escapeHtml(t("clearCoverBtn")) +
          "</button>" +
          "</div>"
        : "") +
      "<label>" +
      escapeHtml(t("title")) +
      "<input id='arTitle' placeholder='" +
      escapeHtml(t("articleTitlePlaceholder")) +
      "' value='" +
      escapeHtml(art.title) +
      "'" +
      dis +
      " /></label>" +
      "<label>" +
      "<div style='display:flex;justify-content:space-between;align-items:baseline'>" +
      escapeHtml(t("summary")) +
      "<span style='font-size:11px;color:var(--muted);font-weight:400'><span id='arSummaryCount'>" +
      art.summary.length +
      "</span> / 200</span>" +
      "</div>" +
      "<textarea id='arSummary' maxlength='200' style='resize:none;height:120px;min-height:120px;font-family:inherit' placeholder='" +
      escapeHtml(t("summaryPlaceholder")) +
      "'" +
      dis +
      ">" +
      escapeHtml(art.summary) +
      "</textarea>" +
      "</label>" +
      "</div>" +
      // Right: Meta panel
      "<div class='articleMetaPanel'>" +
      // Category — moved here from the left column. The status badge and the
      // top save button were removed (article status is shown in the article
      // list / bottom bar, and saving uses the bottom-bar button), so category
      // fills the space freed at the top of this panel.
      // No "カテゴリ" label: the ＋カテゴリ追加 button already names the field.
      "<div>" +
      "<button type='button' id='arCatBtn' style='font-size:12px;padding:5px 12px'" +
      dis +
      ">＋" +
      escapeHtml(t("categoryAddBtn")) +
      "</button>" +
      "<div id='arCatTags' style='display:flex;gap:4px;flex-wrap:wrap;margin-top:6px'></div>" +
      "</div>" +
      "<label>" +
      escapeHtml(t("articleTypeLabel")) +
      "<select id='arType'" +
      dis +
      "><option value=''>" +
      escapeHtml(t("loading")) +
      "</option></select></label>" +
      "<label>" +
      escapeHtml(t("publishDateLabel")) +
      "<div style='display:flex;gap:6px;align-items:center'>" +
      "<input type='date' id='arPubDate' value='" +
      escapeHtml(art.pubDate) +
      "'" +
      dis +
      " style='flex:1;min-width:0' />" +
      "<button type='button' id='arPubDateCalBtn' class='secondary' style='flex-shrink:0;padding:7px 10px;font-size:15px;line-height:1'" +
      dis +
      ">&#128197;</button>" +
      "</div>" +
      "</label>" +
      "<label>" +
      escapeHtml(t("publishTimeLabel")) +
      "<input type='time' id='arPubTime' value='" +
      escapeHtml(art.pubTime) +
      "'" +
      dis +
      " /></label>" +
      "<label>" +
      escapeHtml(t("languages")) +
      "<select id='arLang'" +
      dis +
      "><option value=''>" +
      escapeHtml(t("loading")) +
      "</option></select></label>" +
      "<label>" +
      escapeHtml(t("hashtagLabel")) +
      "<input id='arHashtag' placeholder='" +
      escapeHtml(t("hashtagPlaceholder")) +
      "' value='" +
      escapeHtml(art.hashtag) +
      "'" +
      dis +
      " /></label>" +
      "<label>Slug" +
      "<input id='arSlug' placeholder='my-article-slug' value='" +
      escapeHtml(art.slug) +
      "'" +
      // Existing docs: slug is locked, but clicking it copies the slug.
      (art.did
        ? " readonly style='cursor:pointer' title='" +
          escapeHtml(t("slugCopyHint")) +
          "'"
        : dis) +
      " />" +
      "<span style='font-size:11px;color:var(--muted)'>" +
      escapeHtml(
        art.did
          ? t("slugReadonly") + " ・ " + t("slugCopyHint")
          : t("slugHint"),
      ) +
      "</span>" +
      "</label>" +
      "</div>" +
      "</div>" +
      // BODY (Title + Summary are in the left column of the top grid)
      "<div class='articleBodyWrap' style='border-top:none'>" +
      "<span class='fieldLabel'>" +
      escapeHtml(t("bodyLabel")) +
      "</span>" +
      "<textarea id='arBody' rows='5' style='width:100%;resize:none;overflow:hidden;font-family:inherit;margin-top:4px;min-height:120px'" +
      dis +
      ">" +
      escapeHtml(art.body) +
      "</textarea>" +
      "</div>" +
      "</div>" + // editorBody
      "</div>" + // articleEditorPage
      // Fixed bottom bar — KuroEditor toolbar slot (left) + save status + save button (right)
      "<div class='articleBottomBar'>" +
      (!ro ? "<div id='arKeToolbar' class='arKeToolbarSlot'></div>" : "") +
      "<span id='arSaveStatus' class='autoSaveStatus'>" +
      escapeHtml(t("saveStatusUnsaved")) +
      "</span>" +
      // Auto-save toggle, immediately left of the save button (editable mode
      // only). Replaces KuroEditor's now-hidden 自動保存 checkbox.
      (!ro
        ? "<label style='display:flex;align-items:center;gap:5px;font-size:12px;color:var(--muted);cursor:pointer;user-select:none;white-space:nowrap'>" +
          "<input type='checkbox' id='arAutoSaveCheck' style='cursor:pointer'" +
          (autoSaveEnabled() ? " checked" : "") +
          " />" +
          escapeHtml(t("autoSaveLabel")) +
          "</label>"
        : "") +
      "<button type='button' id='arSaveBtn' style='min-width:80px'>" +
      escapeHtml(t("save")) +
      "</button>" +
      "</div>";
    bindLocaleSelect();
  }

  // Resolve R2 availability BEFORE the first render so the page is built ONCE
  // with the correct cover UI + media-upload handler. Re-rendering after the
  // dropdowns have populated / KuroEditor has attached (the old behaviour) wiped
  // the <select> options back to "読み込み中…" and detached the editor from its
  // textarea — the root cause of the stuck dropdowns + missing body.
  try {
    const storage = await api("/api/system/storage");
    r2Ok = !!storage?.r2Available;
  } catch {
    r2Ok = true; // assume available; cover upload surfaces its own errors
  }

  // Surface any synchronous init failure on-screen (the user cannot open the
  // dev console): a throw here would otherwise abort silently, leaving both
  // dropdowns stuck on "読み込み中…" and KuroEditor unmounted.
  try {
    renderPage();
    bindAllArticleEvents();
  } catch (e) {
    // Transient stale-bundle failure → reload once automatically.
    if (editorAutoRecover()) return;
    const msg = errorMessage(e) || String(e);
    toast(t("initRenderError") + ": " + msg, true);
    throw e;
  }

  // ── Dynamic field population (types / languages / categories) ───────────────
  // These selects are rebuilt by every renderPage() (e.g. draft toggle, cover
  // change), which resets them to the "読み込み中…" placeholder. The fetched
  // lists are cached as promises so each renderPage() can re-fill the *current*
  // <select> from cache — no re-fetch, no flicker, and race-proof. Without this,
  // switching a published article to draft before the language list finished
  // loading left the language dropdown stuck on "読み込み中…" until a reload.
  let typesPromise: Dynamic = null;
  let langsPromise: Dynamic = null;

  function fillTypeSelect(types: Dynamic) {
    const codes = types.map(function (tp: Dynamic) {
      return tp.tid || tp.id || "";
    });
    // Preserve the current value even if it isn't in the registered list, so it
    // stays visible and is not silently dropped on save.
    const typeRegistered = !art.tid || codes.indexOf(art.tid) !== -1;
    const sel = byId("arType");
    if (!sel) return;
    let options =
      "<option value=''>" +
      escapeHtml(t("selectTypeEmpty")) +
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
    if (art.tid && !typeRegistered)
      options +=
        "<option value='" +
        escapeHtml(art.tid) +
        "'>" +
        escapeHtml(art.tid + " " + t("unregisteredSuffix")) +
        "</option>";
    sel.innerHTML = options;
    if (art.tid) sel.value = art.tid;
  }

  function loadTypes() {
    if (!typesPromise)
      typesPromise = api("/api/types").then(function (data: Dynamic) {
        return (data.types || []).filter(function (tp: Dynamic) {
          return !tp.source_type || tp.source_type === "collection";
        });
      });
    typesPromise.then(fillTypeSelect).catch(function (err: Dynamic) {
      typesPromise = null; // allow a later re-render to retry the fetch
      const sel = byId("arType");
      if (sel)
        sel.innerHTML =
          "<option value=''>" + escapeHtml(t("typeLoadFailed")) + "</option>";
      toast(t("typeLoadFailed") + errorMessage(err), true);
    });
  }

  function fillLangSelect(payload: Dynamic) {
    const langs = payload.langs;
    const defaultLang = payload.defaultLang;
    const codes = langs.map(function (lg: Dynamic) {
      return lg.lang || lg.id || "";
    });
    for (const lg of langs) {
      const code = lg.lang || lg.id || "";
      if (code) langNames[code] = lg.displayName || lg.name || code;
    }
    const currentLang = art.lang || defaultLang;
    const sel = byId("arLang");
    if (!sel) return;
    if (!langs.length && !art.existingLangs.length) {
      sel.innerHTML =
        "<option value=''>" + escapeHtml(t("noLanguages")) + "</option>";
      return;
    }
    // Dropdown candidates = registered languages ∪ this article's existing
    // translation langs. Mark which already have content vs. "(new)".
    const seen: Record<string, boolean> = {};
    const candidates: Array<{ code: Dynamic; created: Dynamic }> = [];
    for (const code of codes) {
      if (code && !seen[code]) {
        seen[code] = true;
        candidates.push({
          code,
          created: art.existingLangs.indexOf(code) !== -1,
        });
      }
    }
    for (const code of art.existingLangs) {
      if (code && !seen[code]) {
        seen[code] = true;
        candidates.push({ code, created: true });
      }
    }
    sel.innerHTML = candidates
      .map(function (c) {
        const label =
          langLabel(c.code) + (c.created ? "" : "  " + t("langOptionNew"));
        return (
          "<option value='" +
          escapeHtml(c.code) +
          "'>" +
          escapeHtml(label) +
          "</option>"
        );
      })
      .join("");
    sel.value = currentLang;
    if (!sel.value && candidates.length) sel.value = candidates[0].code;
    if (!art.lang) art.lang = sel.value;
  }

  function loadLanguages() {
    if (!langsPromise)
      langsPromise = Promise.all([
        api("/api/settings")
          .then(function (d: Dynamic) {
            // New-article default authoring language = site base language
            // (基本言語). initial_lang was unified into default_lang.
            return d?.settings?.defaultLang || d?.settings?.initialLang || "ja";
          })
          .catch(function () {
            return "ja";
          }),
        api("/api/languages").then(function (data: Dynamic) {
          return data.languages || [];
        }),
      ]).then(function (r: Dynamic) {
        return { defaultLang: r[0], langs: r[1] };
      });
    langsPromise.then(fillLangSelect).catch(function (err: Dynamic) {
      langsPromise = null; // allow a later re-render to retry the fetch
      const sel = byId("arLang");
      if (sel)
        sel.innerHTML =
          "<option value=''>" + escapeHtml(t("langLoadFailed")) + "</option>";
      toast(t("langLoadFailed") + errorMessage(err), true);
    });
  }

  function loadCategories() {
    if (allCategories.length) return renderCatTags();
    api("/api/categories")
      .then(function (data: Dynamic) {
        allCategories = data.categories || [];
        renderCatTags();
      })
      .catch(function (err: Dynamic) {
        toast(t("catLoadFailed") + errorMessage(err), true);
      });
  }

  // Re-fill every dynamic field from cache. Called once on init and after each
  // renderPage() re-render so the recreated selects never stay on "読み込み中…".
  function refreshDynamicFields() {
    loadTypes();
    loadLanguages();
    loadCategories();
  }

  refreshDynamicFields();

  // Textarea auto-grow (fallback before editor initializes)
  function autoGrow(ta: Dynamic) {
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  }
  const bodyTa = byId("arBody");
  if (bodyTa) {
    autoGrow(bodyTa);
    bodyTa.addEventListener("input", function () {
      autoGrow(bodyTa);
      markBodyDirty();
    });
  }

  // WYSIWYG editor init — KuroEditor (inlined at build time). Wrapped in a
  // function so it can be RE-MOUNTED after every renderPage() re-render: the
  // draft/publish toggle and cover-image change rebuild the #arBody textarea,
  // which would otherwise drop KuroEditor and leave a plain textarea. The media
  // URL cache + "loaded" flag persist across re-mounts (no re-fetch, no flicker).
  const bodyMidUrlCache: Record<string, string> = {};
  let bodyMediaLoaded = false;
  let caretScrollBound = false;

  function mountBodyEditor() {
    const KE = adminWindow.KuroEditor;
    const ta = byId("arBody");
    // KuroEditor missing usually means a stale/half-loaded bundle → reload once.
    if (!KE && ta && editorAutoRecover()) return;
    if (!KE || !ta) return;
    // Release any previous instance: a re-render recreated the textarea, leaving
    // the old editor bound to a now-detached node.
    destroyArticleEditor();
    const ke = new KE(ta, {
      modalToolbar: byId("arKeToolbar") || undefined,
      // Host-managed saving: hide KuroEditor's own 保存 button + 自動保存 checkbox
      // and disable its internal autosave timer. KuroCMS owns the save/autosave UI
      // (bottom bar), so the two never disagree. onDirty still fires for every
      // edit (incl. decoration-only), and we call ke.clearDirty() after a body
      // save to keep KuroEditor's dirty state aligned.
      saveUi: false,
      // キャンバスをアクティブテンプレートの body 配色に一致させる（/api/fonts
      // の editorCanvas 由来）。テンプレートの配色は1組なので両モードのスロット
      // に同じ値を渡し（canvasDarkColors は KE 2.4.0+）、どちらのモードでも
      // テンプレートの実色で描画される＝真の WYSIWYG。
      canvasColors: state.editorCanvasColors || undefined,
      canvasDarkColors: state.editorCanvasColors || undefined,
      // ダークモードはテンプレートの配色から自動決定（KE 2.3.0+）。ホスト指定
      // なので localStorage の保存値より優先され、canvasDarkUi は既定 false の
      // ままなので手動トグルのチェックボックスは表示されない。モードは
      // caret/placeholder 等の未指定キーの既定パレットを左右する。
      canvasDark: editorCanvasDark(),
      urlResolver: function (slug: string) {
        if (slug.startsWith("http")) return slug;
        return bodyMidUrlCache[slug] || slug;
      },
      // KuroEditor calls onSave from its toolbar Save button AND its periodic
      // autosave (which only runs while the editor's 自動保存 checkbox is ON —
      // this is the ONLY path that autosaves the body, so the checkbox really
      // controls body autosave). doSave() without an argument includes the body
      // exactly when it was edited here (bodyDirty), so an untouched body never
      // overwrites server-side (AI) edits.
      onSave: function (html: string) {
        art.body = html;
        if (art.ready && !art.switching && !art.saving && art.dirty) {
          clearTimeout(autoSaveTimer);
          doSave();
        }
      },
      // KuroEditor's complete change signal (MutationObserver-backed). The
      // "input" listeners below miss decoration-only edits (文字色・セル背景色・
      // テーブル操作 manipulate the DOM directly and fire no input event) —
      // without this, such an edit leaves art.dirty false and the onSave guard
      // above silently DROPS the save the user just clicked.
      onDirty: markBodyDirty,
      onMediaUpload: r2Ok
        ? async function (file: File) {
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
            // ?v=cache_version 付き（data.url）で保持する。mid の URL は
            // immutable キャッシュされるため、素の publicPath だと（過去に
            // 同じパスが存在した場合）古いキャッシュ画像が表示される。
            bodyMidUrlCache[data.mid] =
              publicBase + (data.url || data.publicPath);
            // 中身が同一の既存画像に集約された場合はその旨を通知（重複登録防止）
            if (data.reused)
              toast(
                t("mediaReusedToast").replace("{mid}", String(data.mid)),
                false,
              );
            return data.mid;
          }
        : undefined,
    });
    state.articleEditor = ke;
    // KuroEditor mounted → the load is healthy; reset the auto-reload guard so a
    // future transient failure is again eligible for one auto-reload.
    clearEditorReloadGuard();
    if (art.mode !== 0) {
      ke.wysiwyg.contentEditable = "false";
      ke.mmenu.style.display = "none";
    }
    ke.wysiwyg.addEventListener("input", markBodyDirty);
    // Also track edits made in the editor's HTML (source) mode. KuroEditor exposes
    // two edit surfaces; the source <textarea> fires its own native input that the
    // WYSIWYG listener above never sees, so HTML-mode edits would stay undetected
    // (never marked dirty / saved) and be lost on the next re-render.
    ke.sourceArea.addEventListener("input", markBodyDirty);
    const verEl = document.createElement("div");
    verEl.id = "kuroEditorVer";
    verEl.style.cssText =
      "font-size:11px;color:var(--muted);text-align:right;margin-top:4px;padding:0 2px";
    verEl.textContent =
      "KuroEditor v" + (adminWindow.KUROEDITOR_VERSION || "?");
    ke.root.insertAdjacentElement("afterend", verEl);
    // Preload all media → populate urlResolver cache → render content. On
    // re-mounts the cache is already warm, so render immediately.
    if (bodyMediaLoaded) {
      ke.setContent(art.body);
      markReady();
    } else {
      Promise.all([
        api("/api/media/images").catch(function () {
          return { items: [] };
        }),
        api("/api/media/videos").catch(function () {
          return { items: [] };
        }),
        api("/api/media/audios").catch(function () {
          return { items: [] };
        }),
      ])
        .then(function (
          results: Array<{
            items?: Array<{
              id?: string;
              publicPath?: string;
              cacheVersion?: string;
            }>;
          }>,
        ) {
          results.forEach(function (d) {
            (d.items || []).forEach(function (item) {
              if (item.id && item.publicPath)
                bodyMidUrlCache[item.id] =
                  publicBase +
                  item.publicPath +
                  (item.cacheVersion ? "?v=" + item.cacheVersion : "");
            });
          });
          bodyMediaLoaded = true;
          ke.setContent(art.body);
          markReady();
        })
        .catch(function () {
          ke.setContent(art.body);
          markReady();
        });
    }

    // Keep caret above fixed bottom bar (scroll-padding-bottom unreliable in
    // Safari). Bound once; it reads the live editor from state.articleEditor, so
    // it keeps working across re-mounts.
    if (!caretScrollBound) {
      caretScrollBound = true;
      document.addEventListener("selectionchange", function _keCaretScroll() {
        const ed = state.articleEditor;
        if (!ed) {
          document.removeEventListener("selectionchange", _keCaretScroll);
          caretScrollBound = false;
          return;
        }
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount || !ed.wysiwyg.contains(sel.anchorNode))
          return;
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        if (!rect.height) return;
        const bar = document.querySelector<AdminElement>(
          ".articleBottomBar",
        ) as HTMLElement | null;
        const barH = bar ? bar.offsetHeight + 8 : 70;
        const gap = rect.bottom - (window.innerHeight - barH);
        if (gap > 0) window.scrollBy({ top: gap, behavior: "instant" });
      });
    }
  }

  mountBodyEditor();

  // New translation seeded from the base language → mark dirty so it persists
  // (autosave/Save creates the new translation row).
  if (pending && pending.prefill) markDirty();

  // Cover image picker (file upload + drag & drop)
  function bindCoverPicker() {
    const box = byId("arCoverPreview");
    const fileInput = byId("arCoverFileInput") as HTMLInputElement | null;

    async function uploadCoverFile(file: File) {
      try {
        const prepared = await prepareImageForUpload(file);
        const fd = new FormData();
        fd.append("file", prepared.file);
        fd.append("width", String(prepared.width));
        fd.append("height", String(prepared.height));
        const resp = await fetch(withBase("/api/media/images/upload"), {
          method: "POST",
          headers: { Authorization: "Bearer " + state.token },
          body: fd,
        });
        const json = await resp.json();
        // The API returns errors as { error: { code, message } }; passing that
        // object straight to new Error() yields "[object Object]".
        if (!resp.ok)
          throw new Error(
            json.error?.message ||
              json.error?.code ||
              (typeof json.error === "string" ? json.error : "") ||
              resp.statusText,
          );
        readFields(); // preserve in-progress body/title edits before re-render
        art.coverMid = json.mid;
        art.coverPath = json.publicPath;
        art.coverVersionedPath = json.url || "";
        markDirty();
        renderPage();
        bindAllArticleEvents();
        refreshDynamicFields();
        mountBodyEditor();
      } catch (err) {
        // Logs the full object + stack so a post-upload render failure (which is
        // caught here too, not just the upload itself) is diagnosable.
        console.error("cover upload/render failed", err);
        toast(errorMessage(err), true);
      }
    }

    byId("arCoverPickBtn")?.addEventListener("click", function () {
      fileInput?.click();
    });

    // Specify the cover by image id ([[img-xxx]] or img-xxx). On blur, resolve
    // the id to its stored image and show it in the cover area. Uploading via
    // file/drop re-renders with value=art.coverMid, so the field auto-fills.
    function applyCover(mid: string, path: string, versionedPath?: string) {
      readFields(); // preserve in-progress body/title edits before re-render
      art.coverMid = mid;
      art.coverPath = path;
      art.coverVersionedPath = versionedPath || "";
      markDirty();
      renderPage();
      bindAllArticleEvents();
      refreshDynamicFields();
      mountBodyEditor();
    }
    const midInput = byId("arCoverMidInput") as HTMLInputElement | null;
    midInput?.addEventListener("blur", async function () {
      let mid = (midInput.value || "").trim();
      if (mid.startsWith("[[")) mid = mid.slice(2).trim();
      if (mid.endsWith("]]")) mid = mid.slice(0, -2).trim();
      if (mid === art.coverMid) return; // unchanged
      if (!mid) {
        if (art.coverMid) applyCover("", ""); // cleared → remove cover
        return;
      }
      try {
        const res = await api("/api/media/asset/" + encodeURIComponent(mid));
        const item = res.item;
        if (!item || item.kind !== "image") {
          throw new Error(t("coverMidNotFound"));
        }
        applyCover(
          item.id,
          item.publicPath,
          item.cacheVersion ? item.publicPath + "?v=" + item.cacheVersion : "",
        );
      } catch (err) {
        toast(
          err instanceof Error && err.message
            ? err.message
            : t("coverMidNotFound"),
          true,
        );
        midInput.value = art.coverMid; // revert to current
      }
    });

    fileInput?.addEventListener("change", function () {
      const file = fileInput.files?.[0];
      if (file) uploadCoverFile(file);
    });

    if (box && fileInput) {
      let dragCounter = 0;
      box.addEventListener("dragenter", function (e) {
        e.preventDefault();
        dragCounter++;
        box.classList.add("dragover");
      });
      box.addEventListener("dragleave", function () {
        dragCounter--;
        if (dragCounter <= 0) {
          dragCounter = 0;
          box.classList.remove("dragover");
        }
      });
      box.addEventListener("dragover", function (e) {
        e.preventDefault();
      });
      box.addEventListener("drop", function (e) {
        e.preventDefault();
        dragCounter = 0;
        box.classList.remove("dragover");
        const file = (e as DragEvent).dataTransfer?.files?.[0];
        if (file && new RegExp("^image/").test(file.type))
          uploadCoverFile(file);
      });
    }

    byId("arCoverClearBtn")?.addEventListener("click", function () {
      readFields(); // preserve in-progress body/title edits before re-render
      art.coverMid = "";
      art.coverPath = "";
      renderPage();
      bindAllArticleEvents();
      refreshDynamicFields();
      mountBodyEditor();
      markDirty();
    });
  }
  // Return the base-language (initial_lang) content to copy into a new
  // translation. Uses the live fields when the base language is on screen
  // (captures unsaved edits), otherwise fetches the base translation.
  async function getBaseContent() {
    if (art.lang === art.initialLang) {
      readFields();
      return {
        title: art.title,
        summary: art.summary,
        body: art.body,
        hashtag: art.hashtag,
        coverMid: art.coverMid,
        coverPath: art.coverPath,
      };
    }
    const tData = await api(
      "/api/documents/" + art.did + "/translations/" + art.initialLang,
    ).catch(function () {
      return null;
    });
    const tr = tData && tData.translation;
    if (!tr)
      return {
        title: "",
        summary: "",
        body: "",
        hashtag: "",
        coverMid: "",
        coverPath: "",
      };
    let hashtag = "";
    try {
      const hj = JSON.parse(tr.hashtag_json || "[]");
      if (Array.isArray(hj))
        hashtag = hj
          .map(function (h: Dynamic) {
            return "#" + h;
          })
          .join(" ");
    } catch {
      /* ignore */
    }
    let coverMid = "";
    let coverPath = "";
    try {
      const sj = JSON.parse(tr.seo_json || "{}");
      if (sj.coverMid) {
        coverMid = sj.coverMid;
        coverPath = sj.coverPath || "";
      }
    } catch {
      /* ignore */
    }
    return {
      title: tr.title || "",
      summary: tr.summary || "",
      body: tr.body_html || "",
      hashtag,
      coverMid,
      coverPath,
    };
  }

  // Confirm dialog when switching to a language that has no translation yet:
  // "Translate into {lang}?" with a "copy from base language" checkbox (on by
  // default) so the author can translate from the existing base text.
  function openTranslateDialog(target: Dynamic) {
    const name = langLabel(target);
    const body =
      "<p>" +
      escapeHtml(t("translateConfirmMsg").replace("{lang}", name)) +
      "</p>" +
      "<label class='checkRow' style='margin-top:12px;cursor:pointer'>" +
      "<input type='checkbox' id='arCopyBase' checked /> <span>" +
      escapeHtml(
        t("translateCopyBase").replace("{lang}", langLabel(art.initialLang)),
      ) +
      "</span></label>";
    openEntryDialog(
      t("translateDialogTitle").replace("{lang}", name),
      body,
      t("translateCreateBtn").replace("{lang}", name),
      async function (_: Dynamic, close: Dynamic) {
        const copy = !!(byId("arCopyBase") as Dynamic)?.checked;
        const prefill = copy
          ? await getBaseContent()
          : {
              title: "",
              summary: "",
              body: "",
              hashtag: "",
              coverMid: "",
              coverPath: "",
            };
        close();
        pendingArticleLoad = { lang: target, prefill };
        newArticle(art.did);
      },
    );
  }

  // Language dropdown change → switch to / create that translation.
  async function switchToLanguage(target: Dynamic) {
    const sel = byId("arLang");
    // Cancel any pending debounced autosave: it would otherwise fire mid-switch
    // and read the (shared) editor / DOM that is being rebuilt for the new
    // language while still believing it is the old one.
    clearTimeout(autoSaveTimer);
    // The base language must exist (have a did) before adding translations.
    if (!art.did) {
      await doSave();
      if (!art.did) {
        if (sel) sel.value = art.lang;
        return;
      }
    }
    if (art.existingLangs.indexOf(target) !== -1) {
      // Existing translation: persist current edits, then reload that language.
      // doSave() here still targets the CURRENT language (art.lang is owned by
      // the load flow, never the switcher), so it can't mislabel the body.
      if (art.dirty) await doSave();
      if (art.dirty) {
        // The save failed (validation error or body conflict left unresolved).
        // Abort the switch — proceeding would rebuild the editor and silently
        // discard the unsaved edits.
        if (sel) sel.value = art.lang;
        return;
      }
      // From here until the new language is fully on screen, block every save.
      art.switching = true;
      pendingArticleLoad = { lang: target };
      newArticle(art.did);
    } else {
      // No translation yet → confirm + copy-from-base. Keep current selection
      // until the user confirms (cancel leaves the language unchanged).
      if (sel) sel.value = art.lang;
      openTranslateDialog(target);
    }
  }

  function bindAllArticleEvents() {
    bindCoverPicker();
    // Existing docs: the slug is read-only, so a click copies it to the clipboard.
    if (art.did) {
      byId("arSlug")?.addEventListener("click", async function () {
        const el = byId("arSlug");
        const slug = (el as unknown as HTMLInputElement | null)?.value || "";
        if (!slug) return;
        try {
          await navigator.clipboard.writeText(slug);
          toast(t("copySuccess"), false, el);
        } catch {
          toast(t("copyFailed"), true, el);
        }
      });
    }
    byId("arSummary")?.addEventListener("input", function (e: Dynamic) {
      const cnt = byId("arSummaryCount");
      if (cnt) cnt.textContent = String(e.target.value.length);
      markDirty();
    });
    [
      "arType",
      "arSlug",
      "arPubDate",
      "arPubTime",
      "arHashtag",
      "arTitle",
    ].forEach(function (id) {
      byId(id)?.addEventListener("input", markDirty);
      byId(id)?.addEventListener("change", markDirty);
    });
    // The language dropdown is a TRANSLATION SWITCHER, not a plain field: pick a
    // language to view/edit that translation (or create a new one).
    byId("arLang")?.addEventListener("change", function () {
      const sel = byId("arLang");
      if (!sel) return;
      const target = sel.value;
      if (!target || target === art.lang) return;
      switchToLanguage(target);
    });
    byId("arSaveBtn")?.addEventListener("click", function () {
      clearTimeout(autoSaveTimer);
      doSave();
    });
    byId("arAutoSaveCheck")?.addEventListener("change", function () {
      const on = !!(byId("arAutoSaveCheck") as Dynamic)?.checked;
      setAutoSaveEnabled(on);
      if (on) {
        // Turning it on flushes nothing immediately; just arm the timer if there
        // are pending edits so they get picked up on the next tick.
        if (art.dirty) scheduleAutoSave();
      } else {
        clearTimeout(autoSaveTimer);
      }
    });
    // Reflect the current dirty/saving state on the freshly rendered buttons.
    updateSaveButtons();
    byId("arPubDateCalBtn")?.addEventListener("click", function () {
      const inp = byId("arPubDate") as unknown as HTMLInputElement;
      try {
        inp?.showPicker();
      } catch {
        inp?.focus();
      }
    });
    // Publish-state toggle, switched in place (no dialog). Published → Draft
    // just unlocks for editing; Draft → Published persists any unsaved edits
    // first so stale/incomplete content isn't published.
    byId("arDraftBtn")?.addEventListener("click", async function () {
      if (!art.did) return;
      const btn = byId("arDraftBtn") as Dynamic;
      if (btn) btn.disabled = true;
      try {
        if (art.mode === 0) {
          // Draft → Published. Save unsaved edits first; abort if the save
          // failed validation (doSave leaves art.dirty true and shows why).
          if (art.dirty) {
            await doSave();
            if (art.dirty) {
              if (btn) btn.disabled = false;
              return;
            }
          }
          await api("/api/documents/" + art.did, {
            method: "PUT",
            body: JSON.stringify({ mode: 1 }),
          });
          art.mode = 1;
        } else {
          await api("/api/documents/" + art.did, {
            method: "PUT",
            body: JSON.stringify({ mode: 0 }),
          });
          art.mode = 0;
        }
        renderPage();
        bindAllArticleEvents();
        refreshDynamicFields();
        mountBodyEditor();
        toast(art.mode === 1 ? t("publishedToast") : t("draftToast"), false);
      } catch (err) {
        toast(errorMessage(err), true);
        const b = byId("arDraftBtn") as Dynamic;
        if (b) b.disabled = false;
      }
    });
    byId("arCatBtn")?.addEventListener("click", function (e) {
      if (!allCategories.length) {
        toast(t("noCategories"), true);
        return;
      }
      const available: Dynamic = allCategories.filter(function (c) {
        return !art.categories.includes(c.cid);
      });
      if (!available.length) {
        toast(t("allCategoriesSelected"), false);
        return;
      }

      // Toggle: close if already open
      const existing = byId("catPickPopover");
      if (existing) {
        existing.remove();
        return;
      }

      const btn = byId("arCatBtn") as HTMLElement;
      const rect = btn.getBoundingClientRect();
      const ROW_H = 38;
      const desiredH = Math.min(available.length, 10) * ROW_H;

      const pop = document.createElement("div");
      pop.id = "catPickPopover";
      pop.className = "catPickPopover";

      // Right-align to button's right edge (grows leftward)
      pop.style.right = window.innerWidth - rect.right + "px";

      // Prefer showing above; fall back to below if not enough space above
      const spaceAbove = rect.top - 8;
      const spaceBelow = window.innerHeight - rect.bottom - 8;
      if (spaceAbove >= ROW_H) {
        const actualH = Math.min(desiredH, spaceAbove);
        pop.style.top = rect.top - actualH - 4 + "px";
        pop.style.maxHeight = actualH + "px";
      } else {
        pop.style.top = rect.bottom + 4 + "px";
        pop.style.maxHeight =
          Math.min(desiredH, Math.max(spaceBelow, ROW_H)) + "px";
      }

      pop.innerHTML = available
        .map(function (c: Dynamic) {
          return (
            "<div class='catPickRow' data-cid='" +
            escapeHtml(c.cid) +
            "'>" +
            escapeHtml(c.name || c.cid) +
            "</div>"
          );
        })
        .join("");
      document.body.appendChild(pop);

      pop.querySelectorAll<AdminElement>(".catPickRow").forEach(function (row) {
        (row as HTMLElement).addEventListener("click", function () {
          const cid = (row as HTMLElement).dataset.cid;
          if (cid && !art.categories.includes(cid)) {
            art.categories.push(cid);
            markDirty();
            renderCatTags();
          }
          pop.remove();
        });
      });

      setTimeout(function () {
        function onOutside(ev: MouseEvent) {
          if (!pop.contains(ev.target as Node) && ev.target !== btn) {
            pop.remove();
            document.removeEventListener("click", onOutside, true);
          }
        }
        document.addEventListener("click", onOutside, true);
      }, 0);

      e.stopPropagation();
    });
    byId("arDeleteBtn")?.addEventListener("click", onDeleteClick);
  }

  // Second-step confirmation that deletes the WHOLE article (all languages).
  function confirmDeleteWholeArticle() {
    const note =
      "<p>" +
      escapeHtml(t("deleteArticleMsg")) +
      "</p>" +
      "<p style='font-size:12px;color:var(--muted);margin-top:6px'>" +
      escapeHtml(t("deleteArticleImportNote")) +
      "</p>";
    openEntryDialog(
      t("deleteWholeConfirmTitle"),
      note,
      t("deleteWholeAction"),
      async function (_: Dynamic, close: Dynamic) {
        try {
          await api("/api/documents/" + art.did, { method: "DELETE" });
          close();
          history.pushState(null, "", adminHref("/articles"));
          render();
        } catch (err) {
          toast(errorMessage(err), true);
        }
      },
      null,
      "danger",
    );
  }

  function onDeleteClick() {
    if (!art.did) return;
    const name = langLabel(art.lang);
    // Deleting the BASE language is not allowed on its own — it removes every
    // language. Warn, then route to the whole-article delete (second confirm).
    if (art.lang === art.initialLang) {
      openEntryDialog(
        t("deleteBaseTitle"),
        "<p>" +
          escapeHtml(t("deleteBaseWarn").replace("{lang}", name)) +
          "</p>",
        t("deleteWholeAction"),
        function (_: Dynamic, close: Dynamic) {
          close();
          confirmDeleteWholeArticle();
        },
        null,
        "danger",
      );
      return;
    }
    // Non-base language: choose this-language-only vs. whole-article.
    const body =
      "<p>" +
      escapeHtml(t("deleteScopePrompt").replace("{lang}", name)) +
      "</p>" +
      "<label class='checkRow' style='margin-top:10px;cursor:pointer'>" +
      "<input type='radio' name='arDelScope' value='lang' checked /> <span>" +
      escapeHtml(t("deleteScopeLang").replace("{lang}", name)) +
      "</span></label>" +
      "<label class='checkRow' style='margin-top:6px;cursor:pointer'>" +
      "<input type='radio' name='arDelScope' value='all' /> <span>" +
      escapeHtml(t("deleteScopeAll")) +
      "</span></label>";
    openEntryDialog(
      t("deleteArticleTitle"),
      body,
      t("deleteAction"),
      async function (_: Dynamic, close: Dynamic) {
        const scope =
          (
            document.querySelector(
              "input[name='arDelScope']:checked",
            ) as Dynamic
          )?.value || "lang";
        if (scope === "all") {
          close();
          confirmDeleteWholeArticle();
          return;
        }
        try {
          await api("/api/documents/" + art.did + "/translations/" + art.lang, {
            method: "DELETE",
          });
          close();
          // Reload the article at its base language after removing this one.
          pendingArticleLoad = { lang: art.initialLang };
          newArticle(art.did);
        } catch (err) {
          toast(errorMessage(err), true);
        }
      },
      null,
      "danger",
    );
  }
}
