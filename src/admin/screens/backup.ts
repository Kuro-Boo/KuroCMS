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
// リストア 1 リクエストの上限。⚠ 行数だけで切ってはいけない — 本文 HTML を持つ
// テーブル（document_translations / _revisions）は 1 行が実測で最大 82KB あり、
// 200 行固定だと 1 リクエスト 15MB / D1 の 1 バッチ 200 文 × 巨大バインドになる。
// バイト予算を主にし、行数は保険の上限として併用する。
const RESTORE_BATCH_BYTES = 1_000_000;
const RESTORE_BATCH_ROWS_MAX = 200;

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

  // 前回の読み込みで始まって完了しなかった処理の告知。
  // ⚠ 「実行中」ではなく【中断された】と伝える — バックアップ/復元はページ内の
  //   ループなので、再読み込みした時点で処理は死んでいる。復元の中断は DB が
  //   途中状態で残るため、やり直しが要ることまで明示する。
  const stale = backupJobInterrupted();
  const staleNotice = stale
    ? "<div class='notice error' style='margin-bottom:12px'>" +
      "<b>" +
      escapeHtml(t("backupInterruptedTitle")) +
      "</b><br>" +
      escapeHtml(
        (stale.kind === "restore"
          ? t("backupInterruptedRestore")
          : t("backupInterruptedBackup")
        )
          .replace("{phase}", stale.phase || "-")
          .replace(
            "{at}",
            new Date(stale.startedAt || Date.now()).toLocaleString(),
          ),
      ) +
      " <button type='button' id='backupStaleDismiss' class='secondary' style='margin-left:8px;font-size:11px;padding:2px 10px'>" +
      escapeHtml(t("backupInterruptedDismiss")) +
      "</button></div>"
    : "";

  shell(
    t("backup") + (stale ? " ⚠" : ""),
    staleNotice +
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
  const dismiss = byId("backupStaleDismiss");
  if (dismiss)
    dismiss.addEventListener("click", () => {
      clearBackupJob();
      backupScreen();
    });
}

// ── Progress modal ─────────────────────────────────────────────────────────
//
// バックアップ / 復元は「押したら数分間だまって進む」処理で、しかも失敗すると
// 記事とメディアが丸ごと関わる。だから進捗は【情報量を惜しまない】:
//   ・今どの段階か（削除 / データ / メディア / 仕上げ）
//   ・テーブルごとのチェックリスト（何件のうち何件済んだか）
//   ・メディアの件数と転送済みバイト数、失敗件数
//   ・経過時間と残り見込み
//   ・時刻付きの経過ログ（無言で止まったとき「どこまで行ったか」が残る）
//   ・終了時は閉じずにサマリーを出す（何が入ったのかを確認してから閉じる）
let backupProgressState: { cancelled: boolean } | null = null;

interface BackupProgressModel {
  kind: "backup" | "restore";
  title: string;
  fileName: string;
  startedAt: number;
  phase: string;
  detail: string;
  pct: number;
  tables: {
    name: string;
    total: number;
    state: "pending" | "active" | "done";
  }[];
  media: { total: number; done: number; failed: number; bytes: number };
}
let backupProgress: BackupProgressModel | null = null;
let backupTickTimer: Dynamic = null;

function fmtDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(sec / 60);
  return m + ":" + String(sec % 60).padStart(2, "0");
}

function openBackupProgress(title: string): { cancelled: boolean } {
  closeBackupProgress();
  const overlay = createPopupBackdrop();
  overlay.id = "backupProgressOverlay";
  overlay.innerHTML =
    "<div class='popupCard' role='dialog' aria-modal='true' aria-live='polite' style='width:min(620px,94vw)'>" +
    "<h3 class='popupTitle' id='backupProgTitle'></h3>" +
    "<div id='backupProgFile' class='muted' style='font-size:11px;margin-top:2px;word-break:break-all'></div>" +
    "<div id='backupProgPhase' style='font-size:13px;font-weight:700;margin-top:10px'></div>" +
    "<div style='display:flex;align-items:center;gap:10px;margin:8px 0 2px'>" +
    "<div style='flex:1;height:10px;border-radius:6px;background:var(--line);overflow:hidden'>" +
    "<div id='backupProgBar' style='height:100%;width:0%;background:var(--accent);transition:width .2s'></div>" +
    "</div>" +
    "<div id='backupProgPct' class='muted' style='font-size:12px;min-width:3.5em;text-align:right'>0%</div>" +
    "</div>" +
    "<div style='display:flex;justify-content:space-between;gap:8px'>" +
    "<div id='backupProgSub' class='muted' style='font-size:11px;word-break:break-all'></div>" +
    "<div id='backupProgTime' class='muted' style='font-size:11px;white-space:nowrap'></div>" +
    "</div>" +
    "<div id='backupProgTables' style='margin-top:10px;display:grid;grid-template-columns:1fr auto;gap:2px 12px;font-size:11px;max-height:150px;overflow:auto'></div>" +
    "<div id='backupProgMedia' style='margin-top:8px;font-size:11px'></div>" +
    "<div id='backupProgLog' style='margin-top:10px;max-height:120px;overflow:auto;font-size:11px;font-family:ui-monospace,monospace;line-height:1.6;background:var(--surface-2);border-radius:8px;padding:8px 10px'></div>" +
    "<p class='muted' id='backupProgWarn' style='font-size:11px;margin:10px 0 0'>" +
    escapeHtml(t("backupDontClose")) +
    "</p>" +
    "<div style='margin-top:14px;text-align:right'>" +
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
  // 経過時間は 1 秒ごとに動かす（止まって見えないように）
  backupTickTimer = setInterval(paintBackupTime, 1000);
  return st;
}

/** 進捗モデルの初期化。テーブル一覧とメディア総数を先に見せる。 */
function backupProgressInit(init: {
  kind: "backup" | "restore";
  title: string;
  fileName: string;
  tables: { name: string; total: number }[];
  mediaTotal: number;
}): void {
  backupProgress = {
    kind: init.kind,
    title: init.title,
    fileName: init.fileName,
    startedAt: Date.now(),
    phase: "",
    detail: "",
    pct: 0,
    tables: init.tables.map((x) => ({ ...x, state: "pending" as const })),
    media: { total: init.mediaTotal, done: 0, failed: 0, bytes: 0 },
  };
  const f = byId("backupProgFile");
  if (f) f.textContent = init.fileName;
  paintBackupTables();
  paintBackupMedia();
}

function paintBackupTables(): void {
  const box = byId("backupProgTables");
  if (!box || !backupProgress) return;
  box.innerHTML = backupProgress.tables
    .map((tb) => {
      const mark =
        tb.state === "done" ? "✓" : tb.state === "active" ? "▶" : "·";
      const color =
        tb.state === "done"
          ? "var(--accent)"
          : tb.state === "active"
            ? "var(--heading)"
            : "var(--muted)";
      return (
        "<div style='color:" +
        color +
        ";white-space:nowrap;overflow:hidden;text-overflow:ellipsis'>" +
        mark +
        " " +
        escapeHtml(tb.name) +
        "</div><div class='muted' style='text-align:right;font-variant-numeric:tabular-nums'>" +
        tb.total.toLocaleString() +
        "</div>"
      );
    })
    .join("");
}

function paintBackupMedia(): void {
  const el = byId("backupProgMedia");
  if (!el || !backupProgress) return;
  const m = backupProgress.media;
  if (!m.total) {
    el.textContent = "";
    return;
  }
  el.innerHTML =
    "<b>" +
    escapeHtml(t("mediaLabel")) +
    "</b> " +
    m.done +
    " / " +
    m.total +
    "  <span class='muted'>(" +
    fmtBytes(m.bytes) +
    ")</span>" +
    (m.failed
      ? " <span style='color:var(--danger)'>" +
        escapeHtml(t("backupFailedCount").replace("{n}", String(m.failed))) +
        "</span>"
      : "");
}

function paintBackupTime(): void {
  const el = byId("backupProgTime");
  if (!el || !backupProgress) return;
  const elapsed = Date.now() - backupProgress.startedAt;
  let text = t("backupElapsed").replace("{t}", fmtDuration(elapsed));
  if (backupProgress.pct > 3 && backupProgress.pct < 100) {
    const remain = (elapsed / backupProgress.pct) * (100 - backupProgress.pct);
    text += " / " + t("backupRemaining").replace("{t}", fmtDuration(remain));
  }
  el.textContent = text;
}

/** テーブルの状態を進める（active → done）。 */
function backupProgressTable(name: string, state: "active" | "done"): void {
  if (!backupProgress) return;
  const tb = backupProgress.tables.find((x) => x.name === name);
  if (tb) tb.state = state;
  paintBackupTables();
}

function backupProgressMedia(
  done: number,
  failed: number,
  bytes: number,
): void {
  if (!backupProgress) return;
  backupProgress.media = {
    total: backupProgress.media.total,
    done,
    failed,
    bytes,
  };
  paintBackupMedia();
}

/** ダイアログの「今なにをしているか」。ナビの作業中マークもここで更新する。 */
function setBackupPhase(
  kind: "backup" | "restore",
  phase: string,
  detail?: string,
): void {
  if (backupProgress) {
    backupProgress.phase = phase;
    backupProgress.detail = detail || "";
  }
  const el = byId("backupProgPhase");
  if (el) el.textContent = phase + (detail ? "  " + detail : "");
  backupProgressLog(phase + (detail ? " " + detail : ""));
  setBackupJob(kind, phase);
}

/** 経過ログ（1 行ずつ追記。最新が見えるよう自動スクロール）。 */
function backupProgressLog(line: string): void {
  const box = byId("backupProgLog");
  if (!box) return;
  const row = document.createElement("div");
  const now = new Date();
  const z = (n: number) => String(n).padStart(2, "0");
  row.textContent =
    z(now.getHours()) +
    ":" +
    z(now.getMinutes()) +
    ":" +
    z(now.getSeconds()) +
    "  " +
    line;
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
}

function setBackupProgress(pct: number, sub: string) {
  const clamped = Math.max(0, Math.min(100, pct));
  if (backupProgress) backupProgress.pct = clamped;
  const bar = byId("backupProgBar");
  if (bar) (bar as Dynamic).style.width = clamped + "%";
  const pctEl = byId("backupProgPct");
  if (pctEl) pctEl.textContent = Math.round(clamped) + "%";
  const subEl = byId("backupProgSub");
  if (subEl) subEl.textContent = sub;
  paintBackupTime();
}

/**
 * 終了時はダイアログを閉じずにサマリーへ切り替える。
 * ⚠ トーストは数秒で消えるので、「何件入ったのか」を確認する手段が消える。
 */
/**
 * 失敗時。ダイアログは【閉じない】— 経過ログとテーブルの進み具合を残したまま、
 * 何が起きたかを中に大きく出す。原因文はコピーしやすいよう選択可能にする。
 */
function backupProgressFail(title: string, detail: string): void {
  if (!byId("backupProgressOverlay")) {
    // ダイアログを開く前に落ちた場合だけトーストで知らせる
    toast(title + (detail ? ": " + detail : ""), true);
    return;
  }
  const warn = byId("backupProgWarn");
  if (warn) warn.remove();
  const phase = byId("backupProgPhase");
  if (phase) {
    phase.textContent = title;
    (phase as Dynamic).style.color = "var(--danger)";
  }
  const bar = byId("backupProgBar");
  if (bar) (bar as Dynamic).style.background = "var(--danger)";
  if (detail) {
    const box = byId("backupProgLog");
    if (box) {
      const row = document.createElement("div");
      row.style.cssText =
        "margin-top:6px;color:var(--danger);white-space:pre-wrap;user-select:text";
      row.textContent = detail;
      box.appendChild(row);
      box.scrollTop = box.scrollHeight;
    }
  }
  const hint = document.createElement("p");
  hint.className = "muted";
  hint.style.cssText = "font-size:11px;margin:10px 0 0";
  hint.textContent = t("backupFailHint");
  byId("backupProgLog")?.parentNode?.insertBefore(
    hint,
    byId("backupProgLog")!.nextSibling,
  );
  const btn = byId("backupProgCancel");
  if (btn) {
    btn.textContent = t("close");
    const fresh = btn.cloneNode(true) as HTMLElement;
    btn.parentNode?.replaceChild(fresh, btn);
    fresh.addEventListener("click", () => closeBackupProgress());
  }
  if (backupTickTimer) {
    clearInterval(backupTickTimer);
    backupTickTimer = null;
  }
}

function backupProgressSummary(lines: string[], ok: boolean): void {
  const warn = byId("backupProgWarn");
  if (warn) warn.remove();
  const phase = byId("backupProgPhase");
  if (phase) {
    phase.textContent = ok ? t("backupSummaryOk") : t("backupSummaryNg");
    (phase as Dynamic).style.color = ok ? "var(--accent)" : "var(--danger)";
  }
  const log = byId("backupProgLog");
  if (log)
    for (const l of lines) {
      const row = document.createElement("div");
      row.textContent = l;
      log.appendChild(row);
      log.scrollTop = log.scrollHeight;
    }
  const btn = byId("backupProgCancel");
  if (btn) {
    btn.textContent = t("close");
    const fresh = btn.cloneNode(true) as HTMLElement;
    btn.parentNode?.replaceChild(fresh, btn);
    fresh.addEventListener("click", () => closeBackupProgress());
  }
  if (backupTickTimer) {
    clearInterval(backupTickTimer);
    backupTickTimer = null;
  }
}

function closeBackupProgress() {
  const o = byId("backupProgressOverlay");
  if (o) o.remove();
  backupProgressState = null;
  backupProgress = null;
  if (backupTickTimer) {
    clearInterval(backupTickTimer);
    backupTickTimer = null;
  }
}

function backupCancelled(): boolean {
  return !!(backupProgressState && backupProgressState.cancelled);
}

// Simple yes/no confirmation returning a Promise<boolean>.
function backupConfirm(title: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "popupBackdrop";
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
  // ファイル名は保存先選択とサマリー表示の両方で使うので、この関数のスコープに置く
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 13);
  const filename = "kurocms-backup-" + stamp + ".zip";

  try {
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

    backupProgressInit({
      kind: "backup",
      title: t("backupTabBackup"),
      fileName: filename,
      tables: (manifest.tables || []).map((x: Dynamic) => ({
        name: x.name,
        total: x.count || 0,
      })),
      mediaTotal: mediaTotal,
    });
    backupProgressLog(
      t("backupPlanLine")
        .replace("{rows}", tableTotal.toLocaleString())
        .replace("{files}", String(mediaTotal))
        .replace(
          "{bytes}",
          fmtBytes(manifest.media ? manifest.media.totalBytes || 0 : 0),
        ),
    );

    const zw = new ZipWriter(sink);

    // manifest.json
    await zw.add(
      "manifest.json",
      new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    );

    // D1 tables → data/<name>.jsonl (paged stream, bounded memory).
    setBackupPhase("backup", t("backupPhaseTables"));
    for (const tbl of manifest.tables || []) {
      if (backupCancelled()) throw new Error("cancelled");
      setBackupPhase(
        "backup",
        t("backupPhaseTables"),
        tbl.name + " (" + (tbl.count || 0).toLocaleString() + ")",
      );
      backupProgressTable(tbl.name, "active");
      setBackupProgress((done / total) * 100, "data/" + tbl.name + ".jsonl");
      await zw.add("data/" + tbl.name + ".jsonl", backupTableStream(tbl.name));
      done += tbl.count || 0;
      backupProgressTable(tbl.name, "done");
      setBackupProgress((done / total) * 100, "data/" + tbl.name + ".jsonl");
    }

    // Media binaries → media/<path> (one streamed request per file).
    //
    // ⚠ 取りこぼしを黙って進めない。以前はここが `if (res.ok && res.body)` だけで、
    //   R2 の不調や実体欠損で 1 件も入らなくても「完了」と表示された（移行の
    //   検証が成立しない）。失敗は集計して最後に必ず知らせ、ZIP 内にも
    //   media-errors.json として残す（後から突き合わせられるように）。
    const mediaFailed: { mid: string; path: string; reason: string }[] = [];
    let mediaOk = 0;
    let mediaBytes = 0;
    setBackupPhase("backup", t("backupPhaseMedia"), "0/" + mediaTotal);
    let mediaCursor: number | null = 0;
    while (mediaCursor !== null) {
      const page = await api(
        "/api/system/backup/table/media_assets?cursor=" + mediaCursor,
      );
      for (const row of page.rows || []) {
        if (backupCancelled()) throw new Error("cancelled");
        const entryName = "media" + row.public_path;
        setBackupProgress((done / total) * 100, entryName);
        try {
          const res = await fetch(
            backupFetchUrl("/api/system/backup/media/" + row.mid),
            { headers: backupAuthHeaders() },
          );
          if (res.ok && res.body) {
            await zw.add(entryName, res.body, row.size_bytes || 0);
            mediaOk += 1;
            mediaBytes += Number(row.size_bytes || 0);
          } else {
            mediaFailed.push({
              mid: row.mid,
              path: row.public_path,
              reason: "HTTP " + res.status,
            });
          }
        } catch (err) {
          mediaFailed.push({
            mid: row.mid,
            path: row.public_path,
            reason: (err as Error).message || "fetch failed",
          });
        }
        done += 1;
        setBackupProgress((done / total) * 100, entryName);
        backupProgressMedia(mediaOk, mediaFailed.length, mediaBytes);
        if ((mediaOk + mediaFailed.length) % 5 === 0)
          setBackupPhase(
            "backup",
            t("backupPhaseMedia"),
            mediaOk + mediaFailed.length + "/" + mediaTotal,
          );
      }
      mediaCursor = page.nextCursor;
    }

    if (mediaFailed.length) {
      await zw.add(
        "media-errors.json",
        new TextEncoder().encode(
          JSON.stringify(
            { expected: mediaTotal, saved: mediaOk, failed: mediaFailed },
            null,
            2,
          ),
        ),
      );
    }

    setBackupPhase("backup", t("backupPhaseFinish"));
    await zw.close();
    if (writable) await writable.close();
    if (fallbackChunks) backupTriggerDownload(fallbackChunks);

    setBackupProgress(100, "");
    clearBackupJob();
    const summary = [
      "",
      t("backupSummaryFile").replace("{name}", filename),
      t("backupSummaryRows").replace("{rows}", tableTotal.toLocaleString()),
      t("backupSummaryMedia")
        .replace("{ok}", String(mediaOk))
        .replace("{total}", String(mediaTotal))
        .replace("{bytes}", fmtBytes(mediaBytes)),
      t("backupSummaryTime").replace(
        "{t}",
        fmtDuration(
          Date.now() - (backupProgress ? backupProgress.startedAt : Date.now()),
        ),
      ),
    ];
    if (mediaFailed.length) {
      summary.push(
        t("backupMediaIncomplete")
          .replace("{failed}", String(mediaFailed.length))
          .replace("{total}", String(mediaTotal)),
      );
      for (const f of mediaFailed.slice(0, 20))
        summary.push("  - " + f.mid + " " + f.reason);
    }
    backupProgressSummary(summary, mediaFailed.length === 0);
  } catch (e) {
    clearBackupJob();
    if (writable) await writable.abort().catch(() => {});
    backupProgressFail(
      (e as Error).message === "cancelled"
        ? t("backupCancelled")
        : t("backupFailed"),
      (e as Error).message === "cancelled" ? "" : errorMessage(e),
    );
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
  } catch (err) {
    // ⚠ ここを無言の return にしない。以前は「復元を押したのに何も起きない」
    //   状態が何の手掛かりも残さず発生していた（利用者のキャンセルなのか、
    //   ブラウザがピッカーを拒否したのか区別できなかった）。
    const name = (err as Dynamic)?.name;
    if (name === "AbortError" || name === "NotAllowedError") {
      toast(t("restoreCancelledPick"), false);
    } else {
      toast(t("restoreFailed") + ": " + errorMessage(err), true);
    }
    return;
  }
  if (!file) {
    toast(t("restoreCancelledPick"), false);
    return;
  }
  toast(t("restoreReading").replace("{name}", file.name), false);

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
  backupProgressInit({
    kind: "restore",
    title: t("backupTabRestore"),
    fileName: file.name,
    tables: (manifest.tables || []).map((x: Dynamic) => ({
      name: x.name,
      total: x.count || 0,
    })),
    mediaTotal: entries.filter((e: Dynamic) => e.name.startsWith("media/"))
      .length,
  });
  backupProgressLog(
    t("restoreSourceLine")
      .replace("{version}", String(manifest.kurocmsVersion || "?"))
      .replace("{at}", String(manifest.createdAt || "").slice(0, 19)),
  );
  try {
    // 1) Wipe (full replace).
    setBackupPhase("restore", t("restorePhaseWipe"), "D1");
    setBackupProgress(2, t("restorePhaseWipe"));
    await api("/api/system/restore/wipe-db", { method: "POST" });
    setBackupPhase("restore", t("restorePhaseWipe"), "R2");
    await backupWipeLoop("/api/system/restore/wipe-media");
    setBackupPhase("restore", t("restorePhaseWipe"), "KV");
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
    const skippedColumns = new Set<string>();
    const renamedRows: string[] = [];
    // ⚠ ZIP に入っているのに、こちらが知らないテーブル＝**黙って捨てる**行が
    //   ある状態。今の履歴では起きない（対象表は v1.7.7 から不変）が、将来
    //   表を減らしたときに古いバックアップの中身が無言で消えるのを防ぐ。
    const unknownTables = entries
      .filter(
        (e: Dynamic) =>
          e.name.indexOf("data/") === 0 && e.name.endsWith(".jsonl"),
      )
      .map((e: Dynamic) => e.name.slice(5, -6))
      .filter((n: string) => BACKUP_RESTORE_TABLE_ORDER.indexOf(n) < 0);
    for (const name of BACKUP_RESTORE_TABLE_ORDER) {
      if (backupCancelled()) throw new Error("cancelled");
      const entry = entries.find(
        (e: Dynamic) => e.name === "data/" + name + ".jsonl",
      );
      if (!entry) continue;
      setBackupPhase(
        "restore",
        t("restorePhaseTables"),
        name +
          " (" +
          (
            (manifest.tables || []).find((x: Dynamic) => x.name === name)
              ?.count || 0
          ).toLocaleString() +
          ")",
      );
      backupProgressTable(name, "active");
      setBackupProgress((done / total) * 100, "data/" + name + ".jsonl");
      const blob = await reader.blob(entry);
      await backupStreamJsonl(blob, async (rows) => {
        if (backupCancelled()) throw new Error("cancelled");
        const res = await api("/api/system/restore/table/" + name, {
          method: "POST",
          body: JSON.stringify({ rows }),
        });
        // 移行先に無い列は落として続行する。黙って捨てない（1 回だけ記録）。
        const sk = (res && res.skippedColumns) || [];
        for (const col of sk) {
          if (skippedColumns.has(name + "." + col)) continue;
          skippedColumns.add(name + "." + col);
          backupProgressLog(
            t("restoreSkippedColumn")
              .replace("{table}", name)
              .replace("{col}", col),
          );
        }
        // 一意制約にぶつかって退避した行。**必ず見せる** —— slug が変われば
        // 公開 URL が変わるので、知らないまま公開されるのは事故と変わらない。
        for (const r of (res && res.renamed) || []) {
          renamedRows.push(
            t("restoreRenamedRow")
              .replace("{table}", name)
              .replace("{col}", String(r.column))
              .replace("{from}", String(r.from))
              .replace("{to}", String(r.to)),
          );
          backupProgressLog(renamedRows[renamedRows.length - 1]);
        }
        done += rows.length;
        setBackupProgress((done / total) * 100, "data/" + name + ".jsonl");
      });
      backupProgressTable(name, "done");
    }

    // 4) Restore media binaries (one streamed upload per file).
    //
    // ⚠ ここも戻り値を必ず見る。以前は `await fetch(...)` の結果を捨てていたため、
    //   R2 未接続（503）や行欠損（404）で 1 件も入らなくても「完了」と出た。
    const restoreFailed: { mid: string; reason: string }[] = [];
    setBackupPhase(
      "restore",
      t("restorePhaseMedia"),
      "0/" + mediaEntries.length,
    );
    let mediaDone = 0;
    let mediaBytes = 0;
    for (const entry of mediaEntries) {
      if (backupCancelled()) throw new Error("cancelled");
      const base = entry.name.substring(entry.name.lastIndexOf("/") + 1);
      const mid = base.replace(/\.[^.]+$/, "");
      setBackupProgress((done / total) * 100, entry.name);
      const blob = await reader.blob(entry);
      try {
        const res = await fetch(
          backupFetchUrl("/api/system/restore/media/" + mid),
          {
            method: "POST",
            headers: backupAuthHeaders({
              "content-type": "application/octet-stream",
            }),
            body: blob,
          },
        );
        if (!res.ok) restoreFailed.push({ mid, reason: "HTTP " + res.status });
      } catch (err) {
        restoreFailed.push({
          mid,
          reason: (err as Error).message || "fetch failed",
        });
      }
      done += 1;
      mediaDone += 1;
      mediaBytes += blob.size || 0;
      backupProgressMedia(
        mediaDone - restoreFailed.length,
        restoreFailed.length,
        mediaBytes,
      );
      setBackupProgress((done / total) * 100, entry.name);
      if (mediaDone % 5 === 0)
        setBackupPhase(
          "restore",
          t("restorePhaseMedia"),
          mediaDone + "/" + mediaEntries.length,
        );
    }

    // 5) Finish.
    setBackupPhase("restore", t("backupPhaseFinish"));
    await api("/api/system/restore/finish", { method: "POST" });
    setBackupProgress(100, "");
    clearBackupJob();
    const summary = [
      "",
      t("restoreSummaryRows").replace("{rows}", tableTotal.toLocaleString()),
      t("restoreSummaryMedia")
        .replace("{ok}", String(mediaDone - restoreFailed.length))
        .replace("{total}", String(mediaEntries.length))
        .replace("{bytes}", fmtBytes(mediaBytes)),
      t("backupSummaryTime").replace(
        "{t}",
        fmtDuration(
          Date.now() - (backupProgress ? backupProgress.startedAt : Date.now()),
        ),
      ),
      t("restoreNextStep"),
    ];
    if (skippedColumns.size)
      summary.push(
        t("restoreSkippedSummary").replace(
          "{cols}",
          [...skippedColumns].join(", "),
        ),
      );
    if (unknownTables.length)
      summary.push(
        t("restoreUnknownTables").replace("{tables}", unknownTables.join(", ")),
      );
    if (renamedRows.length) {
      summary.push(
        t("restoreRenamedSummary").replace("{n}", String(renamedRows.length)),
      );
      for (const line of renamedRows.slice(0, 20)) summary.push("  - " + line);
      if (renamedRows.length > 20)
        summary.push("  … +" + (renamedRows.length - 20));
    }
    if (restoreFailed.length) {
      summary.push(
        t("restoreMediaIncomplete")
          .replace("{failed}", String(restoreFailed.length))
          .replace("{total}", String(mediaEntries.length)),
      );
      for (const f of restoreFailed.slice(0, 20))
        summary.push("  - " + f.mid + " " + f.reason);
    }
    if (restoreFailed.length)
      console.warn("[restore] media failures", restoreFailed);
    backupProgressSummary(summary, restoreFailed.length === 0);
  } catch (e) {
    clearBackupJob();
    // ⚠ ここでダイアログを閉じない。閉じると「どこまで進んだか」が消え、
    //   数秒で消えるトーストしか残らない（移行作業では致命的）。
    //   経過ログを残したまま、ダイアログの中にエラーを出す。
    backupProgressFail(
      (e as Error).message === "cancelled"
        ? t("backupCancelled")
        : t("restoreFailed"),
      (e as Error).message === "cancelled" ? "" : errorMessage(e),
    );
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
  onBatch: (rows: Dynamic[]) => Promise<void>,
) {
  const reader = blob
    .stream()
    .pipeThrough(new (window as Dynamic).TextDecoderStream())
    .getReader();
  let buf = "";
  let batch: Dynamic[] = [];
  let batchBytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    await onBatch(batch);
    batch = [];
    batchBytes = 0;
  };
  const push = async (line: string) => {
    batch.push(JSON.parse(line));
    // 行の JSON 長をそのまま予算に使う（送信ペイロードとほぼ一致する）
    batchBytes += line.length;
    if (
      batchBytes >= RESTORE_BATCH_BYTES ||
      batch.length >= RESTORE_BATCH_ROWS_MAX
    )
      await flush();
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += value;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) await push(line);
    }
  }
  if (buf.trim()) await push(buf);
  await flush();
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
