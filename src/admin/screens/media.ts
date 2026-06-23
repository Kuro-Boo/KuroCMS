// KuroCMS admin screen module. Concatenated by scripts/build-admin.js.

async function images() {
  mediaScreen("image", "images", "/api/media/images", "image/*");
}

function mediaScreen(
  kind: Dynamic,
  labelKey: Dynamic,
  apiPath: Dynamic,
  acceptMime: Dynamic,
) {
  const listTitleKey =
    "registered" +
    labelKey.charAt(0).toUpperCase() +
    labelKey.slice(1) +
    "List";
  const leadKey = labelKey + "Lead";
  const kindLabel =
    kind === "image"
      ? t("imageTypeLabel")
      : kind === "video"
        ? t("videoTypeLabel")
        : t("audioTypeLabel");
  shell(
    t(labelKey),
    "<div class='stack'>" +
      "<div id='mediaScreenBody' class='panel stack'>" +
      "<div class='panelHead'><h3>" +
      escapeHtml(t(listTitleKey)) +
      "</h3><div class='toolbar'><button type='button' id='mediaAddBtn'>" +
      escapeHtml(t("addFile")) +
      "</button></div></div>" +
      (kind === "image"
        ? "<div style='display:flex;justify-content:flex-end;margin-top:-6px'><label style='display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted)'>" +
          escapeHtml(t("imageAutoResize")) +
          "<select id='imageResizeLimit' style='width:auto;min-width:180px;padding:5px 8px;font-size:12px'>" +
          "<option value='0'>" +
          escapeHtml(t("imageResizeNone")) +
          "</option><option value='200000'>" +
          escapeHtml(t("imageResize200k")) +
          "</option><option value='500000'>" +
          escapeHtml(t("imageResize500k")) +
          "</option><option value='1000000'>" +
          escapeHtml(t("imageResize1m")) +
          "</option><option value='2000000'>" +
          escapeHtml(t("imageResize2m")) +
          "</option></select></label></div>"
        : "") +
      "<div class='categoryHint'>" +
      escapeHtml(t(leadKey)) +
      "</div>" +
      "<div id='mediaStorageInfo' class='muted' style='font-size:13px;padding:6px 0 2px'>" +
      escapeHtml(t("loading")) +
      "</div>" +
      "<div id='mediaDropZone' class='dropZone'>" +
      "<div class='dropZoneIcon'>" +
      (kind === "image" ? "🖼" : kind === "video" ? "🎬" : "🎵") +
      "</div>" +
      "<p class='dropZoneLead'>" +
      escapeHtml(t("dropZoneLead")) +
      "</p>" +
      "<input type='file' id='mediaFileInput' accept='" +
      escapeHtml(acceptMime) +
      "' multiple style='display:none' />" +
      "</div>" +
      "<div id='uploadQueue' class='uploadQueue' style='display:none'></div>" +
      "<div id='mediaList' class='emptyState'>" +
      escapeHtml(t("noMedia")) +
      "</div>" +
      "</div>" +
      "</div>",
  );

  const resizeSelect = byId("imageResizeLimit");
  if (resizeSelect) {
    resizeSelect.value = String(getImageUploadMaxBytes());
    resizeSelect.addEventListener("change", function () {
      setImageUploadMaxBytes(Number(resizeSelect.value));
    });
  }

  function initMediaDropZone() {
    const dropZone = byId("mediaDropZone");
    const fileInput = byId("mediaFileInput");
    if (!dropZone || !fileInput) return;
    dropZone.addEventListener("click", () => fileInput.click());
    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZone.classList.add("over");
    });
    dropZone.addEventListener("dragleave", () =>
      dropZone.classList.remove("over"),
    );
    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropZone.classList.remove("over");
      if (e.dataTransfer?.files?.length)
        uploadFiles(Array.from(e.dataTransfer.files), kind, apiPath);
    });
    fileInput.addEventListener("change", () => {
      if (fileInput.files?.length) {
        uploadFiles(Array.from(fileInput.files), kind, apiPath);
        fileInput.value = "";
      }
    });
  }

  function activateMediaScreen(storageData: Dynamic) {
    const body = byId("mediaScreenBody");
    if (!body) return;
    // Remove overlay and restore panel
    body.style.cssText = "";
    body.style.filter = "";
    const overlay = body.querySelector<AdminElement>(".r2Overlay");
    if (overlay) overlay.remove();

    const m = ((storageData || {}).media || {})[kind] || { count: 0, bytes: 0 };
    const info = byId("mediaStorageInfo");
    if (info) {
      info.textContent =
        m.count === 0
          ? t("mediaInfoNonePre") + kindLabel + t("mediaInfoNoneSuf")
          : t("mediaInfoCountPre") +
            kindLabel +
            t("mediaInfoCountMid1") +
            m.count +
            t("mediaInfoCountMid2") +
            fmtBytes(m.bytes) +
            t("mediaInfoCountEnd");
    }
    byId("mediaAddBtn")?.addEventListener("click", function () {
      byId("mediaFileInput")?.click();
    });
    loadMediaList(apiPath);
    initMediaDropZone();
  }

  function showR2Unavailable() {
    const body = byId("mediaScreenBody");
    if (!body || body.querySelector<AdminElement>(".r2Overlay")) return;
    body.style.cssText = "position:relative;";
    const overlay = document.createElement("div");
    overlay.className = "r2Overlay";
    overlay.style.cssText =
      "position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:rgba(0,0,0,0.72);border-radius:inherit;z-index:10;";
    overlay.innerHTML =
      "<div style='font-size:28px;font-weight:800;color:#fff;text-align:center;padding:0 24px'>" +
      escapeHtml(t("r2EnableTitle")) +
      "</div>" +
      "<div style='font-size:13px;color:rgba(255,255,255,0.7);text-align:center;max-width:380px;line-height:1.8;padding:0 24px'>" +
      escapeHtml(t("r2EnableDesc")) +
      "</div>";
    body.appendChild(overlay);
  }

  // Check R2 availability with polling until available
  let r2PollTimer: Dynamic = null;
  function checkR2(firstCheck: Dynamic) {
    api("/api/system/storage")
      .then(function (s) {
        if (!byId("mediaScreenBody")) {
          // Screen navigated away — stop polling
          if (r2PollTimer) clearTimeout(r2PollTimer);
          return;
        }
        if (s.r2Available) {
          if (r2PollTimer) clearTimeout(r2PollTimer);
          activateMediaScreen(s);
        } else {
          if (firstCheck) showR2Unavailable();
          r2PollTimer = setTimeout(function () {
            checkR2(false);
          }, 10000);
        }
      })
      .catch(function () {
        if (!byId("mediaScreenBody")) return;
        if (firstCheck) initMediaDropZone();
        if (r2PollTimer) clearTimeout(r2PollTimer);
      });
  }
  checkR2(true);
}

function loadMediaList(apiPath: Dynamic) {
  const listEl = byId("mediaList");
  if (!listEl) return;
  listEl.innerHTML =
    "<div class='emptyState'>" + escapeHtml(t("loading")) + "</div>";
  api(apiPath)
    .then(function (data) {
      const items = data.items || [];
      if (items.length === 0) {
        listEl.innerHTML =
          "<div class='emptyState'>" + escapeHtml(t("noMedia")) + "</div>";
        return;
      }
      const isAudioList = items.length > 0 && items[0].kind === "audio";
      const isVideoList = items.length > 0 && items[0].kind === "video";
      const playColTh =
        isAudioList || isVideoList ? "<th style='width:40px'></th>" : "";
      listEl.innerHTML =
        "<table class='tableCompact' style='table-layout:fixed;width:100%'><thead><tr>" +
        playColTh +
        "<th style='width:140px'>" +
        escapeHtml(t("mediaTableMid")) +
        "</th><th style='width:52px'></th><th class='flexible'>" +
        escapeHtml(t("mediaTableFile")) +
        "</th><th style='width:80px'>" +
        escapeHtml(t("mediaTableSize")) +
        "</th><th style='width:60px'></th></tr></thead><tbody>" +
        items
          .map(function (item: Dynamic) {
            const mid = escapeHtml(item.id || "");
            const imgUrl = escapeHtml(publicBase + (item.publicPath || ""));
            const thumb =
              item.kind === "image"
                ? "<img src='" +
                  imgUrl +
                  "' class='uploadThumb' loading='lazy' alt='' style='cursor:zoom-in' data-zoom-url='" +
                  imgUrl +
                  "' data-zoom-name='" +
                  escapeHtml(item.filename || "") +
                  "' />"
                : "<div class='uploadThumbIcon'>" +
                  (item.kind === "video" ? "🎬" : "🎵") +
                  "</div>";
            const playTd =
              item.kind === "audio" || item.kind === "video"
                ? "<td style='width:40px;padding:4px 6px'><button class='secondary small' data-play-url='" +
                  escapeHtml(publicBase + (item.publicPath || "")) +
                  "' data-play-kind='" +
                  escapeHtml(item.kind) +
                  "' data-play-name='" +
                  escapeHtml(item.filename || "") +
                  "' style='padding:4px 8px;font-size:14px;line-height:1'>&#9654;</button></td>"
                : "";
            return (
              "<tr>" +
              playTd +
              "<td style='max-width:140px;overflow:hidden'>" +
              "<code style='font-size:13px;background:var(--surface-2);padding:2px 7px;border-radius:5px;cursor:pointer;word-break:break-all;display:block' title='" +
              escapeHtml(t("copyMidTooltip").replace("{mid}", mid)) +
              "' data-copy-mid='" +
              mid +
              "'>" +
              mid +
              "</code>" +
              "</td>" +
              "<td style='width:48px;padding:4px 0'>" +
              thumb +
              "</td>" +
              "<td class='flexible'><div class='uploadName'>" +
              escapeHtml(item.filename || item.publicPath || "") +
              "</div>" +
              (item.width && item.height
                ? "<div class='uploadMeta'>" +
                  item.width +
                  " × " +
                  item.height +
                  "</div>"
                : "") +
              "</td>" +
              "<td>" +
              fmtBytes(item.sizeBytes || 0) +
              "</td>" +
              "<td><div class='rowActions'><button class='danger small' data-delete-media='" +
              escapeHtml(item.id) +
              "' data-media-path='" +
              escapeHtml(apiPath) +
              "'>&#128465; " +
              escapeHtml(t("delete")) +
              "</button></div></td>" +
              "</tr>"
            );
          })
          .join("") +
        "</tbody></table>";
      // Audio play buttons
      if (isAudioList) {
        let currentAudio: Dynamic = null;
        let currentBtn: Dynamic = null;
        listEl
          .querySelectorAll<AdminElement>("[data-play-url]")
          .forEach(function (btn) {
            btn.addEventListener("click", function () {
              const url = btn.getAttribute("data-play-url");
              if (currentAudio) {
                currentAudio.pause();
                if (currentBtn) {
                  currentBtn.innerHTML = "&#9654;";
                }
                if (currentBtn === btn) {
                  currentAudio = null;
                  currentBtn = null;
                  return;
                }
              }
              if (!url) return;
              currentAudio = new Audio(url);
              currentBtn = btn;
              btn.innerHTML = "&#9646;&#9646;";
              currentAudio.play();
              currentAudio.addEventListener("ended", function () {
                btn.innerHTML = "&#9654;";
                currentAudio = null;
                currentBtn = null;
              });
            });
          });
      }
      // Video play buttons — open popup dialog
      if (isVideoList) {
        listEl
          .querySelectorAll<AdminElement>("[data-play-url]")
          .forEach(function (btn) {
            btn.addEventListener("click", function () {
              const url = btn.getAttribute("data-play-url");
              const name = btn.getAttribute("data-play-name") || "";
              const backdrop = createPopupBackdrop();
              backdrop.style.zIndex = "2300";
              backdrop.innerHTML =
                "<div style='background:var(--surface);border-radius:12px;padding:16px;width:min(92vw,900px);display:grid;gap:12px'>" +
                "<div style='display:flex;align-items:center;gap:8px'>" +
                "<span style='font-weight:700;font-size:14px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'>" +
                escapeHtml(name) +
                "</span>" +
                "<button type='button' id='videoDialogClose' class='secondary small' style='flex-shrink:0'>&#10005;</button>" +
                "</div>" +
                "<video src='" +
                escapeHtml(url) +
                "' controls autoplay style='width:100%;border-radius:8px;max-height:70vh;background:#000'></video>" +
                "</div>";
              document.body.appendChild(backdrop);
              const close = function () {
                const video = backdrop.querySelector<AdminElement>("video");
                if (video) {
                  video.pause();
                  video.removeAttribute("src");
                  video.load();
                }
                backdrop.remove();
              };
              backdrop.addEventListener("click", function (e) {
                if (e.target === backdrop) close();
              });
              backdrop
                .querySelector<AdminElement>("#videoDialogClose")!
                .addEventListener("click", close);
            });
          });
      }
      // Image zoom popup
      listEl
        .querySelectorAll<AdminElement>("[data-zoom-url]")
        .forEach(function (img) {
          img.addEventListener("click", function () {
            const url = img.getAttribute("data-zoom-url");
            const name = img.getAttribute("data-zoom-name") || "";
            const backdrop = createPopupBackdrop();
            backdrop.style.zIndex = "2300";
            backdrop.innerHTML =
              "<div style='background:var(--surface);border-radius:12px;padding:16px;width:min(92vw,900px);display:grid;gap:12px'>" +
              "<div style='display:flex;align-items:center;gap:8px'>" +
              "<span style='font-weight:700;font-size:14px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'>" +
              escapeHtml(name) +
              "</span>" +
              "<button type='button' id='imgZoomClose' class='secondary small' style='flex-shrink:0'>&#10005;</button>" +
              "</div>" +
              "<img src='" +
              escapeHtml(url) +
              "' style='width:100%;height:auto;border-radius:8px;max-height:80vh;object-fit:contain' />" +
              "</div>";
            document.body.appendChild(backdrop);
            const close = function () {
              backdrop.remove();
            };
            backdrop.addEventListener("click", function (e) {
              if (e.target === backdrop) close();
            });
            backdrop
              .querySelector<AdminElement>("#imgZoomClose")!
              .addEventListener("click", close);
          });
        });
      listEl
        .querySelectorAll<AdminElement>("[data-copy-mid]")
        .forEach(function (el) {
          el.addEventListener("click", async function () {
            try {
              await navigator.clipboard.writeText(
                "[[" + el.dataset.copyMid + "]]",
              );
              toast(t("copySuccess"), false, el);
            } catch {
              toast(t("copyFailed"), true, el);
            }
          });
        });
      listEl
        .querySelectorAll<AdminElement>("[data-delete-media]")
        .forEach(function (btn) {
          btn.addEventListener("click", async function () {
            const id = btn.getAttribute("data-delete-media");
            const path = btn.getAttribute("data-media-path");
            openEntryDialog(
              t("deleteConfirmTitle"),
              "<p>" + escapeHtml(t("deleteFileMsg")) + "</p>",
              t("delete"),
              async (_: Dynamic, close: Dynamic) => {
                try {
                  await api(path + "/" + id + "/delete", { method: "DELETE" });
                  close();
                  loadMediaList(path);
                } catch (err) {
                  toast(errorMessage(err), true);
                }
              },
            );
          });
        });
    })
    .catch(function (err) {
      if (listEl)
        listEl.innerHTML =
          "<div class='emptyState'>" +
          escapeHtml(errorMessage(err) || t("apiFailed")) +
          "</div>";
    });
}

function uploadFiles(files: Dynamic, kind: Dynamic, apiPath: Dynamic) {
  const queueEl = byId("uploadQueue");
  if (!queueEl) return;
  queueEl.style.display = "grid";

  files.forEach(async function (file: Dynamic) {
    const itemId = "up_" + Math.random().toString(36).slice(2);
    const isImg = kind === "image" && new RegExp("^image/").test(file.type);
    const thumbHtml = isImg
      ? "<img id='" + itemId + "_thumb' class='uploadThumb' />"
      : "<div class='uploadThumbIcon'>" +
        (kind === "video" ? "🎬" : "🎵") +
        "</div>";

    const row = document.createElement("div");
    row.className = "uploadItem";
    row.id = itemId;
    row.innerHTML =
      thumbHtml +
      "<div class='uploadInfo'>" +
      "<div class='uploadName'>" +
      escapeHtml(file.name) +
      "</div>" +
      "<div class='uploadMeta'>" +
      fmtBytes(file.size) +
      " · " +
      escapeHtml(file.type) +
      "</div>" +
      "</div>" +
      "<div class='uploadStatus' id='" +
      itemId +
      "_status'>" +
      escapeHtml(t("uploadPreparing")) +
      "</div>";
    queueEl.appendChild(row);

    // Show image preview immediately
    if (isImg) {
      const thumbEl = byId(itemId + "_thumb");
      if (thumbEl) thumbEl.src = URL.createObjectURL(file);
    }

    const setStatus = function (text: Dynamic, ok: Dynamic) {
      const s = byId(itemId + "_status");
      if (s) {
        s.textContent = text;
        s.className = "uploadStatus " + (ok ? "ok" : "err");
      }
    };

    try {
      setStatus(t("uploading"), true);
      const formData = new FormData();
      if (kind === "image") {
        const prepared = await prepareImageForUpload(file);
        formData.append("file", prepared.file);
        formData.append("width", String(prepared.width));
        formData.append("height", String(prepared.height));
      } else {
        formData.append("file", file);
      }
      const uploadEndpoint = isLegacyAdminPath
        ? "/admin" + apiPath + "/upload"
        : "/api/admin" + apiPath.slice(4) + "/upload";
      const resp = await fetch(withBase(uploadEndpoint), {
        method: "POST",
        body: formData,
        headers: { Authorization: "Bearer " + state.token },
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || resp.statusText);
      setStatus(t("uploadComplete"), true);
      setTimeout(function () {
        row.remove();
        if (!queueEl.children.length) queueEl.style.display = "none";
      }, 2000);
      loadMediaList(apiPath);
      // Refresh storage info
      api("/api/system/storage")
        .then(function (s) {
          const kindLabel =
            kind === "image"
              ? t("imageTypeLabel")
              : kind === "video"
                ? t("videoTypeLabel")
                : t("audioTypeLabel");
          const m = (s.media || {})[kind] || { count: 0, bytes: 0 };
          const info = byId("mediaStorageInfo");
          if (info)
            info.textContent =
              t("mediaInfoCountPre") +
              kindLabel +
              t("mediaInfoCountMid1") +
              m.count +
              t("mediaInfoCountMid2") +
              fmtBytes(m.bytes) +
              t("mediaInfoCountEnd");
        })
        .catch(function () {});
    } catch (err) {
      setStatus(errorMessage(err) || t("error"), false);
    }
  });
}

async function videos() {
  mediaScreen("video", "videos", "/api/media/videos", "video/*");
}

async function audios() {
  mediaScreen("audio", "audios", "/api/media/audios", "audio/*");
}
