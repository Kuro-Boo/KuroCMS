// KuroCMS admin screen module. Concatenated by scripts/build-admin.js.
//
// Backup / Restore. The ZIP is assembled (backup) and parsed (restore) entirely
// on the client (see src/admin/lib/zipstore.ts) so neither the Worker nor the
// browser ever buffers the whole archive: media is streamed file-by-file and D1
// rows are paged. On Chromium the archive streams straight to/from disk via the
// File System Access API; other browsers fall back to in-memory transfer.

// Restore must insert parents before children — mirror of the server's order.
const BACKUP_RESTORE_TABLE_ORDER = [
  "site_settings",
  "page_templates",
  "external_connections",
  "categories",
  "taxonomy_items",
  "documents",
  "media_assets",
  "document_categories",
  "document_translations",
  "document_translation_revisions",
  "search_entries",
];
const RESTORE_BATCH_ROWS = 200;

// Build the admin-rewritten URL + auth headers for raw (streaming) fetches that
// must bypass api()'s text() buffering. Mirrors the rewrite inside api().
function backupFetchUrl(path: string): string {
  const ep = (isLegacyAdminPath as Dynamic)
    ? "/admin" + path
    : "/api/admin" + path.slice(4);
  return withBase(ep);
}
function backupAuthHeaders(extra?: Record<string, string>): Headers {
  const h = new Headers(extra || {});
  if ((state as Dynamic).token)
    h.set("authorization", "Bearer " + (state as Dynamic).token);
  return h;
}

async function backupScreen() {
  const tabs = [
    { id: "backup", label: t("backupTabBackup") },
    { id: "restore", label: t("backupTabRestore") },
  ];
  const tabBar = tabs
    .map(
      (tb, i) =>
        "<button type='button' class='settingsTab" +
        (i === 0 ? " active" : "") +
        "' data-tab='" +
        tb.id +
        "'>" +
        escapeHtml(tb.label) +
        "</button>",
    )
    .join("");

  shell(
    t("backup"),
    "<div class='settingsTabBar'>" +
      tabBar +
      "</div>" +
      // ── Backup ─────────────────────────────────────────────────────────
      "<div id='panel-backup' class='settingsPanel'>" +
      "<div class='panel stack'>" +
      "<h3>" +
      escapeHtml(t("backupTabBackup")) +
      "</h3>" +
      "<p class='muted' style='white-space:pre-line'>" +
      escapeHtml(t("backupDesc")) +
      "</p>" +
      "<div><button type='button' id='backupStartBtn'>" +
      escapeHtml(t("backupStart")) +
      "</button></div>" +
      "</div></div>" +
      // ── Restore ────────────────────────────────────────────────────────
      "<div id='panel-restore' class='settingsPanel' style='display:none'>" +
      "<div class='panel stack'>" +
      "<h3>" +
      escapeHtml(t("backupTabRestore")) +
      "</h3>" +
      "<p class='muted' style='white-space:pre-line'>" +
      escapeHtml(t("restoreDesc")) +
      "</p>" +
      "<div class='notice error' style='white-space:pre-line'>" +
      escapeHtml(t("restoreWarn")) +
      "</div>" +
      "<div><button type='button' id='restoreStartBtn'>" +
      escapeHtml(t("restoreStart")) +
      "</button></div>" +
      "</div></div>",
  );

  document.querySelectorAll<AdminElement>(".settingsTab").forEach((el) => {
    el.addEventListener("click", () => {
      const id = (el as Dynamic).dataset.tab;
      document
        .querySelectorAll<AdminElement>(".settingsTab")
        .forEach((b) => b.classList.toggle("active", b === el));
      document.querySelectorAll<AdminElement>(".settingsPanel").forEach((p) => {
        (p as Dynamic).style.display = p.id === "panel-" + id ? "" : "none";
      });
    });
  });

  const startBtn = byId("backupStartBtn");
  if (startBtn) startBtn.addEventListener("click", () => runBackup());
  const restoreBtn = byId("restoreStartBtn");
  if (restoreBtn) restoreBtn.addEventListener("click", () => runRestore());
}

// ── Progress modal ─────────────────────────────────────────────────────────
let backupProgressState: { cancelled: boolean } | null = null;

function openBackupProgress(title: string): { cancelled: boolean } {
  closeBackupProgress();
  const overlay = document.createElement("div");
  overlay.id = "backupProgressOverlay";
  overlay.className = "popupOverlay";
  overlay.innerHTML =
    "<div class='popupCard' role='dialog' aria-modal='true' style='min-width:320px'>" +
    "<h3 class='popupTitle' id='backupProgTitle'></h3>" +
    "<div style='height:10px;border-radius:6px;background:var(--line);overflow:hidden;margin:12px 0'>" +
    "<div id='backupProgBar' style='height:100%;width:0%;background:var(--accent);transition:width .2s'></div>" +
    "</div>" +
    "<div id='backupProgSub' class='muted' style='font-size:12px;min-height:18px;word-break:break-all'></div>" +
    "<div style='margin-top:16px;text-align:right'>" +
    "<button type='button' id='backupProgCancel'>" +
    escapeHtml(t("cancel")) +
    "</button></div></div>";
  document.body.appendChild(overlay);
  const titleEl = byId("backupProgTitle");
  if (titleEl) titleEl.textContent = title;
  const st = { cancelled: false };
  backupProgressState = st;
  const cancelBtn = byId("backupProgCancel");
  if (cancelBtn)
    cancelBtn.addEventListener("click", () => (st.cancelled = true));
  return st;
}

function setBackupProgress(pct: number, sub: string) {
  const bar = byId("backupProgBar");
  if (bar) (bar as Dynamic).style.width = Math.max(0, Math.min(100, pct)) + "%";
  const subEl = byId("backupProgSub");
  if (subEl) subEl.textContent = sub;
}

function closeBackupProgress() {
  const o = byId("backupProgressOverlay");
  if (o) o.remove();
  backupProgressState = null;
}

function backupCancelled(): boolean {
  return !!(backupProgressState && backupProgressState.cancelled);
}

// Simple yes/no confirmation returning a Promise<boolean>.
function backupConfirm(title: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "popupOverlay";
    overlay.innerHTML =
      "<div class='popupCard' role='dialog' aria-modal='true' style='min-width:320px'>" +
      "<h3 class='popupTitle'></h3>" +
      "<p style='white-space:pre-line;font-size:13px'></p>" +
      "<div style='margin-top:16px;display:flex;gap:8px;justify-content:flex-end'>" +
      "<button type='button' data-act='no'>" +
      escapeHtml(t("cancel")) +
      "</button>" +
      "<button type='button' data-act='yes' class='danger'>" +
      escapeHtml(t("restoreConfirmYes")) +
      "</button></div></div>";
    (overlay.querySelector(".popupTitle") as Dynamic).textContent = title;
    (overlay.querySelector("p") as Dynamic).textContent = message;
    const done = (v: boolean) => {
      overlay.remove();
      resolve(v);
    };
    overlay
      .querySelector("[data-act='no']")!
      .addEventListener("click", () => done(false));
    overlay
      .querySelector("[data-act='yes']")!
      .addEventListener("click", () => done(true));
    document.body.appendChild(overlay);
  });
}

// ── Backup ───────────────────────────────────────────────────────────────────
async function runBackup() {
  let sink: (chunk: Uint8Array) => Promise<void> | void;
  let writable: Dynamic = null;
  let fallbackChunks: Uint8Array[] | null = null;

  try {
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 13);
    const filename = "kurocms-backup-" + stamp + ".zip";
    const picker = (window as Dynamic).showSaveFilePicker;
    if (picker) {
      const handle = await picker({
        suggestedName: filename,
        types: [
          { description: "ZIP", accept: { "application/zip": [".zip"] } },
        ],
      });
      writable = await handle.createWritable();
      sink = (chunk: Uint8Array) => writable.write(chunk);
    } else {
      // Fallback: accumulate in memory then trigger a download.
      toast(t("backupFallbackWarn"), false);
      const chunks: Uint8Array[] = [];
      fallbackChunks = chunks;
      sink = (chunk: Uint8Array) => {
        chunks.push(chunk);
      };
    }
  } catch {
    return; // user dismissed the save dialog
  }

  openBackupProgress(t("backupTabBackup"));
  try {
    const manifest = await api("/api/system/backup/manifest");
    const tableTotal = (manifest.tables || []).reduce(
      (s: number, x: Dynamic) => s + (x.count || 0),
      0,
    );
    const mediaTotal = manifest.media ? manifest.media.count || 0 : 0;
    const total = tableTotal + mediaTotal || 1;
    let done = 0;

    const zw = new ZipWriter(sink);

    // manifest.json
    await zw.add(
      "manifest.json",
      new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    );

    // D1 tables → data/<name>.jsonl (paged stream, bounded memory).
    for (const tbl of manifest.tables || []) {
      if (backupCancelled()) throw new Error("cancelled");
      setBackupProgress((done / total) * 100, "data/" + tbl.name + ".jsonl");
      await zw.add("data/" + tbl.name + ".jsonl", backupTableStream(tbl.name));
      done += tbl.count || 0;
      setBackupProgress((done / total) * 100, "data/" + tbl.name + ".jsonl");
    }

    // Media binaries → media/<path> (one streamed request per file).
    let mediaCursor: number | null = 0;
    while (mediaCursor !== null) {
      const page = await api(
        "/api/system/backup/table/media_assets?cursor=" + mediaCursor,
      );
      for (const row of page.rows || []) {
        if (backupCancelled()) throw new Error("cancelled");
        const entryName = "media" + row.public_path;
        setBackupProgress((done / total) * 100, entryName);
        const res = await fetch(
          backupFetchUrl("/api/system/backup/media/" + row.mid),
          { headers: backupAuthHeaders() },
        );
        if (res.ok && res.body) {
          await zw.add(entryName, res.body, row.size_bytes || 0);
        }
        done += 1;
        setBackupProgress((done / total) * 100, entryName);
      }
      mediaCursor = page.nextCursor;
    }

    await zw.close();
    if (writable) await writable.close();
    if (fallbackChunks) backupTriggerDownload(fallbackChunks);

    setBackupProgress(100, "");
    closeBackupProgress();
    toast(t("backupDone"), false);
  } catch (e) {
    closeBackupProgress();
    if (writable) await writable.abort().catch(() => {});
    if ((e as Error).message === "cancelled") toast(t("backupCancelled"), true);
    else toast(t("backupFailed") + ": " + (e as Error).message, true);
  }
}

// Paged NDJSON stream of a table — pulls one page per backpressure request.
function backupTableStream(name: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let cursor: number | null = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cursor === null) {
        controller.close();
        return;
      }
      const d = await api(
        "/api/system/backup/table/" + name + "?cursor=" + cursor,
      );
      let out = "";
      for (const r of d.rows || []) out += JSON.stringify(r) + "\n";
      if (out) controller.enqueue(enc.encode(out));
      cursor = d.nextCursor;
      if (cursor === null) controller.close();
    },
  });
}

function backupTriggerDownload(chunks: Uint8Array[]) {
  const blob = new Blob(chunks as Dynamic, { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 13);
  a.download = "kurocms-backup-" + stamp + ".zip";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// ── Restore ──────────────────────────────────────────────────────────────────
async function runRestore() {
  let file: File | null;
  try {
    const picker = (window as Dynamic).showOpenFilePicker;
    if (picker) {
      const [handle] = await picker({
        types: [
          { description: "ZIP", accept: { "application/zip": [".zip"] } },
        ],
        multiple: false,
      });
      file = await handle.getFile();
    } else {
      file = await backupPickFileFallback();
    }
  } catch {
    return;
  }
  if (!file) return;

  let entries: Dynamic[];
  let reader: Dynamic;
  let manifest: Dynamic;
  try {
    reader = new ZipReader(file);
    entries = await reader.entries();
    const manifestEntry = entries.find(
      (e: Dynamic) => e.name === "manifest.json",
    );
    if (!manifestEntry) throw new Error(t("restoreBadFile"));
    manifest = JSON.parse(await reader.text(manifestEntry));
    if (
      !manifest.format ||
      String(manifest.format).indexOf("kurocms.full") !== 0
    )
      throw new Error(t("restoreBadFile"));
  } catch (e) {
    toast(t("restoreFailed") + ": " + (e as Error).message, true);
    return;
  }

  const ok = await backupConfirm(
    t("restoreConfirmTitle"),
    t("restoreConfirmBody"),
  );
  if (!ok) return;

  openBackupProgress(t("backupTabRestore"));
  try {
    // 1) Wipe (full replace).
    setBackupProgress(2, t("restorePhaseWipe"));
    await api("/api/system/restore/wipe-db", { method: "POST" });
    await backupWipeLoop("/api/system/restore/wipe-media");
    await backupWipeLoop("/api/system/restore/wipe-pages");

    // 2) Plan totals for progress (table row counts from manifest + media files).
    const mediaEntries = entries.filter((e: Dynamic) =>
      e.name.startsWith("media/"),
    );
    const tableTotal = (manifest.tables || []).reduce(
      (s: number, x: Dynamic) => s + (x.count || 0),
      0,
    );
    const total = tableTotal + mediaEntries.length || 1;
    let done = 0;

    // 3) Restore tables (parents → children).
    for (const name of BACKUP_RESTORE_TABLE_ORDER) {
      if (backupCancelled()) throw new Error("cancelled");
      const entry = entries.find(
        (e: Dynamic) => e.name === "data/" + name + ".jsonl",
      );
      if (!entry) continue;
      setBackupProgress((done / total) * 100, "data/" + name + ".jsonl");
      const blob = await reader.blob(entry);
      await backupStreamJsonl(blob, RESTORE_BATCH_ROWS, async (rows) => {
        if (backupCancelled()) throw new Error("cancelled");
        await api("/api/system/restore/table/" + name, {
          method: "POST",
          body: JSON.stringify({ rows }),
        });
        done += rows.length;
        setBackupProgress((done / total) * 100, "data/" + name + ".jsonl");
      });
    }

    // 4) Restore media binaries (one streamed upload per file).
    for (const entry of mediaEntries) {
      if (backupCancelled()) throw new Error("cancelled");
      const base = entry.name.substring(entry.name.lastIndexOf("/") + 1);
      const mid = base.replace(/\.[^.]+$/, "");
      setBackupProgress((done / total) * 100, entry.name);
      const blob = await reader.blob(entry);
      await fetch(backupFetchUrl("/api/system/restore/media/" + mid), {
        method: "POST",
        headers: backupAuthHeaders({
          "content-type": "application/octet-stream",
        }),
        body: blob,
      });
      done += 1;
      setBackupProgress((done / total) * 100, entry.name);
    }

    // 5) Finish.
    await api("/api/system/restore/finish", { method: "POST" });
    setBackupProgress(100, "");
    closeBackupProgress();
    toast(t("restoreDone"), false);
  } catch (e) {
    closeBackupProgress();
    if ((e as Error).message === "cancelled") toast(t("backupCancelled"), true);
    else toast(t("restoreFailed") + ": " + (e as Error).message, true);
  }
}

// Repeatedly call a cursored wipe endpoint until the server reports done.
async function backupWipeLoop(path: string) {
  let cursor: string | null = null;
  for (;;) {
    if (backupCancelled()) throw new Error("cancelled");
    const url = cursor ? path + "?cursor=" + encodeURIComponent(cursor) : path;
    const d = await api(url, { method: "POST" });
    if (d.done) break;
    cursor = d.cursor;
    if (!cursor) break;
  }
}

// Stream NDJSON from a Blob, invoking onBatch every `batchSize` rows. Bounded
// memory: only one batch and a partial line are held at a time.
async function backupStreamJsonl(
  blob: Blob,
  batchSize: number,
  onBatch: (rows: Dynamic[]) => Promise<void>,
) {
  const reader = blob
    .stream()
    .pipeThrough(new (window as Dynamic).TextDecoderStream())
    .getReader();
  let buf = "";
  let batch: Dynamic[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += value;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) {
        batch.push(JSON.parse(line));
        if (batch.length >= batchSize) {
          await onBatch(batch);
          batch = [];
        }
      }
    }
  }
  if (buf.trim()) batch.push(JSON.parse(buf));
  if (batch.length) await onBatch(batch);
}

// Classic <input type=file> fallback for browsers without showOpenFilePicker.
function backupPickFileFallback(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip,application/zip";
    input.addEventListener("change", () => {
      resolve(input.files && input.files[0] ? input.files[0] : null);
    });
    input.click();
  });
}
