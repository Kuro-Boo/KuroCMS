// Browser-side TypeScript for KuroCMS admin panel.
// Built by scripts/build-admin.js into dist/admin/admin-app.<hash>.js — do not import directly.
// accessAdminUrl is injected at runtime by the shell as window.__ACCESS_ADMIN_URL__ (src/admin-shell.ts).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dynamic = any;

type AdminElement = HTMLElement & {
  _t?: ReturnType<typeof setTimeout>;
  checked: boolean;
  disabled: boolean;
  files: FileList | null;
  href: string;
  load(): void;
  pause(): void;
  placeholder: string;
  selectionEnd: number | null;
  selectionStart: number | null;
  src: string;
  value: string;
};

type Html2Canvas = (
  element: HTMLElement,
  options?: {
    height?: number;
    logging?: boolean;
    scale?: number;
    useCORS?: boolean;
    width?: number;
  },
) => Promise<HTMLCanvasElement>;

declare const html2canvas: Html2Canvas;

const browserWindow = window as Window &
  typeof globalThis & {
    html2canvas?: Html2Canvas;
  };

function byId(id: string): AdminElement | null {
  return document.getElementById(id) as AdminElement | null;
}

/**
 * このブラウザの IANA タイムゾーン名（取れなければ ""）。
 *
 * ⚠ これを「サイトの時計」として**勝手に保存してよいのはセットアップの 1 回だけ**。
 * 管理画面を開いたブラウザ = サイトの TZ とは限らず（管理者の出張、別の国の
 * 共同管理者）、保存されると次のビルドで全ページの日付が黙って書き換わる。
 * 既存サイトでは候補として見せるだけにして、保存は利用者の操作に委ねる。
 */
function detectBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

function errorMessage(error: unknown, fallback = ""): string {
  if (!(error instanceof Error)) {
    // A thrown non-Error (e.g. a plain object) would otherwise stringify to the
    // useless "[object Object]". Surface its actual contents instead.
    if (error && typeof error === "object") {
      try {
        const j = JSON.stringify(error);
        if (j && j !== "{}") return j;
      } catch {
        /* circular / non-serializable — fall through */
      }
    }
    return String(error || fallback);
  }
  const e = error as Error & { status?: number; code?: string };
  // ⚠ **利用者が次にやることが分かる文にする。** サーバーは英語の説明と
  //   コードを返すが、それをそのまま出すと「[HTTP 409] Publish AND build …
  //   (bsky_not_published)」のようになり、何をすればよいか読み取れない。
  //   状態がはっきりしているものだけ、画面の言語で言い換える。
  //   （HTTP 番号もコードも出さない —— 対処が分かる文の方が役に立つ）
  const known = errText(e.code);
  if (known) return known;
  const status = e.status ? "[HTTP " + e.status + "] " : "";
  const code = e.code ? " (" + e.code + ")" : "";
  // SNS post failures (x_/bsky_/threads_ codes) are deliberate 5xx responses
  // about the UPSTREAM service — the Cloudflare-limit hint would mislead there
  // (the server already embeds the upstream status/body in the message).
  const upstreamSns = /^(x|bsky|threads)_/.test(e.code || "");
  // Surface a likely-Cloudflare-limit hint so it can be told apart from a bug.
  const limitLike =
    !upstreamSns &&
    ((typeof e.status === "number" && e.status >= 500) ||
      /exceed|limit|cpu|timeout|too many|rate/i.test(e.message || ""));
  const hint = limitLike ? " — " + t("cfLimitHint") : "";
  return status + e.message + code + hint;
}

/**
 * サーバーが返した `code` を、画面の言語の文に引き当てる。
 *
 * ⚠ **文言はサーバーに持たせない。** 対応言語が増えるたびに Worker へ全言語の
 *   文字列を積むことになり、配布物が膨らむうえ、UI の辞書と二重管理になる。
 *   サーバーは安定した `code` だけを返し、言い換えはここで行う ——
 *   **言語を足す作業は、他の UI 文言と同じく辞書に足すだけ**で済む。
 *
 * 引き当ては `err_<code>` → SNS の接頭辞を落とした `err_<suffix>` の順。
 * 3 サービスで同じ意味の失敗（draft / not_built / already_posted）を
 * 1 つの訳で賄うため。**辞書に無ければ空を返し、サーバーの説明文に委ねる**
 * —— 訳が無いことより、英語でも中身が読める方がよい。
 */
/**
 * 選ぶ形の切り替え(部品 .segmented・セグメントスイッチ)。選択肢から 1 つを選ぶ切り替えはこれにそろえる
 * (2026-10-22 利用者の決定)。入/切はスイッチ(.toggle)、画面の区切りはタブ(.settingsTab)で、ここではない。
 * opts は [値, 表示の HTML(呼ぶ側でエスケープ済み)]。各ボタンは data-{attr} に値を持つ。
 */
function segmentedHtml(
  attr: string,
  opts: Array<[string, string]>,
  selected: string,
  style = "",
): string {
  return (
    "<div class='segmented' role='radiogroup'" +
    (style ? " style='" + style + "'" : "") +
    ">" +
    opts
      .map(
        ([v, label]) =>
          "<button type='button' role='radio' aria-checked='" +
          (v === selected) +
          "' data-" +
          attr +
          "='" +
          escapeHtml(v) +
          "'>" +
          label +
          "</button>",
      )
      .join("") +
    "</div>"
  );
}

/** .segmented の選択を付け替える(data-{attr} が value のボタンだけ選ぶ)。 */
function markSegmented(root: ParentNode, attr: string, value: string): void {
  root
    .querySelectorAll<HTMLElement>(".segmented > button[data-" + attr + "]")
    .forEach((b) =>
      b.setAttribute(
        "aria-checked",
        String(b.getAttribute("data-" + attr) === value),
      ),
    );
}

function errText(code?: string): string {
  if (!code) return "";
  const keys = ["err_" + code];
  const bare = code.replace(/^(?:bsky|x|threads)_/, "");
  if (bare !== code) keys.push("err_" + bare);
  for (const key of keys) {
    const v = t(key);
    if (v !== key) return v; // t() は辞書に無いとキーをそのまま返す
  }
  return "";
}

/**
 * アップロードの失敗の文。決まった状態(コードが辞書にあるもの)は画面の言語で言い換え、
 * それ以外はサーバーの説明を出す。どのアップロードの口もここを通す ——
 * 口ごとに書くと、上限の言い換えが一部の口にだけ付く。
 */
function uploadErrorMessage(data: Dynamic, statusText: string): string {
  const err = data?.error;
  const code = typeof err?.code === "string" ? err.code : "";
  return (
    errText(code) ||
    err?.message ||
    code ||
    (typeof err === "string" ? err : "") ||
    statusText
  );
}

/**
 * 投げる形。コードを持たせる —— errorMessage はコードが辞書にあればその文だけを出す。
 * 持たせないと、英語の言い換えの "limit" を見て Cloudflare の制限の注記を足してしまう。
 */
function uploadError(data: Dynamic, resp: Response): Error {
  const e = new Error(uploadErrorMessage(data, resp.statusText)) as Error & {
    status?: number;
    code?: string;
  };
  e.status = resp.status;
  if (typeof data?.error?.code === "string") e.code = data.error.code;
  return e;
}

type KuroEditorInstance = {
  destroy(): void;
  getContent(): string;
  setContent(html: string): void;
  isDirty(): boolean;
  /** KE >= 2.1.1。古いバンドル対策で呼び出し側は optional chaining にする。 */
  clearDirty?(): void;
  /** KE >= 2.2.0。通常モードのキャンバス配色をホスト（サイト）の色に合わせる。 */
  setCanvasColors?(colors: { bg?: string; text?: string } | null): void;
  /** KE >= 2.4.0。ダークモード中のキャンバス配色（shape は setCanvasColors と同じ）。 */
  setCanvasDarkColors?(colors: { bg?: string; text?: string } | null): void;
  /** KE >= 2.1.0（options.canvasDark 連携は 2.3.0+）。キャンバスのダーク切替。 */
  setCanvasDark?(on: boolean): void;
  wysiwyg: HTMLElement;
  sourceArea: HTMLTextAreaElement;
  mmenu: HTMLElement;
  root: HTMLElement;
};

type KuroEditorConstructor = new (
  textarea: HTMLElement,
  options: Record<string, unknown>,
) => KuroEditorInstance;

const adminWindow = window as Window &
  typeof globalThis & {
    KuroEditor?: KuroEditorConstructor;
    KUROEDITOR_VERSION?: string;
    __ACCESS_ADMIN_URL__?: string;
    __KUROCMS_ADMIN_LOGO__?: string;
  };

const app = byId("app")!;
const normalizedAdminEntryPath = (() => {
  const value = String(adminWindow.__ACCESS_ADMIN_URL__ || "/kurocms");
  try {
    const url = new URL(value, location.origin);
    return (url.pathname || "/kurocms").replace(/\/+$/, "") || "/kurocms";
  } catch {
    return (
      (value.startsWith("/") ? value : "/" + value).replace(/\/+$/, "") ||
      "/kurocms"
    );
  }
})();
const isLegacyAdminPath = normalizedAdminEntryPath.endsWith("/admin");
const adminBasePath = isLegacyAdminPath
  ? normalizedAdminEntryPath.slice(0, -"/admin".length) || ""
  : normalizedAdminEntryPath;
// publicBase: path prefix before /kurocms (e.g. "/blog" from "/blog/kurocms")
const kurocmsIdx = adminBasePath.lastIndexOf("/kurocms");
const publicBase = kurocmsIdx > 0 ? adminBasePath.slice(0, kurocmsIdx) : "";
function withBase(path: string) {
  const clean = String(path || "/");
  const absolute = clean.startsWith("/") ? clean : "/" + clean;
  return adminBasePath + absolute || "/";
}
function adminHref(subPath = "") {
  const clean = subPath === "/" ? "" : String(subPath || "");
  if (isLegacyAdminPath) {
    return withBase("/admin" + clean);
  }
  return withBase(clean || "/");
}

const imageResizeLimitKey = "kurocms_image_resize_limit";
const DEFAULT_IMAGE_UPLOAD_MAX_BYTES = 1_000_000;
const IMAGE_UPLOAD_MAX_DIMENSION = 2000;

type PreparedUploadImage = {
  file: File;
  height: number;
  resized: boolean;
  width: number;
};

/**
 * Normalize oversized admin uploads before they reach the Worker/R2 according
 * to the limit selected on the Image Manager screen. Resized files are WebP
 * and have browser-discarded metadata.
 */
function getImageUploadMaxBytes(): number {
  try {
    const raw = localStorage.getItem(imageResizeLimitKey);
    if (raw !== null) {
      const stored = Number(raw);
      if ([0, 200_000, 500_000, 1_000_000, 2_000_000].includes(stored)) {
        return stored;
      }
    }
  } catch {
    // Storage may be unavailable in a restricted browser context.
  }
  return DEFAULT_IMAGE_UPLOAD_MAX_BYTES;
}

function setImageUploadMaxBytes(maxBytes: number): void {
  try {
    localStorage.setItem(imageResizeLimitKey, String(maxBytes));
  } catch {
    // Keep the current page usable even when localStorage is unavailable.
  }
}

async function prepareImageForUpload(file: File): Promise<PreparedUploadImage> {
  if (!file.type.startsWith("image/")) {
    throw new Error(t("imageFileRequired"));
  }
  const sourceUrl = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise<void>(function (resolve, reject) {
      image.onload = function () {
        resolve();
      };
      image.onerror = function () {
        reject(new Error("Unable to decode the selected image."));
      };
      image.src = sourceUrl;
    });
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }

  const originalWidth = image.naturalWidth;
  const originalHeight = image.naturalHeight;
  if (!originalWidth || !originalHeight) {
    throw new Error(t("imageDimensionsFailed"));
  }
  const maxBytes = getImageUploadMaxBytes();
  if (maxBytes === 0 || file.size <= maxBytes) {
    return {
      file,
      width: originalWidth,
      height: originalHeight,
      resized: false,
    };
  }

  const initialScale = Math.min(
    1,
    IMAGE_UPLOAD_MAX_DIMENSION / Math.max(originalWidth, originalHeight),
  );
  let width = Math.max(1, Math.round(originalWidth * initialScale));
  let height = Math.max(1, Math.round(originalHeight * initialScale));
  let quality = 0.84;
  let blob: Blob | null = null;

  for (let attempt = 0; attempt < 14; attempt++) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(t("imageResizeUnsupported"));
    context.drawImage(image, 0, 0, width, height);
    blob = await new Promise<Blob | null>(function (resolve) {
      canvas.toBlob(resolve, "image/webp", quality);
    });
    canvas.width = 1;
    canvas.height = 1;
    if (blob && blob.size <= maxBytes) break;
    if (quality > 0.52) {
      quality -= 0.1;
    } else {
      width = Math.max(1, Math.round(width * 0.82));
      height = Math.max(1, Math.round(height * 0.82));
    }
  }
  if (!blob || blob.size > maxBytes) {
    throw new Error(`Unable to reduce the image below ${maxBytes} bytes.`);
  }

  const baseName = file.name.replace(/\.[^.]+$/, "") || "image";
  return {
    file: new File([blob], baseName + ".webp", {
      type: "image/webp",
      lastModified: file.lastModified,
    }),
    width,
    height,
    resized: true,
  };
}
const tokenKey = "kurocms_pat";
const uiLangKey = "kurocms_ui_lang";
const colorModeKey = "kurocms_color_mode";
// バックアップ / 復元は【クライアント側のループ】で進む。ZIP の組み立ても解凍も
// ブラウザがやるので、タブを閉じる・再読み込みするとその場で止まる。何も残さないと
// 利用者は「終わったのか落ちたのか」を判断できないため、開始時に印を付け、
// 完了・取消・失敗で消す。⚠ 再読み込み後に残っている印は「実行中」ではなく
// 【中断された】ことを意味する（ループはページと一緒に死んでいる）。
const backupJobKey = "kurocms_backup_job";
type BackupJob = {
  kind: "backup" | "restore";
  phase: string;
  startedAt: number;
  /** この印を付けたページ読み込みの識別子。違えば別セッション＝中断された。 */
  session: string;
};
const backupSessionId =
  String(Date.now()) + "." + Math.random().toString(36).slice(2, 8);
function readBackupJob(): BackupJob | null {
  try {
    const raw = localStorage.getItem(backupJobKey);
    return raw ? (JSON.parse(raw) as BackupJob) : null;
  } catch {
    return null;
  }
}
/** この読み込みで走っている最中か（＝ダイアログが出ている）。 */
function backupJobLive(): boolean {
  const j = readBackupJob();
  return !!j && j.session === backupSessionId;
}
/** 前回の読み込みで始まり、完了しないまま終わったか。 */
function backupJobInterrupted(): BackupJob | null {
  const j = readBackupJob();
  return j && j.session !== backupSessionId ? j : null;
}
function setBackupJob(kind: "backup" | "restore", phase: string): void {
  try {
    const prev = readBackupJob();
    localStorage.setItem(
      backupJobKey,
      JSON.stringify({
        kind,
        phase,
        startedAt:
          prev && prev.session === backupSessionId
            ? prev.startedAt
            : Date.now(),
        session: backupSessionId,
      } satisfies BackupJob),
    );
  } catch {
    /* storage 不可なら印は諦める（本処理は続く） */
  }
  setActiveNav();
}
function clearBackupJob(): void {
  try {
    localStorage.removeItem(backupJobKey);
  } catch {
    /* ignore */
  }
  setActiveNav();
}
// ブラウザのタブタイトルに出すユーザー名（プロフィールの displayName）のキャッシュ。
// 複数の KuroCMS インスタンスを同時に開くと全部 "KuroCMS Admin" になって
// 見分けがつかないため、"KuroCMS <ユーザー名>" を表示する。セッション取得より
// 前に描画されるぶんのちらつきを避けるため localStorage に持たせる。
const adminTitleNameKey = "kurocms_admin_title_name";
/** document.title を "KuroCMS <ユーザー名>" にする。名前が空なら "KuroCMS Admin"。 */
function setAdminDocumentTitle(displayName: Dynamic): void {
  const name = String(displayName ?? "").trim();
  try {
    if (name) localStorage.setItem(adminTitleNameKey, name);
    else localStorage.removeItem(adminTitleNameKey);
  } catch {
    /* storage unavailable — タイトルは出せるのでキャッシュだけ諦める */
  }
  document.title = name ? "KuroCMS " + name : "KuroCMS Admin";
}
(function applyCachedAdminDocumentTitle() {
  let cached = "";
  try {
    cached = localStorage.getItem(adminTitleNameKey) || "";
  } catch {
    /* storage unavailable */
  }
  if (cached) document.title = "KuroCMS " + cached;
})();
// KuroCMS brand logo. The Worker shell injects the data URL generated from
// KuroBrand/asset/kuroBoo.svg, so every installation is self-contained and never depends
// on kuro.boo being reachable.
const defaultAdminLogo = String(adminWindow.__KUROCMS_ADMIN_LOGO__ || "");
const localeNames: Record<string, string> = {
  en: "English",
  ja: "日本語",
};
const supportedLocales = Object.keys(localeNames);
const menuIcons: Record<string, string> = {
  initialize:
    '<path d="M12 3v6"/><path d="M12 15v6"/><path d="M5.2 5.2l4.2 4.2"/><path d="M14.6 14.6l4.2 4.2"/><path d="M3 12h6"/><path d="M15 12h6"/><path d="M5.2 18.8l4.2-4.2"/><path d="M14.6 9.4l4.2-4.2"/>',
  dashboard: '<path d="M3 11.5L12 4l9 7.5"/><path d="M5 10.5V20h14v-9.5"/>',
  articles:
    '<path d="M7 3h10l4 4v14H7z"/><path d="M13 3v5h5"/><path d="M10 12h4"/><path d="M10 16h4"/>',
  newArticle:
    '<path d="M12 5v14"/><path d="M5 12h14"/><path d="M7 3h10l4 4v14H7z"/>',
  images:
    '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8" cy="10" r="1.5"/><path d="M21 16l-5-5-4 4-2-2-7 7"/>',
  videos:
    '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/>',
  audios:
    '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  categories: '<path d="M4 7h7l2 3h7v8H4z"/><path d="M4 7V5h6l2 2"/>',
  languageManager:
    '<path d="M3 5h18"/><path d="M3 12h12"/><path d="M3 19h18"/><circle cx="18" cy="12" r="3"/><path d="M15.5 14.5l-2 2"/>',
  types:
    '<path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h16"/><path d="M8 5v14"/><path d="M16 5v14"/>',
  siteManagement:
    '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 8h10"/><path d="M7 12h6"/>',
  profile: '<path d="M20 21a8 8 0 10-16 0"/><circle cx="12" cy="8" r="4"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a3 3 0 0 1 5.2 2c0 2-3 2.5-3 4.5"/><circle cx="12" cy="17.5" r=".6" fill="currentColor"/>',
  userManager:
    '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  backup:
    '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/>',
};
const menuItems: Record<string, Dynamic[]> = {
  setup: [
    {
      href: adminHref(""),
      nav: "/initialize",
      key: "initialize",
      icon: menuIcons.initialize,
    },
  ],
  normal: [
    {
      href: adminHref(""),
      nav: "/",
      key: "dashboard",
      icon: menuIcons.dashboard,
    },
    {
      href: adminHref("/articles/new"),
      nav: "/articles/new",
      key: "newArticle",
      icon: menuIcons.newArticle,
      labelKey: "newArticleNav",
    },
    {
      href: adminHref("/articles"),
      nav: "/articles",
      key: "articles",
      icon: menuIcons.articles,
      labelKey: "articlesNav",
    },
    {
      href: adminHref("/site"),
      nav: "/site",
      key: "siteManagement",
      icon: menuIcons.siteManagement,
    },
    {
      href: adminHref("/images"),
      nav: "/images",
      key: "images",
      icon: menuIcons.images,
    },
    {
      href: adminHref("/videos"),
      nav: "/videos",
      key: "videos",
      icon: menuIcons.videos,
    },
    {
      href: adminHref("/audios"),
      nav: "/audios",
      key: "audios",
      icon: menuIcons.audios,
    },
    {
      href: adminHref("/categories"),
      nav: "/categories",
      key: "categories",
      icon: menuIcons.categories,
    },
    {
      href: adminHref("/languages"),
      nav: "/languages",
      key: "languageManager",
      icon: menuIcons.languageManager,
    },
    {
      href: adminHref("/types"),
      nav: "/types",
      key: "types",
      icon: menuIcons.types,
    },
    {
      href: adminHref("/users"),
      nav: "/users",
      key: "userManager",
      icon: menuIcons.userManager,
      adminOnly: true,
    },
    {
      href: adminHref("/backups"),
      nav: "/backups",
      key: "backup",
      icon: menuIcons.backup,
      adminOnly: true,
    },
  ],
  footer: [
    {
      href: adminHref("/settings"),
      nav: "/settings",
      key: "settings",
      icon: menuIcons.settings,
      adminOnly: true,
    },
    {
      href: adminHref("/profile"),
      nav: "/profile",
      key: "profile",
      icon: menuIcons.profile,
    },
    {
      href: adminHref("/help"),
      nav: "/help",
      key: "help",
      icon: menuIcons.help,
    },
  ],
  mobile: [
    {
      href: adminHref(""),
      nav: "/",
      key: "dashboard",
      icon: menuIcons.dashboard,
    },
    {
      href: adminHref("/articles/new"),
      nav: "/articles/new",
      key: "newArticle",
      icon: menuIcons.newArticle,
      labelKey: "newArticleNav",
    },
    {
      href: adminHref("/articles"),
      nav: "/articles",
      key: "articles",
      icon: menuIcons.articles,
      labelKey: "articlesNav",
    },
    {
      href: adminHref("/site"),
      nav: "/site",
      key: "siteManagement",
      icon: menuIcons.siteManagement,
    },
    {
      href: adminHref("/images"),
      nav: "/images",
      key: "images",
      icon: menuIcons.images,
    },
    {
      href: adminHref("/videos"),
      nav: "/videos",
      key: "videos",
      icon: menuIcons.videos,
    },
    {
      href: adminHref("/audios"),
      nav: "/audios",
      key: "audios",
      icon: menuIcons.audios,
    },
    {
      href: adminHref("/categories"),
      nav: "/categories",
      key: "categories",
      icon: menuIcons.categories,
    },
    {
      href: adminHref("/languages"),
      nav: "/languages",
      key: "languageManager",
      icon: menuIcons.languageManager,
    },
    {
      href: adminHref("/types"),
      nav: "/types",
      key: "types",
      icon: menuIcons.types,
    },
    {
      href: adminHref("/users"),
      nav: "/users",
      key: "userManager",
      icon: menuIcons.userManager,
      adminOnly: true,
    },
    {
      href: adminHref("/settings"),
      nav: "/settings",
      key: "settings",
      icon: menuIcons.settings,
      adminOnly: true,
    },
    {
      href: adminHref("/profile"),
      nav: "/profile",
      key: "profile",
      icon: menuIcons.profile,
    },
    {
      href: adminHref("/help"),
      nav: "/help",
      key: "help",
      icon: menuIcons.help,
    },
  ],
};
const i18n = {
  en: {
    brandSub: "Headless publishing",
    initialize: "Initialize",
    dashboard: "Dashboard",
    noticeHeading: "Notices",
    noticeEmpty: "No notices",
    noticeSectionProduct: "From KuroCMS",
    noticeSectionOther: "From Entamy apps",
    noticeAck: "Got it",
    noticeLater: "Read later",
    noticeOpen: "Open",
    noticeCritical: "Urgent notice",
    noticeImportant: "Important notice",
    noticeOther: "Receive notices about other apps",
    noticeStale:
      "Could not check for new notices. Showing the last ones received.",
    articles: "Article Manager",
    articlesNav: "Articles & Build",
    newArticleNav: "New Article",
    newArticle: "New Article",
    siteManagement: "Site Manager",
    images: "Images",
    videos: "Videos",
    audios: "Audio",
    categories: "Categories",
    languageManager: "Languages",
    types: "Types",
    userManager: "Users",
    backup: "Backup",
    backupTabBackup: "Backup",
    backupTabRestore: "Restore",
    backupDesc:
      "Save all KuroCMS content and settings — articles, translations, categories, taxonomies, media library metadata, templates, site settings and SNS connections — together with the actual image / video / audio files as a single ZIP. Login accounts and credentials (users, passkeys, personal access tokens) are excluded. Note: SNS connection tokens are included, so keep the backup file private. The archive streams directly to the file you choose, so very large sites back up without running out of memory.",
    backupStart: "Back up…",
    backupDone: "Backup completed.",
    // メディアの取りこぼしを黙って完了扱いにしないための警告（{failed}/{total} を置換）
    backupMediaIncomplete:
      "Backup finished, but {failed} of {total} media files could NOT be read. See media-errors.json inside the ZIP. Do not use this archive for a migration.",
    backupFailed: "Backup failed",
    backupCancelled: "Cancelled.",
    backupFallbackWarn:
      "This browser cannot stream to disk; the backup is built in memory. Use Chrome or Edge for very large sites.",
    restoreDesc:
      "Restore a KuroCMS backup ZIP. Tables and media are streamed back one piece at a time, so large archives restore without exhausting memory.",
    restoreWarn:
      "Full replace: all current content, media and settings are deleted first, then replaced with the backup. User accounts and login credentials are not affected. This cannot be undone.",
    restoreStart: "Choose a backup to restore…",
    restoreDone:
      "Restore completed. Rebuild the public site to regenerate pages.",
    restoreMediaIncomplete:
      "Tables were restored, but {failed} of {total} media files failed to upload (see the browser console). Check that R2 is connected, then restore again.",
    restoreFailed: "Restore failed",
    restoreBadFile: "Not a valid KuroCMS backup file.",
    restoreConfirmTitle: "Replace all data?",
    restoreConfirmBody:
      "This deletes all current content, media and settings, then restores from the selected backup. This cannot be undone.",
    restoreConfirmYes: "Replace everything",
    restorePhaseWipe: "Clearing existing data…",
    restorePhaseTables: "Loading data…",
    restorePhaseMedia: "Loading media…",
    restoreReading: "Reading {name}…",
    restoreCancelledPick: "No file was selected — restore was not started.",
    backupPhaseTables: "Writing data…",
    backupPhaseMedia: "Writing media…",
    backupPhaseFinish: "Finalizing…",
    backupDontClose:
      "Keep this tab open. Closing or reloading it stops the job partway.",
    backupRunningBadge: "In progress",
    backupPlanLine: "Plan: {rows} rows + {files} media files ({bytes})",
    backupElapsed: "elapsed {t}",
    backupRemaining: "about {t} left",
    backupFailedCount: "{n} failed",
    backupSummaryOk: "Completed",
    backupSummaryNg: "Completed with problems",
    backupFailHint:
      "The log above shows how far it got. Fix the cause and run it again — the steps are safe to repeat.",
    backupSummaryFile: "File: {name}",
    backupSummaryRows: "Rows written: {rows}",
    backupSummaryMedia: "Media written: {ok} / {total} ({bytes})",
    backupSummaryTime: "Duration: {t}",
    restoreSourceLine: "Backup from KuroCMS {version}, created {at}",
    restoreSummaryRows: "Rows restored: {rows}",
    restoreSummaryMedia: "Media restored: {ok} / {total} ({bytes})",
    restoreNextStep: "Next: run a site build to regenerate the public pages.",
    restoreSkippedColumn:
      "Note: {table}.{col} was not imported — this site has no such column.",
    restoreSkippedSummary:
      "Columns not imported (absent on this destination): {cols}",
    restoreRenamedRow:
      '{table}.{col}: "{from}" was already taken, so it was changed to "{to}".',
    restoreRenamedSummary:
      "Rows whose value was changed to satisfy a unique constraint: {n} (older backups allowed these duplicates — nothing was lost)",
    restoreUnknownTables:
      "⚠ This backup contained data that the current KuroCMS does not handle, so it was not imported: {tables}",
    backupInterruptedTitle: "The previous job did not finish",
    backupInterruptedBackup:
      'A backup started at {at} stopped at "{phase}" (the tab was closed or reloaded). The saved ZIP is incomplete — delete it and run the backup again.',
    backupInterruptedRestore:
      'A restore started at {at} stopped at "{phase}" (the tab was closed or reloaded). The database may be half-restored — run the restore again from the beginning before using this site.',
    backupInterruptedDismiss: "Dismiss",
    inviteUser: "Invite User",
    settings: "Settings",
    profile: "Profile",
    help: "Help",
    setupTitle: "Set up your KuroCMS workspace",
    setupLinkMissing:
      "Open this page from the link shown when the site was installed (valid for 7 days). Without it, the first administrator cannot be created.",
    setupLead:
      "Create the first administrator. You sign in with a passkey (fingerprint or face recognition) — there is no password.",
    setupPasskeyNext:
      'Next, you will create the passkey for signing in to this site\'s admin. The window that opens next shows it as "{name}".',
    setupPasskeyTwo:
      'It is separate from the "Entamy ID（契約者）" passkey you created during installation. Use this passkey to write articles and change settings. Applying for or cancelling the contract and changing the owner\'s address are important steps, so they are confirmed with your Entamy ID passkey in a separate window.',
    setupPasskeyGo: "Continue and create the passkey",
    administrator: "Administrator",
    adminEmail: "Admin Email",
    completeSetup: "Complete Setup",
    subtitle: "Cloudflare-first headless CMS",
    apiFailed: "API request failed",
    cfLimitHint:
      "may be a Cloudflare limit (subrequests / CPU time / KV write quota)",
    documents: "Documents",
    loading: "Loading...",
    articleLoading: "Opening article…",
    start: "Start",
    overview: "Overview",
    registeredDocuments: "Articles",
    publishedDocuments: "Published",
    dashboardLead:
      "A compact overview of the current site, publishing state, domains, and content structure.",
    previewActive:
      "Preview mode is active. Setup checks are bypassed for local UI review.",
    articlesLead: "Sort, search, and click a title to edit an article.",
    newArticleLead:
      "Create and edit articles. Publish settings are managed from the article list.",
    imagesLead:
      "Manage image records and public image paths used in article bodies.",
    videosLead: "Manage video records and public video paths.",
    audiosLead: "Manage audio/music file records and public paths.",
    categoriesLead: "Define reusable categories for document classification.",
    languageManagerLead: "Register languages to be used for data entry.",
    typesLead: "Manage article types such as news, blog, and research.",
    settingsLead:
      "Set the public domain, display (base language, time zone, byline), hosting, email, social links, mobile, imports, and IP restriction, and check the region and contract.",
    profileLead:
      "Your own account, display, PATs, passkeys, and IP restriction.",
    noLanguages: "No languages registered",
    profileIdentity: "Account Information",
    legalAgreed: "Agreed version",
    legalTitle: "Terms have been updated",
    legalFirstTitle: "Before you start",
    siteMoveTitle: "Contract",
    siteMoveNowManaged:
      "This site runs on Entamy managed hosting (Entamy's Cloudflare account).",
    siteMoveNowSelf:
      "This site runs on your own Cloudflare account (self-hosted).",
    siteMoveToSelf: "Move to your own Cloudflare account",
    siteMoveToManaged: "Move to Entamy managed hosting",
    siteMoveSelfLead:
      "KuroCMS is set up in your Cloudflare account and your articles, media, settings and users are copied over. This site keeps working while it copies (it pauses only for a few minutes at the final check). When it finishes, this address shows a notice that sends visitors to the new address, and every administrator of this KuroCMS gets an email with a link to register a passkey there. Self-hosting is free.",
    siteMoveManagedLead:
      "KuroCMS is set up on Entamy's Cloudflare account and your articles, media, settings and users are copied over. This site keeps working while it copies. When it finishes, this site shows a notice that sends visitors to the new address ({id}.kurocms.site), and every administrator of this KuroCMS gets an email with a link to register a passkey there. Custom domains are not carried over. The KuroCMS installed in your own Cloudflare account is not deleted; if you no longer need it, delete it yourself after switching. You cannot choose the installation ID.",
    siteMoveManagedPrice:
      "Managed hosting is paid. The free period starts when the new site is ready (once per registered email account; an ID that has ever used managed hosting does not get a free period again). The contract belongs to the Entamy ID that installed this site.",
    siteMoveAccountId: "Cloudflare Account ID",
    siteMoveToken: "Cloudflare API token",
    siteMoveTokenHelp:
      "A token with the same permissions as a self-hosted install. Neither Entamy nor this site keeps it. If the site has media, turn on R2 in your Cloudflare dashboard first.",
    siteMoveConfirm:
      "I understand: a new install is created in my account (nothing existing is overwritten), and social-media keys and PATs are not carried over.",
    siteMoveConfirmRequired: "Please tick the checkbox to confirm.",
    siteMoveCfRequired: "Enter the 32-character Account ID and the API token.",
    siteMoveStart: "Start the move",
    siteMoveRunning: "Moving… ({p}%)",
    siteMoveShow: "Show progress",
    siteMoveStepsTitle: "Steps",
    siteMoveCloseNote:
      "Closing this window does not stop the move. You can reopen it from Settings → Contract.",
    siteMoveFailed: "The move stopped. What was copied so far is kept.",
    siteMoveResume: "Resume from where it stopped",
    siteMoveAgain: "Try again",
    siteMoveDone: "The move is complete.",
    siteMoveMailed:
      "Sent {n} administrators a link to register a passkey at the new address.",
    siteMoveNewAddress: "New address",
    siteMoveOpenAdmin: "Open the new admin panel",
    siteMoveOpsKey: "WorkerOps key",
    siteMoveOpsKeyNote:
      "The key to the new site's recovery console. Save it now somewhere safe. Delete the API token in Cloudflare after the move.",
    siteMoveStep_verify_token: "Check the token and permissions",
    siteMoveStep_reserve_names: "Check for conflicts",
    siteMoveStep_create_storage: "Create the database and storage",
    siteMoveStep_fetch_release: "Fetch the release (verify the signature)",
    siteMoveStep_deploy_app: "Deploy KuroCMS",
    siteMoveStep_apply_schema: "Initialize the database",
    siteMoveStep_bootstrap_admin: "Prepare the administrator",
    siteMoveStep_create_update_token: "Create the update-only token",
    siteMoveStep_deploy_workerops: "Deploy WorkerOps",
    siteMoveStep_finish: "Register the install",
    siteMoveStepManaged_verify_token: "Check readiness",
    siteMoveStepManaged_reserve_names: "Choose the installation ID",
    siteMoveStepManaged_create_update_token: "Prepare updates",
    siteMoveStepManaged_deploy_workerops: "Assign the public address",
    siteMoveStep_move_copy: "Copy articles and settings",
    siteMoveStep_move_media: "Copy media (checked with SHA-256)",
    siteMoveStep_move_build: "Build the public pages",
    siteMoveStep_move_check: "Final check (pauses this site for a few minutes)",
    siteMoveStep_move_finish:
      "Send passkey emails and point this address to a notice",
    err_owner_unknown:
      "The owner of this site is not known yet. Register the owner first (Settings → Contract).",
    err_wrong_direction: "This site cannot move in that direction.",
    err_move_in_progress: "A move is already in progress.",
    err_move_ticket_invalid:
      "Entamy could not confirm this site. Reload and try again.",
    err_source_too_old:
      'To move, first update KuroCMS ("Check for Update" on the dashboard).',
    err_source_busy: "This site is in the middle of another move.",
    err_media_too_large:
      "The media is larger than the managed hosting limit (10 GB per site).",
    err_already_managed: "Your Entamy ID already has a managed site.",
    err_contract_required:
      "The free period has already been used. A subscription is needed for managed hosting.",
    err_managed_unavailable:
      "Managed hosting is not accepting new sites right now.",
    err_managed_capacity_full:
      "Managed hosting is full right now. Please try again later.",
    err_managed_month_full:
      "This month's sign-ups for managed hosting are full. Please try again next month.",
    err_no_managed_install: "The managed install was not found.",
    err_entamy_unavailable:
      "Could not reach Entamy. Please try again in a moment.",
    err_invalid_input: "Check the Account ID and the API token.",
    moveReceivingTitle: "This site is moving in",
    moveReceivingLead:
      "Your articles and media are being copied from Entamy hosting. When it finishes, every administrator of this site gets an email with a link to register a passkey for this address.",
    legalTerms: "Terms of Service",
    legalPrivacy: "Privacy Policy",
    legalTokushoho: "Legal notice (Specified Commercial Transactions Act)",
    legalGdpr: "GDPR addendum",
    legalDocVersion: "Version {version}",
    legalTranslationNote:
      "This is a reference translation. The authoritative text is in {lang}.",
    legalCheckAll: "Check all",
    legalClose: "Close",
    legalAgreeButton: "Agree and continue",
    contactTitle: "Register the owner's email address",
    contactLead:
      "Register the owner's email address. The Entamy ID for it becomes the owner of this CMS: important notices about this CMS are sent there, and it holds the contract if the site moves to Entamy managed hosting. It is not used for anything else.",
    contactConsent: "I agree to this use",
    contactEmail: "Email address",
    contactRegister: "Register",
    contactLater: "Later",
    contactDecline: "Don't register",
    contactClose: "Close",
    contactSent:
      'A confirmation email was sent to {email}. Open the link in it and press "Confirm" (valid for 30 minutes).',
    contactDone: "Your contact email has been confirmed.",
    contactInvalidEmail: "Please enter a valid email address.",
    contactRateLimited:
      "Too many emails were sent. Please try again in an hour.",
    contactUnavailable:
      "The registration service is not reachable right now. Please try again later.",
    contactPanelTitle: "Site owner (Entamy ID)",
    contactInstaller:
      "The Entamy ID used to install this site with the Entamy installer is its owner.",
    siteMoveNeedOwner:
      "This site was installed before the Entamy installer, so its owner is not known yet. Register the owner's email address first (one confirmation email). That Entamy ID will hold the managed hosting contract.",
    siteMoveRegisterOwner: "Register the owner",
    siteMoveNeedUpdate:
      'To move, first update KuroCMS to v{min} or later (now v{now}). You can update from "Check for Update" on the dashboard.',
    siteMoveOwnerUnavailable:
      "Could not check the owner right now. Please try again in a moment.",
    contactPanelHelp:
      "One per site, separate from the sign-in addresses of the people who use this CMS (each person changes their own in Profile). Important notices about this CMS (security, updates, backup reminders) are sent here, and this Entamy ID holds the managed hosting contract. It is not used for anything else.",
    contactLinked: "Registered: {email} (confirmed {date})",
    contactPending: "Waiting for confirmation: {email}",
    contactNone: "Not registered",
    contactOptedOut:
      "Reporting to Entamy is turned off, so a contact cannot be registered.",
    contactChange: "Change",
    contactRemove: "Remove",
    contactRemoveConfirm:
      "Remove the contact email? Important notices will no longer reach you.",
    legalRequired: "Please tick the checkbox to agree.",
    // 導入を見分けるための番号。**"INSTALL-ID" とは呼ばない** ——
    // 導入の鍵(install_id)と取り違えられるため。
    installIdentity: "Identifier",
    profilePreferences: "Interface Preferences",
    profileApiAccess: "Personal Access Token",
    profileApiAccessLead:
      "Create a PAT for REST API access from AI tools, scripts, and external services.",
    createPatAction: "Create New Personal Access Token",
    mcpConnectTitle: "Connect AI (MCP)",
    mcpConnectLead:
      "This site also runs an MCP server, so Claude / Claude Code can manage articles conversationally. Point your AI client at the endpoint below and use a PAT (created here) as the Bearer token.",
    mcpEndpointLabel: "MCP endpoint (this site)",
    mcpConfigLabel: "Claude Code — copy & paste (replace kuro_… with your PAT)",
    email: "Email",
    mailDeliveryTitle: "Email delivery",
    mailDeliveryLead:
      "Emails from this CMS (passkey recovery, invitations, etc.) are sent by the Kuro-Boo server by default. If you set up your own domain, mail is sent within Cloudflare's free allowance and is not subject to the Kuro-Boo server's limit. If your own domain fails to send, the Kuro-Boo server sends it instead.",
    mailDeliveryRequirement:
      "To send from your own domain, this site needs a Worker Custom Domain, Email Routing enabled on that domain, and every administrator's email address added and verified as an Email Routing destination address.",
    mailDeliveryKuroLimit:
      "The Kuro-Boo server has a sending limit. Once it is reached, mail cannot be sent until the limit resets.",
    mailDeliveryCurrent: "Current method",
    mailDeliveryCustom: "Your domain (Email Routing)",
    mailDeliveryKuro: "Kuro-Boo server",
    mailDeliveryDomain: "Custom Domain",
    mailDeliverySender: "Sender",
    mailDeliveryDestination: "Destination (your address)",
    mailDeliveryZoneLabel: "Email Routing on the sender domain",
    mailDeliveryZoneStateOn: "enabled",
    mailDeliveryCfMissing:
      "This site has no Cloudflare key, so sending from your own domain cannot be set up. Mail is sent by the Kuro-Boo server.",
    mailDeliveryCfAuth:
      "This site's Cloudflare key cannot read the Cloudflare settings (the key is old or lacks permission). Sending from your own domain cannot be set up, but mail is still sent by the Kuro-Boo server.",
    mailLastTitle: "Last email",
    mailLastRouting: "sent from your own domain",
    mailLastKuro: "sent by the Kuro-Boo server",
    mailLastRelayed:
      "your own domain failed, so the Kuro-Boo server sent it instead",
    mailLastFailed: "could not be sent",
    settingsTabMail: "Email",
    emailVerified: "Verified",
    emailUnverified: "Not verified",
    emailVerifySend: "Send confirmation email",
    emailVerifySent: "Sent. Open the link in the email to confirm.",
    emailVerifyDone: "Your email address is confirmed.",
    emailVerifyExpired:
      "The link has expired. Send the confirmation email again.",
    emailVerifyInvalid: "The link is invalid or already used.",
    emailVerifyChanged:
      "The email address was changed after the link was sent. Send the confirmation email again.",
    err_email_verify_too_soon: "Please wait a minute before sending again.",
    profileEmailHelp:
      "Your address on this CMS (passkey recovery emails and similar are sent here). The site owner (Entamy ID) is shown in Settings → Contract.",
    mailDeliveryVerified: "verified",
    mailDeliveryUnverified: "not verified",
    mailDeliveryUnavailable: "Cloudflare settings could not be read",
    mailDeliveryAdminOnly: "Only an administrator can change this setting.",
    mailDeliveryToggle: "Send from my domain",
    mailDeliverySaved: "Email delivery setting updated.",
    roles: "Roles",
    interfaceLanguage: "Interface Language",
    profileSaved: "Profile saved.",
    adminRole: "Admin",
    authorRole: "Author",
    displayName: "Username",
    userIdLabel: "User ID",
    updateAccount: "Update Account",
    darkMode: "Dark Mode",
    darkModeHelp: "Switch color mode for the entire admin UI.",
    patManager: "Personal Access Tokens",
    tokenGenerated: "New token generated.",
    copy: "Copy",
    cancel: "Cancel",
    revoke: "Revoke",
    revoked: "Revoked",
    active: "Active",
    generatedToken: "Generated Token",
    patScopeNote: "PAT permissions are the same as the user's permissions.",
    copySuccess: "Copied to clipboard.",
    copyFailed: "Copy failed.",
    deleteServiceTitle: "Delete {service}",
    strapiFieldsLabel: "Strapi fields:",
    initRenderError: "Initialization error",
    imageFileRequired: "The selected file is not an image.",
    imageDimensionsFailed: "Unable to determine image dimensions.",
    imageResizeUnsupported: "Image resize is not supported.",
    tokenRevoked: "Token revoked.",
    tokenHistory: "Token History",
    width: "Width",
    height: "Height",
    noMedia: "No media records yet.",
    previewReadOnly: "Preview mode: this screen is read-only.",
    searchPlaceholder: "Search title or slug",
    entriesPerPage: "Entries per page",
    search: "Search",
    noDocuments: "No documents yet.",
    listEmpty: "None yet.",
    untitled: "(untitled)",
    title: "Title",
    slug: "Slug",
    type: "Type",
    languages: "Languages",
    draft: "Draft",
    published: "Published",
    hidden: "Hidden",
    publishAt: "Publish At",
    summary: "Summary",
    settingsTabBasic: "Basic",
    settingsTabDisplay: "Display",
    settingsTabSns: "SNS",
    settingsTabMobile: "Mobile",
    siteTimezone: "Site time zone",
    siteTimezoneHelp:
      "The clock your site keeps. It decides which calendar month an article belongs to in the archive filter, and the date shown on public pages — both for every visitor, wherever they are. Leave it on UTC only if that is really your editorial time zone. Changing it changes generated HTML, so run a build (all pages) afterwards.",
    siteTimezoneUtc: "UTC (default)",
    siteTimezoneDetected: "This browser is in {tz}.",
    showByline: "Show the author at the end of articles",
    showBylineHelp:
      "Adds “Written by: <display name of the person who created the article>” below each article, and names that person as the author in the structured data for search engines. Turn it off for sites that do not need an author line, such as company or product sites — the structured data then names the site as the author instead. Changing it changes generated HTML, so run a build (all pages) afterwards.",
    siteTimezoneAutoSet:
      "Site time zone set to {tz} (from this browser). Article dates and the monthly archive now follow it — run a build (all pages) to apply it to the public site. You can change it under Settings → Display.",
    mobileTitle: "Mobile layout (site build)",
    mobileIntro:
      "These settings change the HTML that the SITE BUILD generates for your public pages. They do not affect the KuroCMS admin screens or the editor — what you see while writing stays exactly the same.",
    mobileMediaFullWidth: "Drop media layout on phones",
    mobileMediaFullWidthHelp:
      "When ON, media in article bodies is forced to 100% width with no text wrapping on screens up to 640px. Widths and alignment you set while writing (e.g. 50% / left) still apply on desktop — they are only dropped on narrow screens, where there is no room for text to wrap beside a half-width image.",
    mobileMediaFullWidthVideo:
      "Side effect on YouTube: at full width the player is large enough to play in place, so tapping plays it right there instead of opening the enlarged overlay. Images are full width either way, so tapping still opens them enlarged as before.",
    mobileBuildNote:
      "Saving alone changes nothing on the public site — the setting is applied when pages are generated. Run a build (all pages) to reflect it.",
    mobileSavedNeedsBuild:
      "Saved. Run a build (all pages) to apply it to the public site.",
    settingsTabImport: "Import",
    settingsTabIpGate: "IP restriction",
    settingsTabRegion: "Region",
    contractAt: "Hosting started",
    contractPlan: "Billing",
    contractPlanMonth: "Monthly",
    contractPlanYear: "Yearly",
    contractStarted: "Subscribed on",
    contractRenew: "Next renewal",
    contractEnds: "Contract ends on",
    contractApply: "Subscribe to managed hosting",
    contractApplyLead:
      "There is no managed hosting contract yet. To keep using this site after the free period, subscribe on Entamy's contract page.",
    contractCancel: "Cancel the contract",
    contractOpenPage: "Open the contract page",
    contractPageNote:
      "Subscribing and cancelling happen on Entamy's contract page (a new tab), signed in with the site owner's Entamy ID. It can take up to an hour to show here.",
    contractTrialFinal: "Final free period ends",
    contractSubActive: "Active (renews automatically)",
    contractWindowTitle: "Your free period has ended",
    contractWindowLocked:
      "Until you subscribe, you cannot add articles or build (publish) at all. You can still read and back up.",
    contractWindowDelete:
      "Without a subscription, this site's data will be deleted on {date} (30 days after the free period ended). Published pages stay online until then.",
    contractWindowClose: "Close",
    contractWindowMoveHelp:
      "Moving to your own Cloudflare account (self-hosting) is free: open Settings → Contract and start the move. Articles, media and settings are copied, and the old address redirects to the new one.",
    contractGrace: "Waiting before data deletion",
    contractLastDay: "Last day",
    contractDeleteAt: "Data deletion date",
    contractDaysLeft: "Days left",
    contractDays: "{n} days",
    contractRange: "{from} – {to} ({n} days)",
    contractEndedNote:
      "The free period has ended. Without a subscription, your data will be deleted on the date above.",
    contractPending:
      "Contract details have not arrived yet. They appear within about an hour.",
    contractSynced: "Updated {date}.",
    contractNowTitle: "Your contract",
    contractPlansTitle: "Plans and prices",
    contractFormManaged:
      "Runs on Entamy managed hosting (Entamy's Cloudflare account).",
    contractFormSelf: "Runs on your own Cloudflare account (self-hosting).",
    contractBadgeSelf: "Free · no contract needed",
    contractBadgePending: "Checking",
    contractBadgeActive: "Subscribed · {plan}",
    contractBadgeCancelled: "Cancelled · usable until {date}",
    contractBadgeTrial: "Free period · {n} days left",
    contractBadgeEnded: "Free period ended · read-only",
    contractBadgeNone: "No contract",
    contractBadgeScheduled: "Subscribed · paid from {date}",
    contractScheduledNote:
      "You have subscribed to managed hosting. The first payment is made when the free period ends ({date}), and you can keep using the site without interruption. To cancel or check payments, use the Entamy contract page.",
    contractApplied: "Subscribed on",
    contractFirstCharge: "First payment",
    contractBadgeInherited:
      "Inherited from the previous contract · until {date}",
    contractInheritedUntil: "Inherited period ends",
    contractNextPlan: "Your next contract",
    contractInheritedApplyLead:
      "This site uses the period paid under the previous owner's contract. To keep using it after {date}, please subscribe.",
    contractSelfNote:
      "Self-hosting is free and needs no contract. If you move to Entamy managed hosting, it becomes paid (prices on the right).",
    contractBarUntil: "until {date}",
    contractTrialExtendedTo: "Extended by campaign to {date}",
    contractAfterTrial:
      "From {date}, managed hosting is paid. To keep using this site, subscribe before the free period ends (prices on the right). If the free period ends without a subscription, adding articles and building stop, and the data is deleted on {delete}.",
    contractPaidFrom: "Paid from",
    contractApplyLeadTrial:
      "You can subscribe during the free period. Your first payment is due when the free period ends ({date}).",
    contractPlansLead:
      "Managed hosting runs this site on Entamy's Cloudflare account, and Entamy takes care of the Cloudflare setup and updates. It is paid. Self-hosting on your own Cloudflare account is free.",
    contractRegion: "Country or region",
    contractRegionJp: "Japan (JPY)",
    contractRegionUs: "United States and others (USD)",
    contractRegionEu: "Europe (EUR)",
    contractRegionDetected:
      "Chosen from the country of your connection ({country}). The price you pay is set on the contract page.",
    contractPerMonth: "{amount} / month",
    contractPerYear: "{amount} / year",
    contractYearPerMonth: "{amount} per month",
    contractYearSaving: "about {n}% less than monthly",
    contractTaxIncluded: "tax included",
    contractPricesNotYet:
      "Prices for this region are not published yet. Subscriptions are not open in this region.",
    contractPricesUnavailable:
      "Prices could not be read. Please check them on the contract page.",
    contractRuleRenew:
      "Your subscription renews automatically on the day you subscribed (every month or every year). If that day does not exist in a month (29th–31st), the last day of that month is used.",
    contractRuleCancel:
      "If you cancel, a monthly plan stays usable until the end of the month you paid for, with no refund. A yearly plan is refunded by the month: it stays usable until the end of the contract month that includes the cancellation day, and the remaining months are refunded.",
    contractRuleTrial:
      "The free period is given once, the first time an Entamy ID uses managed hosting. If you subscribe during the free period, your first payment is due when it ends.",
    contractRuleUnpaid:
      "If the free period ends without a subscription, adding articles and building (publishing) stop, and the data is deleted {n} days later. Published pages stay online until then.",
    contractRuleSelf:
      "Self-hosting on your own Cloudflare account is free. You can move there from managed hosting with the move below.",
    regionTitle: "Where this site runs",
    regionHelp:
      "Where this KuroCMS's database (D1) and KuroCMS itself are running now. The database region is fixed when it is created and cannot be changed later; Cloudflare picks the location within the region.",
    regionDb: "Database (D1)",
    regionWorker: "KuroCMS location",
    regionEntry: "Where the request arrived",
    regionRtt: "Round trip",
    regionSame: "same region",
    regionApart: "far apart",
    regionUnknown: "Unknown",
    regionOtherPlace: "Cloudflare location ({code})",
    regionMeasure: "Measure again",
    ipGateOn: "On",
    ipGateOff: "Off",
    ipGateCurrentLabel: "This network",
    ipGateHowTitle: "How it works",
    ipGateHow1t: "Registered automatically",
    ipGateHow1b:
      "When you sign in with your passkey, the network you used is registered. Nobody has to do anything.",
    ipGateHow2t: "Extended while you use it",
    ipGateHow2b:
      "Each use extends the registration. A network you stop using is removed after the number of days below.",
    ipGateHow3t: "Other networks are confirmed by email and registered",
    ipGateHow3b:
      "If a signed-in session is used from an unregistered network, it is blocked and a confirmation link is emailed to the user. Signing in again with the passkey also registers it.",
    ipGateDetailTitle: "Advanced settings",
    ipGateDays: "days",
    ipGateTitle: "IP restriction",
    ipGateHelp:
      "The admin panel can be used only from networks registered for each user, so a stolen session cookie can't be used anywhere else. Registration is fully automatic.",
    ipGateEnabled: "Turn on IP restriction",
    ipGatePat: "Also restrict personal access tokens (PAT)",
    ipGatePatHelp:
      "Off by default. AI agents and MCP clients call the API from cloud networks and servers whose addresses change every time, so their IP often switches — that is why this can be turned off.",
    ipGateTtlV6: "Days an IPv6 network stays registered",
    ipGateTtlV4: "Days an IPv4 address stays registered",
    ipGateTtlHelp:
      "Counted from the last use. A network unused for this long is removed and registered again the next time you sign in with your passkey.",
    ipGateCurrent: "This network: {net}",
    ipGateOffConfirm:
      "Turn off IP restriction? A stolen session cookie could then be used from any network.",
    saved: "Saved",
    networkUnregistered:
      "This network isn't registered for your account, so access was blocked. We emailed you a confirmation link. Signing in again with your passkey also registers this network.",
    myNetworks: "Registered networks",
    myNetworksLead:
      "Networks registered automatically when you signed in with your passkey. The admin panel can only be used from these. Remove any you don't recognise.",
    myNetworksOff: "IP restriction is turned off on this site.",
    networkLastUsed: "Last used",
    networkExpires: "Expires",
    networkCurrent: "this network",
    networkRemoveConfirm:
      "Remove this network? Using the admin panel from it will require signing in with your passkey again.",
    ipV6Title: "Registered IPv6",
    ipV6Lead:
      "Your IPv6 networks. Besides the /64 registered automatically at sign-in, you can add the prefix your provider gives you (/48, /56, …) as a fixed entry. Fixed entries never expire, so you aren't stopped when the /64 inside them changes.",
    ipV6Placeholder: "e.g. 2400:4050:7e40::/48",
    ipV6NotePlaceholder: "Note (optional, e.g. Home)",
    ipV6Add: "Add",
    ipV6Added: "Added",
    ipV6UseCurrent: "Use this network's /64",
    ipV6Pinned: "Fixed",
    ipV6Auto: "Automatic",
    ipV6NoExpiry: "No expiry",
    ipV6Empty: "No IPv6 network is registered yet.",
    blueskyHandle: "Bluesky Handle",
    blueskyHandleHelp: "Your Bluesky handle (e.g. yourname.bsky.social).",
    left: "Left",
    siteName: "Site Name",
    siteNameHelp:
      "Internal site name shown in admin and metadata. Use [[site.name]] in templates.",
    adminUrlLabel: "KuroCMS Admin URL",
    adminUrlDerivedFromBootstrap:
      "The address of this admin screen. It follows the public domain.",
    publicDomain: "Public Domain",
    publicDomainHelp:
      "Public base URL of this site. Register a domain with Cloudflare to use a custom domain. Otherwise, your workers.dev URL works out of the box (e.g. https://yoursite.workers.dev/).",
    workerOriginUrl: "Worker Origin URL (workers.dev)",
    workerOriginHelp:
      "Your KuroCMS worker's direct URL on workers.dev (the default public URL when no custom domain is set).",
    customDomainTitle: "Custom Domain (Cloudflare)",
    currentCustomDomains: "Configured custom domains",
    noCustomDomains: "No custom domain configured yet.",
    customDomainHelp:
      "Enter a domain in a Cloudflare zone you own. Cloudflare automatically creates the DNS record and SSL certificate — no manual CNAME needed. The Cloudflare token of this install needs DNS edit permission.",
    customDomainPermNote:
      "If this failed with a permission error, the Cloudflare token of this install lacks DNS edit access. Add the domain from the Cloudflare dashboard instead: Workers & Pages → your KuroCMS Worker → Settings → Domains & Routes → Add → Custom domain.",
    setCustomDomain: "Set custom domain",
    customDomainAdded:
      "Custom domain attached. DNS and SSL are being provisioned by Cloudflare (a few minutes). Then set it as the Public Domain above.",
    r2SetupTitle: "R2 media storage",
    r2SetupHelp:
      "Only needed if you want images, video, or audio. Nothing is charged up to the free 10 GB. Set it up in your own Cloudflare (KuroCMS does not create it): 1) start R2 and create a bucket; 2) Workers & Pages → {worker} → Settings → Bindings → Add → R2 bucket, name the variable MEDIA_BUCKET and pick the bucket from step 1. Once saved, this box shows it as enabled.",
    settingsTabDomain: "Domain",
    publicDomainReset: "Reset to default",
    publicDomainResetDone:
      "Set to the default ({url}). Save, then rebuild all pages.",
    publicDomainLinksNote:
      "Links in your public pages (article URLs, canonical, sitemap and so on) are built from this public domain. After changing it, save and rebuild all pages.",
    ownDomainTitle: "Publish under your own domain",
    ownDomainLead:
      "On KuroCMS managed hosting you can publish your site under your own domain name, using Cloudflare for SaaS. KuroCMS already has the Cloudflare for SaaS contract, so there is nothing extra for you to sign up for or pay. The steps depend on where your domain's DNS is managed.",
    ownDomainDnsQuestion: "Where is your domain's DNS managed?",
    ownDomainStep1Title:
      'Enter the domain name in the public domain above and press "Prepare"',
    ownDomainStep1Desc:
      "For example blog.example.com or example.com. Preparing does not save it yet.",
    ownDomainStep2Title: "Add the TXT records to your DNS",
    ownDomainStep2DescCf:
      "Add them in the Cloudflare dashboard. Adding them does not change what the domain shows now.",
    ownDomainStep2DescOther:
      "Add them at your DNS provider. Adding them does not change what the domain shows now.",
    ownDomainStep3Title: 'Press "Check status", then "Switch domain"',
    ownDomainStep3Desc:
      'Press it a few minutes after adding the TXT records. "Switch domain" becomes available when the certificate is issued.',
    ownDomainStep4Title: "Point the domain's CNAME to this site",
    ownDomainStep4DescCf:
      "You can keep the proxy on (orange cloud). This also works for example.com. It becomes active in about a minute.",
    ownDomainStep4DescOther:
      "Many DNS providers cannot set a CNAME on example.com itself, so use a name such as blog.example.com.",
    ownDomainStep5Title: "Save and rebuild all pages",
    ownDomainStep5Desc:
      'When it is active, press "Save Site Settings" above, then rebuild all pages. It cannot be saved before it is active.',
    ownDomainRecordsBefore:
      'The TXT records appear here when you press "Prepare".',
    ownDomainTxtGone: "The TXT records are already confirmed.",
    ownDomainDnsCloudflare: "DNS on Cloudflare",
    ownDomainDnsOther: "Other DNS providers",
    ownDomainOverwriteNote:
      "When you change the CNAME, whatever the domain showed before will no longer be shown. Email (MX) and other records are not affected.",
    ownDomainPrepare: "Prepare",
    ownDomainNeedHost:
      "Enter the domain name you want to use in the public domain above.",
    ownDomainNotActiveSave:
      "This domain is not active yet. Saving it now would point your page links to an address that does not open. Save once the steps are done.",
    ownDomainCheck: "Check status",
    ownDomainSwitch: "Switch domain",
    ownDomainRemove: "Cancel this domain",
    ownDomainRemoveConfirm:
      "Remove this domain from KuroCMS? If the CNAME already points here, the domain will stop showing your site.",
    ownDomainColState: "Status",
    ownDomainRecDone: "Done",
    ownDomainRecTodo: "Not yet",
    ownDomainColName: "Name",
    ownDomainColValue: "Value",
    ownDomainColPurpose: "Purpose",
    ownDomainPurposeOwnership: "Ownership",
    ownDomainPurposeCertificate: "Certificate",
    ownDomainDone: "Your site is published under this domain.",
    err_invalid_hostname: "Enter a domain name such as blog.example.com.",
    err_hostname_taken:
      "This domain is already in use on KuroCMS managed hosting.",
    err_domain_not_verified:
      "The certificate is not issued yet. Check that the TXT records are added, then try again in a few minutes.",
    err_domain_switched:
      "This domain is already switched. Cancel it first to use another domain.",
    err_no_domain: "Prepare a domain first.",
    err_not_managed: "This is only for managed hosting.",
    err_proof_invalid:
      "Could not confirm this site to Entamy. Please try again.",
    err_domain_not_permitted:
      "Entamy cannot change the domain settings right now. Please contact Entamy.",
    err_domain_failed:
      "Could not change the domain settings. Please try again later.",
    publicDomainManagedHelp:
      'The address used for links in your public pages. By default it is your Entamy hosting address (installation-id.kurocms.site). To publish under your own domain, enter it here and press "Prepare" below. Save it once it is active.',
    r2SetupDashboard: "Open R2 in Cloudflare",
    r2SetupReady: "R2 media storage is enabled.",
    cfManualSteps:
      "Add it from the Cloudflare dashboard: Workers & Pages → your KuroCMS Worker → Settings → Domains & Routes → Add → Custom Domain → enter the domain. Cloudflare creates the DNS record and SSL automatically. After a few minutes, set it as the Public Domain above and save.",
    defaultLanguage: "Default Language",
    defaultLanguageHelp:
      "Select the fallback language used when a translation is missing for a visitor.",
    saveSiteSettings: "Save Site Settings",
    saveSnsSettings: "Save SNS Settings",
    openSnsConsole: "Open SNS console",
    siteSettingsSaved: "Site settings saved.",
    name: "Name",
    newType: "New Type",
    id: "ID",
    newCategory: "New Category",
    typeCreated: "Type created.",
    categoryCreated: "Category created.",
    error: "Error",
    availableLanguages: "Available Languages",
    searchLanguagePlaceholder: "Type to search (e.g. burmese, my)...",
    noMatches: "No matches",
    addLanguage: "Add Language",
    removeLanguage: "Remove",
    languageAdded: "Language added.",
    languageRemoved: "Language removed.",
    noRegisteredLanguages: "No language is registered yet.",
    dataUsage: "Data Usage",
    removeLanguageConfirm:
      "Remove this language from the active language list?",
    removeLanguageKeepPrompt:
      "Removing only unregisters the language — its translations are KEPT and restored if you re-add it. Tick the box below to also permanently delete its data.",
    selectLanguage: "Select Language",
    selectLanguageLead:
      "Please choose your preferred language for the administration interface. You can change this later in the settings.",
    loginTitle: "Login",
    loginLead: "Use your passkey to continue.",
    loginWithPasskey: "Login with Passkey",
    loginNewDeviceTitle: "Register a new device",
    loginNewDeviceAfter:
      "After you submit, open the one-time link in the email (valid for 30 minutes, single use) to register a new passkey on this device. Once it is registered, sign in with “Login with Passkey”.",
    registerPasskey: "Register Passkey",
    registeringPasskey: "Registering...",
    recoverRequestLead:
      "Enter your registered email. We'll send a link to register a new passkey.",
    recoverSendLink: "Send recovery link",
    mailSetupGuideTitle: "How to send from your own domain",
    mailSetupGuideIntro:
      "By default, Kuro's server sends on your behalf. Sending from your own domain uses your Cloudflare free quota and is not subject to Kuro's limit. The setup happens on Cloudflare — it cannot be done from this screen.",
    mailSetupStep1: "Step 1: Enable Email Routing on your domain",
    mailSetupStep1Body:
      "In Cloudflare, open Compute → Email Service → Email Routing, select {zone}, and enable it. The sending domain must be onboarded to your Cloudflare account.",
    mailSetupStep2: "Step 2: Add and verify a destination address",
    mailSetupStep2Body:
      "On the same screen, under Destination addresses (shared across the whole account), add every admin email address — including {address} — then open the link in each confirmation email to mark it verified. Recovery mail goes to whoever requests it, so if you have several admins you need all of them. One unverified address locks out that person alone.",
    mailSetupStep3: "Step 3: Turn on the switch here",
    mailSetupStep3Body:
      "Once steps 1 and 2 are done, the switch becomes available. With it on, mail is sent from your domain, and Kuro's server relays only when that fails.",
    mailSetupOpenCf: "Open Email Routing in Cloudflare",
    mailSetupDocs: "Cloudflare documentation",
    mailSetupNote:
      "If the status says it could not be checked, this installation's token lacks zone-level permission, so KuroCMS cannot verify it. Sending still succeeds if the setup is correct; if it fails, mail is relayed and the screen says so.",
    mailDeliveryZoneOff: "Email Routing is not enabled on the sender domain",
    mailDeliveryZoneOn: "Email Routing enabled on the sender domain",
    mailDeliveryAdminsUnverified:
      "These administrators are not verified destinations and would stop receiving recovery mail",
    // 配送の不調。**順調なときは出さない。**
    recoverRelayed:
      "Your own domain could not send this message, so kuro.boo's server delivered it instead. The mail should arrive, but the own-domain setting is not working — check Settings → Email.",
    recoverRelayedReason: "Own-domain error",
    recoverNotDelivered:
      "The message could NOT be sent. Nothing will arrive until this is resolved.",
    recoverQuota:
      "kuro.boo's sending limit has been reached. The limit resets, so try again after about 12 hours — or set up your own domain in Settings → Email to send without this limit.",
    recoverReason: "Reason",
    recoverSent:
      "If that email is registered, a recovery link has been sent. Please check your inbox.",
    recoverTitle: "Recover access",
    recoverLead: "Register a new passkey for this account.",
    logout: "Logout",
    actions: "Actions",
    edit: "Edit",
    delete: "Delete",
    update: "Update",
    save: "Save",
    updateDone: "Updated.",
    deleteDone: "Deleted.",
    confirmDeleteType: "Delete this type?",
    confirmDeleteCategory: "Delete this category?",
    addRegister: "Add Entry",
    registeredLanguagesList: "Registered Languages",
    registeredTypesList: "Registered Types",
    registeredCategoriesList: "Registered Categories",
    buildingTitle: "Building Site",
    buildSplitNote:
      "To stay within Cloudflare Worker's per-invocation limit (1000 requests), the build automatically adjusts the number of pages per pass based on request usage and continues until it completes.",
    buildPreparing: "Preparing…",
    buildBuiltLabel: "Built",
    buildSkippedLabel: "Skipped (unchanged)",
    buildErrorsLabel: "Errors",
    close: "Close",
    buildDone: "Done",
    buildIncomplete: "Not finished",
    buildIncompleteDetail:
      "The build stopped before finishing (pages or their static assets registration). Run the build again — it continues from where it stopped.",
    buildAssetsLine:
      "Static assets: uploaded {uploaded}, remaining {remaining} ({status})",
    buildCancel: "Cancel",
    buildCancelled: "Build cancelled",
    buildPassRetry:
      "Connection dropped ({err}) — retrying ({n}/{max}). Pages already built are skipped.",
    buildPassShrink:
      "A pass stopped before finishing (it may have hit the CPU limit of this Cloudflare account). Continuing with {n} page(s) per pass.",
    buildPassShrinkLangs:
      "Even one page did not fit in a pass. Continuing with {n} language(s) of a page per pass.",
    buildErrorPrefix: "Build error: ",
    unknownError: "Unknown error",
    mediaLabel: "Media",
    installedVersionLabel: "Installed Version",
    stableVersionLabel: "Stable Version",
    latestVersionLabel: "Latest Version",
    autoUpdateLabel: "Update automatically",
    autoUpdateHint:
      "ON (default): the newest version of the chosen channel is checked once a day and installed by the recovery guardian (WorkerOps), which rolls it back if it fails verification. Press Update Now when it cannot wait.",
    autoUpdateOffConfirm:
      "Turn automatic updates off? New versions will be installed only when you press Update Now.",
    updateChannelLabel: "Always update to latest",
    updateChannelHint:
      "ON: update button targets the latest release (every release). OFF: targets the stable release only (promoted by the maintainer).",
    checking: "Checking…",
    updateNow: "Update Now",
    checkForUpdate: "Check for Update",
    alreadyLatest: "You're on the latest version.",
    versionCheckFailed:
      "Could not check for the latest version. This does NOT mean you are up to date — it means the check itself did not reach GitHub. Try again later.",
    versionCheckFailedStale:
      "Could not check for the latest version — showing what was known as of {when}. A newer release may already exist.",
    updating: "Updating…",
    updateSuccessReload: "Updated. Please reload.",
    updateConfirm: "Update KuroCMS to the latest version?",
    guardianAutoHint:
      "ON (default): each time KuroCMS itself is updated, KuroCMS checks WorkerOps (the recovery guardian) and installs the newest version of the chosen channel. KuroCMS verifies the new WorkerOps and rolls it back if it does not answer.",
    guardianAutoOffConfirm:
      "Turn automatic WorkerOps updates off? New versions will be installed only when you press Update Now.",
    guardianChannelHint:
      "ON: targets the latest WorkerOps release (every release). OFF: targets the stable release only (promoted by the maintainer).",
    guardianUpdateConfirm:
      "Update WorkerOps (the recovery guardian)? KuroCMS verifies the new version and rolls it back if it does not answer. This takes up to about a minute.",
    guardianNoBinding:
      "This installation is not connected to WorkerOps, so it cannot be updated from here.",
    guardianCredsMissing:
      'The Cloudflare credentials for updates are not set, so WorkerOps cannot be updated from here. KuroCMS and WorkerOps also keep two scheduled jobs (cron) instead of one, which on a free Cloudflare account lowers how many installs fit (5 cron jobs per account). To fix: in the Cloudflare dashboard, create an API token with "Workers Scripts: Edit" for this account, and add it to this Worker (Settings → Variables and Secrets) as the secret CF_API_TOKEN, with CF_ACCOUNT_ID (the account ID) and CF_WORKER_NAME (this Worker\'s name). Updates then become available here; once WorkerOps is on a current version, KuroCMS merges the jobs into one by itself.',
    guardianLegacy:
      "This WorkerOps is too old to report its version. Updating it once makes the version visible.",
    guardianLegacyVersion: "an old version",
    guardianTargetTooOld:
      "The selected channel has no version it can update to yet ({min} or later). To try it now, turn on “Always update to latest”.",
    guardianCheckFailed:
      "Could not check the WorkerOps versions. This does NOT mean it is up to date.",
    guardianResultUpdated: "Updated WorkerOps {from} → {to} ({when}).",
    versionUpdatedAt: "Updated KuroCMS {from} → {to} ({when}).",
    guardianResultRolledBack:
      "WorkerOps {to} did not answer, so it was rolled back to the previous version ({when}). Reason: {error}",
    guardianResultFailed:
      "The WorkerOps update failed ({when}). Reason: {error}",
    guardianBusy: "WorkerOps is busy updating KuroCMS. Try again in a minute.",
    storageFreeUsage: "CF Free Tier Usage",
    storageManagedUsage: "Usage (hosted by Entamy)",
    storagePaidUsage: "CF Paid Usage (included in the plan)",
    planFree: "Free",
    cfAccountLabel: "Cloudflare account: ",
    cfAccountManaged: "Cloudflare account for hosted (managed) users",
    managedUpdateRequested:
      "Asked Entamy to check for the new version now. It is installed within a few minutes.",
    managedUpdateNote:
      "Entamy delivers the chosen version automatically. New versions are checked and installed once a day (about 24 hours after the last check). If you need an update right away, ask Entamy to update your site.",
    profileTabAccount: "Account",
    profileTabDisplay: "Display",
    profileTabPat: "PAT",
    profileTabPasskey: "Passkeys",
    profileTabNetwork: "IP restriction",
    cfAccountUnknown: "could not be checked",
    planPaid: "Paid",
    storagePlanHint:
      "Draw the gauges against the Free limits or the Workers Paid included amounts",
    paidIncludedLabel: "Included: ",
    kvWritesTodayPaid: "KV Writes (today, of monthly included)",
    kvPaidMonthlyNote:
      "Paid includes writes 1M / reads 10M per month (billed beyond, not stopped)",
    freeLimitLabel: "Free limit: ",
    managedLimitLabel: "Limit: ",
    mediaUploadFailedInline: "Upload failed: {name}",
    err_media_quota_exceeded:
      "The media storage limit has been reached. Sites hosted by Entamy have a media storage limit. Delete unused media and try again.",
    managedR2Note:
      "Sites hosted by Entamy have a media storage limit ({limit}). Delete unused media to free space.",
    r2Unavailable: "R2 not enabled",
    r2Media: "R2 Media",
    d1Database: "D1 Database",
    kvPages: "KV Pages",
    kvWritesToday: "KV Writes (today)",
    kvReadsLabel: "Reads",
    kvResetLabel: "Resets",
    kvOpsUnavailable: "No data",
    articleCountTitle: "Articles",
    publishedOfTotalTitle: "Published / Articles",
    collectionArticleCount: "Collection Total",
    sortOrder: "Sort",
    sortUpdatedDesc: "Updated: Newest",
    sortUpdatedAsc: "Updated: Oldest",
    sortPublishDesc: "Published: Newest",
    sortPublishAsc: "Published: Oldest",
    sortTitleAsc: "Title A→Z",
    categoryFilter: "Category",
    allCategories: "All",
    buildModeLabel: "Build",
    buildModeManual: "Manual build only",
    buildModeAuto: "Auto-build scheduled posts at their time",
    buildModeAlways: "Build future posts unconditionally",
    buildModeForceAll: "Force full rebuild (all pages)",
    buildNow: "Build Now",
    buildNoTemplateHint: "Please select a template first.",
    openPublicPage: "Open Built Public Site",
    publishedToast: "Publish flag set — goes live at the next build",
    unpublishedToast: "Unpublish flag set — leaves the site at the next build",
    draftToast: "Changed to Draft — leaves the site at the next build",
    unpublishAction: "Unpublish",
    publishAction: "Publish",
    titleSlugHeader: "Title / Slug",
    snsPublishStatus: "SNS Publish Status",
    snsPublished: "Published",
    snsUnpublished: "Unpublished",
    buildStateBuilt: "Built",
    buildStateUnbuilt: "Not built",
    buildStatePending: "Scheduled",
    buildStateExpired: "Ended",
    buildStateStillLive: "Not built (still live)",
    err_not_found: "Not found. It may have already been deleted.",
    err_draft: "This article is still a draft. Publish it first, then post.",
    err_not_built:
      "Published but not built yet. Build it first — posting now would share a link that does not open.",
    err_scheduled:
      "The publish time has not arrived yet, so a build will not publish it. Change the article's publish date/time, or set the build mode to build future-dated articles.",
    err_expired:
      "The unpublish time has passed, so this article is no longer published. Clear the unpublish date/time, or move it further out.",
    err_already_posted: "This article has already been posted.",
    err_not_configured:
      "This SNS is not connected. Set it up under Settings → SNS.",
    err_no_public_domain:
      "The site's public domain is not set. Set it under Settings → Domain.",
    err_invalid_field: "Some input is invalid. Please check the values.",
    err_invalid_email: "That email address is not in a valid format.",
    err_document_not_found: "The article was not found.",
    err_translation_not_found: "There is no translation for this language.",
    err_user_not_found: "The user was not found.",
    err_user_disabled: "This user is disabled.",
    err_email_taken: "That email address is already in use.",
    err_invite_not_found: "The invitation was not found.",
    err_invite_expired: "The invitation has expired. Please issue a new one.",
    err_invitation_required: "An invitation is required.",
    err_recover_invalid:
      "This recovery link is not valid. Please request a new email.",
    err_recover_expired:
      "This recovery link has expired (30 minutes). Please request a new email.",
    err_credential_exists: "This passkey is already registered.",
    err_credential_not_found: "The passkey was not found.",
    err_passkey_not_found: "The passkey was not found.",
    err_last_passkey:
      "You cannot delete your last passkey. Register another one first.",
    err_cannot_modify_self:
      "You cannot change this setting on your own account.",
    err_cannot_delete_self: "You cannot delete your own account.",
    err_slug_exists: "That slug is already in use.",
    err_slug_reserved: "That slug is reserved and cannot be used.",
    err_name_conflict: "That name already exists.",
    err_category_exists: "That category already exists.",
    err_category_in_use:
      "This category is in use by articles and cannot be deleted.",
    err_category_not_found: "The category was not found.",
    err_type_in_use: "This type is in use by articles and cannot be deleted.",
    err_type_not_found: "The type was not found.",
    err_file_too_large: "The file is too large.",
    err_invalid_file_type: "This file type is not supported.",
    err_missing_file: "No file was selected.",
    err_media_not_found: "The media file was not found.",
    err_r2_not_configured:
      "Media storage (R2) is not set up. See Settings → Basic → R2 media storage.",
    err_cf_creds_missing: "Cloudflare credentials are not configured.",
    err_custom_domain_required: "Assign a custom domain first.",
    err_email_routing_destination_unverified:
      "The destination address is not verified. Verify it in Cloudflare Email Routing.",
    err_email_routing_zone_disabled:
      "Email Routing is not enabled on the sending domain.",
    err_email_routing_admin_unverified:
      "Some admin addresses are not verified. Verify all of them.",
    err_no_community_pat:
      "The credential required for public templates is not configured.",
    err_template_owner_required: "Only the owner of this template can do that.",
    err_community_template_not_found: "The public template was not found.",
    err_setup_completed: "Setup has already been completed.",
    err_base_language_delete: "The base language cannot be deleted.",
    err_last_translation: "You cannot delete the last translation.",
    err_lang_required: "A language must be specified.",
    err_invalid_language: "That language is not supported.",
    err_body_conflict: "This was updated elsewhere. Reload before saving.",
    err_revision_not_found: "The revision was not found.",
    err_license_required: "This feature requires a license.",
    snsPostBtn: "Post",
    snsPostingBtn: "Posting…",
    snsPostConfirm:
      "Post this article to Bluesky now (title, link, cover image)?",
    snsPostDone: "Posted to {service}.",
    snsMarkOnlyBtn: "Mark done without posting",
    snsMarkOnlyDone: "Marked as posted (no post sent).",
    snsClearTitle: "Clear posted flag",
    snsClearConfirm:
      "Clear the posted flag? The actual post on the SNS is NOT deleted; the Post button will reappear for this article.",
    snsClearBtn: "Clear flag",
    snsClearDone: "Posted flag cleared.",
    snsClearHint: "Click to clear the posted flag",
    snsPostConfirmX:
      "Post this article to X now? Parent post = cover image + text; the article link is sent as a reply (or in the post body, per Settings → SNS).",
    xSettingsTitle: "X (Twitter) Auto-Post",
    xCredsHelp:
      "Enter the four credentials issued in the X Developer Portal (the app needs Read and write permission). Values are stored server-side and never shown again.",
    xApiKey: "API Key (Consumer Key)",
    xApiSecret: "API Key Secret (Consumer Secret)",
    xAccessToken: "Access Token",
    xAccessSecret: "Access Token Secret",
    xLinkInReply: "Send the article link as a reply (2 posts)",
    snsXUseAutoPost:
      'Posting credentials are configured in the "X (Twitter) Auto-Post" section above (API Key / Secret, Access Token / Secret). This card is only the handle + SID for feed display (planned).',
    xLinkInReplyHelp:
      "On X's API pricing, posts containing a link can be billed at a higher rate. When ON, each article is posted as a parent post (image + text) plus a reply carrying the link — roughly $0.015 + $0.015 ≈ $0.03 per article. When OFF, a single post includes the link in the body.",
    threadsSettingsTitle: "Threads Auto-Post",
    threadsCredsHelp:
      "Enter a long-lived Threads API access token (create an app in Meta for Developers with the threads_basic and threads_content_publish permissions). The token is stored server-side and never shown again.",
    threadsTokenUpdatedAt: "Last token update",
    threadsTokenNextRefreshAt: "Next automatic update (estimate)",
    threadsTokenUpdatePending: "Waiting for automatic confirmation",
    threadsTokenRefreshHelp:
      "The token is refreshed automatically 30 days after the last successful update. The next date is an estimate calculated from the last successful update.",
    threadsPostNote:
      "Each article is posted as ONE post: cover image + title/summary + 1 topic tag + article link (500-char limit; Threads renders only one topic tag per post). Unlike X there is no per-post pricing, so no parent/reply split.",
    snsPostConfirmThreads:
      "Post this article to Threads now? One post: cover image + text + topic tag + article link.",
    snsThreadsUseAutoPost:
      'Posting credentials are configured in the "Threads Auto-Post" card (access token). This card is only the handle for feed display (planned).',
    snsBulkTitle: "Bulk posted-flag operations",
    snsBulkSetBtn: "Mark ALL as posted",
    snsBulkClearBtn: "Clear ALL posted flags",
    snsBulkSetConfirm:
      "Set the {service} posted flag on ALL articles? Existing articles will no longer show the Post button (clear per-article by clicking its posted state, or clear all here). Articles already flagged keep their original timestamps.",
    snsBulkClearConfirm:
      "Clear the {service} posted flag from ALL articles? The Post button will reappear on every published article — be careful not to re-post old articles by accident.",
    snsBulkDone: "Updated {count} article flag(s).",
    snsPostQueued:
      "Posting started — Threads processes the image server-side, so this can take up to a minute. The row will switch to Posted automatically.",
    snsPostQueueTimeout:
      "The post has not been confirmed yet. Reload the article list in a minute to check its status.",
    statusActionsHeader: "Status / Actions",
    langsSuffix: " lang(s)",
    updatedSuffix: " updated",
    tmplTabView: "Template Preview",
    tmplTabSelect: "Select Template",
    tmplTabEdit: "Edit Template",
    tmplTabContent: "Edit Site Text",
    fontTab: "Font Management",
    fontEditorTitle: "Site Fonts",
    fontEditorHint:
      "Load web fonts so your site looks the same on every device, and pick one base font for each site language. Template font-family rules take priority.",
    fontLanguage: "Language",
    fontAvailable: "Available fonts",
    fontLoaded: "Loaded on site",
    fontAddBtn: "← Load",
    fontRemoveBtn: "Remove →",
    fontBaseMark: "Base font",
    fontBaseRequired: "Select a base font (★) before saving.",
    fontSystemLocked: "Built-in (machine-dependent) — cannot be removed",
    fontRecommended: "Recommended",
    fontSaveBtn: "Save fonts",
    fontSaved: "Fonts saved. Build the site to apply.",
    fontSaving: "Saving fonts…",
    fontPreviewText: "Aa あ亜 Mg",
    analyticsTab: "Analytics",
    analyticsTitle: "Analytics & SEO",
    analyticsHint:
      "Configure Google Analytics 4 and the site description used for SEO/social previews. Build the site to apply.",
    analyticsGa4Label: "GA4 Measurement ID",
    analyticsGa4Hint:
      "Your Google Analytics 4 measurement ID (e.g. G-XXXXXXXXXX). Leave empty to disable analytics.",
    analyticsGa4Invalid: "ID must look like G-XXXXXXXXXX.",
    analyticsDescLabel: "Site description (SEO)",
    analyticsDescHint:
      "Default meta/social description for the home and index pages (articles use their own summary).",
    analyticsSaveBtn: "Save",
    analyticsSaving: "Saving…",
    analyticsSaved: "Saved. Build the site to apply.",
    communityUnpublishedBtn: "○ Publish to Community",
    communityUpdateBtn: "↻ Update Community Template",
    tmplRenameBtn: "Rename",
    tmplRenamePrompt: "New template name:",
    tmplRenamed: "Template renamed.",
    communityNameConflictHint:
      "A community template with the same name already exists, so it cannot be published.",
    communityUpdateConfirm: "Update this template in the community library?",
    communityJsRemoved:
      "Community templates cannot contain JavaScript, so {n} script part(s) were removed from the published copy. Use the [[…]] parts (toggle, tab, …) for behaviour. Your own site keeps your template as is.",
    communityUpdateSuccess: "Community template updated!",
    communityDeleteConfirm: "Remove this template from the community library?",
    processing: "Processing…",
    communityDeleteSuccess: "Removed from community library.",
    communityPublishSuccess: "Published to community library!",
    tmplNotLoaded: "Template not loaded",
    noTemplates: "No templates",
    customBadge: "Custom",
    communityActiveBadge: "Community Published",
    inUseBadge: "In Use",
    selectTmpl: "Select",
    publicSelectTmpl: "Select Public Template",
    publicLibraryTemplate: "Public library template",
    templatePageInfo: "Page",
    templateCommunityLoadFailed: "Failed to load public template library.",
    updateTmpl: "Update",
    selectingTmpl: "Selecting…",
    templateSelected:
      "Template selected. Preview available in the Template Preview tab.",
    twCssCompiled:
      "Template CSS compiled — public pages now ship static CSS instead of the Tailwind CDN script.",
    twVersionChanged:
      "Tailwind version changed ({from} → {to}) during recompile. Review the public site — unrelated styles may have shifted.",
    refreshThumbnailHint: "Re-capture thumbnail",
    thumbnailRefreshed: "Thumbnail updated.",
    thumbnailCaptureFailed: "Failed to capture thumbnail.",
    thumbnailUpdateFailed: "Failed to update thumbnail.",
    loadingTmpl: "Loading…",
    pcMode: "Desktop",
    spMode: "Mobile",
    saveStatusSaved: "Saved ✓",
    saveStatusUnsaved: "Unsaved",
    saveStatusBodyUnsaved: "Body unsaved (save manually)",
    autoSaveLabel: "Auto-save",
    saveStatusSaving: "Saving…",
    saveStatusFailed: "Save failed: ",
    bodyConflictMsg: "body was updated elsewhere",
    appNoticeTitle: "Notice from KuroCMS",
    bodyConflictConfirm:
      "The body of this article was updated by another client (e.g. an AI) after you opened it.\n\nOverwriting keeps the other version in the revision history, so it can be restored later. If you cancel, nothing is saved now — reopen the article to load the latest version.",
    bodyConflictOverwrite: "Overwrite with my version",
    articleSavedToast: "Saved",
    mediaReusedToast: "Identical image already exists — reused {mid}",
    typeNotSelectedErr: "Type not selected",
    selectTypeMsg: "Please select an article type",
    slugEmptyErr: "Slug required",
    enterSlugMsg: "Please enter a slug",
    langNotSelectedErr: "Language not selected",
    selectLangMsg: "Please select a language",
    titleEmptyErr: "Title required",
    enterTitleMsg: "Please enter a title",
    changeToDraftEditable: "Switch to Draft (editable)",
    changeToPublished: "Switch to Published",
    buildThisArticleBtn: "Build this article only",
    revisionHistoryBtn: "History",
    revisionHistoryTitle: "Revision history",
    revisionHistoryEmpty: "No revisions yet for this language.",
    revisionHistoryRange: "Revisions {from}–{to} of {total}",
    revisionHistoryPage: "Page",
    revisionPreviewBadge: "Viewing #{n}",
    revisionPreviewExitHint: "Back to the current version",
    revisionPreviewStatus: "Viewing revision #{n} — read-only",
    revisionPreviewNoSave:
      "This is a past revision, so it cannot be edited or saved. Go back to the current version first.",
    revisionPreviewDiscardConfirm:
      "You have unsaved changes. Opening a revision will discard them. Continue?",
    revisionSource_api: "REST API",
    revisionSource_mcp: "AI (MCP)",
    revisionSource_admin: "Admin (saved)",
    revisionSource_autosave: "Admin (autosave)",
    revisionSource_maintenance: "Maintenance",
    revisionSource_import: "Import",
    revisionSource_unknown: "Unknown",
    revisionSummaryMissing: "(no summary was recorded in this revision)",
    revisionLatestBadge: "Latest",
    revisionRestoreBtn: "Copy to latest",
    revisionRestoreBtnWrap: "Copy to\nlatest",
    revisionDiffBtn: "Diff",
    revisionDiffDialogTitle: "Changes: Rev.{n} → current",
    revisionDiffLead:
      "What changed from Rev.{n} to the current version. Green = added, red = removed. The body is compared paragraph by paragraph (text only).",
    revisionDiffSame: "No changes.",
    revisionDiffTitleLabel: "Title",
    revisionDiffSummaryLabel: "Summary",
    revisionDiffBodyLabel: "Body",
    revisionRestoreDraftOnly:
      "Only a draft can be restored. Switch the article to draft first.",
    revisionRestoreTitle: "Restore this revision",
    revisionRestoreLead:
      "A NEW version will be created from #{n} ({date} / {who}).",
    revisionRestoreIncludes:
      "Restored: title, summary, body, SEO (cover), hashtags",
    revisionRestoreExcludes:
      "NOT restored: categories, publish date, article type (they are not part of a revision)",
    revisionRestoreKeepsSummary:
      "This revision has no recorded summary, so the current summary is kept as-is",
    revisionRestoreUndoNote:
      "The content being replaced is saved to history first, so this can be undone.",
    revisionRestoreAction: "Copy to latest",
    revisionRestoreDone: "Restored #{n} as the latest version.",
    buildingBadge: "Building…",
    buildThisArticleDraftHint:
      "Only a published article can be built. Switch it to Published first.",
    buildThisArticleBusy: "Building…",
    buildThisArticleDone: "Rebuilt this article's public pages.",
    editLockedHint:
      "To edit, switch to draft mode using the button at the top right.",
    articleTypeLabel: "Article Type",
    categoryAddBtn: "Add Category",
    publishTimeLabel: "Publish Time",
    hashtagLabel: "Hashtag",
    coverImageLabel: "Cover Image",
    selectCoverBtn: "Load from File",
    clearCoverBtn: "Clear",
    coverDropHint: "Drop here or load from file",
    coverMidHint:
      "Specify a cover by image id, e.g. [[img-xxx]]. Loads when you leave the field.",
    coverMidNotFound: "No image found for that id.",
    r2CoverUnavail: "Media needs R2. See Settings → Basic → R2 media storage.",
    slugLabelNote: "read-only, click to copy",
    slugCopyHint: "Click to copy",
    slugHint:
      "Lowercase letters, numbers and hyphens only (start with a letter or number). Cannot be changed after creation.",
    articleTitlePlaceholder: "Enter article title",
    summaryPlaceholder: "Summary (up to 200 chars · used for SNS)",
    bodyLabel: "Body",
    selectTypeEmpty: "Select type…",
    langLoadFailed: "Failed to load languages",
    typeLoadFailed: "Failed to load types",
    unregisteredSuffix: "(unregistered)",
    catLoadFailed: "Failed to load categories: ",
    dropZoneLead: "Drop files here or click to select",
    r2EnableTitle: "Enable R2 to use media",
    // ⚠ media.ts の overlay は escapeHtml を通す＝タグ不可（プレーンテキストのみ）。
    // Cloudflare 側で始めただけでは使えず、KuroCMS の「R2 利用開始」を押して
    // はじめてバケットが繋がるので、2 段階であることを必ず書く。
    r2EnableDesc:
      "Images, video and audio are stored in Cloudflare R2. Nothing is charged up to the free 10 GB. Set it up in your own Cloudflare by following the steps under Settings → Basic → R2 media storage (start R2, create a bucket, and bind it to this Worker as MEDIA_BUCKET). Once it is bound, this screen becomes available.",
    uploadPreparing: "Preparing…",
    uploading: "Uploading…",
    uploadComplete: "Done",
    imageAutoResize: "Automatic image resizing",
    imageResizeNone: "Do not convert",
    imageResize200k: "Reduce to 200 KB or less",
    imageResize500k: "Reduce to 500 KB or less",
    imageResize1m: "Reduce to 1 MB or less",
    imageResize2m: "Reduce to 2 MB or less",
    deleteConfirmTitle: "Confirm Delete",
    deleteFileMsg: "Delete this file? This cannot be undone.",
    helpRoleLabel: "Description",
    helpCanDoLabel: "What you can do",
    helpNotesLabel: "Notes",
    publishDateLabel: "Publish Date",
    imageTypeLabel: "Images",
    videoTypeLabel: "Videos",
    audioTypeLabel: "Music",
    r2MediaUnavailMsg:
      "Media unavailable<br>Settings → Basic → R2 media storage",
    tmplCommunityLocked: "🔒 Published to community — cannot edit",
    tmplCommunityUnlockHint:
      "Unpublish from community in the Template Preview tab first.",
    deleteUserTitle: "Delete User",
    userDeletedToast: "User deleted.",
    confirmDeleteUserPost: " will be deleted. This cannot be undone.",
    hashtagPlaceholder: "#tag1 #tag2 (space-separated)",
    communityPublishHint: "Click to publish to community library",
    communityPublishConfirm:
      "Publish this template to the kuro.boo community library?\nTemplate name, description, and HTML source will be shared.",
    buildLogLangs: "Languages: ",
    buildLogLangsSep: " type(s) × Articles: ",
    buildLogArticlesSep: " article(s) → Max: ",
    buildLogPagesSuffix: " pages",
    buildDonePrefix: "✓ Done — Built: ",
    buildDoneSkipped: " / Skipped: ",
    buildDoneErrors: " / Errors: ",
    buildSweptPrefix: "🧹 Removed leftover pages: ",
    tmplEditorName: "Template Name",
    tmplEditorAuthor: "Author",
    tmplEditorSaveBtn: "Save",
    tmplEditorPreviewNote:
      "Select the Template Preview tab to view edited preview.",
    tmplEditorPlaceholder: "Template HTML source will appear here",
    tmplDetailDialog: "Template Detail: ",
    tmplDetailAuthorLabel: "Author",
    tmplDetailVersionLabel: "Version",
    tmplDetailDescLabel: "Description",
    tmplDetailDownloadLabel: "Download URL",
    tmplScriptWarnLabel: "Scripts not loaded",
    cspReportsTitle:
      "Security policy (CSP) reports from the public site (what it would block)",
    tmplScriptWarnExternal:
      "External script (not loaded on public pages; paste its code into the template instead): ",
    tmplScriptWarnToken:
      "Script containing [[…]] (blocked by the site's security policy; pass values through data- attributes): ",
    tmplScriptWarnToast:
      "This template has scripts that public pages will not run. See the template detail.",
    tmplDetailClose: "Close",
    tmplDeleteConfirm: "Delete this template?",
    tmplEditorNotSelected: "No template selected",
    tmplCurrentTemplate: "Active template: ",
    contentEditorTitle: "Site Text",
    contentEditorHint:
      "Register content for each key referenced by the template (e.g. top-hero-title). Missing keys will render as blank.",
    contentAddBtn: "＋ Key Register",
    contentBaseLang: "Base",
    contentAddKeyNote: "※ This key will be added to all languages.",
    contentDeleteAllLangsNote: "※ This key will be deleted from all languages.",
    tmplEmptyState:
      "No templates. Please select one from the Template Selection tab.",
    tmplSaved: "Saved",
    tmplSavedAndPreview: "Saved / Preview also updated",
    tmplNameRequired: "Please enter a template name",
    tmplDetailInfo: "Details",
    noneRegistered: "Nothing registered yet.",
    noCategories: "No categories registered.",
    noUsers: "No users registered.",
    backToArticles: "Back to article list",
    allCategoriesSelected: "All categories are already selected.",
    deleteArticleTitle: "Delete Article",
    deleteArticleMsg: "Delete this article? This cannot be undone.",
    deleteArticleImportNote:
      "Deleted imported articles can be re-imported on next import.",
    deleteAction: "Delete",
    langOptionNew: "(new)",
    translateDialogTitle: "Translate into {lang}",
    translateConfirmMsg: "Create a {lang} translation of this article?",
    translateCopyBase: "Copy content from {lang} (base language)",
    translateCreateBtn: "Create {lang}",
    deleteScopePrompt: "Delete the {lang} translation, or the whole article?",
    deleteScopeLang: "Delete only this language ({lang})",
    deleteScopeAll: "Delete the whole article (all languages)",
    deleteWholeConfirmTitle: "Delete whole article",
    deleteWholeAction: "Delete all languages",
    deleteBaseTitle: "Delete base language",
    deleteBaseWarn:
      "Deleting the base language ({lang}) deletes this article in ALL languages.",
    contentKeyLabel: "Key",
    contentValueLabel: "Content",
    contentUpdatedLabel: "Updated",
    contentSystemBadge: "Default",
    contentDeleteConfirm: "Delete this key?",
    contentNotTranslated: "Not translated",
    contentCreateBtn: "Create",
    contentInheritedValue: "Same as base setting when shown",
    contentMediaNotFound: "Media does not exist",
    contentMediaRefHint:
      "Use the exact ID shown in the media screen. The standard form is img-001 / vid-001 / aud-001.",
    contentAddEditTitle: "Register Site Text",
    contentEditTitle: "Edit Site Text",
    contentKeyHint: "Template reference key",
    contentValueHint: "Content (HTML or text)",
    contentMediaHint:
      "Image: [[img-001]]   Video: [[vid-001]]   Audio: [[aud-001]]",
    mediaTableMid: "MID",
    mediaTableFile: "Filename",
    mediaTableSize: "Size",
    copyMidTooltip: "Click to copy [[{mid}]]",
    mediaInfoNonePre: "No ",
    mediaInfoNoneSuf: " files registered.",
    mediaInfoCountPre: "Current ",
    mediaInfoCountMid1: ": ",
    mediaInfoCountMid2: " file(s), ",
    mediaInfoCountEnd: " in R2.",
    helpBasic: "Basics",
    helpUpdates: "Updates",
    blueskyAppPassword: "Access Token (App Password)",
    blueskyAppPasswordHelp: "Generate in Bluesky Settings → App Passwords.",
    importFromStrapi: "Import from Strapi",
    importFromKurocms: "Import from KuroCMS",
    importStrapiDesc: "Bulk import articles from Strapi 5 REST API.",
    importKurocmsDesc: "Bulk import articles from another KuroCMS instance.",
    importConnectionSettings: "Connection Settings",
    strapiUrlHelp:
      "Base URL of your Strapi 5 server (e.g. https://cms.example.com)",
    strapiApiToken: "API Token",
    strapiApiTokenHelp: "Generate in Strapi Admin → Settings → API Tokens",
    strapiContentType: "Content Type",
    strapiContentTypeHelp:
      "Strapi content type name to import from (default: articles)",
    importFieldMapping: "Field Mapping (Advanced)",
    strapiFieldTitle: "Title field",
    strapiFieldSlug: "Slug field",
    strapiFieldSummary: "Summary field",
    strapiFieldBody: "Body field",
    strapiFieldCategories: "Categories field",
    importConnectAndShow: "Connect & Preview",
    importConnect: "Connect",
    importSaveConfig: "Save Settings",
    importSettingsSection: "Import Settings",
    importDestType: "Destination Type",
    importDestTypeAll: "All (by article type)",
    importLangLabel: "Import Language",
    importSelected: "Import Checked",
    importAll: "Import All",
    importArticleList: "Article List",
    selectAllToggle: "Select All / Deselect",
    kurocmsUrlHelp:
      "Base URL of the source KuroCMS instance (e.g. https://example.com)",
    kurocmsPatLabel: "PAT Token",
    kurocmsPatHelp:
      "Issue in source admin → Profile → Tokens (starts with kuro_)",
    addSnsTitle: "Add SNS Integration",
    snsServiceLabel: "Service",
    snsSavePending: "Saved (API integration coming soon)",
    snsHandleLabel: "Handle / Username",
    snsAccessToken: "Access Token",
    snsApiComingSoon: "* API integration is planned for a future update.",
    snsDeleteMsgPre: "Delete ",
    snsDeleteMsgSuf: " integration settings?",
    helpPageLead: "Guide to the features, usage, and notes for each screen.",
    siteManagementLead:
      "Manage templates and static content for the public site.",
    previewFetchFailed: "Preview fetch failed: ",
    contentKeyRequired: "Please enter a key.",
    articleNotFound: "Article not found.",
    articleLoadFailed: "Failed to load article: ",
    addFile: "+ Add File",
    purgeDataSuffix: " items will be permanently deleted",
    refetchError: "Re-fetch error: ",
    importConnectSuccessPre: "Connected — ",
    importCountSuffix: " article(s)",
    connectError: "Connection error: ",
    articlesNotFound: "No articles found.",
    modifiedBadge: "edited",
    importedBadge: "imported",
    alreadyImportedBadge: "done",
    selectImportType: "Please select a destination type.",
    selectImportLang: "Please select an import language.",
    importing: "Importing…",
    previewFetchError: "Preview fetch error: ",
    kurocmsLastUpdated: "KuroCMS last updated: ",
    strapiConflictWarning:
      "Import All overwrites every article with the Strapi version. The following were edited in KuroCMS after import — uncheck any you want to keep (protect from overwrite).",
    strapiConflictNoCheck: "Unchecked = keep KuroCMS version (not overwritten)",
    importAllConflictTitle: "Import All — Conflict Check",
    runImport: "Run Import",
    selectArticlesForImport: "Please select articles to import.",
    connectionSettingsSaved: "Connection settings saved.",
    kurocmsRetrievedSuffix: " retrieved",
    selectTypeAndLang: "Please select a destination type and language.",
    kurocmsConflictWarning:
      "The following articles have been edited in KuroCMS. Check to overwrite.",
    overwriteConfirmTitle: "Overwrite Check — Edited Articles",
    importConfirmAll: "Import All — Confirm",
    importConfirmAllMsg: "Import all KuroCMS articles.",
    importConfirmSelMsgPre: "Import ",
    importConfirmSelMsgSuf: " article(s).",
    execute: "Run",
    importProgressTitle: "Importing…",
    importComplete: "Import complete",
    importErrorsLabel: "Errors:",
    importResultPre: "Done: ",
    importResultImported: " imported",
    importResultOverwritten: " overwritten",
    importResultSkipped: " skipped",
    imagesDownloadedToR2Suf: " images saved to R2",
    bskyConnectionCleared: "Bluesky connection cleared.",
    bskyDisconnectConfirm: "Clear Bluesky connection and hide?",
    userUpdated: "User updated.",
    emailRequired: "Please enter an email address.",
    inviteSubmit: "Issue Invite Link",
    inviteLink: "Invite Link",
    inviteExpiryMsg: " — invite link (valid 48 hours).",
    copyAndClose: "Copy & Close",
    userStatus: "Status",
    registeredDate: "Registered",
    lastLoginDate: "Last login",
    noRole: "No Role",
    disableAccount: "Disable Account",
    tokenDeleteConfirm: "Delete this token? This cannot be undone.",
    rename: "Rename",
    passkeyDevices: "Passkeys (devices)",
    passkeyDevicesLead:
      "Register passkeys on multiple devices so you can still sign in if one is lost.",
    addPasskey: "Add this device",
    passkeyNameLabel: "Device name",
    passkeyNamePlaceholder: "e.g. MacBook, iPhone",
    passkeyCreated: "Added",
    passkeyLastUsed: "last used",
    passkeyCurrent: "current passkey",
    passkeyAdded: "Passkey added.",
    passkeyRenamed: "Passkey renamed.",
    passkeyRemoved: "Passkey removed.",
    passkeyDeleteConfirm:
      "Remove this passkey? That device will no longer be able to sign in.",
    editUserTitle: "Edit User: ",
    disabled: "Disabled",
  },
  ja: {
    brandSub: "記事管理システム",
    initialize: "初期化",
    dashboard: "ダッシュボード",
    noticeHeading: "お知らせ",
    noticeEmpty: "お知らせはありません",
    noticeSectionProduct: "KuroCMS から",
    noticeSectionOther: "Entamy の製品から",
    noticeAck: "確認した",
    noticeLater: "あとで読む",
    noticeOpen: "開く",
    noticeCritical: "緊急のお知らせ",
    noticeImportant: "重要なお知らせ",
    noticeOther: "ほかの製品のお知らせを受け取る",
    noticeStale:
      "新しいお知らせを確かめられませんでした。前に受け取ったものを出しています。",
    articles: "記事管理",
    articlesNav: "記事管理＆ビルド",
    newArticleNav: "新規記事作成",
    newArticle: "記事作成",
    siteManagement: "サイト管理",
    images: "画像管理",
    videos: "動画管理",
    audios: "音楽管理",
    categories: "カテゴリ管理",
    languageManager: "言語管理",
    types: "タイプ管理",
    settings: "設定",
    profile: "プロフィール",
    help: "ヘルプ",
    setupTitle: "KuroCMS ワークスペースを設定",
    setupLinkMissing:
      "導入の完了画面に出たリンク（7 日以内）からこの画面を開いてください。リンクが無いと、最初の管理者を作れません。",
    setupLead:
      "最初の管理者を作成します。ログインはパスキー（指紋や顔認証）で行い、パスワードはありません。",
    setupPasskeyNext:
      "次に、このサイトの管理画面に入るためのパスキーを作ります。このあと出る窓には「{name}」と表示されます。",
    setupPasskeyTwo:
      "導入のときに作った「Entamy ID（契約者）」のパスキーとは別のものです。記事を書く・設定を変えるときは、こちらのパスキーを使います。契約の申し込み・解約・持ち主のアドレスの変更は大事な手続きなので、別の窓で Entamy ID のパスキーで確かめます。",
    setupPasskeyGo: "確認して、パスキーを作る",
    administrator: "管理者",
    adminEmail: "管理者メール",
    completeSetup: "初期設定を完了",
    subtitle: "Cloudflare優先のヘッドレスCMS",
    apiFailed: "APIリクエストに失敗しました",
    cfLimitHint:
      "Cloudflare の制限の可能性（サブリクエスト / CPU 時間 / KV 書き込み上限など）",
    documents: "登録記事",
    loading: "読み込み中...",
    articleLoading: "記事を読み込んでいます…",
    start: "開始",
    overview: "概要",
    registeredDocuments: "記事数",
    publishedDocuments: "公開中",
    dashboardLead:
      "現在のサイト、公開状態、ドメイン、コンテンツ構造を一覧する画面です。",
    previewActive:
      "プレビューモードです。ローカルUI確認のため初期化チェックを回避しています。",
    articlesLead:
      "ソートと検索で記事を絞り込み、タイトルをクリックして編集します。",
    newArticleLead:
      "新規記事の作成と、既存記事の編集・更新を行います。公開設定は記事一覧で行います。",
    imagesLead:
      "画像ファイルをアップロードして管理します。各画像には MID（例: img-001）が割り当てられます。記事本文やサイトの文字情報に [[img-001]] と記述するとその位置に画像が表示されます。MID 欄をクリックすると [[MID]] 形式でクリップボードにコピーされます。",
    videosLead:
      "動画ファイルをアップロードして管理します。記事本文やサイトの文字情報に [[vid-001]] と記述するとその位置に動画プレーヤーが表示されます。MID 欄をクリックでコピーできます。",
    audiosLead:
      "音楽・音声ファイルをアップロードして管理します。記事本文やサイトの文字情報に [[aud-001]] と記述するとその位置に音楽プレーヤーが表示されます。MID 欄をクリックでコピーできます。",
    categoriesLead: "記事分類に使うカテゴリを管理します。",
    languageManagerLead: "データ登録で利用する言語を登録します。",
    typesLead: "news、blog、research などの記事タイプを管理します。",
    settingsLead:
      "公開ドメイン、表示（基本言語・時刻・筆者）、契約（いまの契約・無料期間・料金・持ち主・引っ越し）、メール送信、SNS 連動、スマホ、インポート、IP 制限を設定し、稼働地域を確かめます。",
    profileLead: "自分のアカウント、表示、PAT、パスキー、IP 制限を設定します。",
    noLanguages: "言語が登録されていません",
    profileIdentity: "アカウント情報",
    legalAgreed: "同意した版",
    legalTitle: "規約が更新されました",
    legalFirstTitle: "はじめに",
    siteMoveTitle: "契約",
    siteMoveNowManaged:
      "いまは Entamy の委託運用で動いています（Entamy の Cloudflare アカウント）。",
    siteMoveNowSelf:
      "いまはご自身の Cloudflare アカウントで動いています（顧客導入）。",
    siteMoveToSelf: "ご自身の Cloudflare アカウントへ引っ越す",
    siteMoveToManaged: "Entamy の委託運用へ引っ越す",
    siteMoveSelfLead:
      "ご自身の Cloudflare アカウントに KuroCMS を立て、記事・メディア・設定・利用者を写します。写している間もこのサイトはそのまま使えます（最後の突き合わせの数分だけ止まります）。終わると、このアドレスは新しいアドレスへの案内に替わり、この KuroCMS の管理者全員に、新しいアドレスでパスキーを登録するリンクがメールで届きます。顧客導入は無料です。",
    siteMoveManagedLead:
      "Entamy の Cloudflare アカウントに KuroCMS を立て、記事・メディア・設定・利用者を写します。写している間もこのサイトはそのまま使えます。終わると、このサイトは新しいアドレス（{導入ID}.kurocms.site）への案内に替わり、この KuroCMS の管理者全員に、新しいアドレスでパスキーを登録するリンクがメールで届きます。独自ドメインは引き継ぎません。ご自身の Cloudflare に導入した KuroCMS のものは消しません。必要なければ、運用を切り替えた後にご自身で削除してください。※導入 ID は選べません。",
    siteMoveManagedPrice:
      "委託運用は有料です。最初の無料期間は、新しいサイトが使えるようになった時点から数えます（登録メールアカウントごとに 1 回。一度でも委託運用を使ったことがある ID の場合は無料期間は追加されません）。契約の持ち主は、このサイトを導入した Entamy ID です。",
    siteMoveAccountId: "Cloudflare の Account ID",
    siteMoveToken: "Cloudflare の API トークン",
    siteMoveTokenHelp:
      "顧客導入と同じ権限のトークンです。Entamy もこのサイトも保存しません。メディアがあるサイトは、先に Cloudflare のダッシュボードで R2 を有効にしてください。",
    siteMoveConfirm:
      "移す先は新しい導入として作られ、既存のものを上書きしないこと、SNS の連携の鍵と PAT は持っていかないことを確かめました。",
    siteMoveConfirmRequired: "チェックを入れて確かめてください。",
    siteMoveCfRequired: "32 桁の Account ID と API トークンを入れてください。",
    siteMoveStart: "引っ越しを始める",
    siteMoveRunning: "引っ越しています（{p}%）",
    siteMoveShow: "進み具合を見る",
    siteMoveStepsTitle: "作業の工程",
    siteMoveCloseNote:
      "閉じても引っ越しは止まりません。「設定 → 契約」からいつでも開き直せます。",
    siteMoveFailed: "引っ越しが止まりました。写した分は残っています。",
    siteMoveResume: "途中から再開",
    siteMoveAgain: "やり直す",
    siteMoveDone: "引っ越しが終わりました。",
    siteMoveMailed:
      "管理者 {n} 人に、新しいアドレスでパスキーを登録するリンクを送りました。",
    siteMoveNewAddress: "新しいアドレス",
    siteMoveOpenAdmin: "新しい管理画面を開く",
    siteMoveOpsKey: "番人（WorkerOps）の鍵",
    siteMoveOpsKeyNote:
      "新しいサイトの復旧画面に入る鍵です。いま安全な場所に控えてください。引っ越しが終わったら、API トークンは Cloudflare で削除してください。",
    siteMoveStep_verify_token: "トークンと権限を確かめる",
    siteMoveStep_reserve_names: "既存のものとの衝突を確かめる",
    siteMoveStep_create_storage: "データベースと保存先を作る",
    siteMoveStep_fetch_release: "版を取得する（署名を確かめる）",
    siteMoveStep_deploy_app: "KuroCMS を配備する",
    siteMoveStep_apply_schema: "データベースを初期化する",
    siteMoveStep_bootstrap_admin: "管理者を準備する",
    siteMoveStep_create_update_token: "更新専用のトークンを作る",
    siteMoveStep_deploy_workerops: "番人（WorkerOps）を配備する",
    siteMoveStep_finish: "導入を記録する",
    siteMoveStepManaged_verify_token: "準備を確かめる",
    siteMoveStepManaged_reserve_names: "導入 ID を決める",
    siteMoveStepManaged_create_update_token: "更新の準備",
    siteMoveStepManaged_deploy_workerops: "公開アドレスを割り当てる",
    siteMoveStep_move_copy: "記事と設定を写す",
    siteMoveStep_move_media: "メディアを写す（SHA-256 で確かめる）",
    siteMoveStep_move_build: "公開ページを作る",
    siteMoveStep_move_check: "最後の突き合わせ（数分だけこのサイトを止めます）",
    siteMoveStep_move_finish:
      "パスキーの登録のメールを送り、このアドレスを案内に替える",
    err_owner_unknown:
      "このサイトの持ち主がまだ分かりません。先に持ち主を登録してください（設定 → 契約）。",
    err_wrong_direction: "このサイトはその向きには引っ越せません。",
    err_move_in_progress: "引っ越しはもう始まっています。",
    err_move_ticket_invalid:
      "Entamy がこのサイトを確かめられませんでした。開き直してもう一度押してください。",
    err_source_too_old:
      "引っ越すには、先に KuroCMS を更新してください（ダッシュボードの「今すぐ更新のチェック」）。",
    err_source_busy: "このサイトは別の引っ越しの途中です。",
    err_media_too_large:
      "メディアが委託運用の上限（1 サイト 10 GB）を超えています。",
    err_already_managed:
      "この Entamy ID には、もう委託運用のサイトがあります。",
    err_contract_required:
      "無料期間はもう使っています。委託運用には契約が要ります。",
    err_managed_unavailable: "いまは委託運用の受付を止めています。",
    err_managed_capacity_full:
      "いまは委託運用に空きがありません。しばらくしてからもう一度お試しください。",
    err_managed_month_full:
      "今月の委託運用の受付は締め切りました。来月にもう一度お試しください。",
    err_no_managed_install: "委託の導入が見つかりません。",
    err_entamy_unavailable:
      "Entamy に届きませんでした。少し待ってからもう一度お試しください。",
    err_invalid_input: "Account ID と API トークンを確かめてください。",
    moveReceivingTitle: "引っ越しを受けています",
    moveReceivingLead:
      "Entamy の委託から、記事とメディアを写しています。終わると、このサイトの管理者全員に、このアドレスでパスキーを登録するリンクがメールで届きます。",
    legalTerms: "利用規約",
    legalPrivacy: "プライバシーポリシー",
    legalTokushoho: "特定商取引法に基づく表記",
    legalGdpr: "GDPR 追補",
    legalDocVersion: "版 {version}",
    legalTranslationNote: "この表示は参考訳です。正文は {lang} です。",
    legalCheckAll: "すべてにチェック",
    legalClose: "閉じる",
    legalAgreeButton: "同意して続ける",
    contactTitle: "持ち主のメールアドレスの登録",
    contactLead:
      "持ち主のメールアドレスを登録します。このアドレスの Entamy ID がこの CMS の持ち主になり、重要なお知らせが届き、Entamy の委託運用へ引っ越すときは契約の持ち主になります。それ以外には使いません。",
    contactConsent: "この使い方に了承します",
    contactEmail: "メールアドレス",
    contactRegister: "登録する",
    contactLater: "後で",
    contactDecline: "登録しない",
    contactClose: "閉じる",
    contactSent:
      "{email} に確認のメールを送りました。メールのリンクを開き、「確認する」を押してください(30分有効)。",
    contactDone: "連絡先のメールアドレスを確認できました。",
    contactInvalidEmail: "メールアドレスを正しく入力してください。",
    contactRateLimited:
      "送った回数が多すぎます。1時間ほどおいてから試してください。",
    contactUnavailable:
      "いまは登録の窓口につながりません。しばらくしてから試してください。",
    contactPanelTitle: "サイトの持ち主（Entamy ID）",
    contactInstaller:
      "このサイトを導入口で入れたときの Entamy ID が持ち主です。",
    siteMoveNeedOwner:
      "このサイトは導入口より前の仕組みで入れたため、持ち主がまだ分かりません。先に持ち主のメールアドレスを登録してください（確認のメール 1 通）。その Entamy ID が委託運用の契約の持ち主になります。",
    siteMoveRegisterOwner: "持ち主を登録する",
    siteMoveNeedUpdate:
      "引っ越すには、先に KuroCMS を v{min} 以上へ更新してください（いまは v{now}）。ダッシュボードの「今すぐ更新のチェック」から更新できます。",
    siteMoveOwnerUnavailable:
      "いまは持ち主を確かめられません。少し待ってからもう一度お試しください。",
    contactPanelHelp:
      "サイトに 1 つだけの宛先です。この CMS を使う人のログイン用のアドレス（各自がプロフィールで変えます）とは別です。この CMS の重要なお知らせ（セキュリティ・更新・バックアップのお願いなど）が届き、この Entamy ID が委託運用の契約の持ち主になります。それ以外には使いません。",
    contactLinked: "登録済み: {email}(確認 {date})",
    contactPending: "確認待ち: {email}",
    contactNone: "未登録",
    contactOptedOut:
      "Entamy への報告を止めているため、連絡先は登録できません。",
    contactChange: "変更",
    contactRemove: "取り消し",
    contactRemoveConfirm:
      "連絡先のメールアドレスを取り消しますか？重要なお知らせが届かなくなります。",
    legalRequired: "チェックを入れて同意してください。",
    installIdentity: "管理番号",
    profilePreferences: "表示設定",
    profileApiAccess: "Personal Access Tokenの作成",
    profileApiAccessLead:
      "REST APIでアクセスするためにPAT（Personal Access Token）を作成します。主にAIなどから利用されます。/api/help にアクセスするとREST API の使い方の説明が表示されます。",
    createPatAction: "新規Personal Access Tokenを作成",
    mcpConnectTitle: "AI 連携（MCP）",
    mcpConnectLead:
      "このサイトは MCP サーバーも備えており、Claude / Claude Code から会話的に記事を管理できます。AI クライアントに下の接続先を設定し、ここで作る PAT を Bearer トークンとして使います。",
    mcpEndpointLabel: "接続先エンドポイント（このサイト）",
    mcpConfigLabel: "Claude Code 設定（コピペ・kuro_… を自分の PAT に置換）",
    email: "メール",
    mailDeliveryTitle: "メール送信設定",
    mailDeliveryLead:
      "この CMS からのメール（パスキーの復旧・招待など）は、既定では黒兎のサーバーが送ります。自分のドメインから送るように設定すると、Cloudflare の無料枠で送れ、黒兎のサーバーの上限を受けません。自分のドメインで送れなかったときは、黒兎のサーバーが代わりに送ります。",
    mailDeliveryRequirement:
      "自分のドメインから送るには、このサイトに Worker のカスタムドメインがあること、そのドメインで Email Routing が有効なこと、管理者全員のメールアドレスが Email Routing の宛先として認証済みであることが必要です。",
    mailDeliveryKuroLimit:
      "黒兎のサーバーには送信数の上限があります。上限に達すると、時間がたつまで送れません。",
    mailDeliveryCurrent: "現在の送信方法",
    mailDeliveryCustom: "自分のドメイン（Email Routing）",
    mailDeliveryKuro: "黒兎のサーバー",
    mailDeliveryDomain: "カスタムドメイン",
    mailDeliverySender: "送信元",
    mailDeliveryDestination: "宛先（あなたのアドレス）",
    mailDeliveryZoneLabel: "送信元ドメインの Email Routing",
    mailDeliveryZoneStateOn: "有効",
    mailDeliveryCfMissing:
      "このサイトには Cloudflare の鍵が無いため、自分のドメインからの送信は設定できません。メールは黒兎のサーバーが送ります。",
    mailDeliveryCfAuth:
      "このサイトの Cloudflare の鍵では Cloudflare の設定を読めません（鍵が古いか、権限が足りません）。自分のドメインからの送信は設定できませんが、メールは黒兎のサーバーが送ります。",
    mailLastTitle: "最後のメール",
    mailLastRouting: "自分のドメインから送りました",
    mailLastKuro: "黒兎のサーバーが送りました",
    mailLastRelayed:
      "自分のドメインで送れなかったため、黒兎のサーバーが代わりに送りました",
    mailLastFailed: "送れませんでした",
    settingsTabMail: "メール送信",
    emailVerified: "確認済み",
    emailUnverified: "未確認",
    emailVerifySend: "確認メールを送る",
    emailVerifySent: "送りました。メールのリンクを開くと確認済みになります。",
    emailVerifyDone: "メールアドレスを確認しました。",
    emailVerifyExpired:
      "リンクの期限が切れています。確認メールを送り直してください。",
    emailVerifyInvalid: "リンクが正しくないか、すでに使われています。",
    emailVerifyChanged:
      "リンクを送った後にメールアドレスが変わりました。確認メールを送り直してください。",
    err_email_verify_too_soon: "1 分ほど待ってから、もう一度送ってください。",
    profileEmailHelp:
      "この CMS で使うあなたのアドレスです（パスキーを失くしたときの復旧メールなどが届きます）。サイトの持ち主（Entamy ID）は「設定 → 契約」で確かめます。",
    mailDeliveryVerified: "検証済み",
    mailDeliveryUnverified: "未検証",
    mailDeliveryUnavailable: "Cloudflareの設定を取得できません",
    mailDeliveryAdminOnly: "この設定を変更できるのは管理者だけです。",
    mailDeliveryToggle: "自分のドメインから送信する",
    mailDeliverySaved: "メール送信設定を更新しました。",
    roles: "権限",
    interfaceLanguage: "管理画面の言語",
    profileSaved: "プロフィールを保存しました。",
    adminRole: "管理者",
    authorRole: "投稿者",
    displayName: "ユーザー名",
    userIdLabel: "ユーザID",
    updateAccount: "アカウント更新",
    darkMode: "ダークモード",
    darkModeHelp: "管理画面全体のカラーモードを切り替えます。",
    patManager: "Personal Access Token",
    tokenGenerated: "新しいトークンを生成しました。",
    copy: "コピー",
    cancel: "キャンセル",
    revoke: "取り消し",
    revoked: "取り消し済み",
    active: "有効",
    generatedToken: "生成されたトークン",
    patScopeNote: "PATの権限はユーザーの権限と同じになります。",
    copySuccess: "クリップボードにコピーしました。",
    copyFailed: "コピーに失敗しました。",
    deleteServiceTitle: "{service} を削除",
    strapiFieldsLabel: "Strapi フィールド:",
    initRenderError: "初期化エラー",
    imageFileRequired: "選択されたファイルは画像ではありません。",
    imageDimensionsFailed: "画像サイズを取得できませんでした。",
    imageResizeUnsupported: "画像の縮小処理はサポートされていません。",
    tokenRevoked: "トークンを取り消しました。",
    tokenHistory: "トークン履歴",
    width: "幅",
    height: "高さ",
    noMedia: "メディアはまだありません。",
    previewReadOnly: "プレビューモードのため、この画面は読み取り専用です。",
    searchPlaceholder: "タイトルまたはスラッグを検索",
    entriesPerPage: "件 / ページ",
    search: "検索",
    noDocuments: "記事はまだありません。",
    listEmpty: "まだありません。",
    untitled: "（無題）",
    title: "タイトル",
    slug: "スラッグ",
    type: "タイプ",
    languages: "言語",
    draft: "下書き",
    published: "公開",
    hidden: "非表示",
    publishAt: "公開日",
    summary: "概要",
    userManager: "ユーザー管理",
    backup: "バックアップ",
    backupTabBackup: "バックアップ",
    backupTabRestore: "レストア",
    backupDesc:
      "KuroCMS のすべてのコンテンツと設定（記事・翻訳・カテゴリ・タクソノミー・メディア管理情報・テンプレート・サイト設定・SNS 連携）を、画像／動画／音楽の実ファイルとともに 1 つの ZIP に保存します。ログインアカウントと認証情報（ユーザー・パスキー・個人アクセストークン）は含まれません。なお SNS 連携のトークンは含まれるため、バックアップファイルは厳重に保管してください。選択したファイルへ直接ストリーミング保存するため、大規模サイトでもメモリ不足になりません。",
    backupStart: "バックアップ…",
    backupDone: "バックアップが完了しました。",
    backupMediaIncomplete:
      "バックアップは終了しましたが、メディア {total} 件のうち {failed} 件を読み出せませんでした。ZIP 内の media-errors.json を確認してください。この ZIP を移行に使わないでください。",
    backupFailed: "バックアップに失敗しました",
    backupCancelled: "中止しました。",
    backupFallbackWarn:
      "このブラウザはディスクへの逐次書き込みに非対応のため、メモリ上で生成します。大規模サイトでは Chrome / Edge を使用してください。",
    restoreDesc:
      "KuroCMS のバックアップ ZIP から復元します。テーブルとメディアを 1 件ずつストリーミングで戻すため、大容量でもメモリを使い切りません。",
    restoreWarn:
      "全置換：現在のコンテンツ・メディア・設定をすべて削除してから、バックアップで置き換えます。ユーザーアカウントとログイン情報は影響を受けません。この操作は取り消せません。",
    restoreStart: "復元するバックアップを選択…",
    restoreDone:
      "復元が完了しました。公開サイトを再ビルドするとページが再生成されます。",
    restoreMediaIncomplete:
      "テーブルは復元しましたが、メディア {total} 件のうち {failed} 件のアップロードに失敗しました（詳細はブラウザのコンソール）。R2 が接続されているか確認して、もう一度復元してください。",
    restoreFailed: "復元に失敗しました",
    restoreBadFile: "有効な KuroCMS バックアップファイルではありません。",
    restoreConfirmTitle: "すべてのデータを置き換えますか？",
    restoreConfirmBody:
      "現在のコンテンツ・メディア・設定をすべて削除し、選択したバックアップから復元します。この操作は取り消せません。",
    restoreConfirmYes: "すべて置き換える",
    restorePhaseWipe: "既存データを削除中…",
    restorePhaseTables: "データを読み込み中…",
    restorePhaseMedia: "メディアを読み込み中…",
    restoreReading: "{name} を読み込んでいます…",
    restoreCancelledPick:
      "ファイルが選択されなかったため、復元は開始していません。",
    backupPhaseTables: "データを書き出し中…",
    backupPhaseMedia: "メディアを書き出し中…",
    backupPhaseFinish: "仕上げ中…",
    backupDontClose:
      "このタブは開いたままにしてください。閉じたり再読み込みすると途中で止まります。",
    backupRunningBadge: "実行中",
    backupPlanLine: "予定: {rows} 行 ＋ メディア {files} 件（{bytes}）",
    backupElapsed: "経過 {t}",
    backupRemaining: "残り 約 {t}",
    backupFailedCount: "{n} 件失敗",
    backupSummaryOk: "完了しました",
    backupSummaryNg: "完了しましたが問題があります",
    backupFailHint:
      "上のログにどこまで進んだかが残っています。原因を直してからもう一度実行してください（同じ手順を繰り返しても安全です）。",
    backupSummaryFile: "ファイル: {name}",
    backupSummaryRows: "書き出した行数: {rows}",
    backupSummaryMedia: "書き出したメディア: {ok} / {total}（{bytes}）",
    backupSummaryTime: "所要時間: {t}",
    restoreSourceLine: "KuroCMS {version} で {at} に作成されたバックアップ",
    restoreSummaryRows: "復元した行数: {rows}",
    restoreSummaryMedia: "復元したメディア: {ok} / {total}（{bytes}）",
    restoreNextStep:
      "次の手順: サイトビルドを実行すると公開ページが再生成されます。",
    restoreSkippedColumn:
      "注記: {table}.{col} はこのサイトに存在しない列のため取り込みませんでした。",
    restoreSkippedSummary:
      "取り込まなかった列（この移行先に存在しない）: {cols}",
    restoreRenamedRow:
      "{table}.{col}: 「{from}」は既に使われているため「{to}」に変更しました。",
    restoreRenamedSummary:
      "一意制約のため値を変更した行: {n} 件（古いバックアップでは重複が許されていました。1 件も失われていません）",
    restoreUnknownTables:
      "⚠ このバックアップに含まれていた次のデータは、現在の KuroCMS が扱わないため取り込んでいません: {tables}",
    backupInterruptedTitle: "前回の処理が完了していません",
    backupInterruptedBackup:
      "{at} に開始したバックアップが「{phase}」で止まりました（タブを閉じたか再読み込みしたため）。保存された ZIP は不完全です。削除して取り直してください。",
    backupInterruptedRestore:
      "{at} に開始した復元が「{phase}」で止まりました（タブを閉じたか再読み込みしたため）。データベースが途中状態の可能性があります。このサイトを使う前に、最初から復元をやり直してください。",
    backupInterruptedDismiss: "閉じる",
    inviteUser: "ユーザーを招待",
    settingsTabBasic: "基本",
    settingsTabDisplay: "表示",
    settingsTabSns: "SNS連動",
    settingsTabMobile: "スマホ設定",
    siteTimezone: "サイトのタイムゾーン",
    siteTimezoneHelp:
      "サイトが使う時計です。記事一覧の月による絞り込みでどの月に入るか、公開ページに出る日付がいつになるか——この 2 つを、どこから見ている閲覧者に対しても同じにします。日本で運用しているなら Asia/Tokyo を選んでください（UTC のままだと、日本時間 0:00〜8:59 に公開した記事が前の月のアーカイブに入り、9/1 の記事が 8 月に混ざります）。生成される HTML が変わるので、変更後はビルド（全ページ）を実行してください。",
    siteTimezoneUtc: "UTC（既定）",
    siteTimezoneDetected: "このブラウザのタイムゾーンは {tz} です。",
    showByline: "記事の末尾に筆者を表示する",
    showBylineHelp:
      "記事の下に「筆者: 記事を作った人の表示名」を出し、検索エンジン向けの構造化データでもその人を著者にします。会社・製品紹介のサイトなど、筆者を出す必要がないサイトは OFF にしてください（構造化データの著者はサイト名になります）。生成される HTML が変わるので、変更後はビルド（全ページ）を実行してください。",
    siteTimezoneAutoSet:
      "サイトのタイムゾーンを {tz}（このブラウザの設定）にしました。記事の日付と月別アーカイブの区切りがこれに従います。公開ページに反映するにはビルド（全ページ）を実行してください。変更は設定 → 表示タブから行えます。",
    mobileTitle: "スマホ向けレイアウト（サイトビルドの設定）",
    mobileIntro:
      "ここの設定は、サイトビルドが生成する公開ページの HTML を変えるものです。KuroCMS の管理画面やエディタの表示は変わりません（執筆中の見え方はそのままです）。",
    mobileMediaFullWidth: "スマホでのメディアレイアウトの解除",
    mobileMediaFullWidthHelp:
      "ON にすると、幅 640px 以下の画面では記事本文中のメディアを常に 100% 幅にし、回り込みを解除します。執筆時に指定した幅や寄せ（50%・左寄せなど）は PC ではそのまま効き、狭い画面でだけ無効になります（半分の幅の横に文章を回り込ませる余地が無いため）。",
    mobileMediaFullWidthVideo:
      "YouTube への副作用: 全幅になるとプレイヤーが十分な大きさになるため、タップすると拡大オーバーレイではなく【その場で再生】されます。画像はどちらでも全幅なので、タップ時の動作は変わりません（従来どおり拡大表示）。",
    mobileBuildNote:
      "保存しただけでは公開ページは変わりません。この設定はページ生成時に反映されるので、ビルド（全ページ）を実行してください。",
    mobileSavedNeedsBuild:
      "保存しました。公開ページに反映するにはビルド（全ページ）を実行してください。",
    settingsTabImport: "インポート",
    settingsTabIpGate: "IP 制限",
    settingsTabRegion: "稼働地域",
    contractAt: "委託を始めた日",
    contractPlan: "払い方",
    contractPlanMonth: "月払い",
    contractPlanYear: "年払い",
    contractStarted: "契約日",
    contractRenew: "次の更新日",
    contractEnds: "契約の終わる日",
    contractApply: "委託契約を申し込む",
    contractApplyLead:
      "委託の契約はまだありません。無料期間の後も使い続けるには、Entamy の契約の頁で申し込んでください。",
    contractCancel: "解約する",
    contractOpenPage: "契約の頁を開く",
    contractPageNote:
      "申し込み・解約は Entamy の契約の頁（新しいタブ）で、サイトの持ち主の Entamy ID でログインして行います。ここに出るまで最長 1 時間かかります。",
    contractTrialFinal: "最後の無料期間の終わり",
    contractSubActive: "契約中（自動で更新）",
    contractWindowTitle: "無料期間が終わりました",
    contractWindowLocked:
      "契約するまで、記事の追加とビルド（公開）は一切できません。読む・バックアップは続けられます。",
    contractWindowDelete:
      "契約しない場合、このサイトのデータは {date} に消えます（無料期間の終わりから 30 日）。それまで公開済みのページは出し続けます。",
    contractWindowClose: "閉じる",
    contractWindowMoveHelp:
      "ご自身の Cloudflare アカウントへの引っ越し（顧客導入）は無料です。「設定 → 契約」から引っ越しを始めると、記事・メディア・設定を写し、古いアドレスは新しいアドレスへ案内します。",
    contractGrace: "データ削除の待機期間",
    contractLastDay: "最終日",
    contractDeleteAt: "データを消す日",
    contractDaysLeft: "残り",
    contractDays: "{n} 日",
    contractRange: "{from} 〜 {to}（{n} 日間）",
    contractEndedNote:
      "無料期間が終わりました。契約しない場合、データは上の日に消えます。",
    contractPending: "契約情報はまだ届いていません。1 時間ほどで出ます。",
    contractSynced: "{date} に更新。",
    contractNowTitle: "いまの契約",
    contractPlansTitle: "契約の形態と料金",
    contractFormManaged:
      "Entamy の委託運用で動いています（Entamy の Cloudflare アカウント）。",
    contractFormSelf:
      "ご自身の Cloudflare アカウントで動いています（顧客導入）。",
    contractBadgeSelf: "無料・契約は要りません",
    contractBadgePending: "確かめ中",
    contractBadgeActive: "契約中・{plan}",
    contractBadgeCancelled: "解約済み・{date} まで使えます",
    contractBadgeTrial: "無料期間中・残り {n} 日",
    contractBadgeEnded: "無料期間終了・読み取りだけ",
    contractBadgeNone: "契約なし",
    contractBadgeScheduled: "申し込み済み・{date} から有料",
    contractScheduledNote:
      "委託契約を申し込み済みです。無料期間が終わる {date} に最初のお支払いをし、そのまま使い続けられます。解約や支払いの確認は、Entamy の契約の頁で行います。",
    contractApplied: "申し込んだ日",
    contractFirstCharge: "最初のお支払い",
    contractBadgeInherited: "前の契約から引き継いだ期間・{date} まで",
    contractInheritedUntil: "引き継いだ期間の終わり",
    contractNextPlan: "次の契約",
    contractInheritedApplyLead:
      "前の持ち主の契約で払われた期間を使っています。{date} の後も使うには、契約のお申し込みが要ります。",
    contractSelfNote:
      "顧客導入は無料で、契約は要りません。Entamy の委託運用へ引っ越すと有料になります（料金は右）。",
    contractBarUntil: "{date} まで",
    contractTrialExtendedTo: "キャンペーンで {date} まで延長",
    contractAfterTrial:
      "{date} から委託運用は有料です。使い続けるには、無料期間のうちに委託契約を申し込んでください（料金は右）。申し込まないまま無料期間が終わると、記事の追加とビルドが止まり、{delete} にデータが消えます。",
    contractPaidFrom: "有料になる日",
    contractApplyLeadTrial:
      "無料期間中でも申し込めます。最初のお支払いは無料期間が終わったとき（{date}）です。",
    contractPlansLead:
      "委託運用は、Entamy の Cloudflare アカウントでこのサイトを動かす有料の形です。Cloudflare の手続きと更新は Entamy が受け持ちます。ご自身の Cloudflare アカウントで動かす顧客導入は無料です。",
    contractRegion: "国・地域",
    contractRegionJp: "日本（円）",
    contractRegionUs: "米国ほか（米ドル）",
    contractRegionEu: "欧州（ユーロ）",
    contractRegionDetected:
      "回線の国（{country}）から選びました。お支払いの額は契約の頁で決まります。",
    contractPerMonth: "{amount} / 月",
    contractPerYear: "{amount} / 年",
    contractYearPerMonth: "月あたり {amount}",
    contractYearSaving: "月払いより約 {n}% お得",
    contractTaxIncluded: "税込",
    contractPricesNotYet:
      "この地域の料金はまだ公開していません。この地域ではまだ申し込めません。",
    contractPricesUnavailable:
      "料金を読めませんでした。契約の頁でご確認ください。",
    contractRuleRenew:
      "契約した日が更新日で、自動で更新します（月払いは毎月、年払いは毎年）。29〜31 日で、その日が無い月は月末です。",
    contractRuleCancel:
      "途中で解約すると、月払いは払った 1 か月の終わりまで使え、返金はありません。年払いは月割りで、解約した日を含む契約月の終わりまで使え、残りの月の分を返金します。",
    contractRuleTrial:
      "無料期間は、Entamy ID で委託運用を初めて使うときに 1 回だけ付きます。無料期間中に申し込んでも、最初のお支払いは無料期間が終わったときです。",
    contractRuleUnpaid:
      "契約しないまま無料期間が終わると、記事の追加とビルド（公開）が止まり、{n} 日後にデータが消えます。公開済みのページはそれまで出し続けます。",
    contractRuleSelf:
      "ご自身の Cloudflare アカウントで動かす顧客導入は無料です。委託運用からは、下の引っ越しで移れます。",
    regionTitle: "稼働地域",
    regionHelp:
      "この KuroCMS のデータベース（D1）と KuroCMS 本体が、いまどこで動いているかです。データベースの地域は作ったときに決まり、後から変えられません。地域の中のどの拠点に置くかは Cloudflare が選びます。",
    regionDb: "データベース（D1）",
    regionWorker: "KuroCMS の場所",
    regionEntry: "要求を受けた拠点",
    regionRtt: "往復",
    regionSame: "同じ地域",
    regionApart: "離れています",
    regionUnknown: "不明",
    regionOtherPlace: "Cloudflare の拠点（{code}）",
    regionMeasure: "測り直す",
    ipGateOn: "入",
    ipGateOff: "切",
    ipGateCurrentLabel: "この回線",
    ipGateHowTitle: "仕組み",
    ipGateHow1t: "自動で登録",
    ipGateHow1b:
      "パスキーでログインすると、その回線が登録されます。利用者が操作することはありません。",
    ipGateHow2t: "使うたびに延長",
    ipGateHow2b:
      "使うたびに登録が延びます。使わなくなった回線は、下の日数がたつと外れます。",
    ipGateHow3t: "別の回線はメールで確認し再登録",
    ipGateHow3b:
      "ログイン済みの状態が登録していない回線から使われると止め、本人へ確認のリンクをメールします。パスキーでログインし直しても登録されます。",
    ipGateDetailTitle: "詳細設定",
    ipGateDays: "日",
    ipGateTitle: "IP 制限",
    ipGateHelp:
      "管理画面は、利用者ごとに登録した回線からしか使えません。盗まれたログインの状態（クッキー）を、ほかの場所で使わせません。登録は全自動です。",
    ipGateEnabled: "IP 制限を入れる",
    ipGatePat: "個人用アクセストークン（PAT）も制限する",
    ipGatePatHelp:
      "既定は切です。AI のエージェントや MCP は、毎回アドレスの変わるクラウドの回線やサーバーから API を呼ぶため、IP が切り替わることが多く、切にできるようになっています。",
    ipGateTtlV6: "IPv6 の回線を登録しておく日数",
    ipGateTtlV4: "IPv4 のアドレスを登録しておく日数",
    ipGateTtlHelp:
      "最後に使ってからの日数です。この間使わなかった回線は外れ、次にパスキーでログインしたときにまた登録されます。",
    ipGateCurrent: "この回線: {net}",
    ipGateOffConfirm:
      "IP 制限を切りますか？ 盗まれたログインの状態が、どの回線からでも使えるようになります。",
    saved: "保存しました",
    networkUnregistered:
      "この回線はあなたのアカウントに登録されていないため、止めました。確認のリンクをメールで送りました。パスキーでログインし直しても、この回線が登録されます。",
    myNetworks: "登録した回線",
    myNetworksLead:
      "パスキーでログインしたときに自動で登録された回線です。管理画面はここにある回線からしか使えません。心当たりのないものは外してください。",
    myNetworksOff: "このサイトでは IP 制限が切られています。",
    networkLastUsed: "最後に使った日時",
    networkExpires: "期限",
    networkCurrent: "この回線",
    networkRemoveConfirm:
      "この回線を外しますか？ この回線から管理画面を使うには、パスキーでログインし直す必要があります。",
    ipV6Title: "登録 IPv6",
    ipV6Lead:
      "あなたの IPv6 の回線です。パスキーでログインしたときに自動で登録される /64 のほか、プロバイダーから受けている prefix（/48・/56 など）を固定で足せます。固定の回線は期限がなく、その中の /64 が変わっても止まりません。",
    ipV6Placeholder: "例: 2400:4050:7e40::/48",
    ipV6NotePlaceholder: "メモ（任意・例: 自宅）",
    ipV6Add: "追加",
    ipV6Added: "追加しました",
    ipV6UseCurrent: "この回線の /64 を入れる",
    ipV6Pinned: "固定",
    ipV6Auto: "自動",
    ipV6NoExpiry: "期限なし",
    ipV6Empty: "IPv6 の回線はまだ登録されていません。",
    blueskyHandle: "Blueskyハンドル",
    blueskyHandleHelp:
      "Blueskyのハンドル名（例: yourname.bsky.social）。空白で非表示。",
    left: "左",
    siteName: "サイト名",
    siteNameHelp:
      "管理画面やメタ情報で表示されるサイト名です。テンプレートでは [[site.name]] で表示できます。",
    adminUrlLabel: "KuroCMS管理画面URL",
    adminUrlDerivedFromBootstrap:
      "この管理画面のアドレスです。公開ドメインに合わせて決まります。",
    publicDomain: "公開ドメイン",
    publicDomainHelp:
      "サイトの公開 URL です。Cloudflare でドメインを契約すると独自ドメインを設定できます。未設定の場合は workers.dev の URL をそのまま使用できます（例: https://yoursite.workers.dev/）。",
    workerOriginUrl: "Worker オリジン URL（workers.dev）",
    workerOriginHelp:
      "KuroCMS Worker の workers.dev 直接 URL です（カスタムドメイン未設定時の既定の公開 URL）。",
    customDomainTitle: "カスタムドメイン（Cloudflare）",
    currentCustomDomains: "設定済みカスタムドメイン",
    noCustomDomains: "カスタムドメインは未設定です。",
    customDomainHelp:
      "ご自身の Cloudflare アカウントで管理しているドメインを入力してください。Cloudflare が DNS レコードと SSL 証明書を自動作成します（CNAME の手動追加は不要）。設定には、この導入の Cloudflare のトークンに DNS の編集権限が必要です。",
    customDomainPermNote:
      "権限エラーで失敗した場合は、この導入の Cloudflare のトークンに DNS の編集権限がありません。Cloudflare ダッシュボードの Workers & Pages → KuroCMS の Worker → 設定 → ドメインとルート → 追加 → カスタムドメイン から追加してください。",
    setCustomDomain: "カスタムドメインを設定",
    customDomainAdded:
      "カスタムドメインを割り当てました。Cloudflare が DNS と SSL を自動構成中です（数分）。完了後、上の「公開ドメイン」に設定して保存してください。",
    r2SetupTitle: "R2 メディアストレージ",
    r2SetupHelp:
      "画像・動画・音楽を扱う場合だけ必要です。無料枠の 10GB までは課金されません。設定はご自身の Cloudflare で行います（KuroCMS からは作りません）。① R2 の利用を開始し、バケットを作る ② Workers & Pages → {worker} → 設定 → バインディング → 追加 → R2 バケット で、変数名を MEDIA_BUCKET にして ① のバケットを選ぶ。保存すると、この枠に「利用可能です」と出ます。",
    settingsTabDomain: "ドメイン",
    publicDomainReset: "既定値に戻す",
    publicDomainResetDone:
      "既定値（{url}）を入れました。保存して、全ページをビルドしてください。",
    publicDomainLinksNote:
      "公開ページ内のリンク（記事の URL・canonical・サイトマップなど）は、この公開ドメインから作ります。変えたら保存して、全ページをビルドしてください。",
    ownDomainTitle: "自分のドメインで公開する",
    ownDomainLead:
      "KuroCMS の委託運用では、Cloudflare for SaaS の機能を使って、お客様のドメイン名でサイトを公開できます。Cloudflare for SaaS は KuroCMS 側で契約しているので、お客様の追加の契約や費用はありません。設定の手順は、お客様のドメインの DNS をどこで管理しているかで変わります。",
    ownDomainDnsQuestion: "ドメインの DNS はどこで管理していますか？",
    ownDomainStep1Title:
      "上の公開ドメインにドメイン名を入れて「準備する」を押す",
    ownDomainStep1Desc:
      "例: blog.example.com や example.com など。準備するだけで、まだ保存はしません。",
    ownDomainStep2Title: "DNS に TXT レコードを追加する",
    ownDomainStep2DescCf:
      "Cloudflare のダッシュボードで追加します。追加しても、今の表示は変わりません。",
    ownDomainStep2DescOther:
      "お使いの DNS の管理画面で追加します。追加しても、今の表示は変わりません。",
    ownDomainStep3Title: "「状態を確かめる」→「ドメインを切り替える」を押す",
    ownDomainStep3Desc:
      "TXT を追加して数分たってから押します。証明書が発行されると「ドメインを切り替える」が押せます。",
    ownDomainStep4Title: "DNS の CNAME をこのサイトに向ける",
    ownDomainStep4DescCf:
      "プロキシはオン（オレンジの雲）のままで構いません。example.com にも設定できます。1 分ほどで有効になります。",
    ownDomainStep4DescOther:
      "example.com そのものには CNAME を設定できないことが多いので、blog.example.com のような名前を使ってください。",
    ownDomainStep5Title: "保存して、全ページをビルドする",
    ownDomainStep5Desc:
      "有効になったら、上の「サイト設定を保存」を押し、全ページをビルドします。有効になる前は保存できません。",
    ownDomainRecordsBefore:
      "「準備する」を押すと、ここに TXT レコードが表示されます。",
    ownDomainTxtGone: "TXT レコードの確認は済んでいます。",
    ownDomainDnsCloudflare: "Cloudflare で管理している",
    ownDomainDnsOther: "その他の DNS（お名前.com など）",
    ownDomainOverwriteNote:
      "CNAME を書き換えると、そのドメインでそれまで表示していたものは見えなくなります。メール（MX）やほかのレコードには影響しません。",
    ownDomainPrepare: "準備する",
    ownDomainNeedHost:
      "上の公開ドメインに、使いたいドメイン名を入れてください。",
    ownDomainNotActiveSave:
      "このドメインはまだ有効になっていません。いま保存すると、ページのリンクが開けないアドレスに向きます。手順を終えてから保存してください。",
    ownDomainCheck: "状態を確かめる",
    ownDomainSwitch: "ドメインを切り替える",
    ownDomainRemove: "取り消す",
    ownDomainRemoveConfirm:
      "このドメインを KuroCMS から外しますか？ すでに CNAME をこちらへ向けている場合、そのドメインではサイトが表示されなくなります。",
    ownDomainColState: "状態",
    ownDomainRecDone: "済み",
    ownDomainRecTodo: "まだ",
    ownDomainColName: "名前",
    ownDomainColValue: "値",
    ownDomainColPurpose: "用途",
    ownDomainPurposeOwnership: "所有の確認",
    ownDomainPurposeCertificate: "証明書",
    ownDomainDone: "このドメインで公開しています。",
    err_invalid_hostname:
      "blog.example.com のような形でドメイン名を入れてください。",
    err_hostname_taken:
      "このドメインは、すでに KuroCMS の委託運用で使われています。",
    err_domain_not_verified:
      "証明書がまだ発行されていません。TXT レコードを足したか確かめて、数分後にもう一度押してください。",
    err_domain_switched:
      "このドメインは切り替え済みです。別のドメインにするときは、先に取り消してください。",
    err_no_domain: "先にドメインを準備してください。",
    err_not_managed: "委託運用だけで使えます。",
    err_proof_invalid:
      "このサイトを Entamy に確かめられませんでした。もう一度押してください。",
    err_domain_not_permitted:
      "いま Entamy がドメインの設定を変えられません。Entamy にお問い合わせください。",
    err_domain_failed:
      "ドメインの設定を変えられませんでした。しばらくしてから、もう一度押してください。",
    publicDomainManagedHelp:
      "公開ページのリンクに使うアドレスです。既定は委託のアドレス（導入 ID.kurocms.site）です。自分のドメインで公開するときは、ここにドメイン名を入れて、下の「準備する」を押してください。保存するのは有効になってからです。",
    r2SetupDashboard: "Cloudflare で R2 を確認",
    r2SetupReady: "R2 メディアストレージは利用可能です。",
    cfManualSteps:
      "Cloudflare ダッシュボードから追加します：Workers & Pages → お使いの KuroCMS Worker → 設定 → ドメインとルート → 追加 → カスタムドメイン → ドメインを入力。DNS と SSL は Cloudflare が自動作成します。数分後、上の「公開ドメイン」に設定して保存してください。",
    defaultLanguage: "基本言語",
    defaultLanguageHelp:
      "ユーザーが記事を見た時に、翻訳がない記事の場合に利用するフォールバック言語を選択します。",
    saveSiteSettings: "サイト設定を保存",
    saveSnsSettings: "SNS情報を保存",
    openSnsConsole: "SNS管理画面を開く",
    siteSettingsSaved: "サイト設定を保存しました。",
    name: "名前",
    newType: "新規タイプ",
    id: "ID",
    newCategory: "新規カテゴリ",
    typeCreated: "タイプを作成しました。",
    categoryCreated: "カテゴリを作成しました。",
    error: "エラー",
    availableLanguages: "利用可能な言語",
    searchLanguagePlaceholder: "入力して検索（例: ビルマ, my）...",
    noMatches: "該当する言語がありません",
    addLanguage: "言語を追加",
    removeLanguage: "削除",
    languageAdded: "言語を追加しました。",
    languageRemoved: "言語を削除しました。",
    noRegisteredLanguages: "登録済み言語はありません。",
    dataUsage: "データ使用状況",
    removeLanguageConfirm: "この言語を対応言語リストから削除しますか？",
    removeLanguageKeepPrompt:
      "削除しても翻訳データは保持され、再登録すれば元に戻ります。下のチェックを入れた場合のみ、その言語のデータも完全に削除されます。",
    selectLanguage: "言語を選択",
    selectLanguageLead:
      "管理画面で使用する言語を選択してください。後で管理画面にて変更可能です。",
    loginTitle: "ログイン",
    loginLead: "パスキーでログインしてください。",
    loginWithPasskey: "パスキーでログイン",
    loginNewDeviceTitle: "新しくデバイスを登録する場合",
    loginNewDeviceAfter:
      "送信後、届いたメールのワンタイムリンク（30分間有効・1回のみ）を開くと、このデバイスに新しいパスキーを登録できます。登録が完了すると、以降は「パスキーでログイン」からサインインできます。",
    registerPasskey: "パスキーを登録",
    registeringPasskey: "登録中...",
    recoverRequestLead:
      "登録済みのメールアドレスを入力してください。新しいパスキーを登録するためのリンクを送信します。",
    recoverSendLink: "再設定リンクを送信",
    mailSetupGuideTitle: "自ドメインで送信する設定方法",
    mailSetupGuideIntro:
      "既定では黒兎のサーバーが代理送信します。ご自身のドメインから送ると、Cloudflare の無料枠で送信でき、黒兎側の上限を受けません。設定は Cloudflare 側で行います（この画面からは実行できません）。",
    mailSetupStep1: "手順 1：ドメインで Email Routing を有効にする",
    mailSetupStep1Body:
      "Cloudflare の Compute → Email Service → Email Routing を開き、{zone} を選んで有効化します。送信元のドメインが Cloudflare に登録されていることが条件です。",
    mailSetupStep2: "手順 2：宛先アドレスを追加して認証する",
    mailSetupStep2Body:
      "同じ画面の Destination addresses（宛先アドレス。アカウント全体で共有）に、{address} を含む管理者のメールアドレスをすべて追加し、届いた確認メールのリンクを開いて verified にします。⚠ 復旧メールは要求した本人へ送るため、管理者が複数いる場合は全員分が必要です。1 人でも未認証だと、その人だけログインできなくなります。",
    mailSetupStep3: "手順 3：この画面のスイッチを入れる",
    mailSetupStep3Body:
      "手順 1・2 が済むとスイッチが押せるようになります。入れると以後は自ドメインから送信し、失敗したときだけ黒兎のサーバーが代送します。",
    mailSetupOpenCf: "Cloudflare の Email Routing を開く",
    mailSetupDocs: "Cloudflare の手順書",
    mailSetupNote:
      "「確認できませんでした」と出る場合、この導入のトークンに zone 側の権限が無く、CMS からは判定できない状態です。設定が正しければ送信は成功します。失敗した場合は代送に切り替わり、その旨が画面に表示されます。",
    mailDeliveryZoneOff:
      "送信元ドメインで Email Routing が有効になっていません",
    mailDeliveryZoneUnknown:
      "確認できませんでした（この導入のトークンに zone 側の権限が無い可能性があります）。送信に失敗する場合はここを疑ってください",
    mailDeliveryZoneOn: "送信元ドメインで Email Routing が有効です",
    mailDeliveryAdminsUnverified:
      "次の管理者は verified な宛先ではないため、復旧メールが届かなくなります",
    // 配送の不調。**順調なときは出さない。**
    recoverRelayed:
      "自ドメインからの送信に失敗したため、黒兎のサーバーが代わりに送信しました。メールは届くはずですが、自ドメインの設定は機能していません。設定 → メール送信をご確認ください。",
    recoverRelayedReason: "自ドメイン側のエラー",
    recoverNotDelivered:
      "メールを送信できませんでした。このままでは届きません。",
    recoverQuota:
      "黒兎のサーバーの送信上限に達しました。上限は時間で戻るため、12 時間ほど空けて再度お試しください。設定 → メール送信で自分のドメインを設定すると、この上限を受けずに送信できます。",
    recoverReason: "理由",
    recoverSent:
      "登録があれば、再設定リンクを送信しました。メールをご確認ください。",
    recoverTitle: "アクセスを復旧",
    recoverLead: "このアカウントに新しいパスキーを登録します。",
    logout: "ログアウト",
    actions: "操作",
    edit: "修正",
    delete: "削除",
    update: "更新",
    save: "保存",
    updateDone: "更新しました。",
    deleteDone: "削除しました。",
    confirmDeleteType: "このタイプを削除しますか？",
    confirmDeleteCategory: "このカテゴリを削除しますか？",
    addRegister: "追加登録",
    registeredLanguagesList: "登録済み言語の一覧",
    registeredTypesList: "登録されているタイプの一覧",
    registeredCategoriesList: "登録されているカテゴリの一覧",
    buildingTitle: "サイトをビルド中",
    buildSplitNote:
      "Cloudflare Worker の1回の実行上限（1000 リクエスト）に合わせ、リクエスト使用量に応じて1回あたりのビルド件数を自動調整し、完了まで複数回に分けて実行します。",
    buildPreparing: "準備中…",
    buildBuiltLabel: "ビルド",
    buildSkippedLabel: "スキップ（変更なし）",
    buildErrorsLabel: "エラー",
    close: "閉じる",
    buildDone: "完了",
    buildIncomplete: "未完了",
    buildIncompleteDetail:
      "ビルドが最後まで終わる前に止まりました(ページ、または静的資産の登録)。もう一度ビルドすると、続きから進みます。",
    buildAssetsLine: "静的資産: 上げた {uploaded}・残り {remaining}({status})",
    buildCancel: "中止",
    buildCancelled: "ビルドを中止しました",
    buildPassRetry:
      "接続が切れました（{err}）— 再試行します（{n}/{max}）。ビルド済みのページはスキップされます。",
    buildPassShrink:
      "1 回の処理が途中で止まりました（この Cloudflare の口座の CPU の上限に当たった可能性があります）。1 回 {n} ページに減らして続けます。",
    buildPassShrinkLangs:
      "1 ページでも 1 回に収まりませんでした。1 回にページの {n} 言語ずつ作って続けます。",
    buildErrorPrefix: "ビルドエラー: ",
    unknownError: "不明なエラー",
    mediaLabel: "メディア",
    installedVersionLabel: "導入バージョン",
    stableVersionLabel: "安定バージョン",
    latestVersionLabel: "最新バージョン",
    autoUpdateLabel: "自動で更新する",
    autoUpdateHint:
      "ON（既定）: 選んだ版の新しいものを1日に1回確かめ、復旧の番人（WorkerOps）が入れます。入れた直後の検証に失敗すれば元の版に戻します。急ぐときは「今すぐ更新」を押してください。",
    autoUpdateOffConfirm:
      "自動更新を切にします。新しい版は「今すぐ更新」を押したときだけ入ります。続けますか？",
    updateChannelLabel: "常に最新版に更新",
    updateChannelHint:
      "ON: 更新ボタンは最新版（リリースのたび）を対象にします。OFF: 安定版（管理者が昇格したリリース）のみを対象にします。",
    checking: "確認中…",
    updateNow: "今すぐ更新",
    checkForUpdate: "今すぐ更新のチェック",
    alreadyLatest: "最新バージョンです。",
    versionCheckFailed:
      "最新バージョンを確認できませんでした。これは「最新です」という意味ではなく、確認そのものが GitHub に届かなかったという意味です。時間をおいて再度お試しください。",
    versionCheckFailedStale:
      "最新バージョンを確認できませんでした。表示しているのは {when} 時点で分かっていた版です。すでに新しい版が出ている可能性があります。",
    updating: "更新中…",
    updateSuccessReload: "更新しました。ページをリロードしてください。",
    updateConfirm: "KuroCMS を最新バージョンに更新しますか？",
    guardianAutoHint:
      "ON（既定）: KuroCMS 自身が更新されるたびに、KuroCMS が WorkerOps（復旧の番人）を確かめ、選んだ版の新しいものを入れます。入れた後に新しい WorkerOps が応答しなければ、KuroCMS が元の版に戻します。",
    guardianAutoOffConfirm:
      "WorkerOps の自動更新を切にします。新しい版は「今すぐ更新」を押したときだけ入ります。続けますか？",
    guardianChannelHint:
      "ON: WorkerOps の最新版（リリースのたび）を対象にします。OFF: 安定版（管理者が昇格したリリース）のみを対象にします。",
    guardianUpdateConfirm:
      "WorkerOps（復旧の番人）を更新しますか？ 新しい版が応答しなければ元の版に戻します。1 分ほどかかります。",
    guardianNoBinding:
      "この導入は WorkerOps と繋がっていないため、ここからは更新できません。",
    guardianCredsMissing:
      "更新用の Cloudflare の資格情報が設定されていないため、ここからは WorkerOps を更新できません。また、KuroCMS と WorkerOps の定期処理（cron）が 1 本にまとまらず 2 本のままです。無料の Cloudflare の口座では cron が 5 本までなので、入れられる導入の数が減ります。直すには: Cloudflare のダッシュボードで、この口座の「Workers Scripts: 編集」の権限を持つ API トークンを作り、この Worker の「設定 → 変数とシークレット」に、シークレット CF_API_TOKEN（そのトークン）と、CF_ACCOUNT_ID（口座 ID）・CF_WORKER_NAME（この Worker の名前）を入れてください。ここから更新できるようになり、WorkerOps を新しい版へ上げた後は、KuroCMS が定期処理を自分で 1 本にまとめます。",
    guardianLegacy:
      "この WorkerOps は古く、版を名乗れません。一度更新すると版が表示されるようになります。",
    guardianLegacyVersion: "古い版",
    guardianTargetTooOld:
      "選んでいる側には、まだ上げられる版（{min} 以降）がありません。今すぐ試すなら「常に最新版に更新」をオンにしてください。",
    guardianCheckFailed:
      "WorkerOps の版を確認できませんでした。「最新です」という意味ではありません。",
    guardianResultUpdated:
      "WorkerOps を {from} → {to} に更新しました（{when}）。",
    versionUpdatedAt: "KuroCMS を {from} → {to} に更新しました（{when}）。",
    guardianResultRolledBack:
      "WorkerOps {to} が応答しなかったため、元の版に戻しました（{when}）。理由: {error}",
    guardianResultFailed:
      "WorkerOps の更新に失敗しました（{when}）。理由: {error}",
    guardianBusy:
      "WorkerOps が KuroCMS を更新している最中です。1 分ほどおいてもう一度お試しください。",
    storageFreeUsage: "CF 無料枠使用状況",
    storageManagedUsage: "使用状況（Entamy 委託）",
    storagePaidUsage: "CF Paid 使用状況（料金に含まれる分）",
    planFree: "無料枠",
    cfAccountLabel: "Cloudflare アカウント: ",
    cfAccountManaged: "委託利用者用の Cloudflare アカウント",
    managedUpdateRequested:
      "新しい版をすぐ確かめるよう Entamy に頼みました。数分で入ります。",
    managedUpdateNote:
      "委託では、選んだ版を Entamy が自動で届けます。新しい版は 1 日 1 回（前回の確認から 24 時間後）確かめて入れます。すぐに更新が必要なときは、Entamy に更新を依頼してください。",
    profileTabAccount: "アカウント",
    profileTabDisplay: "表示",
    profileTabPat: "PAT",
    profileTabPasskey: "パスキー",
    profileTabNetwork: "IP制限",
    cfAccountUnknown: "確認できません",
    planPaid: "Paid",
    storagePlanHint:
      "グラフを無料枠の上限で描くか、Workers Paid の料金に含まれる量で描くかを切り替えます",
    paidIncludedLabel: "料金に含まれる量: ",
    kvWritesTodayPaid: "KV 書き込み（本日・月の含み分に対して）",
    kvPaidMonthlyNote:
      "Paid は月 書き込み 100 万回・読み出し 1,000 万回まで含む（超えた分は課金。止まらない）",
    freeLimitLabel: "無料枠上限: ",
    managedLimitLabel: "上限: ",
    mediaUploadFailedInline: "アップロード失敗: {name}",
    err_media_quota_exceeded:
      "メディアの保存上限に達したため、保存できません。Entamy 委託のサイトは、メディアの保存に上限があります。不要なメディアを削除してから、もう一度お試しください。",
    managedR2Note:
      "Entamy 委託のサイトは、メディアの保存に上限（{limit}）があります。不要なメディアを削除すると空きが増えます。",
    r2Unavailable: "R2 未有効",
    r2Media: "R2 メディア",
    d1Database: "D1 データベース",
    kvPages: "KV 公開ページ",
    kvWritesToday: "KV 書き込み（本日）",
    kvReadsLabel: "読み取り",
    kvResetLabel: "リセット",
    kvOpsUnavailable: "データなし",
    articleCountTitle: "記事数",
    publishedOfTotalTitle: "公開数 / 記事数",
    collectionArticleCount: "コレクション記事数",
    sortOrder: "ソート順",
    sortUpdatedDesc: "更新日 新しい順",
    sortUpdatedAsc: "更新日 古い順",
    sortPublishDesc: "公開日 新しい順",
    sortPublishAsc: "公開日 古い順",
    sortTitleAsc: "タイトル A→Z",
    categoryFilter: "カテゴリ",
    allCategories: "すべて",
    buildModeLabel: "ビルド設定",
    buildModeManual: "手動ビルドのみ",
    buildModeAuto: "公開予定記事をその時間に自動ビルド",
    buildModeAlways: "未来記事も無条件にビルド",
    buildModeForceAll: "強制的に全件をビルド",
    buildNow: "今すぐビルド",
    buildNoTemplateHint: "テンプレートを選択してください。",
    openPublicPage: "ビルドした公開ページを開く",
    publishedToast: "公開フラグを設定しました（次のビルドで公開されます）",
    unpublishedToast: "非公開フラグを設定しました（次のビルドで反映されます）",
    draftToast: "下書きに変更しました（次のビルドで反映されます）",
    unpublishAction: "非公開に",
    publishAction: "公開する",
    titleSlugHeader: "タイトル / Slug",
    snsPublishStatus: "SNS公開状態",
    snsPublished: "公開済み",
    snsUnpublished: "未公開",
    buildStateBuilt: "ビルド済み",
    buildStateUnbuilt: "未ビルド",
    buildStatePending: "公開待ち",
    buildStateExpired: "公開終了",
    buildStateStillLive: "未ビルド（公開中）",
    err_not_found:
      "対象が見つかりません。すでに削除されている可能性があります。",
    err_draft:
      "この記事はまだ下書きです。先に「公開する」を押してから投稿してください。",
    err_not_built:
      "公開済みですが、まだビルドされていません。先にビルドしてください（未ビルドのまま投稿すると、開けないリンクを共有することになります）。",
    err_scheduled:
      "公開予定日時がまだ来ていません。ビルドしても、その時刻を過ぎるまでは公開されません。記事の公開日時を変更するか、ビルド設定を「未来記事も無条件にビルド」にしてください。",
    err_expired:
      "公開終了日時を過ぎているため、この記事は公開されていません。公開終了日時を空にするか、先の日時に変更してください。",
    err_already_posted: "この記事はすでに投稿済みです。",
    err_not_configured:
      "この SNS の接続が未設定です。設定 → SNS で登録してください。",
    err_no_public_domain:
      "サイトの公開ドメインが未設定です。設定 → ドメインで登録してください。",
    err_invalid_field: "入力に誤りがあります。内容をご確認ください。",
    err_invalid_email: "メールアドレスの形式が正しくありません。",
    err_document_not_found: "記事が見つかりません。",
    err_translation_not_found: "この言語の翻訳がありません。",
    err_user_not_found: "利用者が見つかりません。",
    err_user_disabled: "この利用者は無効化されています。",
    err_email_taken: "このメールアドレスは既に使われています。",
    err_invite_not_found: "招待が見つかりません。",
    err_invite_expired: "招待の有効期限が切れています。作り直してください。",
    err_invitation_required: "招待が必要です。",
    err_recover_invalid:
      "この再設定リンクは使えません。もう一度メールを送ってください。",
    err_recover_expired:
      "再設定リンクの有効期限が切れています（30分）。もう一度メールを送ってください。",
    err_credential_exists: "このパスキーは既に登録されています。",
    err_credential_not_found: "パスキーが見つかりません。",
    err_passkey_not_found: "パスキーが見つかりません。",
    err_last_passkey:
      "最後のパスキーは削除できません。先に別のパスキーを登録してください。",
    err_cannot_modify_self: "自分自身のこの設定は変更できません。",
    err_cannot_delete_self: "自分自身は削除できません。",
    err_slug_exists: "このスラグは既に使われています。",
    err_slug_reserved: "このスラグは予約されていて使えません。",
    err_name_conflict: "同じ名前が既にあります。",
    err_category_exists: "このカテゴリは既にあります。",
    err_category_in_use: "このカテゴリは記事で使われているため削除できません。",
    err_category_not_found: "カテゴリが見つかりません。",
    err_type_in_use: "このタイプは記事で使われているため削除できません。",
    err_type_not_found: "タイプが見つかりません。",
    err_file_too_large: "ファイルが大きすぎます。",
    err_invalid_file_type: "この形式のファイルは扱えません。",
    err_missing_file: "ファイルが選ばれていません。",
    err_media_not_found: "画像・メディアが見つかりません。",
    err_r2_not_configured:
      "画像の保存先（R2）が未設定です。「設定 → 基本」の「R2 メディアストレージ」の手順でつないでください。",
    err_cf_creds_missing: "Cloudflare の資格情報が未設定です。",
    err_custom_domain_required: "先にカスタムドメインを割り当ててください。",
    err_email_routing_destination_unverified:
      "宛先アドレスが未認証です。Cloudflare の Email Routing で認証してください。",
    err_email_routing_zone_disabled:
      "送信元ドメインで Email Routing が有効になっていません。",
    err_email_routing_admin_unverified:
      "未認証の管理者アドレスがあります。全員分を認証してください。",
    err_no_community_pat:
      "公開テンプレートの操作に必要な資格情報が未設定です。",
    err_template_owner_required: "このテンプレートの所有者だけが操作できます。",
    err_community_template_not_found: "公開テンプレートが見つかりません。",
    err_setup_completed: "初期設定は完了済みです。",
    err_base_language_delete: "基準言語は削除できません。",
    err_last_translation: "最後の翻訳は削除できません。",
    err_lang_required: "言語を指定してください。",
    err_invalid_language: "その言語は扱えません。",
    err_body_conflict:
      "他の場所で更新されています。読み込み直してから保存してください。",
    err_revision_not_found: "履歴が見つかりません。",
    err_license_required: "この機能にはライセンスが必要です。",
    snsPostBtn: "投稿",
    snsPostingBtn: "投稿中…",
    snsPostConfirm:
      "この記事を Bluesky に投稿しますか？（タイトル・リンク・カバー画像）",
    snsPostDone: "{service} に投稿しました。",
    snsMarkOnlyBtn: "実際に投稿せず完了とする",
    snsMarkOnlyDone: "投稿済みに設定しました（投稿は送信していません）。",
    snsClearTitle: "投稿済みフラグの解除",
    snsClearConfirm:
      "投稿済みフラグを解除しますか？（SNS上の実際の投稿は削除されません。解除するとこの記事に「投稿」ボタンが再表示されます）",
    snsClearBtn: "フラグ解除",
    snsClearDone: "投稿済みフラグを解除しました。",
    snsClearHint: "クリックで投稿済みフラグを解除",
    snsPostConfirmX:
      "この記事を X に投稿しますか？（親ポスト=カバー画像＋本文。記事リンクは設定に応じてリプライまたは本文で送信されます）",
    xSettingsTitle: "X (Twitter) 自動投稿",
    xCredsHelp:
      "X Developer Portal で発行した4つの認証情報を入力します（アプリの権限は Read and write が必要）。値はサーバー側に保存され、再表示されません。",
    xApiKey: "API Key（Consumer Key）",
    xApiSecret: "API Key Secret（Consumer Secret）",
    xAccessToken: "Access Token",
    xAccessSecret: "Access Token Secret",
    xLinkInReply: "リンクはリプライで投稿（2通に分割）",
    snsXUseAutoPost:
      "投稿用の認証情報は、上の「X (Twitter) 自動投稿」欄で設定します（API Key / Secret・Access Token / Secret の4つ）。このカードはハンドルとSID（フィード表示・将来対応）のみです。",
    xLinkInReplyHelp:
      "X APIでは本文にリンクを含む投稿は高い料金区分になる場合があります。ONにすると親ポスト（画像＋本文）→リプライ（記事リンク）の2通に分けて投稿し、費用を抑えます（目安: $0.015＋$0.015＝約$0.03/記事・約5円）。OFFにすると1通の本文にリンクを含めて投稿します。",
    threadsSettingsTitle: "Threads 自動投稿",
    threadsCredsHelp:
      "Threads API の長期アクセストークンを入力します（Meta for Developers でアプリを作成し、threads_basic と threads_content_publish 権限が必要）。値はサーバー側に保存され、再表示されません。",
    threadsTokenUpdatedAt: "トークン更新完了日",
    threadsTokenNextRefreshAt: "次回自動更新予定（目安）",
    threadsTokenUpdatePending: "自動更新の確認待ち",
    threadsTokenRefreshHelp:
      "最終更新の成功から30日後に自動更新します。次回予定日は、更新完了日から算出した目安です。",
    threadsPostNote:
      "投稿は1通構成：カバー画像＋タイトル/要約＋トピックタグ1つ＋記事リンク（500字制限。Threadsは1投稿につきタグ1つのみリンク化されます）。Xと違い投稿ごとの課金がないため、親＋リプライ分割はしません。",
    snsPostConfirmThreads:
      "この記事を Threads に投稿しますか？（1通：カバー画像＋本文＋トピックタグ＋記事リンク）",
    snsThreadsUseAutoPost:
      "投稿用の認証情報は「Threads 自動投稿」カードで設定します（アクセストークン）。このカードはハンドル（フィード表示・将来対応）のみです。",
    snsBulkTitle: "投稿済みフラグの一括操作",
    snsBulkSetBtn: "全件投稿済みにする",
    snsBulkClearBtn: "全件投稿済みを解除",
    snsBulkSetConfirm:
      "{service} の投稿済みフラグを全記事に立てますか？既存記事には「投稿」ボタンが表示されなくなります（解除は記事ごとの投稿済み表示クリック、またはここから全件解除）。すでにフラグが立っている記事の投稿日時は保持されます。",
    snsBulkClearConfirm:
      "{service} の投稿済みフラグを全記事から解除しますか？全公開記事に「投稿」ボタンが再表示されます。過去記事を誤って再投稿しないようご注意ください。",
    snsBulkDone: "{count} 件のフラグを更新しました。",
    snsPostQueued:
      "投稿を開始しました。Threadsは画像処理のため最大1分ほどかかります。完了すると一覧が自動で投稿済み表示になります。",
    snsPostQueueTimeout:
      "投稿の完了をまだ確認できていません。1分ほど後に記事一覧を再読み込みして状態を確認してください。",
    statusActionsHeader: "状態 / 操作",
    langsSuffix: "言語",
    updatedSuffix: "更新",
    tmplTabView: "テンプレート表示",
    tmplTabSelect: "テンプレート選択",
    tmplTabEdit: "テンプレート編集",
    tmplTabContent: "サイト文字編集",
    fontTab: "フォント管理",
    fontEditorTitle: "サイトのフォント",
    fontEditorHint:
      "Web フォントを読み込むと、閲覧者の機種に依存せず同じ見た目になります。サイトの対応言語ごとに基本フォントを選べます。テンプレート側の font-family 指定が優先されます。",
    fontLanguage: "設定言語",
    fontAvailable: "読み込めるフォント",
    fontLoaded: "サイトに読み込むフォント",
    fontAddBtn: "← 読み込む",
    fontRemoveBtn: "外す →",
    fontBaseMark: "基本フォント",
    fontBaseRequired: "保存前に基本フォント（★）を選択してください。",
    fontSystemLocked: "組み込み（機種依存）— 外せません",
    fontRecommended: "おすすめ",
    fontSaveBtn: "フォントを保存",
    fontSaved: "フォントを保存しました。ビルドで反映されます。",
    fontSaving: "保存中…",
    fontPreviewText: "Aa あ亜 永",
    analyticsTab: "計測",
    analyticsTitle: "計測・SEO",
    analyticsHint:
      "Google アナリティクス 4 と、SEO・SNS プレビューに使うサイト説明を設定します。ビルドで反映されます。",
    analyticsGa4Label: "GA4 計測ID",
    analyticsGa4Hint:
      "Google アナリティクス 4 の計測ID（例: G-XXXXXXXXXX）。空欄にすると計測を無効にします。",
    analyticsGa4Invalid: "IDは G-XXXXXXXXXX 形式で入力してください。",
    analyticsDescLabel: "サイト説明（SEO）",
    analyticsDescHint:
      "トップ・一覧ページの既定メタ／SNS 説明文（記事は各記事の要約を使用）。",
    analyticsSaveBtn: "保存",
    analyticsSaving: "保存中…",
    analyticsSaved: "保存しました。ビルドで反映されます。",
    communityUnpublishedBtn: "○ コミュニティに公開",
    communityUpdateBtn: "↻ 公開テンプレートを更新",
    tmplRenameBtn: "名前変更",
    tmplRenamePrompt: "新しいテンプレート名:",
    tmplRenamed: "テンプレート名を変更しました。",
    communityNameConflictHint:
      "同じ名前の公開テンプレートが既に存在するため公開できません。",
    communityUpdateConfirm:
      "このテンプレートで公開テンプレートを更新しますか？",
    communityJsRemoved:
      "Community のテンプレートには JS を入れられないため、公開した写しから {n} か所の JS を外しました。動きは [[…]] の部品（toggle・tab など）で付けてください。自分のサイトのテンプレートはそのままです。",
    communityUpdateSuccess: "公開テンプレートを更新しました！",
    communityDeleteConfirm:
      "コミュニティライブラリからこのテンプレートを削除しますか？",
    processing: "処理中…",
    communityDeleteSuccess: "コミュニティライブラリから削除しました。",
    communityPublishSuccess: "コミュニティライブラリに公開しました！",
    tmplNotLoaded: "テンプレートが読み込まれていません",
    noTemplates: "テンプレートがありません",
    customBadge: "カスタム",
    communityActiveBadge: "コミュニティ公開",
    inUseBadge: "使用中",
    selectTmpl: "選択",
    publicSelectTmpl: "公開テンプレートで選択",
    publicLibraryTemplate: "公開ライブラリテンプレート",
    templatePageInfo: "ページ",
    templateCommunityLoadFailed:
      "公開テンプレートライブラリを読み込めませんでした。",
    updateTmpl: "更新",
    selectingTmpl: "選択中…",
    templateSelected:
      "テンプレートを選択しました。「テンプレート表示」タブでプレビューを確認できます。",
    twCssCompiled:
      "テンプレートCSSを静的生成しました。公開ページは Tailwind CDN の代わりに静的CSSで配信されます。",
    twVersionChanged:
      "再コンパイル中に Tailwind のバージョンが変わりました（{from} → {to}）。編集と無関係なスタイルがずれた可能性があるため、公開サイトをご確認ください。",
    refreshThumbnailHint: "サムネイルを再キャプチャ",
    thumbnailRefreshed: "サムネイルを更新しました。",
    thumbnailCaptureFailed: "サムネイルのキャプチャに失敗しました。",
    thumbnailUpdateFailed: "サムネイルの更新に失敗しました。",
    loadingTmpl: "読込中…",
    pcMode: "パソコン用",
    spMode: "スマホ用",
    saveStatusSaved: "保存済み ✓",
    saveStatusUnsaved: "未保存",
    saveStatusBodyUnsaved: "本文未保存（手動で保存してください）",
    autoSaveLabel: "自動保存",
    saveStatusSaving: "保存中…",
    saveStatusFailed: "保存失敗: ",
    bodyConflictMsg: "本文が別の場所で更新されています",
    appNoticeTitle: "KuroCMS からの通知",
    bodyConflictConfirm:
      "この記事の本文は、開いた後に別のクライアント（AI など）によって更新されています。\n\n上書きしても相手の版はリビジョン履歴に残るので、後から戻せます。キャンセルすると今は保存しません（最新版を読むには記事を開き直してください）。",
    bodyConflictOverwrite: "自分の本文で上書き",
    articleSavedToast: "保存しました",
    mediaReusedToast: "同じ内容の画像が既にあるため {mid} を再利用しました",
    typeNotSelectedErr: "タイプ未選択",
    selectTypeMsg: "記事タイプを選択してください",
    slugEmptyErr: "Slug未入力",
    enterSlugMsg: "Slug を入力してください",
    langNotSelectedErr: "言語未選択",
    selectLangMsg: "言語を選択してください",
    titleEmptyErr: "タイトル未入力",
    enterTitleMsg: "タイトルを入力してください",
    changeToDraftEditable: "下書き（編集可能）に変更",
    changeToPublished: "公開に切り替え",
    buildThisArticleBtn: "この記事だけビルド",
    revisionHistoryBtn: "修正履歴",
    revisionHistoryTitle: "修正履歴",
    revisionHistoryEmpty: "この言語の履歴はまだありません。",
    revisionHistoryRange: "履歴 {from}〜{to} / 全 {total} 件",
    revisionHistoryPage: "ページ",
    revisionPreviewBadge: "#{n} を表示中",
    revisionPreviewExitHint: "現在の版に戻る",
    revisionPreviewStatus: "リビジョン #{n} を表示中（閲覧のみ）",
    revisionPreviewNoSave:
      "表示中の内容は過去の版なので、修正・保存はできません。現在の版に戻ってから編集してください。",
    revisionPreviewDiscardConfirm:
      "保存していない編集があります。履歴を表示すると破棄されます。続けますか？",
    revisionSource_api: "REST API",
    revisionSource_mcp: "AI（MCP）",
    revisionSource_admin: "管理画面（保存）",
    revisionSource_autosave: "管理画面（自動保存）",
    revisionSource_maintenance: "メンテナンス",
    revisionSource_import: "インポート",
    revisionSource_unknown: "不明",
    revisionSummaryMissing: "（この版には概要が記録されていません）",
    revisionLatestBadge: "最新",
    revisionRestoreBtn: "コピーして最新に",
    revisionRestoreBtnWrap: "コピーして\n最新に",
    revisionDiffBtn: "差分",
    revisionDiffDialogTitle: "変わったところ: Rev.{n} → 現在の版",
    revisionDiffLead:
      "Rev.{n} から現在の版までに変わったところです。緑は足した行、赤は消した行。本文は段落ごとの文字で比べます（装飾の違いは出ません）。",
    revisionDiffSame: "違いはありません。",
    revisionDiffTitleLabel: "タイトル",
    revisionDiffSummaryLabel: "概要",
    revisionDiffBodyLabel: "本文",
    revisionRestoreDraftOnly:
      "復元できるのは下書きのときだけです。先に下書きに切り替えてください。",
    revisionRestoreTitle: "この版に戻す",
    revisionRestoreLead:
      "#{n}（{date} ・ {who}）の内容で、新しい版を作ります。",
    revisionRestoreIncludes:
      "戻すもの: タイトル / 概要 / 本文 / SEO（カバー画像）/ ハッシュタグ",
    revisionRestoreExcludes:
      "戻らないもの: カテゴリ / 公開日 / 記事タイプ（履歴に含まれないため）",
    revisionRestoreKeepsSummary:
      "この版には概要が記録されていないため、概要は現在のままにします",
    revisionRestoreUndoNote:
      "置き換えられる今の内容は先に履歴へ保存されるので、元に戻せます。",
    revisionRestoreAction: "コピーして最新に",
    revisionRestoreDone: "#{n} の内容を最新の版として保存しました。",
    buildingBadge: "ビルド中",
    buildThisArticleDraftHint:
      "ビルドできるのは公開中の記事だけです。先に「公開に切り替え」てください。",
    buildThisArticleBusy: "ビルド中…",
    buildThisArticleDone: "この記事の公開ページを再ビルドしました。",
    editLockedHint:
      "編集するには右上のボタンで下書きモードに切り替えてください",
    articleTypeLabel: "記事タイプ",
    categoryAddBtn: "カテゴリ追加",
    publishTimeLabel: "公開時刻",
    hashtagLabel: "ハッシュタグ",
    coverImageLabel: "カバー画像",
    selectCoverBtn: "画像をファイルから読込む",
    clearCoverBtn: "解除",
    coverDropHint: "ドロップまたはファイルから読込む",
    coverMidHint:
      "画像ID（例: [[img-xxx]]）でカバーを指定。フォーカスを外すと読み込みます。",
    coverMidNotFound: "そのIDの画像が見つかりません。",
    r2CoverUnavail:
      "メディアを使うには R2 が必要です（設定 → 基本 →「R2 メディアストレージ」）。",
    slugLabelNote: "slugは変更不可。クリックでコピー",
    slugCopyHint: "クリックでコピー",
    slugHint:
      "半角の小文字英数字とハイフンだけ（先頭は英数字）。作成後は変更できません。",
    articleTitlePlaceholder: "記事タイトルを入力",
    summaryPlaceholder: "記事の概要（200文字まで・SNS 投稿でも使用）",
    bodyLabel: "記事本文",
    selectTypeEmpty: "タイプを選択…",
    langLoadFailed: "言語の読み込み失敗",
    typeLoadFailed: "タイプの読み込み失敗",
    unregisteredSuffix: "(未登録)",
    catLoadFailed: "カテゴリ読み込み失敗: ",
    dropZoneLead: "ここにファイルをドロップ、またはクリックして選択",
    r2EnableTitle: "メディアを使うには R2 の有効化が必要です",
    r2EnableDesc:
      "画像・動画・音楽は Cloudflare R2 に保存します。無料枠の 10GB までは課金されません。設定はご自身の Cloudflare で行います。「設定 → 基本」の「R2 メディアストレージ」にある手順（R2 の利用を始め、バケットを作り、この Worker に MEDIA_BUCKET の名前でつなぐ）を済ませると、この画面が使えるようになります。",
    uploadPreparing: "準備中…",
    uploading: "アップロード中…",
    uploadComplete: "完了",
    imageAutoResize: "画像サイズの自動縮小",
    imageResizeNone: "変換しない",
    imageResize200k: "200KB以下に縮小",
    imageResize500k: "500KB以下に縮小",
    imageResize1m: "1MB以下に縮小",
    imageResize2m: "2MB以下に縮小",
    deleteConfirmTitle: "削除の確認",
    deleteFileMsg: "このファイルを削除しますか？この操作は取り消せません。",
    helpRoleLabel: "役割の説明",
    helpCanDoLabel: "出来る事",
    helpNotesLabel: "注意点",
    publishDateLabel: "公開日",
    imageTypeLabel: "画像",
    videoTypeLabel: "動画",
    audioTypeLabel: "音楽",
    r2MediaUnavailMsg:
      "メディア利用不可<br>設定 → 基本 →「R2 メディアストレージ」",
    tmplCommunityLocked: "🔒 コミュニティ公開中のテンプレートは修正できません",
    tmplCommunityUnlockHint:
      "テンプレート表示タブで「コミュニティ非公開」にしてから編集してください",
    deleteUserTitle: "ユーザー削除",
    userDeletedToast: "ユーザーを削除しました",
    confirmDeleteUserPost: " を削除します。この操作は取り消せません。",
    hashtagPlaceholder: "#tag1 #tag2 スペース区切り",
    communityPublishHint: "クリックでコミュニティライブラリに公開する",
    communityPublishConfirm:
      "このテンプレートを kuro.boo コミュニティライブラリに公開しますか？\nテンプレート情報（名前・説明・HTML ソース）が共有されます。",
    buildLogLangs: "言語 ",
    buildLogLangsSep: " 種 × 記事 ",
    buildLogArticlesSep: " 件 → 最大 ",
    buildLogPagesSuffix: " ページ",
    buildDonePrefix: "✓ 完了 — ビルド ",
    buildDoneSkipped: " / スキップ ",
    buildDoneErrors: " / エラー ",
    buildSweptPrefix: "🧹 不要ページを削除: ",
    tmplEditorName: "テンプレート名",
    tmplEditorAuthor: "作者",
    tmplEditorSaveBtn: "保存",
    tmplEditorPreviewNote:
      "テンプレート表示タブを選択すると編集したプレビューを表示できます。",
    tmplEditorPlaceholder: "テンプレートのHTMLソースがここに表示されます",
    tmplDetailDialog: "テンプレート詳細: ",
    tmplDetailAuthorLabel: "作者",
    tmplDetailVersionLabel: "バージョン",
    tmplDetailDescLabel: "説明",
    tmplDetailDownloadLabel: "ダウンロード URL",
    tmplScriptWarnLabel: "読み込まないスクリプト",
    cspReportsTitle: "公開サイトの守り（CSP）の報告（止めることになるもの）",
    tmplScriptWarnExternal:
      "外部の JS（公開ページでは読み込みません。使う時は中身をテンプレートに貼り付けてください）: ",
    tmplScriptWarnToken:
      "[[…]] を含むスクリプト（サイトの守り（CSP）で止まります。値は data- 属性で渡してください）: ",
    tmplScriptWarnToast:
      "公開ページで動かないスクリプトがあります。テンプレートの詳細をご覧ください。",
    tmplDetailClose: "閉じる",
    tmplDeleteConfirm: "このテンプレートを削除しますか？",
    tmplEditorNotSelected: "テンプレートが選択されていません",
    tmplCurrentTemplate: "選択中のテンプレート：",
    contentEditorTitle: "サイトの文字情報",
    contentEditorHint:
      "テンプレートが参照するキー（例: top-hero-title）ごとに内容を登録します。キーが一致しないと該当箇所が空白になります。",
    contentAddBtn: "＋ キー登録",
    contentBaseLang: "基本",
    contentAddKeyNote: "※ キーは全言語に追加されます。",
    contentDeleteAllLangsNote:
      "※ 削除されるキーはすべての言語から削除されます。",
    tmplEmptyState:
      "テンプレートが無いのでテンプレート選択からテンプレートを選択してください",
    tmplSaved: "保存しました",
    tmplSavedAndPreview: "保存しました / プレビューも更新しました",
    tmplNameRequired: "テンプレート名を入力してください",
    tmplDetailInfo: "詳細情報",
    noneRegistered: "登録されていません",
    noCategories: "カテゴリが登録されていません",
    noUsers: "ユーザーが登録されていません",
    backToArticles: "記事一覧に戻る",
    allCategoriesSelected: "すべてのカテゴリが選択済みです",
    deleteArticleTitle: "記事を削除",
    deleteArticleMsg: "この記事を削除しますか？この操作は取り消せません。",
    deleteArticleImportNote:
      "インポートした記事を削除すると、次回インポート時に再インポートできるようになります。",
    deleteAction: "削除する",
    langOptionNew: "（未作成）",
    translateDialogTitle: "{lang}言語の翻訳",
    translateConfirmMsg: "この記事の{lang}言語の翻訳を作成しますか？",
    translateCopyBase: "{lang}（基本言語）の内容を複製する",
    translateCreateBtn: "{lang}言語の作成",
    deleteScopePrompt: "{lang}の翻訳、または記事全体を削除します。",
    deleteScopeLang: "この言語（{lang}）の翻訳のみ削除",
    deleteScopeAll: "記事全体（全言語）を削除",
    deleteWholeConfirmTitle: "記事全体を削除",
    deleteWholeAction: "記事全体を削除する",
    deleteBaseTitle: "基本言語の削除",
    deleteBaseWarn:
      "基本言語（{lang}）を削除すると、この記事は全言語が削除されます。",
    contentKeyLabel: "キー",
    contentValueLabel: "内容",
    contentUpdatedLabel: "更新日",
    contentSystemBadge: "初期値",
    contentDeleteConfirm: "このキーを削除しますか？",
    contentNotTranslated: "未翻訳",
    contentCreateBtn: "作成",
    contentInheritedValue: "表示時は基本の設定と同じ",
    contentMediaNotFound: "存在しないメディアです",
    contentMediaRefHint:
      "メディア管理画面に表示されている ID をそのまま使ってください。標準形式は img-001 / vid-001 / aud-001 です。",
    contentAddEditTitle: "文字情報を登録",
    contentEditTitle: "文字情報を編集",
    contentKeyHint: "テンプレート参照キー",
    contentValueHint: "内容（HTML）",
    contentMediaHint:
      "画像: [[img-001]] &nbsp; 動画: [[vid-001]] &nbsp; 音楽: [[aud-001]]<br>メディア管理画面でアップロード後、ファイル名左の ID をコピーして使用してください。",
    mediaTableMid: "MID",
    mediaTableFile: "ファイル名",
    mediaTableSize: "サイズ",
    copyMidTooltip: "クリックで [[{mid}]] をコピー",
    mediaInfoNonePre: "現在 ",
    mediaInfoNoneSuf: " ファイルは登録されていません。",
    mediaInfoCountPre: "現在の",
    mediaInfoCountMid1: "ファイル ",
    mediaInfoCountMid2: " 件、合計 ",
    mediaInfoCountEnd: " の R2 容量を使用しています。",
    helpBasic: "基本",
    helpUpdates: "更新",
    blueskyAppPassword: "アクセストークン（App Password）",
    blueskyAppPasswordHelp: "Bluesky の設定 → App Passwords で発行。",
    importFromStrapi: "Strapiからのインポート",
    importFromKurocms: "KuroCMSからのインポート",
    importStrapiDesc: "Strapi 5 REST API から記事を一括インポートします。",
    importKurocmsDesc:
      "別の KuroCMS インスタンスから記事を一括インポートします。",
    importConnectionSettings: "接続設定",
    strapiUrlHelp:
      "Strapi 5 サーバーのベース URL（例: https://cms.example.com）",
    strapiApiToken: "API トークン",
    strapiApiTokenHelp: "Strapi 管理画面 → Settings → API Tokens で発行",
    strapiContentType: "コンテンツタイプ",
    strapiContentTypeHelp:
      "インポート元の Strapi コンテンツタイプ名（デフォルト: articles）",
    importFieldMapping: "フィールドマッピング（高度な設定）",
    strapiFieldTitle: "タイトルフィールド",
    strapiFieldSlug: "スラッグフィールド",
    strapiFieldSummary: "サマリーフィールド",
    strapiFieldBody: "本文フィールド",
    strapiFieldCategories: "カテゴリフィールド",
    importConnectAndShow: "接続 & 表示",
    importConnect: "接続",
    importSaveConfig: "設定を保存",
    importSettingsSection: "インポート設定",
    importDestType: "インポート先タイプ",
    importDestTypeAll: "すべて（記事のタイプ別）",
    importLangLabel: "インポート言語",
    importSelected: "下で選択したものをインポート",
    importAll: "全件インポート",
    importArticleList: "記事一覧",
    selectAllToggle: "全選択 / 解除",
    kurocmsUrlHelp: "移行元インスタンスのベース URL（例: https://example.com）",
    kurocmsPatLabel: "PAT トークン",
    kurocmsPatHelp:
      "移行元管理画面 → マイページ → トークン で発行（kuro_ から始まる）",
    addSnsTitle: "SNS連動を追加",
    snsServiceLabel: "サービス",
    snsSavePending: "保存しました（API 連携は準備中です）",
    snsHandleLabel: "ハンドル / ユーザー名",
    snsAccessToken: "アクセストークン",
    snsApiComingSoon: "※ API 連携機能は今後のアップデートで対応予定です。",
    snsDeleteMsgPre: "",
    snsDeleteMsgSuf: " の連動設定を削除しますか？",
    helpPageLead: "各機能画面の役割・操作方法・注意点をまとめたガイドです。",
    siteManagementLead:
      "テンプレートの表示・選択・編集と、ヒーローテキスト・About 等の固定コンテンツを管理します。",
    previewFetchFailed: "プレビュー取得失敗: ",
    contentKeyRequired: "キーを入力してください",
    articleNotFound: "記事が見つかりません",
    articleLoadFailed: "記事の読み込みに失敗しました: ",
    addFile: "+ ファイルを追加",
    purgeDataSuffix: "件のデータを完全に削除する",
    refetchError: "再取得エラー: ",
    importConnectSuccessPre: "接続成功 — ",
    importCountSuffix: " 件",
    connectError: "接続エラー: ",
    articlesNotFound: "記事が見つかりませんでした",
    modifiedBadge: "修正済",
    importedBadge: "取込済",
    alreadyImportedBadge: "済",
    selectImportType: "インポート先タイプを選択してください",
    selectImportLang: "インポート言語を選択してください",
    importing: "インポート中…",
    previewFetchError: "プレビュー取得エラー: ",
    kurocmsLastUpdated: "KuroCMS 最終更新: ",
    strapiConflictWarning:
      "全件インポートは全記事を Strapi 版で上書きします。以下の記事はインポート後に KuroCMS で編集されています。残したい記事はチェックを外してください（上書きせず保護します）。",
    strapiConflictNoCheck: "チェックなし = KuroCMS 版を保持（上書きしない）",
    importAllConflictTitle: "全件インポート — 競合確認",
    runImport: "インポート実行",
    selectArticlesForImport: "インポートする記事を選択してください",
    connectionSettingsSaved: "接続設定を保存しました",
    kurocmsRetrievedSuffix: " 件取得",
    selectTypeAndLang: "インポート先タイプと言語を選択してください",
    kurocmsConflictWarning:
      "以下の記事は KuroCMS で編集済みです。上書きする場合はチェックを入れてください。",
    overwriteConfirmTitle: "編集済み記事の上書き確認",
    importConfirmAll: "全件インポート — 確認",
    importConfirmAllMsg: "KuroCMS の全記事をインポートします。",
    importConfirmSelMsgPre: "",
    importConfirmSelMsgSuf: " 件をインポートします。",
    execute: "実行",
    importProgressTitle: "インポート中…",
    importComplete: "インポート完了",
    importErrorsLabel: "エラー:",
    importResultPre: "完了: ",
    importResultImported: " 件追加",
    importResultOverwritten: " 件上書",
    importResultSkipped: " 件スキップ",
    imagesDownloadedToR2Suf: " 件を R2 に保存しました",
    bskyConnectionCleared: "Bluesky の接続情報をクリアしました",
    bskyDisconnectConfirm: "Bluesky の接続情報をクリアして非表示にしますか？",
    userUpdated: "ユーザーを更新しました",
    emailRequired: "メールアドレスを入力してください",
    inviteSubmit: "招待リンクを発行",
    inviteLink: "招待リンク",
    inviteExpiryMsg: " への招待リンクです。48時間有効です。",
    copyAndClose: "コピーして閉じる",
    userStatus: "状態",
    registeredDate: "登録日",
    lastLoginDate: "最終ログイン",
    noRole: "権限なし",
    disableAccount: "アカウント無効化",
    tokenDeleteConfirm: "このトークンを削除しますか？削除後は元に戻せません。",
    rename: "名前を変更",
    passkeyDevices: "パスキー（デバイス）",
    passkeyDevicesLead:
      "複数のデバイスにパスキーを登録しておくと、1台を失ってもサインインできます。",
    addPasskey: "このデバイスを追加",
    passkeyNameLabel: "デバイス名",
    passkeyNamePlaceholder: "例: MacBook、iPhone",
    passkeyCreated: "登録",
    passkeyLastUsed: "最終使用",
    passkeyCurrent: "現在のパスキー",
    passkeyAdded: "パスキーを追加しました。",
    passkeyRenamed: "パスキー名を変更しました。",
    passkeyRemoved: "パスキーを削除しました。",
    passkeyDeleteConfirm:
      "このパスキーを削除しますか？そのデバイスではサインインできなくなります。",
    editUserTitle: "ユーザー編集: ",
    disabled: "無効",
  },
};
function detectLocale() {
  const saved = localStorage.getItem(uiLangKey);
  if (saved && supportedLocales.includes(saved)) return saved;
  const browser = navigator.languages || [navigator.language || "en"];
  for (const value of browser) {
    const base = String(value).toLowerCase().split("-")[0];
    if (supportedLocales.includes(base)) return base;
  }
  return "en";
}
const previewParams = new URLSearchParams(location.search);
const savedColorMode = localStorage.getItem(colorModeKey);
const prefersDark =
  window.matchMedia &&
  window.matchMedia("(prefers-color-scheme: dark)").matches;
type AdminState = {
  token: string;
  themeLoaded: boolean;
  themeSettings: Dynamic | null;
  currentUser: Dynamic | null;
  uiLang: string;
  preview: boolean;
  colorMode: "dark" | "light";
  articleEditor: KuroEditorInstance | null;
  isAdmin: boolean;
  storageAlert: boolean;
  /** お知らせ(Entamy Notice)の未読(「この製品から」だけ)。ダッシュボードの項目に数で出す。 */
  noticeUnread: number;
  /** アクティブテンプレートの body 配色（/api/fonts の editorCanvas）。
      KuroEditor の canvasColors に渡し、通常モードのキャンバスを実サイトの
      配色に一致させる（ダーク系テンプレートでも WYSIWYG になる）。 */
  editorCanvasColors: { bg?: string; text?: string } | null;
};

const state: AdminState = {
  // 管理画面はパスキーのセッション(cookie)で名乗る。前の版は PAT を localStorage に置いて全部の要求に
  // 付けていた —— ログアウトしても残るので、読まずに消す(課題 78566a3d)。
  token: (() => {
    try {
      localStorage.removeItem(tokenKey);
    } catch {
      /* 使えない環境では、そもそも置いていない */
    }
    return "";
  })(),
  themeLoaded: false,
  themeSettings: null,
  currentUser: null,
  uiLang: detectLocale(),
  preview: previewParams.get("preview") === "1",
  colorMode:
    savedColorMode === "dark" || (!savedColorMode && prefersDark)
      ? "dark"
      : "light",
  articleEditor: null,
  isAdmin: false,
  storageAlert: false,
  noticeUnread: 0,
  editorCanvasColors: null,
};

// Dids whose single-article build ("この記事だけビルド") is in flight. The build
// runs server-side and the fetch survives SPA navigation, so the article list
// (dashboard.ts) reads this to show a "ビルド中" badge after the title, and the
// editor's build handler clears it (and removes the live badge) when done.
const buildingDocs = new Set<string>();

// ---- Passkey / WebAuthn helpers ----
function b64uEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary)
    .split("+")
    .join("-")
    .split("/")
    .join("_")
    .split("=")
    .join("");
}

function b64uDecode(s: string): ArrayBuffer {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function serializeCredentialForRegistration(cred: PublicKeyCredential) {
  const response = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id,
    rawId: b64uEncode(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: b64uEncode(response.clientDataJSON),
      attestationObject: b64uEncode(response.attestationObject),
    },
  };
}

function serializeCredentialForAuthentication(cred: PublicKeyCredential) {
  const response = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: b64uEncode(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: b64uEncode(response.clientDataJSON),
      authenticatorData: b64uEncode(response.authenticatorData),
      signature: b64uEncode(response.signature),
      userHandle: response.userHandle ? b64uEncode(response.userHandle) : null,
    },
  };
}

function t(key: string): string {
  const lang = state.uiLang as keyof typeof i18n;
  return (
    (i18n[lang] && (i18n[lang] as Record<string, string>)[key]) ||
    (i18n.en as Record<string, string>)[key] ||
    key
  );
}
function localeSelectHtml() {
  return (
    "<label>" +
    escapeHtml(t("selectLanguageLead")) +
    "<select class='localeSelect' id='uiLocale'>" +
    supportedLocales
      .map(
        (locale) =>
          "<option value='" +
          locale +
          "'" +
          (locale === state.uiLang ? " selected" : "") +
          ">" +
          localeNames[locale] +
          "</option>",
      )
      .join("") +
    "</select></label>"
  );
}
// Compact language selector for the page header (right of the help button).
// Same #uiLocale id/mechanism as localeSelectHtml(); no verbose label.
function headerLocaleSelectHtml() {
  return (
    "<select class='localeSelect headerLocale' id='uiLocale' title='" +
    escapeHtml(t("selectLanguageLead")) +
    "' aria-label='" +
    escapeHtml(t("selectLanguageLead")) +
    "'>" +
    supportedLocales
      .map(
        (locale) =>
          "<option value='" +
          locale +
          "'" +
          (locale === state.uiLang ? " selected" : "") +
          ">" +
          localeNames[locale] +
          "</option>",
      )
      .join("") +
    "</select>"
  );
}
function bindLocaleSelect(onChange = render) {
  const select = byId("uiLocale");
  if (!select) return;
  select.addEventListener("change", () => {
    state.uiLang = select.value;
    localStorage.setItem(uiLangKey, state.uiLang);
    document.documentElement.lang = state.uiLang;
    onChange();
  });
}
function enablePreviewMode() {
  if (state.preview) return;
  state.preview = true;
}
function applyColorMode(mode: Dynamic) {
  state.colorMode = mode === "dark" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", state.colorMode);
  localStorage.setItem(colorModeKey, state.colorMode);
  if (state.themeSettings) {
    applyTheme(state.themeSettings);
  }
}
document.documentElement.lang = state.uiLang;
applyColorMode(state.colorMode);

function routePath() {
  const adminRoot = adminHref("");
  if (
    location.pathname === "/initialize" ||
    location.pathname === "/initialize/"
  )
    return "/initialize";
  if (location.pathname === adminRoot || location.pathname === adminRoot + "/")
    return "/";
  if (location.pathname.startsWith(adminRoot + "/")) {
    return location.pathname.slice(adminRoot.length) || "/";
  }
  if (isLegacyAdminPath) {
    if (location.pathname === "/admin" || location.pathname === "/admin/")
      return "/";
    if (location.pathname.startsWith("/admin/")) {
      return location.pathname.replace(/^\/admin/, "") || "/";
    }
  }
  if (adminBasePath && location.pathname === adminBasePath) return "/";
  if (
    adminBasePath &&
    location.pathname.startsWith(adminBasePath + "/initialize")
  )
    return "/initialize";
  return "/";
}

function renderLogoHtml() {
  return (
    "<img src='" +
    escapeHtml(defaultAdminLogo) +
    "' style='width:38px; height:38px; border-radius:8px; object-fit:cover;' />"
  );
}

function setActiveNav() {
  const path = routePath();
  for (const link of document.querySelectorAll<HTMLElement>("[data-nav]")) {
    link.classList.toggle("active", link.dataset.nav === path);
  }
}

function menuIconHtml(name: Dynamic) {
  return (
    "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true'>" +
    menuIcons[name] +
    "</svg>"
  );
}
// Builds the class attribute for a sidebar nav link.
function navItemClassAttr(item: Dynamic, active: boolean) {
  const cls = [];
  if (active) cls.push("active");
  return cls.length ? " class='" + cls.join(" ") + "'" : "";
}
function menuHtml(mode: Dynamic) {
  const items = menuItems[mode];
  return items
    .filter((item) => !item.adminOnly || state.isAdmin)
    .map((item) => {
      const active = mode === "setup" ? true : routePath() === item.nav;
      const dot =
        // お知らせの未読はダッシュボードの項目に数で出す(枠がダッシュボードの最上部にあるため)。
        state.noticeUnread > 0 && item.key === "dashboard"
          ? "<span class='navNoticeCount'>" +
            String(state.noticeUnread) +
            "</span>"
          : state.storageAlert && item.key === "dashboard"
            ? "<span class='navAlertDot'></span>"
            : item.key === "backup" && backupJobLive()
              ? "<span class='navBusyDot' title='" +
                escapeHtml(t("backupRunningBadge")) +
                "'></span>"
              : item.key === "backup" && backupJobInterrupted()
                ? "<span class='navAlertDot'></span>"
                : "";
      return (
        "<a href='" +
        item.href +
        "' data-nav='" +
        item.nav +
        "'" +
        navItemClassAttr(item, active) +
        ">" +
        menuIconHtml(item.key) +
        "<span>" +
        escapeHtml(t(item.labelKey || item.key)) +
        "</span>" +
        dot +
        "</a>"
      );
    })
    .join("");
}
function setSidebarMode(mode: Dynamic) {
  const brand = document.querySelector<AdminElement>(".brand");
  if (brand)
    brand.innerHTML =
      renderLogoHtml() +
      "<div><h1>Kuro<span class='brandAccent'>CMS</span></h1><div class='brandSub'>" +
      escapeHtml(t("brandSub")) +
      "</div></div>";
  const nav = byId("sidebarNav");
  const footerNav = byId("sidebarFooterNav");
  const mobileNav = byId("mobileNav");
  const brandSub = document.querySelector<AdminElement>(".brandSub");
  if (brandSub) brandSub.textContent = t("brandSub");
  if (nav) nav.innerHTML = menuHtml(mode);
  if (footerNav)
    footerNav.innerHTML =
      mode === "normal"
        ? menuItems.footer
            .map((item) => {
              const active = routePath() === item.nav;
              return (
                "<a href='" +
                item.href +
                "' data-nav='" +
                item.nav +
                "'" +
                navItemClassAttr(item, active) +
                ">" +
                menuIconHtml(item.key) +
                "<span>" +
                escapeHtml(t(item.labelKey || item.key)) +
                "</span></a>"
              );
            })
            .join("")
        : "";
  if (mobileNav) {
    mobileNav.innerHTML =
      mode === "normal"
        ? menuItems.mobile
            .map((item) => {
              const active = routePath() === item.nav;
              return (
                "<a href='" +
                item.href +
                "' data-nav='" +
                item.nav +
                "'" +
                navItemClassAttr(item, active) +
                ">" +
                menuIconHtml(item.key) +
                "<span>" +
                escapeHtml(t(item.labelKey || item.key)) +
                "</span></a>"
              );
            })
            .join("")
        : menuHtml(mode);
  }
}

// Reactive auto-reload after a system update. Every admin API response carries
// the serving Worker's version (x-kurocms-version). When it stops matching the
// version that served this page, the Worker was updated under an open tab — the
// admin JS/HTML here is now stale against the new API — so reload to pick up the
// fresh client. No timers: this is driven entirely by the client's own requests
// (navigation, saves, autosave), so an idle tab stays put until it next acts.
// A pending reload is held back while an article edit is unsaved; the next api()
// call (an autosave/save/navigation) re-checks and reloads once it has flushed.
let serverVersionChanged = false;
function noteServerVersion(response: Dynamic) {
  const loaded = (window as Dynamic).__KUROCMS_VERSION__;
  if (!loaded) return; // page served by older HTML without the marker
  const served = response.headers.get("x-kurocms-version");
  if (served && served !== loaded) serverVersionChanged = true;
  if (serverVersionChanged && !hasUnsavedArticleEdits()) location.reload();
}

// Reactive list refresh keyed on the article dataset revision. The server stamps
// every admin API response with x-kurocms-docrev (bumped by DB triggers on any
// documents change — including AI/REST/MCP edits). When it moves relative to
// what we last saw, re-fetch the live list if one is mounted. This closes the
// gap the focus-based refresh can't: a change that lands while the operator is
// actively using the admin surfaces on their very next request. Driven entirely
// by the client's own traffic — no polling.
let lastSeenDocRev: string | null = null;
function noteDataRevision(response: Dynamic) {
  const rev = response.headers.get("x-kurocms-docrev");
  if (!rev) return;
  if (lastSeenDocRev === null) {
    lastSeenDocRev = rev; // baseline on first observation
    return;
  }
  if (rev === lastSeenDocRev) return;
  lastSeenDocRev = rev;
  // Refresh a mounted list, but never yank the page during an unsaved edit.
  if (activeListReload && !hasUnsavedArticleEdits()) activeListReload();
}

async function api(path: Dynamic, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (state.token) headers.set("authorization", "Bearer " + state.token);
  const directPaths = [
    "/api/health",
    "/api/help",
    "/api/setup/status",
    "/api/setup",
    "/api/auth/session",
    "/api/auth/passkey/login/begin",
    "/api/auth/passkey/login/complete",
    "/api/auth/passkey/register/begin",
    "/api/auth/passkey/register/complete",
    "/api/auth/logout",
  ];
  const endpoint =
    path.startsWith("/api/") && !directPaths.includes(path)
      ? isLegacyAdminPath
        ? "/admin" + path
        : "/api/admin" + path.slice(4)
      : path;
  const response = await fetch(withBase(endpoint), { ...options, headers });
  noteServerVersion(response);
  noteDataRevision(response);
  // Read as text first so non-JSON failures are still surfaced (e.g. a
  // Cloudflare 5xx/limit HTML page when the Worker is killed). Otherwise the
  // error collapses to a generic message and a bug can't be told from a CF limit.
  const raw = await response.text();
  let data: Dynamic = {};
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      /* non-JSON body (e.g. a CF error page) — keep {}; use raw snippet below */
    }
  }
  if (!response.ok) {
    const jsonMsg = data?.error?.message;
    const snippet =
      !jsonMsg && raw
        ? raw
            .replace(/<[^>]*>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 200)
        : "";
    const err = new Error(jsonMsg || snippet || t("apiFailed")) as Error & {
      code?: string;
      status?: number;
      detail?: string;
    };
    err.code = data?.error?.code;
    err.status = response.status;
    if (snippet) err.detail = snippet;
    // 登録していない回線から使われた(IP 制限)。確認のメールは送ってあるので、
    // ログインの画面へ戻して理由を出す。パスキーで入り直せば、この回線が登録される。
    if (err.code === "network_unregistered") {
      setTimeout(() => loginScreen(t("networkUnregistered")), 0);
    }
    throw err;
  }
  return data;
}

function applyTheme(settings: Dynamic) {
  state.themeSettings = settings;
  const root = document.documentElement;
  root.style.setProperty("--theme-accent", settings.themeAccent || "#06b6d4");
  if (state.colorMode === "dark") {
    root.style.removeProperty("--theme-sidebar");
    root.style.removeProperty("--theme-main-pane");
  } else {
    root.style.setProperty(
      "--theme-sidebar",
      settings.themeSidebar || "#ffffff",
    );
    root.style.setProperty(
      "--theme-main-pane",
      settings.themeMainPane || "#ffffff",
    );
  }
}

async function loadTheme() {
  if (state.themeLoaded) return;
  try {
    const data = await api("/api/settings");
    applyTheme(data.settings);
    state.themeLoaded = true;
  } catch {
    state.themeLoaded = true;
  }
  applyEditorFont();
}

// Whether the active template's canvas is DARK — drives KuroEditor's
// canvasDark option (KE 2.3.0+), so the editor's light/dark mode follows the
// template automatically instead of a user-facing checkbox (canvasDarkUi
// stays at its default false = hidden). Decided by the YIQ luminance of the
// resolved template body background (editorCanvas.bg from /api/fonts);
// unresolvable/absent bg = light, the editor's stylesheet default.
function editorCanvasDark(): boolean {
  const bg = state.editorCanvasColors?.bg || "";
  const m = bg.match(
    /^#(?:([0-9a-f]{3})[0-9a-f]?|([0-9a-f]{6})(?:[0-9a-f]{2})?)$/i,
  );
  if (!m) return false;
  const hex = m[2] || (m[1] || "").replace(/(.)/g, "$1$1");
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 < 128;
}

// Render the KuroEditor body (article body + site-text editors) in the
// configured site base font, so the editor is WYSIWYG with the published site.
// Only the editor content (.kuro-body/.kuro-content) is touched — the admin
// chrome keeps its system font. Web fonts come straight from the Google CDN.
async function applyEditorFont(lang = "") {
  try {
    const data = await api(
      "/api/fonts" + (lang ? "?lang=" + encodeURIComponent(lang) : ""),
    );
    const loaded: Dynamic[] = data.loaded || [];
    const baseStack: string = data.baseStack || "";

    // アクティブテンプレートの body 配色。以後マウントされるエディタは
    // options.canvasColors / canvasDarkColors で受け取り、マウント済みエディタ
    // には即時反映する。テンプレートの配色は1組なので両モードのスロットに同じ
    // 値を渡し（KE 2.4.0+）、どちらのモードでもテンプレートの実色で描画される
    // （モード側は caret/placeholder 等の未指定キーの既定値を左右する）。
    // ダークモードもテンプレート配色から自動決定して同期（テンプレート変更後の
    // /api/fonts 再取得で、開いているエディタも即時にモードが切り替わる）。
    state.editorCanvasColors = data.editorCanvas || null;
    state.articleEditor?.setCanvasColors?.(state.editorCanvasColors);
    state.articleEditor?.setCanvasDarkColors?.(state.editorCanvasColors);
    state.articleEditor?.setCanvasDark?.(editorCanvasDark());

    let link = byId("kuroSiteFontLink") as Dynamic;
    if (loaded.length) {
      const fams = loaded
        .map(function (f: Dynamic) {
          const w = (
            f.weights && f.weights.length ? f.weights : [400, 700]
          ).join(";");
          return (
            "family=" +
            encodeURIComponent(f.family).replace(/%20/g, "+") +
            ":wght@" +
            w
          );
        })
        .join("&");
      const href =
        "https://fonts.googleapis.com/css2?" + fams + "&display=swap";
      if (!link) {
        link = document.createElement("link");
        link.id = "kuroSiteFontLink";
        link.rel = "stylesheet";
        document.head.appendChild(link);
      }
      if (link.href !== href) link.href = href;
    } else if (link) {
      link.remove();
    }

    let style = byId("kuroEditorFont") as Dynamic;
    if (baseStack) {
      // Mirror the public render (fonts.ts → baseFontStyle): a TEMPLATE-PRIORITY
      // default, NOT a forced override. :where() carries zero specificity and we
      // drop !important, so the base font only fills in where nothing else is set
      // — and any inline font-family KuroEditor writes (e.g. the 明朝 picker's
      // <span style="font-family:…">) wins via the normal cascade. Children
      // inherit from the container; code/kbd keep their own monospace rule from
      // ke-content.css, so no blanket descendant selector is needed.
      const css =
        ":where(.kuro-body,.kuro-content){font-family:" + baseStack + "}";
      if (!style) {
        style = document.createElement("style");
        style.id = "kuroEditorFont";
        document.head.appendChild(style);
      }
      style.textContent = css;
    } else if (style) {
      style.remove();
    }
  } catch {
    /* ignore — editor just keeps the default font */
  }
}

function shell(title: Dynamic, body: Dynamic) {
  destroyArticleEditor();
  document.querySelector<AdminElement>(".articleBottomBar")?.remove();
  setSidebarMode("normal");
  setActiveNav();
  const helpKeyMap = {
    [t("dashboard")]: "dashboard",
    [t("articles")]: "articles",
    [t("newArticle")]: "newArticle",
    [t("images")]: "images",
    [t("videos")]: "videos",
    [t("audios")]: "audios",
    [t("categories")]: "categories",
    [t("languageManager")]: "languages",
    [t("types")]: "types",
    [t("siteManagement")]: "siteManagement",
    [t("settings")]: "settings",
    [t("profile")]: "profile",
    [t("userManager")]: "users",
    [t("backup")]: "backup",
  };
  const helpKey = helpKeyMap[title];
  const helpBtn = helpKey
    ? "<button class='helpBtn' data-help-key='" +
      escapeHtml(helpKey) +
      "'>&#10067; " +
      escapeHtml(t("help")) +
      "</button>"
    : "";
  app.innerHTML =
    (state.preview ? previewNoticeHtml() : "") +
    "<header><div><h2>" +
    escapeHtml(title) +
    "</h2><p class='pageLead'>" +
    escapeHtml(pageLeadForTitle(title)) +
    "</p></div>" +
    "<div class='headerRight'>" +
    helpBtn +
    headerLocaleSelectHtml() +
    "</div></header>" +
    body +
    "<div class='credit'>©2026 <a href='https://kuro.boo/' target='_blank' rel='noopener' style='color:inherit;text-decoration:none'>Kuro.boo</a> All Rights Reserved.</div>";
  bindLocaleSelect();
}

function pageLeadForTitle(title: Dynamic) {
  const leads = {
    [t("dashboard")]: t("dashboardLead"),
    [t("articles")]: t("articlesLead"),
    [t("newArticle")]: t("newArticleLead"),
    [t("images")]: t("imagesLead"),
    [t("videos")]: t("videosLead"),
    [t("audios")]: t("audiosLead"),
    [t("categories")]: t("categoriesLead"),
    [t("languageManager")]: t("languageManagerLead"),
    [t("types")]: t("typesLead"),
    [t("settings")]: t("settingsLead"),
    [t("profile")]: t("profileLead"),
    [t("siteManagement")]: t("siteManagementLead"),
    [t("help")]: t("helpPageLead"),
  };
  return leads[title] || t("subtitle");
}

function previewNoticeHtml() {
  return "<div class='notice'>" + escapeHtml(t("previewActive")) + "</div>";
}

function setStorageAlertBadge(hasAlert: Dynamic) {
  if (state.storageAlert === hasAlert) return;
  state.storageAlert = hasAlert;
  const nav = byId("sidebarNav");
  if (nav) nav.innerHTML = menuHtml("normal");
  const mobileNav = byId("mobileNav");
  if (mobileNav)
    mobileNav.innerHTML = menuItems.mobile
      .filter(function (item) {
        return !item.adminOnly || state.isAdmin;
      })
      .map(function (item) {
        const active = routePath() === item.nav;
        const dot =
          state.storageAlert && item.key === "dashboard"
            ? "<span class='navAlertDot'></span>"
            : "";
        return (
          "<a href='" +
          item.href +
          "' data-nav='" +
          item.nav +
          "'" +
          navItemClassAttr(item, active) +
          ">" +
          menuIconHtml(item.key) +
          "<span>" +
          escapeHtml(t(item.labelKey || item.key)) +
          "</span>" +
          dot +
          "</a>"
        );
      })
      .join("");
}
let _storageAlertChecked = false;
function checkStorageAlertOnce() {
  if (_storageAlertChecked) return;
  _storageAlertChecked = true;
  api("/api/system/storage")
    .then(function (s) {
      const hasAlert =
        (s.d1 && s.d1.pct >= 50) ||
        (s.r2 && s.r2.pct >= 50) ||
        (s.kv && s.kv.pct >= 50);
      setStorageAlertBadge(!!hasAlert);
    })
    .catch(function () {});
}

let _siteTimezoneInited = false;
/**
 * サイトの時計の初期設定 —— **まだ一度も決まっていないときだけ**、この
 * ブラウザの TZ を採る。判定はサーバー側の `WHERE site_timezone = ''` が持つ
 * ので、ここは投げるだけでよい（管理者が複数いても二度目は空振りする）。
 *
 * ⚠ 効くのは初回の 1 回だけ。以後の変更は設定画面から明示的に行う —— 毎回の
 * 起動で上書きすると、管理者が旅先で開くたびにサイトの時計が動き、次のビルドで
 * 全ページの日付が黙って書き換わる。
 *
 * 実際に設定できたときだけ「ビルドが要る」ことを伝える。既存記事の日付表記は
 * 公開ページに焼き込まれているので、再ビルドするまで変わらない。
 */
function initSiteTimezoneOnce() {
  if (_siteTimezoneInited || !state.isAdmin) return;
  _siteTimezoneInited = true;
  const timezone = detectBrowserTimezone();
  if (!timezone) return;
  api("/api/settings/timezone-init", {
    method: "POST",
    body: JSON.stringify({ timezone }),
  })
    .then(function (res) {
      if (res && res.applied)
        toast(t("siteTimezoneAutoSet").replace("{tz}", res.timezone));
    })
    .catch(function () {});
}

let _toastWrap: Dynamic = null;
function getToastWrap() {
  if (!_toastWrap || !document.body.contains(_toastWrap)) {
    _toastWrap = document.createElement("div");
    _toastWrap.className = "toastWrap";
    document.body.appendChild(_toastWrap);
  }
  return _toastWrap;
}

function toast(
  message: Dynamic,
  error: Dynamic = false,
  anchor: Dynamic = null,
) {
  if (anchor instanceof Element) {
    // Speech-bubble callout near the anchor element
    document
      .querySelectorAll<AdminElement>(".callout")
      .forEach((el) => el.remove());
    const rect = anchor.getBoundingClientRect();
    const bubble = document.createElement("div");
    const spaceBelow = window.innerHeight - rect.bottom;
    const above = spaceBelow < 80;
    bubble.className =
      "callout" + (error ? " error" : "") + (above ? " above" : "");
    bubble.textContent = message;
    document.body.appendChild(bubble);
    // Position after render so offsetWidth is available
    requestAnimationFrame(() => {
      const bw = bubble.offsetWidth;
      let left = rect.left;
      if (left + bw > window.innerWidth - 16)
        left = window.innerWidth - bw - 16;
      bubble.style.left = Math.max(8, left) + "px";
      bubble.style.top = above
        ? rect.top - bubble.offsetHeight - 10 + "px"
        : rect.bottom + 8 + "px";
    });
    setTimeout(() => bubble.remove(), error ? 12000 : 4000);
    return;
  }
  // Fixed corner toast — no layout shift
  const wrap = getToastWrap();
  const item = document.createElement("div");
  item.className = "toastItem" + (error ? " error" : "");
  item.textContent = message;
  wrap.appendChild(item);
  setTimeout(
    () => {
      item.remove();
    },
    error ? 12000 : 4000,
  );
}

function fieldError(id: Dynamic, message: Dynamic) {
  const el = byId(id) as HTMLInputElement | null;
  if (el) {
    el.setCustomValidity(message);
    el.reportValidity();
    setTimeout(() => el.setCustomValidity(""), 3000);
  } else toast(message, true);
}

function createPopupBackdrop(): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "popupBackdrop";
  if (window.innerWidth <= 860) {
    el.style.justifyContent = "flex-start";
    el.style.paddingTop = "16px";
  }
  return el;
}

function requireDialogValue(form: Dynamic, selector: Dynamic, msg: Dynamic) {
  const el = form.querySelector(selector);
  if (!el || !el.value.trim()) throw new Error(msg);
  return el.value.trim();
}

function openEntryDialog(
  title: Dynamic,
  bodyHtml: Dynamic,
  submitText: Dynamic,
  onSubmit: Dynamic,
  onCancel: (() => void) | null = null,
  submitClass = "",
  /**
   * 閉じる道を用意しない。**同意のように「押さない＝続けられない」もの**に使う。
   * やめる／背景クリックの両方を塞ぐ（片方だけ塞ぐと抜け道になる）。
   */
  blocking = false,
) {
  const backdrop = createPopupBackdrop();
  backdrop.innerHTML =
    "<div class='popupCard' role='dialog' aria-modal='true'><form id='entryDialogForm' class='stack'><h3 class='popupTitle'>" +
    escapeHtml(title) +
    "</h3><div class='popupBody'>" +
    bodyHtml +
    "</div><div class='popupActions'>" +
    (blocking
      ? ""
      : "<button type='button' class='secondary' id='entryDialogCancel'>" +
        escapeHtml(t("cancel")) +
        "</button>") +
    "<button type='submit'" +
    (submitClass ? " class='" + submitClass + "'" : "") +
    ">" +
    escapeHtml(submitText) +
    "</button></div></form></div>";
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  const cancel = () => {
    close();
    if (onCancel) onCancel();
  };
  backdrop.addEventListener("click", (event) => {
    if (!blocking && event.target === backdrop) cancel();
  });
  const cancelBtn = backdrop.querySelector<AdminElement>("#entryDialogCancel");
  if (cancelBtn) cancelBtn.addEventListener("click", cancel);
  const form = backdrop.querySelector<AdminElement>("#entryDialogForm");
  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      // Show a spinner on the submit button while onSubmit runs. Many dialogs do
      // external network calls (SNS post, community publish, …) whose duration is
      // invisible; the spinner makes the wait obvious. On success onSubmit calls
      // close() and the node is gone; if it left the dialog open (e.g. a
      // validation error) we restore the button so it stays usable.
      const submitBtn = form.querySelector<AdminElement>(
        "button[type='submit']",
      );
      const prevHtml = submitBtn ? submitBtn.innerHTML : "";
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = "<span class='btnSpinner'></span>" + prevHtml;
      }
      if (cancelBtn) cancelBtn.disabled = true;
      try {
        await onSubmit(form, close);
      } finally {
        if (document.body.contains(backdrop)) {
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = prevHtml;
          }
          if (cancelBtn) cancelBtn.disabled = false;
        }
      }
    });
  }
}

async function runBuildWithProgress(force = false) {
  // Create progress dialog
  const overlay = document.createElement("div");
  overlay.className = "buildProgress";
  overlay.innerHTML =
    "<div class='buildProgressCard'>" +
    "<div style='display:flex;align-items:center;gap:10px'>" +
    "<svg style='flex-shrink:0;width:20px;height:20px;color:var(--accent)' fill='none' viewBox='0 0 24 24' stroke='currentColor' stroke-width='2'><path stroke-linecap='round' stroke-linejoin='round' d='M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15'/></svg>" +
    "<h3 style='margin:0;font-size:16px'>" +
    escapeHtml(t("buildingTitle")) +
    "</h3>" +
    "<span id='bpPhase' style='font-size:12px;color:var(--muted);margin-left:auto'>" +
    escapeHtml(t("buildPreparing")) +
    "</span>" +
    "</div>" +
    "<div style='font-size:11px;color:var(--muted);line-height:1.5'>" +
    escapeHtml(t("buildSplitNote")) +
    "</div>" +
    "<div class='buildProgressBar'><div class='buildProgressFill' id='bpFill' style='width:0%'></div></div>" +
    "<div style='display:grid;grid-template-columns:repeat(3,1fr);gap:8px;font-size:13px'>" +
    "<div style='background:rgba(21,122,110,.08);border-radius:8px;padding:8px 12px;text-align:center'>" +
    "<div style='font-size:20px;font-weight:800;color:var(--accent)' id='bpBuilt'>0</div>" +
    "<div style='font-size:11px;color:var(--muted)'>" +
    escapeHtml(t("buildBuiltLabel")) +
    "</div>" +
    "</div>" +
    "<div style='background:var(--surface-2);border-radius:8px;padding:8px 12px;text-align:center'>" +
    "<div style='font-size:20px;font-weight:800;color:var(--muted)' id='bpSkipped'>0</div>" +
    "<div style='font-size:11px;color:var(--muted)'>" +
    escapeHtml(t("buildSkippedLabel")) +
    "</div>" +
    "</div>" +
    "<div style='background:rgba(239,68,68,.06);border-radius:8px;padding:8px 12px;text-align:center'>" +
    "<div style='font-size:20px;font-weight:800;color:var(--danger)' id='bpErrors'>0</div>" +
    "<div style='font-size:11px;color:var(--muted)'>" +
    escapeHtml(t("buildErrorsLabel")) +
    "</div>" +
    "</div>" +
    "</div>" +
    "<div class='buildLog' id='bpLog'><div class='buildLogLine skipped' style='color:var(--muted)'>" +
    escapeHtml(t("buildPreparing")) +
    "</div></div>" +
    "<div id='bpCancelRow' style='text-align:center'>" +
    "<button type='button' id='bpCancel' class='secondary' style='min-width:120px'>" +
    escapeHtml(t("buildCancel")) +
    "</button>" +
    "</div>" +
    "<div id='bpDoneRow' style='display:none;text-align:center'>" +
    "<button type='button' id='bpClose' style='min-width:120px'>" +
    escapeHtml(t("close")) +
    "</button>" +
    "</div>" +
    "</div>";
  document.body.appendChild(overlay);

  // Cancel: abort the in-flight pass and stop launching further passes. Safe and
  // resumable — already-built pages persist in KV (build cache), so a later build
  // continues where this left off.
  const buildAbort = new AbortController();
  let cancelled = false;
  byId("bpCancel")?.addEventListener("click", function () {
    if (cancelled) return;
    cancelled = true;
    buildAbort.abort();
    const cb = byId("bpCancel") as HTMLButtonElement | null;
    if (cb) cb.disabled = true;
  });

  // Build runs in multiple Worker invocations (passes) to stay under the
  // per-invocation subrequest limit. Counts accumulate across passes:
  //  - builtCount: total newly-built (across all passes)
  //  - donePaths: unique paths built OR skipped — dedups re-skips so the
  //    progress bar is monotonic and reaches 100% on completion
  //  - errorCount: errors of the CURRENT pass only (errored pages are retried)
  let builtCount = 0,
    errorCount = 0,
    total = 0,
    passIndex = 0,
    moreToCome = false,
    fatalError = false,
    sweptCount = 0,
    langCount = 0,
    // 言語を分けて作ったページの進み(partial)。ページは増えなくても前へ進んでいる。
    partialCount = 0;
  // 回の量(課題 a408a584)。undefined = サーバーの既定。回が途中で切れたら半分にし、1 ページでも
  // 切れたら言語の数を半分にする。CPU の時間は測れないので、切れたという出来事で決める。
  let passBudget: number | undefined;
  // この回で「終わり」(done)の知らせが届いたか。届かずに切れた回は、CPU の上限で打ち切られた
  // 可能性がある(課題 a408a584)。回ごとに偽へ戻す。
  let passDone: boolean;
  let passLangs: number | undefined;
  // Static Assets registration reported by the last pass (null = not reached).
  // A pass that only registers builds no page, so this — not the page count —
  // tells whether it moved forward.
  let lastAssets: {
    done: boolean;
    status: string;
    uploaded?: number;
    remaining?: number | null;
  } | null = null;
  // Read through a function: the value is set inside handleEvent, which the
  // compiler cannot see from the loop below.
  const currentAssets = () => lastAssets;
  const donePaths = new Set<string>();

  function updateCounts() {
    const fill = byId("bpFill");
    const phase = byId("bpPhase");
    const done = donePaths.size + errorCount;
    if (fill && total > 0)
      fill.style.width = Math.min(100, (done / total) * 100) + "%";
    if (phase && total > 0) phase.textContent = done + " / " + total;
  }

  function appendLog(cls: Dynamic, text: Dynamic) {
    const log = byId("bpLog");
    if (!log) return;
    const line = document.createElement("div");
    line.className = "buildLogLine " + cls;
    line.textContent = text;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  function setSkipDisplay() {
    const el = byId("bpSkipped");
    if (el) el.textContent = String(Math.max(0, donePaths.size - builtCount));
  }

  function handleEvent(ev: Dynamic) {
    if (ev.type === "start") {
      // The server re-emits `start` each pass; only take it on the first pass.
      if (passIndex <= 1) {
        total = ev.total;
        langCount = Number(ev.langs) || 0;
        byId("bpPhase")!.textContent = "0 / " + total;
        appendLog(
          "skipped",
          t("buildLogLangs") +
            fmtNum(ev.langs) +
            t("buildLogLangsSep") +
            fmtNum(ev.articles) +
            t("buildLogArticlesSep") +
            fmtNum(total) +
            t("buildLogPagesSuffix"),
        );
      }
    } else if (ev.type === "page") {
      if (ev.status === "built") {
        builtCount++;
        donePaths.add(ev.path);
        byId("bpBuilt")!.textContent = fmtNum(builtCount);
        setSkipDisplay();
        appendLog("built", "✓ [" + ev.lang + "] " + ev.path);
      } else if (ev.status === "skipped") {
        donePaths.add(ev.path);
        setSkipDisplay();
        // Only log skips on the first pass; later passes re-skip already-built
        // pages and would spam the log.
        if (passIndex <= 1 && ev.reason !== "no content")
          appendLog(
            "skipped",
            "⏭ [" +
              ev.lang +
              "] " +
              ev.path +
              (ev.reason ? " — " + ev.reason : ""),
          );
      } else if (ev.status === "partial") {
        partialCount++;
        appendLog("built", "… [" + ev.lang + "] " + ev.path);
      } else if (ev.status === "error") {
        errorCount++;
        byId("bpErrors")!.textContent = fmtNum(errorCount);
        appendLog(
          "error",
          "✕ [" + ev.lang + "] " + ev.path + " — " + (ev.reason || t("error")),
        );
      }
      updateCounts();
    } else if (ev.type === "done") {
      passDone = true;
      // Per-pass completion: `more` true ⇒ budget spent, another pass follows.
      moreToCome = !!ev.more;
      // Orphan pages removed by the final pass's mark-and-sweep.
      if (ev.swept) sweptCount += ev.swept;
      lastAssets = ev.assets || null;
      if (lastAssets && lastAssets.status !== "unchanged") {
        appendLog(
          lastAssets.done ? "built" : "skipped",
          t("buildAssetsLine")
            .replace("{uploaded}", fmtNum(lastAssets.uploaded || 0))
            .replace(
              "{remaining}",
              lastAssets.remaining == null ? "—" : fmtNum(lastAssets.remaining),
            )
            .replace("{status}", String(lastAssets.status)),
        );
      }
    } else if (ev.type === "error") {
      fatalError = true;
      appendLog(
        "error",
        t("buildErrorPrefix") + (ev.message || t("unknownError")),
      );
    }
  }

  // Swap the cancel button for the close button and wire close.
  function showCloseButton() {
    const cancelRow = byId("bpCancelRow");
    if (cancelRow) cancelRow.style.display = "none";
    const doneRow = byId("bpDoneRow");
    if (doneRow) doneRow.style.display = "";
    byId("bpClose")?.addEventListener("click", function () {
      overlay.remove();
    });
  }

  // Final UI shown once, after the last pass (more:false) or a fatal error.
  function finalizeBuild() {
    byId("bpFill")!.style.width = "100%";
    byId("bpPhase")!.textContent = t("buildDone");
    appendLog(
      "built",
      t("buildDonePrefix") +
        fmtNum(builtCount) +
        t("buildDoneSkipped") +
        fmtNum(Math.max(0, donePaths.size - builtCount)) +
        t("buildDoneErrors") +
        fmtNum(errorCount),
    );
    if (sweptCount > 0)
      appendLog("skipped", t("buildSweptPrefix") + fmtNum(sweptCount));
    if (errorCount === 0 && !fatalError) {
      api("/api/v1/published", {
        method: "PUT",
        body: JSON.stringify({ published: true }),
      }).catch(function () {});
    }
    // ビルドが documents.live を実体化した直後。一覧のビルド状態バッジは古い
    // ままなので取り直す（編集中は他の再読込と同じ約束で yank しない）。
    if (activeListReload && !hasUnsavedArticleEdits()) activeListReload();
    showCloseButton();
  }

  // Stopped while the server still said "more" (no progress, or the pass cap):
  // never call it done — the pages or their Static Assets registration are not
  // finished. Not marked published either.
  function finalizeIncomplete() {
    byId("bpPhase")!.textContent = t("buildIncomplete");
    appendLog("error", t("buildIncompleteDetail"));
    showCloseButton();
  }

  // Shown when the user cancels: stops without marking the site published.
  function finalizeCancelled() {
    byId("bpPhase")!.textContent = t("buildCancelled");
    appendLog("error", t("buildCancelled"));
    showCloseButton();
  }

  // Fetch languages, then run the build across multiple passes (one Worker
  // invocation each) until the server reports more:false.
  try {
    const langData = await api("/api/languages").catch(function () {
      return { languages: [] };
    });
    const buildLang = (langData.languages || [])[0]?.lang || "ja";
    const token = state.token;
    const MAX_PASSES = 60; // safety cap against an unexpected non-terminating loop
    // 1 パスの取りこぼし（回線瞬断・プロキシのアイドル切断）を吸収する回数。
    const MAX_PASS_RETRIES = 5;
    let passRetries = 0;
    do {
      passIndex++;
      errorCount = 0;
      const errEl = byId("bpErrors");
      if (errEl) errEl.textContent = "0";
      const prevDone = donePaths.size;
      const prevPartial = partialCount;
      passDone = false;
      const buildHeaders = new Headers({ "Content-Type": "application/json" });
      if (token) buildHeaders.set("Authorization", "Bearer " + token);
      try {
        const res = await fetch(withBase("/api/build"), {
          method: "POST",
          headers: buildHeaders,
          // Force only on the first pass; resume passes rely on the build cache
          // (rewritten as pages rebuild) to skip already-done pages.
          body: JSON.stringify({
            lang: buildLang,
            force: force && passIndex === 1,
            ...(passBudget ? { budget: passBudget } : {}),
            ...(passLangs ? { langs: passLangs } : {}),
          }),
          credentials: "include",
          signal: buildAbort.signal,
        });
        if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() || "";
          for (const line of lines) {
            if (line.trim()) {
              try {
                handleEvent(JSON.parse(line));
              } catch {
                // Ignore malformed streaming build events and continue reading.
              }
            }
          }
        }
        // Flush remaining
        if (buf.trim()) {
          try {
            handleEvent(JSON.parse(buf));
          } catch {
            // Ignore a malformed trailing build event.
          }
        }
        // 「終わり」が届かずに閉じた回(CPU の上限で打ち切られると、応答は途中で閉じる)。
        if (!passDone && !fatalError) throw new Error("pass ended early");
      } catch (passErr) {
        // A user cancel aborts the fetch — stop quietly, not as an error.
        if (cancelled) break;
        // 回の量を減らして続ける(課題 a408a584)。減らせるうちは再試行の回数に数えない ——
        // 減らすたびに 1 回で使う CPU が小さくなるので、続ければ前へ進む。
        if (passBudget === undefined || passBudget > 1) {
          passBudget =
            passBudget === undefined ? 25 : Math.floor(passBudget / 2);
          appendLog(
            "warn",
            t("buildPassShrink").replace("{n}", String(passBudget)),
          );
          passIndex--;
          continue;
        }
        if (langCount > 1 && (passLangs === undefined || passLangs > 1)) {
          passLangs =
            passLangs === undefined
              ? Math.max(1, Math.floor(langCount / 2))
              : Math.floor(passLangs / 2);
          appendLog(
            "warn",
            t("buildPassShrinkLangs").replace("{n}", String(passLangs)),
          );
          passIndex--;
          continue;
        }
        // ⚠ ストリームが途中で切れても致命にしない。ビルドはパス単位で再開でき、
        //   済んだページは次のパスでスキップされるので、やり直せば必ず前へ進む。
        //   ここを throw にしていたため、長いビルドが "network error" 1 回で
        //   止まっていた（2026-08-13 に 35/196 で発生）。1 パスは 2 分近く
        //   ストリームを開き続けるので、切断はそれなりの頻度で起きる。
        passRetries++;
        if (passRetries > MAX_PASS_RETRIES) throw passErr;
        appendLog(
          "warn",
          t("buildPassRetry")
            .replace("{n}", String(passRetries))
            .replace("{max}", String(MAX_PASS_RETRIES))
            .replace("{err}", errorMessage(passErr)),
        );
        await new Promise(function (r) {
          setTimeout(r, 3000 * passRetries);
        });
        passIndex--; // 失敗したパスは数に入れない
        continue;
      }
      passRetries = 0; // 成功したら再試行カウンタを戻す
      // Guard: if a pass claims "more" but made no progress, stop to avoid a loop.
      // Progress = new pages, OR static assets uploaded on this pass. A guardian
      // busy with another operation is waited for (a few seconds) — it frees up.
      if (
        moreToCome &&
        donePaths.size === prevDone &&
        partialCount === prevPartial
      ) {
        const a = currentAssets();
        if (a && a.status === "busy") {
          await new Promise(function (r) {
            setTimeout(r, 5000);
          });
        } else if (!(a && (a.uploaded || 0) > 0)) break;
      }
    } while (moreToCome && !fatalError && !cancelled && passIndex < MAX_PASSES);
    if (cancelled) finalizeCancelled();
    else if (moreToCome && !fatalError) finalizeIncomplete();
    else finalizeBuild();
  } catch (err) {
    appendLog("error", t("error") + ": " + errorMessage(err));
    showCloseButton();
  }
}

async function reportClientError(
  context: Dynamic,
  error: Dynamic,
  metadata = {},
) {
  try {
    if (state.preview) return;
    const payload = {
      context,
      source: "admin-ui",
      route: routePath(),
      message:
        error instanceof Error
          ? errorMessage(error)
          : String(error || "Unknown"),
      stack: error instanceof Error ? error.stack || "" : "",
      metadata,
    };
    const headers = { "content-type": "application/json" };
    await fetch(
      withBase(
        isLegacyAdminPath
          ? "/admin/api/debug/client-error"
          : "/api/admin/debug/client-error",
      ),
      {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        keepalive: true,
      },
    );
  } catch {
    // Error reporting must never interrupt the admin UI.
  }
}

function fmtBytes(b: Dynamic) {
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + " MB";
  return (b / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

/**
 * 数量(件数・回数・行数・ページ数)の表示はすべてここを通す —— 桁区切りを画面全体で
 * 揃える(2026-10-16。カンマのある所と無い所が混ざっていた)。区切りの形はブラウザの言語。
 * ⚠ ID・版の番号・リビジョン番号のような「番号」には使わない(区切ると別物に見える)。
 */
function fmtNum(n: unknown): string {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString() : String(n ?? "");
}

function makePieChart(
  pct: Dynamic,
  label: Dynamic,
  used: Dynamic,
  maxLabel: Dynamic,
  // 委託の上限のように「無料枠」ではない上限は、見出しと注記を差し替える。
  limit?: { label: string; note?: string },
) {
  const r = 36;
  const circ = 2 * Math.PI * r;
  const filled = Math.min(1, pct / 100) * circ;
  const cls = pct < 70 ? "ok" : pct < 90 ? "warn" : "danger";
  const color =
    pct < 70 ? "var(--accent)" : pct < 90 ? "var(--accent-3)" : "var(--danger)";
  return (
    "<div class='storageCard" +
    (pct >= 50 ? " storage-alert" : "") +
    "'>" +
    "<div class='storageCardTitle'>" +
    escapeHtml(label) +
    "</div>" +
    "<div class='pieWrap'>" +
    "<svg viewBox='0 0 100 100'>" +
    "<circle class='pieBg' cx='50' cy='50' r='" +
    r +
    "' />" +
    "<circle class='pieArc " +
    cls +
    "' cx='50' cy='50' r='" +
    r +
    "' " +
    "stroke-dasharray='" +
    filled.toFixed(1) +
    " " +
    circ.toFixed(1) +
    "' />" +
    "</svg>" +
    "<div class='piePct' style='color:" +
    color +
    "'>" +
    pct.toFixed(1) +
    "<span style='font-size:10px'>%</span>" +
    "<div class='piePctSub'>" +
    escapeHtml(used) +
    "</div>" +
    "</div>" +
    "</div>" +
    "<div class='storageDetail'>" +
    escapeHtml(limit ? limit.label : t("freeLimitLabel")) +
    escapeHtml(maxLabel) +
    "</div>" +
    (limit?.note
      ? "<div class='storageDetail'>" + escapeHtml(limit.note) + "</div>"
      : "") +
    "</div>"
  );
}

// ヘルプの中身(v2・2026-10-21 に全面改定)。画面の文言とコードで確かめたことだけを書く。
// 表示の約束: canDo は " / " で、notes は「。」で(英語は ". " で)区切って箇条書きにする(help.ts)。
// 括弧の中に「。」を入れない(そこで切れる)。
const helpContent: Record<string, Dynamic> = {
  basic: {
    title: "KuroCMS の基本",
    role: "KuroCMS は Cloudflare の上で動く記事管理システムです。記事・メディア・サイトの見た目を管理画面で整え、ビルドすると公開ページができます。動かし方は 2 つあり、Entamy の Cloudflare アカウントで動く「委託運用」と、ご自身の Cloudflare アカウントで動く「顧客導入」です。いまどちらで動いているかは「設定 → 契約」で確かめられます。",
    canDo:
      "記事を書く（多言語・修正履歴・自動保存） / 画像・動画・音楽を置き、記事やサイト文字に貼る / テンプレート・サイト文字・フォント・計測で公開サイトを整える / ビルドして公開ページを作る（手動・予定公開に合わせた自動ビルドなど） / SNS（Bluesky・X・Threads）へ記事を投稿する / 利用者を招待し、管理者と投稿者に分ける / バックアップと復元 / REST API と MCP で、AI から記事を扱う（PAT） / 委託運用と顧客導入のあいだで引っ越す",
    notes:
      "ログインはパスキー（指紋や顔認証など）だけで、パスワードはありません。パスキーは複数のデバイスに登録しておいてください。パスキーをすべて失くしたときは、ログイン画面から登録済みのメールアドレスに再設定のリンクを送れます。記事の公開・非公開や表示の設定を変えても、ビルドするまで公開ページは変わりません。顧客導入では、Cloudflare の無料枠を超えた分がご自身の Cloudflare に課金されます。委託運用では、メディアの保存に上限（1 サイト 10 GB）があります。使用状況はダッシュボードで確かめてください。",
  },
  dashboard: {
    title: "ダッシュボード",
    role: "サイトの状態をまとめて見るホーム画面です。お知らせ・記事とメディアの数・使用状況・版（KuroCMS と、復旧の番人 WorkerOps）を表示します。",
    canDo:
      "Entamy と KuroCMS からのお知らせを読む / 記事数と公開数、メディアの件数と容量を確かめる / D1・R2・KV の使用状況をグラフで確かめる（顧客導入では、無料枠と Workers Paid の含み分を切り替えられる） / KuroCMS と WorkerOps の版を確かめ、「今すぐ更新のチェック」「今すぐ更新」を押す / 「自動で更新する」「常に最新版に更新」を切り替える",
    notes:
      "使用量が 70% を超えると黄色、90% を超えると赤になります。赤になる前に要らないメディアを消してください。委託運用では、使用状況は委託の上限に対して描きます。委託運用では更新を Entamy が届けるので、出るのは最新版のスイッチだけです。更新の仕組みはヘルプの「更新」を、お知らせはヘルプの「お知らせ」を見てください。",
  },
  articles: {
    title: "記事管理＆ビルド",
    role: "記事の一覧と、公開ページのビルドをまとめた画面です。記事の公開・非公開の切り替えと、SNS への投稿もここで行います。",
    canDo:
      "更新日・公開日・タイトルで並べ替え、カテゴリで絞り込み、タイトルと Slug で検索する / タイトルを押して記事を開く / 「公開する」「非公開に」で公開の印を切り替える / 記事ごとのビルドの状態（ビルド済み・未ビルド・公開待ち・公開終了）を確かめる / Bluesky・X・Threads へ投稿する（実際には投稿せず投稿済みにする、投稿済みの印を外す、もできる） / 下のビルド欄で方式を選び、「今すぐビルド」を押す / ビルドした公開ページを開く",
    notes:
      "公開・非公開は印を付けるだけで、ビルドするまで公開ページは変わりません。ビルドの方式は 4 つです。「手動ビルドのみ」「公開予定記事をその時間に自動ビルド」「未来記事も無条件にビルド」「強制的に全件をビルド」から選びます。大きなサイトのビルドは、Cloudflare の 1 回の実行の上限に合わせて何回かに分けて進みます。途中で止まっても、もう一度ビルドすると続きから進みます。SNS へ投稿できるのは、公開してビルド済みの記事だけです。SNS の接続は「設定 → SNS連動」で行います。",
  },
  newArticle: {
    title: "記事作成 / 編集",
    role: "記事を作り、本文や設定を書き換える画面です。新しく作るときは、タイプ・Slug・最初の言語を決めます。記事管理でタイトルを押すと、この画面で開きます。",
    canDo:
      "タイプ・Slug・最初の言語を決めて作る / タイトル・概要（200 文字まで・SNS の投稿にも使う）・本文をリッチエディタで書く / カバー画像・カテゴリ・ハッシュタグ・公開日時を設定する / ほかの言語の翻訳を作る（基本言語の内容を写して始められる） / 修正履歴を見て、過去の版を「コピーして最新に」で戻す / この記事だけをビルドする",
    notes:
      "Slug は半角の小文字英数字とハイフンだけで、先頭は英数字です。作った後は変えられません。公開中の記事は、右上で下書きに切り替えてから編集します。編集は自動で保存され、保存の状態は画面に出ます。開いた後に AI などが本文を書き換えていたときは、上書きするか聞きます。上書きしても、相手の版は修正履歴に残ります。過去の版に戻せるのは下書きのときだけで、カテゴリ・公開日・タイプは戻りません。カバー画像は、画像管理の画像から選ぶか、ファイルから読み込みます。",
  },
  images: {
    title: "画像管理",
    role: "画像をアップロードして管理する画面です。画像ごとに MID（img-001 など）が付き、記事の本文やサイト文字に [[img-001]] と書くと、そこに画像が出ます。",
    canDo:
      "ドラッグ＆ドロップかクリックでアップロードする / MID を押して [[MID]] をコピーする / 一覧で確かめ、要らない画像を消す / 「画像サイズの自動縮小」で、アップロードのときの上限を選ぶ（変換しない・200KB・500KB・1MB・2MB）",
    notes:
      "メディアは Cloudflare R2 に置きます。顧客導入で R2 がまだ無いときは、「設定 → 基本」の「R2 メディアストレージ」の手順でつないでください。自動縮小の設定はブラウザごとに覚えます。別のブラウザや端末では選び直してください。同じ内容の画像をもう一度上げると、前の画像を使い回します。アップロードした画像は、アドレスが分かれば誰でも見られます。人に見せない画像は置かないでください。",
  },
  videos: {
    title: "動画管理",
    role: "動画ファイルをアップロードして管理する画面です。記事の本文やサイト文字に [[vid-001]] と書くと、そこに動画のプレーヤーが出ます。",
    canDo:
      "動画ファイルをアップロードする / MID を押して [[MID]] をコピーする / 一覧で確かめ、要らない動画を消す",
    notes:
      "動画は容量が大きく、R2 の無料枠や委託運用の上限をすぐに使います。できるだけ YouTube などに置き、記事にはそのリンクを入れてください。外のサービスに置いた動画は R2 を使いません。",
  },
  audios: {
    title: "音楽管理",
    role: "音楽・音声ファイルをアップロードして管理する画面です。記事の本文やサイト文字に [[aud-001]] と書くと、そこに音楽のプレーヤーが出ます。",
    canDo:
      "音楽・音声ファイルをアップロードする / MID を押して [[MID]] をコピーする / 一覧で確かめ、要らないファイルを消す",
    notes:
      "音楽も容量が大きいため、できるだけ SoundCloud や Spotify などに置いてください。外のサービスに置いたものは R2 を使いません。",
  },
  categories: {
    title: "カテゴリ管理",
    role: "記事の分類に使うカテゴリを管理する画面です。",
    canDo: "カテゴリを追加・名前の変更・削除する / カテゴリの一覧を確かめる",
    notes:
      "記事で使っているカテゴリは消せません。先に記事から外してください。最初から Business・Hobby・Sports・Money・Life が入っています。",
  },
  languages: {
    title: "言語管理",
    role: "記事に使う言語を登録する画面です。REST API で記事を登録するときも、ここにある言語だけを受け付けます。",
    canDo:
      "言語を名前やコードで探して追加する / 言語を外す（翻訳を残すか、まとめて消すかを選ぶ） / 登録した言語の一覧を確かめる",
    notes:
      "言語を外しても、既定では翻訳は残り、登録し直すと戻ります。消す欄にチェックを入れたときだけ、その言語のデータも消えます。基本言語は外せません。基本言語は「設定 → 表示」で決めます。言語コードは ja・en・pt-br のような形です。",
  },
  types: {
    title: "タイプ管理",
    role: "記事の種類（ニュース・ブログなど）を管理する画面です。複数の記事を持つ Collection と、1 件だけの Single の 2 種類があります。",
    canDo:
      "Collection のタイプを追加・編集する（ブログなど、記事管理に並ぶもの） / Single のタイプを追加・編集する（TOP・About などの固定ページ） / タイプを消す",
    notes:
      "記事が 1 件でもあるタイプは消せません。先に記事を消すか、記事のタイプを変えてください。最初から入っている news と blog は残しておくことを勧めます。Single のタイプは記事を 1 件しか持てません。",
  },
  siteManagement: {
    title: "サイト管理",
    role: "公開サイトのテンプレート・サイト文字・フォント・計測を管理する画面です。テンプレート表示・テンプレート選択・テンプレート編集・サイト文字編集・フォント管理・計測の 6 つのタブがあります。",
    canDo:
      "テンプレート表示：パソコンとスマホの見え方を確かめる / テンプレート選択：手元のテンプレートやコミュニティのテンプレートを選ぶ / テンプレート編集：テンプレートの HTML を直接書き換える / サイト文字編集：サイト名や、テンプレートが使う文字を言語ごとに書く / フォント管理：Web フォントを読み込み、言語ごとに基本フォントを決める / 計測：GA4 の計測 ID と、SEO 用のサイト説明を設定する",
    notes:
      "テンプレート・サイト文字・フォント・計測の変更は、ビルドすると公開ページに出ます。サイト文字は、テンプレートが参照するキーと一致しないと、その場所が空になります。テンプレートの編集には HTML の知識が要ります。コミュニティに公開中のテンプレートは編集できません。先に非公開にしてください。",
  },
  settings: {
    title: "設定",
    role: "サイト全体の設定をまとめた画面です。タブごとに分かれています。開いているタブのくわしい説明は、そのタブでヘルプを押すと出ます。",
    canDo:
      "基本：R2 メディアストレージ（顧客導入だけ） / ドメイン：公開ドメインと既定値に戻す・Worker の URL・独自ドメイン（委託運用は Cloudflare for SaaS で自分のドメインを付ける） / 表示：基本言語・サイトのタイムゾーン・記事の末尾に筆者を出すか / 契約：いまの運用の形と契約の状態・無料期間の残り・国ごとの料金・申し込みと解約への入口（委託運用だけ）、持ち主の登録、委託運用と顧客導入のあいだの引っ越し / メール送信：この CMS のメールをどこから送るか（顧客導入だけ） / SNS連動：Bluesky・X・Threads の接続と、投稿済みの印の一括操作 / スマホ設定：狭い画面で記事のメディアを全幅にする / インポート：Strapi や別の KuroCMS から記事を取り込む / IP 制限：管理画面を使える回線を絞る / 稼働地域：データベースと KuroCMS が動いている場所を確かめる",
    notes:
      "表示とスマホ設定の変更は、ビルド（全ページ）を実行するまで公開ページに出ません。公開ページ内のリンクは、ドメインのタブの一番上の公開ドメインから作ります。データベースの地域は作ったときに決まり、後から変えられません。契約情報は 1 時間ほどごとに更新されます。",
  },
  domain: {
    title: "ドメイン",
    role: "このサイトをどのアドレスで公開するかを決めるタブです。顧客導入でも委託運用でも、ここにまとまっています。",
    canDo:
      "公開ドメインを変える / 「既定値に戻す」で、委託運用は 導入 ID.kurocms.site に、顧客導入は workers.dev のアドレスに戻す / Worker の URL を確かめる（顧客導入） / Cloudflare の独自ドメインを付ける（顧客導入） / 自分のドメインで公開する（委託運用・Cloudflare for SaaS）",
    notes:
      "公開ページ内のリンク（記事の URL・canonical・サイトマップなど）は、一番上の公開ドメインから作ります。変えたら保存して、全ページをビルドしてください。委託運用で自分のドメインを使うときは、ドメイン名を入れて「準備する」を押し、表示された TXT レコードを DNS に足します。証明書が発行済みになったら「ドメインを切り替える」を押し、最後に CNAME を 導入 ID.kurocms.site に向けます。Cloudflare で管理しているドメインは、CNAME を向けた時点で有効になります。ほかの DNS では、ルートのドメインに CNAME を置けないことが多いので、www などを使います。CNAME を書き換えると、そのドメインでそれまで表示していたものは見えなくなります。Cloudflare for SaaS は KuroCMS 側で契約しているので、お客様の追加の費用はありません。",
  },
  hosting: {
    title: "契約と引っ越し",
    role: "このサイトがどこで動いているか（委託運用か顧客導入か）と、持ち主を確かめるタブです。もう一方の形への引っ越しもここで行います。",
    canDo:
      "いまの運用の形と委託の契約の状態・払い方（月払い・年払い）・契約日・次の更新日を見る / 無料期間の残りを棒で見る / 国（日本・米国・欧州）を選んで料金を見る（初めは回線の国） / 委託契約の申し込み・解約は、Entamy の契約の頁（新しいタブ・サイトの持ち主の Entamy ID でログイン）で行う / 持ち主（Entamy ID）のメールアドレスを登録・変更・取り消す / いまの運用の形を確かめる / 委託運用から、ご自身の Cloudflare アカウントへ引っ越す（顧客導入・無料） / 顧客導入から、Entamy の委託運用へ引っ越す（有料・最初に無料期間がある） / 引っ越しの工程と進み具合をダイアログで見る / 止まった引っ越しを「途中から再開」で続ける",
    notes:
      "導入口で入れたサイトは、そのときログインした Entamy ID が持ち主です。それより前に入れたサイトは、先に持ち主のメールアドレスを登録します。確認のメールが 1 通届きます。引っ越すには、KuroCMS を新しい版へ更新しておく必要があります。足りないときは画面が知らせます。写している間もサイトはそのまま使えます。止まるのは最後の突き合わせの数分だけです。ダイアログを閉じても引っ越しは止まりません。終わると、古いアドレスは新しいアドレスへの案内に替わり、管理者全員に、新しいアドレスでパスキーを登録するリンクがメールで届きます。持っていかないものは、パスキー・ログインの状態・登録した回線・PAT・SNS の連携の鍵・操作の記録です。更新の方式と IP 制限は、引っ越し先では既定に戻ります。委託運用の無料期間は、登録メールアカウントごとに 1 回です。委託運用へ移った後も、ご自身の Cloudflare に入れた KuroCMS は消しません。要らなければご自身で消してください。",
  },
  mail: {
    title: "メール送信",
    role: "この CMS が送るメール（パスキーの再設定など）を、どこから送るかを決めるタブです。顧客導入のサイトにだけ出ます。",
    canDo:
      "いまの送り方（自分のドメイン、または黒兎のサーバー）を確かめる / 自分のドメインから送るスイッチを入れる / 最後のメールがどの経路で送られたかを確かめる / Cloudflare の Email Routing を設定する手順を見る",
    notes:
      "既定では黒兎のサーバーが送ります。黒兎のサーバーには送信数の上限があります。自分のドメインから送るには、このサイトに Worker のカスタムドメインがあり、そのドメインで Email Routing が有効で、管理者全員のアドレスが宛先として認証済みであることが要ります。自分のドメインで送れなかったときは、黒兎のサーバーが代わりに送ります。最後のメールを代わりに送ったときと、送れなかったときは、赤で出ます。設定を変えられるのは管理者だけです。委託運用では Entamy が送るので、このタブは出ません。",
  },
  ipGate: {
    title: "IP 制限",
    role: "管理画面を、利用者ごとに登録した回線からしか使えないようにする仕組みです。盗まれたログインの状態（クッキー）を、ほかの場所で使わせません。",
    canDo:
      "設定 → IP 制限：入・切、PAT も制限するか、登録を残す日数（IPv6 と IPv4）を決める / プロフィール → IP 制限：自分の登録した回線を確かめ、心当たりの無いものを外す / IPv6 のプロバイダーの prefix（/48・/56 など）を固定で足す",
    notes:
      "既定は入です。登録は自動で、パスキーでログインすると、その回線が登録されます。使うたびに期限が延び、使わなくなった回線は決めた日数で外れます。登録していない回線から使われると止め、本人へ確認のリンクをメールします。パスキーでログインし直しても登録されます。PAT の制限は既定で切です。AI や MCP は、アドレスの変わるクラウドの回線から呼ぶことが多いためです。IP 制限を切ると、盗まれたログインの状態がどの回線からでも使えるようになります。",
  },
  updates: {
    title: "更新と復旧の番人",
    role: "KuroCMS と、その復旧の番人（WorkerOps）の版を新しくする仕組みです。ダッシュボードの版の枠で操作します。",
    canDo:
      "導入している版・安定版・最新版を確かめる / 「今すぐ更新のチェック」「今すぐ更新」で更新する / 「自動で更新する」を入・切にする / 「常に最新版に更新」で、安定版だけを入れるか、リリースのたびに入れるかを選ぶ / WorkerOps も同じように更新する",
    notes:
      "自動で更新するときは、1 日に 1 回、選んだ版の新しいものを確かめ、WorkerOps が入れます。入れた直後の確かめに失敗すると、元の版に戻します。安定版は、提供元が確かめて昇格させた版です。最新版はリリースのたびに出るので、確かめの少ない版も入ります。版を確かめられなかったときは「確認できませんでした」と出ます。最新という意味ではありません。委託運用では Entamy が更新を届けるので、出るのは最新版のスイッチだけです。選んだ版の新しいものを 1 日 1 回（前回の確認から 24 時間後）確かめて自動で入れます。すぐに更新が必要なときは、Entamy に更新を依頼してください。",
  },
  notices: {
    title: "お知らせと持ち主",
    role: "Entamy と KuroCMS からのお知らせを受け取る仕組みです。お知らせはダッシュボードに出ます。",
    canDo:
      "お知らせを読み、「確認した」で閉じる / 「あとで読む」で後回しにする / ほかの Entamy の製品のお知らせも受け取るかを選ぶ / 持ち主のメールアドレスを登録して、重要なお知らせを受け取る（設定 → 契約）",
    notes:
      "緊急・重要なお知らせは、ログインしたときにダイアログでも出ます。新しいお知らせを確かめられなかったときは、前に受け取ったものを出し、その旨を表示します。持ち主のメールアドレスは、重要なお知らせと、委託運用の契約の持ち主のためだけに使います。同じ持ち主の複数のサイトでは、1 か所で確認したお知らせは、ほかのサイトでも確認済みになります。規約が更新されると、次に開いたときに同意を求めます。",
  },
  profile: {
    title: "プロフィール",
    role: "自分のアカウント・表示・PAT・パスキー・登録した回線を設定する画面です。アカウント・表示・PAT・パスキー・IP 制限の 5 つのタブがあります。",
    canDo:
      "アカウント：ユーザー名とメールアドレスを変える / 表示：管理画面の言語とダークモードを切り替える / PAT：REST API と MCP（AI 連携）で使うトークンを作る・取り消す / パスキー：このデバイスを追加し、名前を変え、要らないものを消す / IP 制限：自分の登録した回線を確かめ、外す",
    notes:
      "プロフィールのメールアドレスは、パスキーの再設定などが届くあなたのアドレスです。サイトの持ち主（Entamy ID）とは別で、持ち主は「設定 → 契約」で確かめます。PAT の権限は、あなたの権限と同じです。漏れると不正に使われるので、要らない PAT はすぐ取り消してください。REST API の使い方は /api/help に出ます。最後のパスキーは消せません。",
  },
  users: {
    title: "ユーザー管理",
    role: "利用者を招待し、権限を決める画面です。管理者だけが使えます。",
    canDo:
      "メールアドレスを入れて招待リンクを発行する / 権限（管理者・投稿者）を変える / アカウントを無効にする・消す / 登録日と最終ログインを確かめる",
    notes:
      "招待リンクは 48 時間有効です。本人にだけ渡してください。管理者は投稿者の権限も兼ねます。自分自身の権限は変えられず、自分を消すこともできません。",
  },
  backup: {
    title: "バックアップ",
    role: "サイトの中身を ZIP に書き出し、ZIP から戻す画面です。管理者だけが使え、バックアップとレストアの 2 つのタブがあります。",
    canDo:
      "記事・翻訳・カテゴリ・タクソノミー・テンプレート・サイトの設定・SNS 連携と、画像・動画・音楽の実ファイルを 1 つの ZIP に保存する / ZIP から、今の中身をすべて置き換えて戻す",
    notes:
      "利用者・パスキー・PAT と、SNS・取り込み元の鍵は ZIP に入りません（ZIP は暗号化しないため）。レストアの後は、設定の「SNS 連動」などで接続し直してください。レストアは、今のコンテンツ・メディア・設定をすべて消してから置き換えます。取り消せません。処理の間はタブを開いたままにしてください。大きなサイトは Chrome か Edge を使ってください。レストアの後はビルドすると、公開ページが作り直されます。別の Cloudflare や委託運用へ移るときは、バックアップではなく「設定 → 契約」の引っ越しを使ってください。",
  },
  faq: {
    title: "よくある質問 (Q&A)",
    faqs: [
      {
        q: "委託運用からご自身の Cloudflare へ（または逆へ）移りたい",
        a: "「設定 → 契約」の引っ越しを使ってください。記事・メディア・設定・利用者を写し、終わると古いアドレスは新しいアドレスへの案内に替わります。パスキーは持っていけないので、新しいアドレスで登録し直すリンクがメールで届きます。",
      },
      {
        q: "パスキーを登録したデバイスを失くしたら？",
        a: "ほかのデバイスのパスキーでログインできます。すべて失くしたときは、ログイン画面の「新しくデバイスを登録する場合」から登録済みのメールアドレスを入れると、再設定のリンクが届きます（30 分有効・1 回だけ）。メールが届かないときは、管理者に「設定 → メール送信」の状態を確かめてもらってください。",
      },
      {
        q: "記事を公開したのに、公開ページに出ません",
        a: "公開は印を付けるだけで、ビルドするまで公開ページは変わりません。記事管理の下の「今すぐビルド」を押してください。公開日時が先の記事は、その時刻まで出ません（ビルドの方式を「未来記事も無条件にビルド」にすると出ます）。",
      },
      {
        q: "記事の Slug は後から変えられますか？",
        a: "変えられません。URL が変わらないようにするためです。変えたいときは、記事を作り直してください。",
      },
      {
        q: "持ち主（Entamy ID）とは何ですか？",
        a: "このサイトの持ち主として Entamy に記録されているアカウントです。重要なお知らせが届き、委託運用の契約の持ち主になります。導入口で入れたサイトは、そのときログインした Entamy ID です。それより前のサイトは「設定 → 契約」で登録します。プロフィールのメールアドレスとは別のものです。",
      },
      {
        q: "使用量が上限を超えるとどうなりますか？",
        a: "顧客導入では、Cloudflare の無料枠を超えた分がご自身の Cloudflare に課金されます（後払い）。委託運用では、メディアの保存が上限に達すると、新しく保存できなくなります。どちらも、ダッシュボードで使用状況を確かめ、要らないメディアを消してください。",
      },
      {
        q: "REST API や AI（MCP）から記事を扱うには？",
        a: "プロフィールの PAT タブでトークンを作り、Authorization: Bearer <token> を付けて API を呼びます。使い方は /api/help に出ます。MCP の接続先と Claude Code の設定例も、同じタブにあります。",
      },
      {
        q: "R2 が無くても使えますか？",
        a: "文字だけの記事なら使えます。画像・動画・音楽には R2 が要ります。顧客導入では「設定 → 基本」の「R2 メディアストレージ」の手順でつないでください。委託運用では最初から使えます。",
      },
      {
        q: "Strapi から取り込んだ記事を上書きしたい",
        a: "「設定 → インポート」の「全件インポート」を押すと、KuroCMS で編集した記事を見つけて「修正済」と表示します。上書きする記事にだけチェックを入れて実行します。チェックしなかった記事は KuroCMS の版のまま残ります。",
      },
      {
        q: "複数人で使えますか？",
        a: "使えます。管理者が「ユーザー管理」で招待リンクを発行して追加します。権限は管理者と投稿者の 2 つで、管理者は投稿者の権限も兼ねます。",
      },
    ],
  },
};

const helpContentEn: Record<string, Dynamic> = {
  basic: {
    title: "KuroCMS basics",
    role: "KuroCMS is a content management system that runs on Cloudflare. You shape articles, media and the look of the site in this admin panel, and a build turns them into public pages. It runs in one of two ways: managed hosting on Entamy's Cloudflare account, or self-hosting on your own Cloudflare account. Settings → Contract shows which one this site uses.",
    canDo:
      "Write articles (multilingual, revision history, autosave) / Upload images, video and audio and place them in articles and site text / Shape the public site with templates, site text, fonts and analytics / Build public pages (manually, or automatically at scheduled publish times) / Post articles to Bluesky, X and Threads / Invite users as administrators or authors / Back up and restore / Work with articles from AI through the REST API and MCP (PAT) / Move between managed hosting and self-hosting",
    notes:
      "Sign-in uses passkeys only (fingerprint, face and the like); there is no password. Register passkeys on more than one device. If you lose every passkey, the sign-in screen can email a reset link to your registered address. Publishing, unpublishing or changing display settings does not change the public pages until you build. When self-hosting, anything beyond Cloudflare's free allowance is billed to your Cloudflare account. On managed hosting, media storage has a limit (10 GB per site). Check usage on the dashboard.",
  },
  dashboard: {
    title: "Dashboard",
    role: "The home screen for the state of the site. It shows notices, article and media counts, usage, and versions (KuroCMS and its recovery guardian, WorkerOps).",
    canDo:
      'Read notices from Entamy and KuroCMS / Check the article and published counts, and media counts and sizes / Check D1, R2 and KV usage on charts (when self-hosting, switch between the free allowance and what Workers Paid includes) / Check the KuroCMS and WorkerOps versions and press "Check for Update" or "Update Now" / Switch "Update automatically" and "Always update to latest"',
    notes:
      'Usage turns yellow above 70% and red above 90%. Delete media you no longer need before it turns red. On managed hosting, usage is drawn against the managed limits. On managed hosting, Entamy delivers updates, so only the latest-version switch is shown. See "Updates" and "Notices" in this help for how those work.',
  },
  articles: {
    title: "Article Manager & build",
    role: "The article list together with building the public pages. You also publish or unpublish articles and post them to social media here.",
    canDo:
      'Sort by updated date, publish date or title, filter by category, and search titles and slugs / Open an article by clicking its title / Set the publish flag with "Publish" and "Unpublish" / Check each article\'s build state (built, not built, scheduled, ended) / Post to Bluesky, X and Threads (you can also mark as posted without posting, or clear the posted mark) / Choose a build mode in the build bar and press "Build Now" / Open the built public page',
    notes:
      'Publishing only sets a flag; the public pages do not change until you build. There are four build modes: "Manual build only", "Auto-build scheduled posts at their time", "Build future posts unconditionally" and "Force full rebuild (all pages)". A large site builds in several passes to fit Cloudflare\'s per-run limits. If a build stops, building again continues from where it stopped. Only published and built articles can be posted to social media. Connect the services under Settings → SNS.',
  },
  newArticle: {
    title: "New / edit article",
    role: "Create articles and edit their body and settings. A new article needs a type, a slug and its first language. Clicking a title in Article Manager opens it here.",
    canDo:
      'Create with a type, slug and first language / Write the title, summary (up to 200 characters, also used for social posts) and body in the rich editor / Set the cover image, categories, hashtags and publish time / Create translations (optionally starting from a copy of the base language) / Browse the revision history and restore an older version with "Copy to latest" / Build just this article',
    notes:
      "A slug uses lowercase letters, numbers and hyphens, and starts with a letter or number. It cannot be changed after creation. To edit a published article, switch it to draft with the button at the top right first. Edits save automatically and the save state is shown on screen. If an AI or another client changed the body after you opened it, you are asked before overwriting; their version stays in the revision history. Older versions can be restored only while the article is a draft, and categories, publish date and type are not restored. Pick the cover from Images or load it from a file.",
  },
  images: {
    title: "Images",
    role: "Upload and manage images. Each image gets an MID such as img-001, and writing [[img-001]] in an article or in site text shows the image there.",
    canDo:
      'Upload by drag and drop or by clicking / Click an MID to copy [[MID]] / Review the list and delete images you no longer need / Choose the upload size limit under "Automatic image resizing" (no conversion, 200KB, 500KB, 1MB, 2MB)',
    notes:
      "Media is stored in Cloudflare R2. If a self-hosted site has no R2 yet, connect it with the steps under Settings → Basic → R2 media storage. The auto-resize choice is remembered per browser, so choose again on another browser or device. Uploading the same image again reuses the existing one. Anyone who knows an uploaded image's address can see it, so do not upload private images.",
  },
  videos: {
    title: "Videos",
    role: "Upload and manage video files. Writing [[vid-001]] in an article or in site text shows a video player there.",
    canDo:
      "Upload video files / Click an MID to copy [[MID]] / Review the list and delete videos you no longer need",
    notes:
      "Video files are large and quickly use up the free R2 allowance or the managed limit. Where possible, host videos on YouTube or a similar service and put the link in the article. Videos hosted elsewhere do not use R2.",
  },
  audios: {
    title: "Audio",
    role: "Upload and manage music and audio files. Writing [[aud-001]] in an article or in site text shows an audio player there.",
    canDo:
      "Upload music and audio files / Click an MID to copy [[MID]] / Review the list and delete files you no longer need",
    notes:
      "Audio files are large too, so host them on SoundCloud, Spotify or a similar service where possible. Files hosted elsewhere do not use R2.",
  },
  categories: {
    title: "Categories",
    role: "Manage the categories used to group articles.",
    canDo: "Add, rename and delete categories / Review the category list",
    notes:
      "A category used by articles cannot be deleted; remove it from those articles first. Business, Hobby, Sports, Money and Life are included from the start.",
  },
  languages: {
    title: "Languages",
    role: "Register the languages used for articles. The REST API also accepts only the languages listed here.",
    canDo:
      "Search by name or code and add a language / Remove a language (choose whether to keep or delete its translations) / Review the registered languages",
    notes:
      "Removing a language keeps its translations by default, and registering it again brings them back. Its data is deleted only if you tick the delete box. The base language cannot be removed; set it under Settings → Display. Language codes look like ja, en or pt-br.",
  },
  types: {
    title: "Types",
    role: "Manage article types such as news or blog. A Collection type holds many articles and a Single type holds exactly one.",
    canDo:
      "Add and edit Collection types (blogs and the like, listed in Articles) / Add and edit Single types (fixed pages such as Top or About) / Delete types",
    notes:
      "A type with even one article cannot be deleted; delete those articles or change their type first. Keeping the built-in news and blog types is recommended. A Single type can hold only one article.",
  },
  siteManagement: {
    title: "Site Manager",
    role: "Manage the public site's template, site text, fonts and analytics. It has six tabs: template preview, template selection, template editing, site text, fonts and analytics.",
    canDo:
      "Template preview: check how the site looks on a computer and a phone / Template selection: choose a local template or one from the community library / Template editing: edit the template HTML directly / Site text: write the site name and the text the template uses, per language / Fonts: load web fonts and choose a base font per language / Analytics: set the GA4 measurement ID and the SEO site description",
    notes:
      "Changes to the template, site text, fonts and analytics reach the public pages when you build. Site text must use the keys the template refers to, or that spot stays empty. Editing a template requires HTML knowledge. A template published to the community cannot be edited; unpublish it first.",
  },
  settings: {
    title: "Settings",
    role: "Site-wide settings, split into tabs. Press Help while a tab is open to see help for that tab.",
    canDo:
      "Basic: R2 media storage (self-hosting only) / Domain: public domain and reset to default, Worker URL, custom domain (on managed hosting, attach your own domain with Cloudflare for SaaS) / Display: base language, site time zone, author line at the end of articles / Contract: the hosting form and contract status, the free period left, prices by country, and the way to subscribe or cancel (managed hosting only); register the owner; move between managed hosting and self-hosting / Email: where this CMS sends its mail from (self-hosting only) / SNS: connect Bluesky, X and Threads, and set or clear posted marks in bulk / Mobile: make article media full width on narrow screens / Import: bring in articles from Strapi or another KuroCMS / IP restriction: limit the networks that can use the admin panel / Region: see where the database and KuroCMS run",
    notes:
      "Display and Mobile changes reach the public pages only after a full build. Links in your public pages are built from the public domain at the top of the Domain tab. The database region is fixed when the database is created. Contract information refreshes about once an hour.",
  },
  domain: {
    title: "Domain",
    role: "This tab decides the address your site is published at. It is the same tab on self-hosting and managed hosting.",
    canDo:
      'Change the public domain / "Reset to default" goes back to installation-id.kurocms.site on managed hosting, or the workers.dev address on self-hosting / See the Worker URL (self-hosting) / Attach a Cloudflare custom domain (self-hosting) / Publish under your own domain (managed hosting, Cloudflare for SaaS)',
    notes:
      'Links in your public pages (article URLs, canonical, sitemap and so on) are built from the public domain at the top. After changing it, save and rebuild all pages. To use your own domain on managed hosting, enter the domain name, press "Prepare" and add the TXT records shown to your DNS. When the certificate is issued, press "Switch domain", then point the CNAME to installation-id.kurocms.site. A domain on Cloudflare becomes active when the CNAME points here. Many other DNS providers cannot put a CNAME on the root domain, so use www or similar. When you change the CNAME, whatever the domain showed before is no longer shown. KuroCMS already has the Cloudflare for SaaS contract, so there is no extra cost for you.',
  },
  hosting: {
    title: "Contract and moving",
    role: "This tab shows where the site runs (managed hosting or self-hosting) and who owns it. You also move to the other form here.",
    canDo:
      'See the hosting form and the contract status, plan (monthly or yearly), subscription date and next renewal / See the free period left as a bar / Choose a country (Japan, United States, Europe) to see its prices (first chosen from your connection) / Register, change or remove the owner\'s email address (Entamy ID) / Move from managed hosting to your own Cloudflare account (self-hosting, free) / Move from self-hosting to Entamy managed hosting (paid, with a free period at first) / Watch the steps and progress of a move in a dialog / Continue a stopped move with "Resume from where it stopped"',
    notes:
      "For a site installed through the installer, the owner is the Entamy ID that signed in at the time. For a site installed before that, register the owner's email address first; you receive one confirmation email. Moving requires a recent KuroCMS version, and the screen tells you if yours is too old. The site keeps working while it copies and pauses only for a few minutes at the final check. Closing the dialog does not stop the move. When it finishes, the old address shows a notice that points to the new one, and every administrator gets an email with a link to register a passkey at the new address. Passkeys, sign-in state, registered networks, PATs, social media keys and the activity log are not carried over. The update settings and IP restriction return to their defaults at the new site. The managed free period is given once per registered email account. After moving to managed hosting, the KuroCMS in your own Cloudflare account is not deleted; delete it yourself if you no longer need it.",
  },
  mail: {
    title: "Email",
    role: "This tab decides where the mail this CMS sends (passkey resets and the like) comes from. It is shown only on self-hosted sites.",
    canDo:
      "See how mail is sent now (your own domain, or the Kuro-Boo server) / Turn on sending from your own domain / See which route the last email took / Read the steps to set up Cloudflare Email Routing",
    notes:
      "By default the Kuro-Boo server sends the mail, and it has a sending limit. To send from your own domain, this site needs a custom domain on its Worker, Email Routing must be on for that domain, and every administrator's address must be a verified destination. If sending from your own domain fails, the Kuro-Boo server sends it instead. The last email is shown in red if it was relayed or could not be sent. Only administrators can change this. On managed hosting Entamy sends the mail, so this tab is not shown.",
  },
  ipGate: {
    title: "IP restriction",
    role: "Lets each user use the admin panel only from networks registered to them. A stolen sign-in state (cookie) cannot be used from anywhere else.",
    canDo:
      "Settings → IP restriction: turn it on or off, decide whether PATs are restricted too, and set how many days networks stay registered (IPv6 and IPv4) / Profile → IP restriction: see your registered networks and remove any you do not recognise / Pin an IPv6 provider prefix (/48, /56 and so on)",
    notes:
      "It is on by default. Registration is automatic: signing in with a passkey registers that network. Each use extends it, and networks you stop using drop off after the set number of days. Use from an unregistered network is stopped, and the user gets a confirmation link by email; signing in again with a passkey also registers it. Restricting PATs is off by default, because AI agents and MCP often call from cloud networks whose addresses change. Turning IP restriction off lets a stolen sign-in state work from any network.",
  },
  updates: {
    title: "Updates and the recovery guardian",
    role: "How KuroCMS and its recovery guardian (WorkerOps) are updated. Use the version box on the dashboard.",
    canDo:
      'See the installed, stable and latest versions / Update with "Check for Update" and "Update Now" / Turn "Update automatically" on or off / Use "Always update to latest" to choose between stable versions only and every release / Update WorkerOps the same way',
    notes:
      "With automatic updates, the chosen channel is checked once a day and WorkerOps installs anything new. If the check right after installing fails, it goes back to the previous version. Stable versions are releases the publisher has checked and promoted. The latest channel gets every release, including ones that have been checked less. If the version check cannot reach the release source, it says so; that does not mean you are up to date. On managed hosting Entamy delivers updates, so only the latest-version switch is shown. New versions of the chosen channel are checked and installed automatically once a day (about 24 hours after the last check). If you need an update right away, ask Entamy to update your site.",
  },
  notices: {
    title: "Notices and the owner",
    role: "How notices from Entamy and KuroCMS reach you. Notices appear on the dashboard.",
    canDo:
      'Read a notice and close it with "Got it" / Put it off with "Read later" / Choose whether to receive notices from other Entamy products / Register the owner\'s email address to receive important notices (Settings → Contract)',
    notes:
      "Urgent and important notices also appear in a dialog when you sign in. If new notices cannot be checked, the ones received earlier are shown with a note saying so. The owner's email address is used only for important notices and as the owner of a managed contract. On several sites with the same owner, a notice acknowledged on one site is acknowledged on the others too. When the terms are updated, you are asked to agree the next time you open the admin panel.",
  },
  profile: {
    title: "Profile",
    role: "Your account, display, PATs, passkeys and registered networks. It has five tabs: Account, Display, PAT, Passkeys and IP restriction.",
    canDo:
      "Account: change your user name and email address / Display: switch the admin panel language and dark mode / PAT: create and revoke tokens for the REST API and MCP (AI) / Passkeys: add this device, rename passkeys and delete ones you no longer need / IP restriction: see and remove your registered networks",
    notes:
      "The email address in your profile is where passkey resets and similar mail reach you. It is separate from the site owner (Entamy ID), which you check under Settings → Contract. A PAT has the same permissions as you. A leaked PAT can be misused, so revoke any you no longer need right away. How to use the REST API is shown at /api/help. Your last passkey cannot be deleted.",
  },
  users: {
    title: "Users",
    role: "Invite users and set their permissions. Administrators only.",
    canDo:
      "Enter an email address and issue an invitation link / Change permissions (administrator or author) / Disable or delete accounts / See registration and last sign-in dates",
    notes:
      "Invitation links are valid for 48 hours. Give them only to the person invited. Administrators also have author permissions. You cannot change your own permissions or delete yourself.",
  },
  backup: {
    title: "Backup",
    role: "Export the site's content to a ZIP and restore from a ZIP. Administrators only; it has Backup and Restore tabs.",
    canDo:
      "Save articles, translations, categories, taxonomy, templates, site settings, social connections, and the image, video and audio files in one ZIP / Restore from a ZIP, replacing everything currently there",
    notes:
      "Users, passkeys, PATs and the keys for social media and import sources are not in the ZIP (it is not encrypted). After a restore, reconnect them in Settings (SNS and so on). Restore deletes all current content, media and settings before replacing them, and it cannot be undone. Keep the tab open while it runs. Use Chrome or Edge for large sites. After a restore, build to regenerate the public pages. To move to another Cloudflare account or to managed hosting, use the move under Settings → Contract rather than a backup.",
  },
  faq: {
    title: "FAQ",
    faqs: [
      {
        q: "I want to move from managed hosting to my own Cloudflare (or the other way)",
        a: "Use the move under Settings → Contract. It copies articles, media, settings and users, and when it finishes the old address points visitors to the new one. Passkeys cannot be carried over, so you receive an email with a link to register one at the new address.",
      },
      {
        q: "What if I lose the device with my passkey?",
        a: 'Sign in with a passkey on another device. If you have lost them all, enter your registered email address under "Register a new device" on the sign-in screen to receive a reset link (valid for 30 minutes, single use). If the email does not arrive, ask an administrator to check Settings → Email.',
      },
      {
        q: "I published an article but it does not appear on the public site",
        a: 'Publishing only sets a flag; the public pages change when you build. Press "Build Now" at the bottom of Article Manager. An article with a future publish time does not appear until then (the "Build future posts unconditionally" mode shows it).',
      },
      {
        q: "Can I change an article's slug later?",
        a: "No. It stays fixed so that the URL never changes. To change it, create the article again.",
      },
      {
        q: "What is the owner (Entamy ID)?",
        a: "The account Entamy records as the owner of this site. It receives important notices and becomes the owner of a managed contract. For a site installed through the installer, it is the Entamy ID that signed in at the time; for older sites, register it under Settings → Contract. It is separate from the email address in your profile.",
      },
      {
        q: "What happens if usage goes over the limit?",
        a: "When self-hosting, anything beyond Cloudflare's free allowance is billed to your Cloudflare account. On managed hosting, new media cannot be saved once storage reaches the limit. Either way, check usage on the dashboard and delete media you no longer need.",
      },
      {
        q: "How do I work with articles from the REST API or AI (MCP)?",
        a: "Create a token on the PAT tab of your profile and call the API with an Authorization: Bearer <token> header. Usage is shown at /api/help. The MCP endpoint and a Claude Code configuration example are on the same tab.",
      },
      {
        q: "Can I use KuroCMS without R2?",
        a: "Yes, for text-only articles. Images, video and audio need R2. When self-hosting, connect it with the steps under Settings → Basic → R2 media storage. Managed hosting has it from the start.",
      },
      {
        q: "I want to overwrite articles imported from Strapi",
        a: 'Press "Import All" under Settings → Import. Articles edited in KuroCMS are detected and marked "edited". Tick only the ones to overwrite and run it; unticked articles keep their KuroCMS version.',
      },
      {
        q: "Can several people use it?",
        a: "Yes. An administrator adds people by issuing invitation links under Users. There are two permission levels, administrator and author, and administrators also have author permissions.",
      },
    ],
  },
};

function modeLabel(mode: Dynamic) {
  return mode === 1 ? t("published") : mode === 2 ? t("hidden") : t("draft");
}

function formatDateTime(value: Dynamic) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function escapeHtml(value: Dynamic) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      (
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#039;",
        }) as Record<string, string>
      )[char],
  );
}

/**
 * 規約・プライバシーポリシーの再同意。
 *
 * 版が上がったとき、および同意を取る前に導入された環境（記録が無い）で出す。
 * **どちらも「同意済みの版が現在の版と違う」で同じ**なので、経路を分けない。
 *
 * 版を取得できないときは何も出さない —— 何に同意したのか記録できないまま
 * 同意させても意味が無く、管理画面の障害で CMS が使えなくなるのも困る。
 */
/**
 * 無料期間が終わり、契約の無い委託(cms-pricing「無料期間が切れたとき」・課題 8396f3b7)。
 * ログインのたびに 1 回(このタブの間・ログアウトで消える sessionStorage)、契約を結ぶかを確かめる窓を出す。
 * 窓は「契約するまで記事の追加とビルドは一切できない」「データは無料期間の終わりから 30 日で消える」と、
 * 委託契約の申し込み(Entamy の契約の頁)と、自分の Cloudflare へ引っ越す道(無料)を出す。
 * 判定は API と同じ(サーバーが変更の要求を 402 で断る・contract-lock.ts)。管理者だけが契約を読める。
 */
async function checkContractWindowOnce() {
  const KEY = "kurocms-contract-window";
  try {
    if (sessionStorage.getItem(KEY)) return;
  } catch {
    /* 使えなければ毎回出す */
  }
  let r: Dynamic;
  try {
    r = await api("/api/system/contract");
  } catch {
    return; // 管理者でない・取れない時は出さない(変更はサーバーが断る)
  }
  const c = r && r.contract;
  if (!r?.managed || !c || c.subscription !== "none" || !c.trial_final_at)
    return;
  if (Number(r.now) <= Number(c.trial_final_at)) return;
  try {
    sessionStorage.setItem(KEY, "1");
  } catch {
    /* 覚えられなくても出す */
  }
  const date = (ms: number | null) =>
    ms == null
      ? "—"
      : new Date(ms).toLocaleDateString(state.uiLang, {
          year: "numeric",
          month: "long",
          day: "numeric",
          timeZone: "UTC",
        });
  const ov = document.createElement("div");
  ov.setAttribute("role", "dialog");
  ov.setAttribute("aria-modal", "true");
  ov.style.cssText =
    "position:fixed;inset:0;z-index:2900;background:rgba(8,12,22,.72);" +
    "display:flex;align-items:center;justify-content:center;padding:20px";
  const card = document.createElement("div");
  card.style.cssText =
    "width:min(560px,100%);background:var(--panel,#141f35);color:var(--ink,#e9eefc);" +
    "border:1px solid var(--line,#293b5d);border-radius:14px;padding:22px;" +
    "font-size:14px;line-height:1.8;box-shadow:0 18px 50px rgba(0,0,0,.5)";
  const h = document.createElement("h3");
  h.textContent = t("contractWindowTitle");
  h.style.cssText = "margin:0 0 10px;font-size:18px";
  const p1 = document.createElement("p");
  p1.textContent = t("contractWindowLocked");
  p1.style.cssText = "margin:0 0 8px;font-weight:700";
  const p2 = document.createElement("p");
  p2.textContent = t("contractWindowDelete").replace(
    "{date}",
    date(c.delete_at),
  );
  p2.style.cssText = "margin:0 0 16px";
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;margin:0 0 14px";
  const apply = document.createElement("a");
  apply.href = CONTRACT_PAGE;
  apply.target = "_blank";
  apply.rel = "noopener";
  apply.className = "button";
  apply.textContent = t("contractApply");
  const move = document.createElement("a");
  move.href = adminHref("/settings") + "?tab=hosting";
  move.className = "button secondary";
  move.textContent = t("siteMoveToSelf");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "secondary";
  close.textContent = t("contractWindowClose");
  close.addEventListener("click", () => ov.remove());
  move.addEventListener("click", () => ov.remove());
  row.append(apply, move, close);
  const p3 = document.createElement("p");
  p3.textContent = t("contractWindowMoveHelp");
  p3.style.cssText = "margin:0;color:var(--muted,#91a0c3);font-size:13px";
  card.append(h, p1, p2, row, p3);
  ov.appendChild(card);
  document.body.appendChild(ov);
}

let legalChecked = false;
type LegalBlockView =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[] };
type LegalDocView = {
  docType: string;
  version: string | null;
  isTranslation: boolean;
  canonicalLang: string | null;
  blocks: LegalBlockView[];
};

/**
 * 規約の同意(起動時の関門)。**共通の同意の窓(entamy-connect/web/ui の consent.ts)と同じ形** ——
 * 文書ごとのチェック欄を並べ、名前を押すと条文を開き、全部にチェックしてから同意する(2026-10-26・利用者の指示)。
 * どの文書を出すか・並び・要否は、サーバーが共通の部品(EntamyLegal.fetchDocuments)で決めて返す。
 * 管理画面から entamy-connect を取り込まないのは、公開ミラーが組み立てられなくなるため(notice.ts と同じ)。
 * 窓は閉じられない(取り消しも Esc も無い)。本文は文字として置き、HTML を素通しにしない。
 */
function legalDocTitle(docType: string): string {
  const key = (
    {
      terms: "legalTerms",
      privacy: "legalPrivacy",
      tokushoho: "legalTokushoho",
      gdpr: "legalGdpr",
    } as Record<string, string>
  )[docType];
  return key ? t(key) : docType;
}

function legalBodyView(blocks: LegalBlockView[]): HTMLElement {
  const root = document.createElement("div");
  for (const block of blocks) {
    if (block.kind === "heading") {
      const h = document.createElement(
        `h${Math.min(Math.max(block.level, 3), 6)}`,
      );
      h.textContent = block.text;
      h.style.cssText = "margin:14px 0 6px;font-size:14px";
      root.append(h);
    } else if (block.kind === "list") {
      const ul = document.createElement("ul");
      ul.style.cssText = "margin:6px 0;padding-left:20px";
      for (const item of block.items) {
        const li = document.createElement("li");
        li.textContent = item;
        ul.append(li);
      }
      root.append(ul);
    } else {
      const p = document.createElement("p");
      p.style.cssText = "margin:6px 0";
      block.text.split("\n").forEach((line, i) => {
        if (i) p.append(document.createElement("br"));
        p.append(document.createTextNode(line));
      });
      root.append(p);
    }
  }
  return root;
}

const legalOverlayCss =
  "position:fixed;inset:0;background:rgba(8,12,22,.72);display:flex;align-items:center;justify-content:center;padding:20px";
const legalCardCss =
  "background:var(--surface,#1e293b);color:var(--ink,#f1f5f9);border:1px solid var(--line,#334155);border-radius:14px;" +
  "box-shadow:0 18px 50px rgba(0,0,0,.5);display:flex;flex-direction:column;max-height:calc(100dvh - 40px)";

/** 1つの文書の条文を、関門の上に開く。 */
function openLegalDocument(doc: LegalDocView) {
  const ov = document.createElement("div");
  ov.setAttribute("role", "dialog");
  ov.setAttribute("aria-modal", "true");
  ov.style.cssText = legalOverlayCss + ";z-index:3001";
  const card = document.createElement("div");
  card.style.cssText = legalCardCss + ";width:min(640px,100%)";
  const h = document.createElement("h3");
  h.textContent = legalDocTitle(doc.docType);
  h.style.cssText = "margin:0;padding:18px 22px 6px;font-size:16px";
  const body = document.createElement("div");
  body.tabIndex = 0;
  body.style.cssText =
    "overflow:auto;padding:0 22px 12px;font-size:13px;line-height:1.7;flex:1 1 auto;min-height:0";
  if (doc.version) {
    const v = document.createElement("p");
    v.textContent = t("legalDocVersion").replace("{version}", doc.version);
    v.style.cssText =
      "margin:0 0 8px;color:var(--muted,#94a3b8);font-size:12px";
    body.append(v);
  }
  // 正文以外は参考訳である旨を出す(§3.2)。
  if (doc.isTranslation) {
    const n = document.createElement("p");
    n.textContent = t("legalTranslationNote").replace(
      "{lang}",
      doc.canonicalLang ?? "",
    );
    n.style.cssText =
      "margin:0 0 8px;color:var(--muted,#94a3b8);font-size:12px";
    body.append(n);
  }
  body.append(legalBodyView(doc.blocks));
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = t("legalClose");
  close.style.cssText =
    "margin:10px 22px 16px;align-self:flex-end;border:0;border-radius:9px;padding:8px 16px;font:inherit;font-weight:700";
  close.onclick = () => ov.remove();
  card.append(h, body, close);
  ov.append(card);
  document.body.append(ov);
  close.focus();
}

async function checkLegalConsentOnce() {
  if (legalChecked) return;
  legalChecked = true;
  let info: {
    needsConsent?: boolean;
    currentVersion?: string | null;
    acceptedVersion?: string | null;
    summary?: string | null;
    documents?: LegalDocView[];
  };
  try {
    info = await api(
      "/api/system/legal?lang=" + encodeURIComponent(state.uiLang || "ja"),
    );
  } catch {
    return; // 取れなければ求めない
  }
  const documents = info.documents ?? [];
  // **提示できない文面に同意させない**(§3.2)。
  if (!info.needsConsent || !info.currentVersion || documents.length === 0)
    return;

  const ov = document.createElement("div");
  ov.setAttribute("role", "dialog");
  ov.setAttribute("aria-modal", "true");
  ov.style.cssText = legalOverlayCss + ";z-index:3000";
  const card = document.createElement("div");
  card.style.cssText =
    legalCardCss + ";width:min(460px,100%);font-size:14px;line-height:1.7";

  // 初めての同意(記録が無い)は「更新」ではない。改定の要約(差分)も、前の版を知らない人には意味が無い。
  const first = !info.acceptedVersion;
  const h = document.createElement("h3");
  h.textContent = t(first ? "legalFirstTitle" : "legalTitle");
  h.style.cssText = "margin:0;padding:20px 22px 8px;font-size:18px";
  card.append(h);

  const list = document.createElement("div");
  list.style.cssText =
    "overflow:auto;padding:0 22px 8px;flex:1 1 auto;min-height:0";
  if (info.summary && !first) {
    const sum = document.createElement("p");
    sum.textContent = info.summary;
    sum.style.cssText =
      "margin:0 0 10px;color:var(--muted,#94a3b8);font-size:13px";
    list.append(sum);
  }

  const go = document.createElement("button");
  const checks: HTMLInputElement[] = [];
  const all = document.createElement("input");
  // 全部にチェックが付くまで押せない。**押せない理由は見た目で分かるようにする。**
  const sync = () => {
    const ok = checks.length > 0 && checks.every((c) => c.checked);
    all.checked = ok;
    go.disabled = !ok;
    go.style.opacity = ok ? "1" : ".45";
    go.style.cursor = ok ? "pointer" : "not-allowed";
  };
  const row = (input: HTMLInputElement, label: HTMLElement) => {
    const line = document.createElement("div");
    line.style.cssText =
      "display:flex;align-items:center;gap:10px;padding:5px 0";
    input.type = "checkbox";
    input.style.cssText = "width:16px;height:16px;margin:0;flex:none";
    line.append(input, label);
    return line;
  };
  for (const doc of documents) {
    const input = document.createElement("input");
    input.setAttribute("aria-label", legalDocTitle(doc.docType));
    input.addEventListener("change", sync);
    checks.push(input);
    // 名前はリンク。**押すと条文を開く**(チェックは付けない)。
    const link = document.createElement("a");
    link.href = "#";
    link.textContent = legalDocTitle(doc.docType);
    link.style.cssText = "font-weight:700;text-decoration:underline";
    link.addEventListener("click", (event) => {
      event.preventDefault();
      openLegalDocument(doc);
    });
    list.append(row(input, link));
  }
  const hr = document.createElement("hr");
  hr.style.cssText =
    "border:0;border-top:1px solid var(--line,#334155);margin:6px 0";
  list.append(hr);
  all.id = "legalCheckAll";
  const allLabel = document.createElement("label");
  allLabel.htmlFor = all.id;
  allLabel.textContent = t("legalCheckAll");
  allLabel.style.fontWeight = "600";
  all.addEventListener("change", () => {
    for (const c of checks) c.checked = all.checked;
    sync();
  });
  list.append(row(all, allLabel));
  card.append(list);

  const foot = document.createElement("div");
  foot.style.cssText =
    "display:flex;justify-content:flex-end;padding:10px 22px 20px";
  go.type = "button";
  go.textContent = t("legalAgreeButton");
  go.style.cssText =
    "border:0;border-radius:9px;padding:10px 18px;font:inherit;font-weight:700;" +
    "background:var(--accent,#2f7d6b);color:#fff";
  sync();

  const version = info.currentVersion;
  go.onclick = () => {
    if (go.disabled) return;
    // **押したらすぐ閉じる。** 通信の結果を待たせない ——
    // 待たされると押せていないと思って何度も押すことになる。
    ov.remove();

    // 記録は背後で行い、失敗しても黙って繰り返す。
    // 取りこぼしても次回の読み込みでまた尋ねるだけなので、利用者に見せる必要が無い。
    void (async () => {
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          await api("/api/system/legal/accept", {
            method: "POST",
            body: JSON.stringify({ version }),
          });
          return;
        } catch (e) {
          // 版が進んでいた場合は、いま同意した版ではないので繰り返さない。
          const code = (e as { body?: { error?: { code?: string } } }).body
            ?.error?.code;
          if (code === "legal_version_mismatch") return;
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        }
      }
    })();
  };
  foot.append(go);
  card.append(foot);
  ov.append(card);
  document.body.append(ov);
}

/**
 * 持ち主の連絡先(古い導入。cms-admin-integration「連絡先の登録」)。
 *
 * 管理者が開いたとき、持ち主が結ばれていなければ一度だけ尋ねる。**どれを選んでも管理画面は
 * 止めない。** 訊けないとき(圏外)は「未登録」と読まずに何も出さない。
 */
type ContactInfo = {
  state: "opted_out" | "unavailable" | "installer" | "linked" | "none";
  email?: string;
  linkedAt?: string;
  declined?: boolean;
  pending?: { email: string; expiresAt: string } | null;
};

let contactChecked = false;
/** ログイン中の人のメールアドレス。持ち主の登録の欄に初めから入れる(多くは管理者が持ち主)。 */
let sessionEmail = "";
async function checkContactOnce() {
  if (contactChecked || !state.isAdmin || state.preview) return;
  contactChecked = true;
  let info: ContactInfo;
  try {
    info = await api("/api/system/contact");
  } catch {
    return;
  }
  if (info.state !== "none" || info.declined) return;
  openContactDialog(info, { prompt: true });
}

function openContactDialog(
  info: ContactInfo,
  opts: { prompt: boolean; onClose?: () => void },
) {
  // 規約の同意と同じく、共有ダイアログに載せず自前で組む(全画面用の指定を拾って崩れるため)。
  const ov = document.createElement("div");
  ov.setAttribute("role", "dialog");
  ov.setAttribute("aria-modal", "true");
  ov.style.cssText =
    "position:fixed;inset:0;z-index:3000;background:rgba(8,12,22,.72);" +
    "display:flex;align-items:center;justify-content:center;padding:20px";
  const card = document.createElement("div");
  card.style.cssText =
    "width:min(520px,100%);background:var(--panel,#141f35);color:var(--ink,#e9eefc);" +
    "border:1px solid var(--line,#293b5d);border-radius:14px;padding:22px;" +
    "font-size:14px;line-height:1.8;box-shadow:0 18px 50px rgba(0,0,0,.5)";
  ov.appendChild(card);
  let polling: ReturnType<typeof setInterval> | null = null;
  const close = () => {
    if (polling) clearInterval(polling);
    ov.remove();
    opts.onClose?.();
  };
  const button = (label: string, primary: boolean) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.style.cssText =
      "border:0;border-radius:9px;padding:10px 16px;font:inherit;font-weight:700;cursor:pointer;" +
      (primary
        ? "background:var(--accent,#2f7d6b);color:#fff"
        : "background:transparent;color:var(--muted,#91a0c3);border:1px solid var(--line,#293b5d)");
    return b;
  };

  const h = document.createElement("h3");
  h.textContent = t("contactTitle");
  h.style.cssText = "margin:0 0 10px;font-size:18px";
  const lead = document.createElement("p");
  lead.textContent = t("contactLead");
  lead.style.cssText =
    "margin:0 0 12px;color:var(--muted,#91a0c3);font-size:13px";
  const input = document.createElement("input");
  input.type = "email";
  input.autocomplete = "email";
  input.placeholder = t("contactEmail");
  input.setAttribute("aria-label", t("contactEmail"));
  input.value = info.pending?.email ?? sessionEmail;
  input.style.cssText = "width:100%;box-sizing:border-box;margin:0 0 10px";
  const label = document.createElement("label");
  label.style.cssText =
    "display:flex;align-items:flex-start;gap:10px;cursor:pointer;margin:0 0 10px";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.style.cssText = "margin-top:5px;flex:0 0 auto;width:16px;height:16px";
  const boxText = document.createElement("span");
  boxText.textContent = t("contactConsent");
  label.appendChild(box);
  label.appendChild(boxText);
  const msg = document.createElement("div");
  msg.style.cssText =
    "color:var(--danger,#ff9aa5);font-size:12px;min-height:16px;margin-bottom:8px";
  const row = document.createElement("div");
  row.style.cssText =
    "display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap";

  const go = button(t("contactRegister"), true);
  // 了承とアドレスが揃うまで押せない。**押せない理由は見た目で分かるようにする。**
  const sync = () => {
    const ready = box.checked && input.value.trim().includes("@");
    go.disabled = !ready;
    go.style.opacity = ready ? "1" : ".45";
    go.style.cursor = ready ? "pointer" : "not-allowed";
  };
  box.addEventListener("change", sync);
  input.addEventListener("input", sync);
  sync();

  if (opts.prompt) {
    const decline = button(t("contactDecline"), false);
    decline.onclick = () => {
      close();
      void api("/api/system/contact/decline", {
        method: "POST",
        body: "{}",
      }).catch(() => {});
    };
    const later = button(t("contactLater"), false);
    later.onclick = close;
    row.appendChild(decline);
    row.appendChild(later);
  } else {
    const cancel = button(t("contactClose"), false);
    cancel.onclick = close;
    row.appendChild(cancel);
  }
  row.appendChild(go);

  const sent = (email: string) => {
    card.replaceChildren();
    const h2 = h.cloneNode(true);
    const p = document.createElement("p");
    p.textContent = t("contactSent").replace("{email}", email);
    p.style.cssText = "margin:0 0 14px";
    const r = document.createElement("div");
    r.style.cssText = "display:flex;justify-content:flex-end";
    const done = button(t("contactClose"), true);
    done.onclick = close;
    r.appendChild(done);
    card.append(h2, p, r);
    // 確認の頁で押されたら「確認済み」に変わる。開いているあいだだけ訊き直す(期限の30分まで)。
    const until = Date.now() + 30 * 60 * 1000;
    polling = setInterval(async () => {
      if (Date.now() > until || !ov.isConnected) {
        if (polling) clearInterval(polling);
        return;
      }
      try {
        const now = (await api("/api/system/contact")) as ContactInfo;
        if (now.state === "linked" && now.email === email) {
          if (polling) clearInterval(polling);
          p.textContent = t("contactDone");
          setTimeout(close, 1500);
        }
      } catch {
        /* 次の回にまた訊く */
      }
    }, 5000);
  };

  go.onclick = async () => {
    if (go.disabled) return;
    go.disabled = true;
    msg.textContent = "";
    const email = input.value.trim();
    try {
      await api("/api/system/contact", {
        method: "POST",
        body: JSON.stringify({ email, consent: true, lang: state.uiLang }),
      });
      sent(email.toLowerCase());
    } catch (e) {
      const code = (e as { code?: string }).code;
      msg.textContent =
        code === "invalid_email"
          ? t("contactInvalidEmail")
          : code === "rate_limited"
            ? t("contactRateLimited")
            : t("contactUnavailable");
      sync();
    }
  };

  card.append(h, lead, input, label, msg, row);
  document.body.appendChild(ov);
  input.focus();
}

/** 設定(基本)の連絡先の欄。アドレスは ID に訊いたものを出す(KuroCMS には写さない)。 */
async function renderContactPanel(el: HTMLElement | null) {
  if (!el) return;
  if (!state.isAdmin || state.preview) {
    el.remove();
    return;
  }
  let info: ContactInfo;
  try {
    info = await api("/api/system/contact");
  } catch {
    info = { state: "unavailable" };
  }
  const line =
    info.state === "linked"
      ? t("contactLinked")
          .replace("{email}", info.email ?? "")
          .replace("{date}", info.linkedAt ? formatDateTime(info.linkedAt) : "")
      : info.state === "installer"
        ? t("contactInstaller")
        : info.state === "opted_out"
          ? t("contactOptedOut")
          : info.state === "unavailable"
            ? t("contactUnavailable")
            : info.pending
              ? t("contactPending").replace("{email}", info.pending.email)
              : t("contactNone");
  el.innerHTML =
    "<div class='panelHead'><h3>" +
    escapeHtml(t("contactPanelTitle")) +
    "</h3></div>" +
    "<div class='muted' style='font-size:12px'>" +
    escapeHtml(t("contactPanelHelp")) +
    "</div>" +
    "<div style='display:flex;align-items:center;gap:8px;flex-wrap:wrap'>" +
    "<span style='flex:1;min-width:0;word-break:break-all'>" +
    escapeHtml(line) +
    "</span>" +
    (info.state === "linked" || info.state === "none"
      ? "<button type='button' class='secondary' id='contactEditBtn'>" +
        escapeHtml(
          info.state === "linked" ? t("contactChange") : t("contactRegister"),
        ) +
        "</button>"
      : "") +
    (info.state === "linked"
      ? "<button type='button' class='danger' id='contactRemoveBtn'>" +
        escapeHtml(t("contactRemove")) +
        "</button>"
      : "") +
    "</div>";
  const rerender = () => void renderContactPanel(el);
  el.querySelector("#contactEditBtn")?.addEventListener("click", () =>
    openContactDialog(info, { prompt: false, onClose: rerender }),
  );
  el.querySelector("#contactRemoveBtn")?.addEventListener(
    "click",
    async (event) => {
      if (!confirm(t("contactRemoveConfirm"))) return;
      try {
        await api("/api/system/contact/remove", { method: "POST", body: "{}" });
        rerender();
      } catch (err) {
        toast(errorMessage(err), true, event.currentTarget as HTMLElement);
      }
    },
  );
}

async function render() {
  try {
    if (state.preview) {
      enablePreviewMode();
    } else {
      // Check setup status
      const setupStatusResponse = await fetch(withBase("/api/setup/status"));
      if (setupStatusResponse.ok) {
        const setupStatus = await setupStatusResponse.json();
        if (setupStatus.moving) return movingScreen();
        if (setupStatus.needsSetup) {
          return setupScreen(setupStatus);
        }
      }

      // Check for invitation token in URL
      const urlParams = new URLSearchParams(location.search);
      const inviteToken = urlParams.get("invite");
      if (inviteToken) {
        return inviteScreen(inviteToken);
      }
      const recoverToken = urlParams.get("recover");
      if (recoverToken) {
        return recoverScreen(recoverToken);
      }

      // Check session
      try {
        const sessionData = await api("/api/auth/session");
        if (!sessionData.authenticated) {
          return loginScreen();
        }
        state.isAdmin = sessionData.isAdmin === true;
        sessionEmail =
          typeof sessionData.email === "string" ? sessionData.email : "";
        setAdminDocumentTitle(sessionData.displayName);
      } catch {
        return loginScreen();
      }
    }
    await loadTheme();
    setTimeout(checkStorageAlertOnce, 0);
    // サイトの時計がまだ空なら、このブラウザの TZ で埋める（初回のみ）。
    setTimeout(initSiteTimezoneOnce, 0);
    // 規約の再同意。**画面の描画は止めない** —— 同意が要るかどうかは
    // 外部への問い合わせで決まるので、待たせると管理画面が開かなくなる。
    setTimeout(checkLegalConsentOnce, 0);
    // お知らせ(Entamy Notice)。**描画は止めない**。緊急・重要の未読は規約の窓が済んでから出す。
    setTimeout(noticeGateOnce, 0);
    // 持ち主の連絡先(古い導入)。描画は止めない(外部への問い合わせで決まるため)。
    setTimeout(checkContactOnce, 0);
    // 無料期間が終わり契約の無い委託は、ログインのたびに契約を結ぶかを確かめる(課題 8396f3b7)。
    setTimeout(checkContractWindowOnce, 0);
    // Screens that expose a live list register a reloader (activeListReload);
    // clear it here so it only points at the screen currently on view.
    activeListReload = null;
    const path = routePath();
    if (path === "/initialize") return setupScreen({ needsSetup: true });
    if (path === "/articles") return articles();
    if (path === "/articles/new") return newArticle(null);
    if (path.startsWith("/articles/") && path.length > "/articles/".length)
      return newArticle(path.slice("/articles/".length));
    if (path === "/images") return images();
    if (path === "/videos") return videos();
    if (path === "/audios") return audios();
    if (path === "/categories") return categories();
    if (path === "/languages") return languages();
    if (path === "/types") return types();
    if (path === "/settings") return settings();
    if (path === "/users") return loadUsersPanel();
    if (path === "/backups") return backupScreen();
    if (path === "/profile") return profile();
    if (path === "/site") return siteManagement();
    if (path === "/help") return help();
    return dashboard();
  } catch (error) {
    try {
      await reportClientError("render", error);
    } catch {
      // Rendering the fallback must not depend on telemetry.
    }
    const errMsg = escapeHtml(errorMessage(error, "Render error"));
    try {
      shell("Error", "<div class='notice error'>" + errMsg + "</div>");
    } catch {
      if (app)
        app.innerHTML =
          "<div style='padding:40px 20px'><p style='color:red;font-weight:600'>KuroCMS: " +
          errorMessage(error, "Unknown error").replace(/[<>&]/g, "") +
          "</p></div>";
    }
  }
}

/**
 * 設定とプロフィールは、開いているタブにくわしいヘルプがあればそれを出す
 * (運用の形・メール送信・IP 制限は、画面全体の説明では足りないため)。
 */
function helpTopicFor(key: string): string {
  if (key !== "settings" && key !== "profile") return key;
  const tab =
    document.querySelector<HTMLElement>(".settingsTab.active")?.dataset.tab ||
    "";
  const byTab: Record<string, string> =
    key === "settings"
      ? { domain: "domain", hosting: "hosting", mail: "mail", ipgate: "ipGate" }
      : { network: "ipGate" };
  return byTab[tab] || key;
}

document.body.addEventListener("click", (event: Dynamic) => {
  const helpTrigger = event.target.closest("[data-help-key]");
  if (helpTrigger) {
    showHelpDialog(helpTopicFor(helpTrigger.dataset.helpKey));
    return;
  }
  const link = event.target.closest("a[href]");
  if (!link) return;
  if (!(link.getAttribute("href") || "").startsWith(adminHref(""))) return;
  event.preventDefault();
  history.pushState(null, "", link.href);
  render();
});
window.addEventListener("error", (event) => {
  reportClientError(
    "window.error",
    event.error || new Error(event.message || "window.error"),
    {
      filename: event.filename || "",
      lineno: event.lineno || 0,
      colno: event.colno || 0,
    },
  );
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  reportClientError(
    "window.unhandledrejection",
    reason instanceof Error
      ? reason
      : new Error(String(reason || "Unhandled rejection")),
  );
});
window.addEventListener("popstate", render);
render();

// ── Refresh a live list when the tab/window regains focus ──────────────────
// The article list is a snapshot taken when the screen mounts. If an article is
// created out-of-band while it's open — e.g. AI via the REST/MCP API — the list
// wouldn't reflect it until a manual reload or re-navigation. The list screen
// registers its reloader in activeListReload; re-fetch it whenever the operator
// returns to the tab (the natural moment after triggering an external create).
// Event-driven, not polled: nothing runs while the tab sits in the foreground.
let activeListReload: (() => void) | null = null;
let lastListRefreshAt = 0;
function refreshActiveListOnReturn() {
  if (!activeListReload) return;
  const nowMs = Date.now();
  // Collapse the focus + visibilitychange pair that fire together on tab switch.
  if (nowMs - lastListRefreshAt < 1500) return;
  lastListRefreshAt = nowMs;
  activeListReload();
}
document.addEventListener("visibilitychange", function () {
  if (document.visibilityState === "visible") refreshActiveListOnReturn();
});
window.addEventListener("focus", refreshActiveListOnReturn);

// ── Resizable sidebar ─────────────────────────────────────────────────────
// Drag the divider between the sidebar and the workspace to set its width.
// Persisted in localStorage; clamped to a sensible range; desktop only.
(function initSidebarResizer() {
  const KEY = "kurocms_sidebar_w";
  const MIN = 184;
  const MAX = 380;
  const root = document.documentElement;
  const applyWidth = (w: number): number => {
    const clamped = Math.max(MIN, Math.min(MAX, Math.round(w)));
    root.style.setProperty("--sidebar-w", clamped + "px");
    return clamped;
  };
  const saved = parseInt(localStorage.getItem(KEY) || "", 10);
  if (Number.isFinite(saved)) applyWidth(saved);
  const rez = document.getElementById("sidebarResizer");
  if (!rez) return;
  let dragging = false;
  rez.addEventListener("mousedown", (e: MouseEvent) => {
    dragging = true;
    rez.classList.add("dragging");
    document.body.classList.add("sidebarResizing");
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e: MouseEvent) => {
    if (dragging) applyWidth(e.clientX);
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    rez.classList.remove("dragging");
    document.body.classList.remove("sidebarResizing");
    const w = parseInt(
      getComputedStyle(root).getPropertyValue("--sidebar-w"),
      10,
    );
    if (Number.isFinite(w)) {
      try {
        localStorage.setItem(KEY, String(w));
      } catch {
        /* storage unavailable — width simply won't persist */
      }
    }
  });
})();

// ── Mobile nav scrollbar indicator ────────────────────────────────────────
function updateMobileNavBar(): void {
  const nav = byId("mobileNav") as HTMLElement | null;
  const bar = byId("mobileNavBar") as HTMLElement | null;
  const thumb = byId("mobileNavThumb") as HTMLElement | null;
  if (!nav || !bar || !thumb) return;
  // Track is managed by CSS (visible on ≤860px). On wider screens, hide via JS.
  if (window.innerWidth > 860) {
    bar.style.display = "none";
    return;
  }
  bar.style.removeProperty("display"); // let CSS control display
  const trackW = bar.clientWidth;
  if (trackW === 0) return; // not yet laid out
  const scrollable = nav.scrollWidth > nav.clientWidth + 1;
  if (!scrollable) {
    // All items visible: show full-width thumb to indicate no scroll needed
    thumb.style.width = "100%";
    thumb.style.transform = "translateX(0)";
    thumb.style.opacity = "0.35";
    return;
  }
  thumb.style.opacity = "1";
  const ratio = nav.clientWidth / nav.scrollWidth;
  const thumbW = Math.max(Math.round(trackW * ratio), 24);
  const maxScroll = nav.scrollWidth - nav.clientWidth;
  const thumbLeft =
    maxScroll > 0
      ? Math.round((nav.scrollLeft / maxScroll) * (trackW - thumbW))
      : 0;
  thumb.style.width = thumbW + "px";
  thumb.style.transform = "translateX(" + thumbLeft + "px)";
}
(function initMobileNavBar() {
  const nav = byId("mobileNav");
  if (!nav) return;
  nav.addEventListener("scroll", updateMobileNavBar, { passive: true });
  new MutationObserver(updateMobileNavBar).observe(nav, { childList: true });
  window.addEventListener("resize", updateMobileNavBar, { passive: true });
  // Retry until nav has content (render() is async)
  function tryUpdate() {
    updateMobileNavBar();
    if (!byId("mobileNav")?.children.length) requestAnimationFrame(tryUpdate);
  }
  requestAnimationFrame(tryUpdate);
})();
