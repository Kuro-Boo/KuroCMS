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
// Default brand logo = the KuroCMS brand favicon (kuro.boo). Resolved via
// the /favicon.svg route (302 to the site's configured favicon media).
// NOTE(2026-07): this URL 404'd for a while — root cause was the
// resolveFaviconPath() empty-language-row bug (fixed in v1.8.36), not this
// constant. The brand default is the maintainer's decision; do not swap it
// for placeholders or inlined variants.
const defaultAdminLogo = "https://kuro.boo/favicon.svg";
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
    restoreFailed: "Restore failed",
    restoreBadFile: "Not a valid KuroCMS backup file.",
    restoreConfirmTitle: "Replace all data?",
    restoreConfirmBody:
      "This deletes all current content, media and settings, then restores from the selected backup. This cannot be undone.",
    restoreConfirmYes: "Replace everything",
    restorePhaseWipe: "Clearing existing data…",
    inviteUser: "Invite User",
    settings: "Settings",
    profile: "Profile",
    help: "Help",
    firstRun: "First run",
    setupTitle: "Set up your KuroCMS workspace",
    setupLead:
      "Create the first administrator and accept the Kuro License. Authentication uses Cloudflare Access one-time passcodes (OTP).",
    administrator: "Administrator",
    ownerAccount:
      "Steps: 1) Enter the administrator email address 2) Click “Go to Cloudflare Authentication” 3) On the Cloudflare screen, enter the same email address and submit 4) Enter the 6-digit code sent to that email.",
    adminEmail: "Admin Email",
    adminPassword: "Admin Password",
    confirmPassword: "Confirm Password",
    otpCode: "One-Time Passcode",
    setupEmailLockedNotice:
      "This email is pre-registered by deployment setup and locked.",
    license: "License",
    licenseAccept:
      "I have read and accept the Kuro License, including the requirement to show",
    attributionArea: "in an appropriate attribution area.",
    completeSetup: "Complete Setup",
    issueOtp: "Go to Cloudflare Authentication",
    verifyOtpAndComplete: "Verify and Complete Setup",
    otpSent: "Please check your email and enter the 6-digit passcode.",
    otpCodeInvalid: "Please enter a valid 6-digit passcode.",
    otpFlowNotice:
      "After pressing the button, the screen moves to Cloudflare Access. Enter the same email address you entered here and submit. Then a 6-digit code is sent to that email address, and you can complete authentication on the switched screen.",
    nextTitle: "Setup Steps",
    nextLead: "Complete the following to get started:",
    nextAdmin: "Select the initial UI language.",
    nextPat: "Enter the administrator email and password.",
    nextLicense: "Read and accept the Kuro License.",
    nextStep4: "Click the completion button.",
    licenseRequired: "Kuro License acceptance is required.",
    passwordMismatch: "Passwords do not match.",
    setupDone: "Initial setup completed.",
    subtitle: "Cloudflare-first headless CMS",
    savePat: "Save PAT",
    patPlaceholder: "Personal Access Token",
    patSaved: "PAT saved.",
    apiFailed: "API request failed",
    cfLimitHint:
      "may be a Cloudflare limit (subrequests / CPU time / KV write quota)",
    documents: "Documents",
    loading: "Loading...",
    articleLoading: "Opening article…",
    api: "API",
    next: "Next",
    start: "Start",
    nextHint: "Create your first article or add categories and types.",
    healthy: "Healthy",
    unknown: "Unknown",
    setPat: "Set PAT to load documents.",
    noRecordsYet: "No records yet.",
    overview: "Overview",
    registeredDocuments: "Articles",
    publishedDocuments: "Published",
    dashboardLead:
      "A compact overview of the current site, publishing state, domains, and content structure.",
    contentStatus: "Content Status",
    mediaStatus: "Media Status",
    siteStatus: "Site Status",
    publicDomainLabel: "Public Domain",
    developmentDomainLabel: "Preview URL",
    defaultLangLabel: "Default Language",
    initialLangLabel: "Initial Authoring Language",
    publishedCount: "Published",
    draftCount: "Drafts",
    hiddenCount: "Hidden",
    recentDocuments: "Recent Documents",
    setupHealth: "Setup Health",
    backupStatus: "Backup Status",
    notConnected: "Not connected",
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
      "Configure domains, language defaults, theme colors, and license information.",
    profileLead:
      "Manage personal admin preferences, UI language, and Personal Access Token storage.",
    selectType: "Select type",
    create: "Create",
    created: "Created",
    noTypes: "No types registered",
    noLanguages: "No languages registered",
    profileIdentity: "Account Information",
    profileSecurity: "Security",
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
    account: "Account",
    uid: "User ID",
    email: "Email",
    roles: "Roles",
    personalSettings: "Personal Settings",
    interfaceLanguage: "Interface Language",
    saveProfile: "Save Profile",
    profileSaved: "Profile saved.",
    adminRole: "Admin",
    authorRole: "Author",
    displayName: "Username",
    userIdLabel: "User ID",
    changePassword: "Change Password",
    currentPassword: "Current Password",
    newPassword: "New Password",
    confirmNewPassword: "Confirm New Password",
    updateAccount: "Update Account",
    updatePassword: "Update Password",
    passwordUpdated: "Password updated.",
    darkMode: "Dark Mode",
    darkModeHelp: "Switch color mode for the entire admin UI.",
    patManager: "Personal Access Tokens",
    tokenName: "Token Name",
    generate: "Generate",
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
    notRegistered: "not registered",
    imageFileRequired: "The selected file is not an image.",
    imageDimensionsFailed: "Unable to determine image dimensions.",
    imageResizeUnsupported: "Image resize is not supported.",
    revokeToken: "Revoke Token",
    tokenRevoked: "Token revoked.",
    tokenHistory: "Token History",
    uploadImage: "Register Image",
    uploadVideo: "Register Video",
    uploadAudio: "Register Audio",
    filename: "Filename",
    mime: "MIME Type",
    extension: "Extension",
    sizeBytes: "Size Bytes",
    dimensions: "Dimensions",
    width: "Width",
    height: "Height",
    publicPath: "Public Path",
    noMedia: "No media records yet.",
    managementScreen: "Management Screen",
    previewReadOnly: "Preview mode: this screen is read-only.",
    searchPlaceholder: "Search title or slug",
    entriesPerPage: "Entries per page",
    search: "Search",
    noDocuments: "No documents yet.",
    untitled: "(untitled)",
    title: "Title",
    slug: "Slug",
    type: "Type",
    mode: "Mode",
    languages: "Languages",
    updated: "Updated",
    draft: "Draft",
    published: "Published",
    hidden: "Hidden",
    publishAt: "Publish At",
    summary: "Summary",
    bodyHtml: "Body HTML",
    editorView: "Editor View",
    sourceView: "Source View",
    createAndSave: "Create and Save",
    reloadTypes: "Reload Types",
    articleCreated: "Article created.",
    siteSettings: "Site Settings",
    settingsTabBasic: "Basic",
    settingsTabDesign: "Design",
    settingsTabSns: "SNS",
    settingsTabLicense: "License",
    settingsTabImport: "Import",
    blueskyHandle: "Bluesky Handle",
    blueskyHandleHelp: "Your Bluesky handle (e.g. yourname.bsky.social).",
    blueskyShowFeed: "Show Feed on Public Pages",
    blueskyShowFeedHelp: "Display Bluesky posts in the sidebar.",
    blueskyFeedPosition: "Feed Position",
    left: "Left",
    right: "Right",
    threadsHandle: "Threads Handle",
    threadsHandleHelp: "Your Threads username (e.g. @yourname).",
    threadsShowFeed: "Show Threads Feed",
    threadsShowFeedHelp: "Display Threads posts on public pages (future).",
    threadsApiNote:
      "Threads API requires Meta review. Will be enabled once access is granted.",
    licenseAttributionPhrase: "Attribution Phrase",
    licenseText: "License Text",
    acceptedAt: "Accepted At",
    siteName: "Site Name",
    siteNameHelp:
      "Internal site name shown in admin and metadata. Use [[site.name]] in templates.",
    adminUrlLabel: "KuroCMS Admin URL",
    adminUrlDerivedFromBootstrap:
      "Determined by the domain setting in env.bootstrap.",
    publicDomain: "Public Domain",
    publicDomainHelp:
      "Public base URL of this site. Register a domain with Cloudflare to use a custom domain. Otherwise, your workers.dev URL works out of the box (e.g. https://yoursite.workers.dev/).",
    developmentDomain: "Preview URL",
    developmentDomainHelp: "Internal preview path under the public URL.",
    workerOriginUrl: "Worker Origin URL (workers.dev)",
    workerOriginHelp:
      "Your KuroCMS worker's direct URL on workers.dev (the default public URL when no custom domain is set).",
    customDomainTitle: "Custom Domain (Cloudflare)",
    currentCustomDomains: "Configured custom domains",
    noCustomDomains: "No custom domain configured yet.",
    customDomainHelp:
      "Enter a domain in a Cloudflare zone you own. Cloudflare automatically creates the DNS record and SSL certificate — no manual CNAME needed. Requires the worker token to have DNS edit permission (granted on a fresh install/re-bootstrap).",
    customDomainPermNote:
      "If this failed with a permission error, the worker token lacks DNS edit access. Re-bootstrap KuroCMS to regenerate the token, or add the domain from the Cloudflare dashboard.",
    setCustomDomain: "Set custom domain",
    customDomainAdded:
      "Custom domain attached. DNS and SSL are being provisioned by Cloudflare (a few minutes). Then set it as the Public Domain above.",
    r2SetupTitle: "R2 media storage",
    r2SetupHelp:
      "R2 is optional. After approving R2 access in the Cloudflare dashboard, press the button below to create an R2 bucket and connect it to KuroCMS.",
    r2SetupDashboard: "Open R2 in Cloudflare",
    r2SetupButton: "Start using R2",
    r2SetupReady: "R2 media storage is enabled.",
    r2SetupWorking: "Creating and connecting the R2 bucket...",
    r2SetupDone: "R2 is ready. Reloading KuroCMS...",
    cfManualSteps:
      "Add it from the Cloudflare dashboard: Workers & Pages → your KuroCMS Worker → Settings → Domains & Routes → Add → Custom Domain → enter the domain. Cloudflare creates the DNS record and SSL automatically. After a few minutes, set it as the Public Domain above and save.",
    checkDns: "Verify DNS",
    dnsOk: "DNS is resolving correctly.",
    dnsFail: "DNS not yet propagated. Please wait a few minutes and try again.",
    defaultLanguage: "Default Language",
    defaultLanguageHelp:
      "Select the fallback language used when a translation is missing for a visitor.",
    initialAuthoringLanguage: "Initial Authoring Language",
    initialAuthoringLanguageHelp:
      "The initially selected language when creating a new article.",
    enabledLanguages: "Enabled Languages",
    enabledLanguagesHelp:
      "Choose the languages available for multilingual content.",
    theme: "Theme",
    accentColor: "Accent color",
    accentHelp: "Buttons, mark, and important actions.",
    sidebarColor: "Sidebar color",
    sidebarHelp: "The main navigation background.",
    mainPaneColor: "Main pane color",
    mainPaneHelp: "Workspace background and selected sidebar item.",
    saveSiteSettings: "Save Site Settings",
    maintenanceTitle: "Maintenance",
    cleanupStylesHelp:
      "Removes style noise that Chrome's rich copy baked into article bodies pasted with an older editor (huge revert-layer property dumps and hard-coded theme colors), and normalizes plain external links into the KuroEditor link notation ([[url|text]]). Only style attributes carrying the copy-noise signature are touched; decorations you applied on purpose stay, and links that the notation cannot represent (non-http, formatted content inside the link, etc.) are left as-is. The previous body of every changed article is saved to revision history. Run a build afterwards to regenerate the cleaned pages.",
    cleanupStylesButton: "Clean up copied-style noise & normalize links",
    cleanupStylesProgress: "Cleaning… changed so far:",
    cleanupStylesDone:
      "Done: cleaned {n} translation(s) (scan matched {s}). Run a build to publish the cleaned pages.",
    cleanupStylesNothing: "No copy-noise styles found. Nothing to clean.",
    cleanupStylesToast: "Style cleanup finished",
    siteSettingsSaved: "Site settings saved.",
    workerSecrets: "Workers Secret Registration",
    workerSecretsLead:
      "Register Cloudflare operation values used by KuroCMS automation. The API token itself is not persisted in D1.",
    cfAccountId: "Cloudflare Account ID",
    cfZoneId: "Cloudflare Zone ID",
    opsWorkerName: "Ops Worker Name",
    accessAudience: "Access Audience (aud)",
    cfApiToken: "Cloudflare API Token",
    cfApiTokenHelp:
      "Enter a token with minimum scope for deploy/build operations. Apply as Workers Secret in production.",
    registerWorkerSecret: "Register Workers Secret",
    workerSecretsSaved: "Workers secret registration saved.",
    apiTokenMasked: "Registered Token",
    name: "Name",
    requiredAttribution: "Required Attribution",
    acceptedBy: "Accepted By",
    newType: "New Type",
    id: "ID",
    createType: "Create Type",
    newCategory: "New Category",
    createCategory: "Create Category",
    typeCreated: "Type created.",
    categoryCreated: "Category created.",
    error: "Error",
    chooseCategory: "Choose Category",
    atLeastOneLanguage: "Select at least one enabled language.",
    availableLanguages: "Available Languages",
    searchLanguagePlaceholder: "Type to search (e.g. burmese, my)...",
    noMatches: "No matches",
    selectedLanguages: "Registered Languages",
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
    lostDevice: "Lost your device?",
    recoverRequestLead:
      "Enter your registered email. We'll send a link to register a new passkey.",
    recoverSendLink: "Send recovery link",
    recoverSent:
      "If that email is registered, a recovery link has been sent. Please check your inbox.",
    recoverTitle: "Recover access",
    recoverLead: "Register a new passkey for this account.",
    logout: "Logout",
    adminLogo: "Admin Logo URL",
    adminLogoHelp: "Direct link to your logo image or SVG data.",
    version: "Version",
    latestVersion: "Latest",
    nodeVersion: "Worker Runtime",
    edition: "Edition",
    communityEdition: "Community Edition",
    editorEngine: "Editor Engine",
    bundledVersion: "Bundled",
    details: "Details",
    customization: "Customization",
    actions: "Actions",
    edit: "Edit",
    delete: "Delete",
    update: "Update",
    save: "Save",
    updateDone: "Updated.",
    deleteDone: "Deleted.",
    confirmDeleteType: "Delete this type?",
    confirmDeleteCategory: "Delete this category?",
    editNamePrompt: "Name",
    editSlugPrompt: "Slug",
    addRegister: "Add Entry",
    registeredImagesList: "Registered Images",
    registeredVideosList: "Registered Videos",
    registeredAudiosList: "Registered Audio",
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
    buildCancel: "Cancel",
    buildCancelled: "Build cancelled",
    buildErrorPrefix: "Build error: ",
    unknownError: "Unknown error",
    mediaLabel: "Media",
    installedVersionLabel: "Installed Version",
    stableVersionLabel: "Stable Version",
    latestVersionLabel: "Latest Version",
    updateChannelLabel: "Always update to latest",
    updateChannelHint:
      "ON: update button targets the latest release (every release). OFF: targets the stable release only (promoted by the maintainer).",
    checking: "Checking…",
    updateNow: "Update Now",
    checkForUpdate: "Check for Update",
    alreadyLatest: "You're on the latest version.",
    updating: "Updating…",
    updateSuccessReload: "Updated. Please reload.",
    updateConfirm: "Update KuroCMS to the latest version?",
    storageFreeUsage: "CF Free Tier Usage",
    freeLimitLabel: "Free limit: ",
    r2Unavailable: "R2 not subscribed",
    r2Media: "R2 Media",
    d1Database: "D1 Database",
    kvPages: "KV Pages",
    kvWritesToday: "KV Writes (today)",
    kvReadsLabel: "Reads",
    kvResetLabel: "Resets",
    kvOpsUnavailable: "No data",
    articleCountTitle: "Articles",
    collectionArticleCount: "Collection Total",
    sortOrder: "Sort",
    sortUpdatedDesc: "Updated: Newest",
    sortUpdatedAsc: "Updated: Oldest",
    sortPublishDesc: "Published: Newest",
    sortPublishAsc: "Published: Oldest",
    sortTitleAsc: "Title A→Z",
    categoryFilter: "Category",
    allCategories: "All",
    buildSite: "Build Site",
    buildModeLabel: "Build",
    buildModeManual: "Manual build only",
    buildModeAuto: "Auto-build scheduled posts at their time",
    buildModeAlways: "Build future posts unconditionally",
    buildModeForceAll: "Force full rebuild (all pages)",
    siteBuildBarHint: "Publish article, template, and content changes.",
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
    snsPostBtn: "Post",
    snsPostingBtn: "Posting…",
    snsPostConfirm:
      "Post this article to Bluesky now (title, link, cover image)?",
    snsPostDone: "Posted to {service}.",
    snsMarkOnlyBtn: "Mark done without posting",
    snsMarkOnlyHelp:
      "Sets the posted flag without actually posting — for articles already announced on this SNS (e.g. after re-creating an article).",
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
    fontMoveUp: "Move up",
    fontMoveDown: "Move down",
    fontBaseMark: "Base font",
    fontBaseNone: "Template default",
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
    communityPublishedBtn: "● Published to Community",
    communityUnpublishedBtn: "○ Publish to Community",
    communityUpdateBtn: "↻ Update Community Template",
    tmplRenameBtn: "Rename",
    tmplRenamePrompt: "New template name:",
    tmplRenamed: "Template renamed.",
    communityEditHint: "Edit and save HTML in the Edit tab to enable.",
    communityNameConflictHint:
      "A community template with the same name already exists, so it cannot be published.",
    communityUpdateConfirm: "Update this template in the community library?",
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
    newTemplateNamePrompt: "Enter a new name for this template.",
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
    bodyConflictConfirm:
      "The body of this article was updated by another client (e.g. an AI) after you opened it.\n\nOK: overwrite with your version (the other version is kept in revision history)\nCancel: don't save now (reopen the article to load the latest version)",
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
    changeToDraft: "Change to Draft",
    changeToDraftEditable: "Switch to Draft (editable)",
    changeToPublished: "Switch to Published",
    editLockedHint:
      "To edit, switch to draft mode using the button at the top right.",
    articleTypeLabel: "Article Type",
    statusFieldLabel: "Status",
    categoryLabel: "Category",
    categoryAddBtn: "Add Category",
    publishTimeLabel: "Publish Time",
    hashtagLabel: "Hashtag",
    coverImageLabel: "Cover Image",
    notSelected: "Not selected",
    selectCoverBtn: "Load from File",
    clearCoverBtn: "Clear",
    coverDropHint: "Drop here or load from file",
    coverMidHint:
      "Specify a cover by image id, e.g. [[img-xxx]]. Loads when you leave the field.",
    coverMidNotFound: "No image found for that id.",
    r2CoverUnavail: "R2 is not available. Media files cannot be used.",
    slugReadonly: "Slug cannot be changed after creation.",
    slugLabelNote: "read-only, click to copy",
    slugCopyHint: "Click to copy",
    slugHint:
      "Letters, numbers, hyphens, underscores only. Cannot be changed after creation.",
    articleTitlePlaceholder: "Enter article title",
    summaryPlaceholder: "Summary (up to 200 chars · used for SNS)",
    bodyLabel: "Body",
    selectTypeEmpty: "Select type…",
    langLoadFailed: "Failed to load languages",
    typeLoadFailed: "Failed to load types",
    unregisteredSuffix: "(unregistered)",
    catLoadFailed: "Failed to load categories: ",
    dropZoneLead: "Drop files here or click to select",
    r2EnableTitle: "Please enable R2 on Cloudflare.",
    r2EnableDesc:
      "R2 is required for image, video, and audio uploads. Free tier: up to 10 GB (no charge).",
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
    unsupportedUrl:
      "Unsupported URL. Enter a YouTube, SoundCloud, or Spotify URL.",
    helpRoleLabel: "Description",
    helpCanDoLabel: "What you can do",
    helpNotesLabel: "Notes",
    publishDateLabel: "Publish Date",
    imageTypeLabel: "Images",
    videoTypeLabel: "Videos",
    audioTypeLabel: "Music",
    r2MediaUnavailMsg: "R2 not subscribed<br>media unavailable",
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
    tmplDetailClose: "Close",
    tmplDeleteConfirm: "Delete this template?",
    tmplNoTemplateSelected: "No template selected",
    tmplEditorNotSelected: "No template selected",
    tmplCurrentTemplate: "Active template: ",
    contentEditorTitle: "Site Text",
    contentEditorHint:
      "Register content for each key referenced by the template (e.g. top-hero-title). Missing keys will render as blank.",
    contentAddBtn: "＋ Key Register",
    contentBaseLang: "Base",
    contentLangLabel: "Language",
    contentAddKeyNote: "※ This key will be added to all languages.",
    contentDeleteAllLangsNote: "※ This key will be deleted from all languages.",
    communityDeleteFailed: "Failed to remove from community",
    communityPublishFailed: "Failed to publish to community",
    tmplEmptyState:
      "No templates. Please select one from the Template Selection tab.",
    tmplSaved: "Saved",
    tmplSavedAndPreview: "Saved / Preview also updated",
    tmplNameRequired: "Please enter a template name",
    tmplDetailInfo: "Details",
    noneRegistered: "Nothing registered yet.",
    noImages: "No images registered.",
    noCategories: "No categories registered.",
    noUsers: "No users registered.",
    backToArticles: "Back to article list",
    selectCoverImageTitle: "Select Cover Image",
    allCategoriesSelected: "All categories are already selected.",
    addCategoryTitle: "Add Category",
    add: "Add",
    selectCategoryMsg: "Please select a category.",
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
    contentInsertImgBtn: "Insert Image",
    mediaTableMid: "MID",
    mediaTablePreview: "",
    mediaTableFile: "Filename",
    mediaTableSize: "Size",
    copyMidTooltip: "Click to copy [[{mid}]]",
    copyBtn: "Copy",
    genEmbedBtn: "Generate Code",
    embedCodeLabel: "Embed Code (paste in article body)",
    embedWarning:
      "Large files consume the free tier (R2: 10GB) quickly. Use YouTube or similar link-based methods instead.",
    embedSectionTitle: "Generate External Video/Audio Embed Code",
    embedSectionDesc:
      "Enter a YouTube, SoundCloud, or Spotify URL to generate an &lt;iframe&gt; code for your article.",
    mediaInfoNonePre: "No ",
    mediaInfoNoneSuf: " files registered.",
    mediaInfoCountPre: "Current ",
    mediaInfoCountMid1: ": ",
    mediaInfoCountMid2: " file(s), ",
    mediaInfoCountEnd: " in R2.",
    helpBasic: "Basics",
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
    snsInstanceUrl: "Instance URL",
    snsApiComingSoon: "* API integration is planned for a future update.",
    snsDeleteMsgPre: "Delete ",
    snsDeleteMsgSuf: " integration settings?",
    helpPageLead: "Guide to the features, usage, and notes for each screen.",
    siteManagementLead:
      "Manage templates and static content for the public site.",
    previewFetchFailed: "Preview fetch failed: ",
    contentKeyRequired: "Please enter a key.",
    contentValueRequired: "Please enter content.",
    articleNotFound: "Article not found.",
    articleLoadFailed: "Failed to load article: ",
    changeToDraftConfirm: "Change status to Draft?",
    addFile: "+ Add File",
    purgeDataSuffix: " items will be permanently deleted",
    refetchError: "Re-fetch error: ",
    strapiSettingsSaved: "Strapi connection settings saved.",
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
    importError: "Import error: ",
    previewFetchError: "Preview fetch error: ",
    kurocmsLastUpdated: "KuroCMS last updated: ",
    strapiConflictWarning:
      "Import All overwrites every article with the Strapi version. The following were edited in KuroCMS after import — uncheck any you want to keep (protect from overwrite).",
    strapiConflictNoCheck: "Unchecked = keep KuroCMS version (not overwritten)",
    importAllConflictTitle: "Import All — Conflict Check",
    runImport: "Run Import",
    strapiImportAllConfirmMsg:
      "Import all Strapi articles. Already imported ones will be skipped.",
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
    importProgressPage: "Page",
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
    firstRun: "初回起動",
    setupTitle: "KuroCMS ワークスペースを設定",
    setupLead:
      "最初の管理者を作成し、Kuro License に同意します。認証には Cloudflare Access のワンタイムパスワード（OTP）を利用します。",
    administrator: "管理者",
    ownerAccount:
      "手順: 1) 管理者メールアドレスを入力 2)「Cloudflare認証画面に移動」を押す 3) Cloudflare の画面で同じメールアドレスを入力して送信 4) メールに届いた6桁コードを入力します。",
    adminEmail: "管理者メール",
    adminPassword: "管理者パスワード",
    confirmPassword: "パスワード確認",
    otpCode: "ワンタイムパスワード",
    setupEmailLockedNotice:
      "このメールアドレスは初期導入で事前登録済みのため、変更できません。",
    license: "ライセンス",
    licenseAccept: "Kuro License を読み、次の表示要件に同意します:",
    attributionArea: "適切な表示領域に表示します。",
    completeSetup: "初期設定を完了",
    issueOtp: "Cloudflare認証画面に移動",
    verifyOtpAndComplete: "ワンタイムパスワードを確認して初期設定を完了",
    otpSent:
      "Cloudflare から送付されたメールを確認し、6桁コードを入力してください。",
    otpCodeInvalid: "6桁のワンタイムパスワードを入力してください。",
    otpFlowNotice:
      "ボタンを押すと画面は Cloudflare Access に切り替わりますので、ここで入力したメールアドレスを設定して送信ボタンを押します、その後、登録したメールアドレスに6桁コードが届くので切り替わった画面で認証してください。",
    nextTitle: "設定の手順",
    nextLead: "以下の手順で初期設定を行います:",
    nextAdmin: "初期言語の選択を行います。",
    nextPat: "管理者のIDとしてのメールアドレスとパスワードを入力します。",
    nextLicense: "ライセンスをお読み頂き承認を行います。",
    nextStep4: "完了ボタンを押します。",
    licenseRequired: "Kuro License への同意が必要です。",
    passwordMismatch: "パスワードが一致しません。",
    setupDone: "初期設定が完了しました。",
    subtitle: "Cloudflare優先のヘッドレスCMS",
    savePat: "PATを保存",
    patPlaceholder: "Personal Access Token",
    patSaved: "PATを保存しました。",
    apiFailed: "APIリクエストに失敗しました",
    cfLimitHint:
      "Cloudflare の制限の可能性（サブリクエスト / CPU 時間 / KV 書き込み上限など）",
    documents: "登録記事",
    loading: "読み込み中...",
    articleLoading: "記事を読み込んでいます…",
    api: "API",
    next: "次の操作",
    start: "開始",
    nextHint: "最初の記事を作成するか、カテゴリとタイプを追加します。",
    healthy: "正常",
    unknown: "不明",
    setPat: "記事を読み込むにはPATを設定してください。",
    noRecordsYet: "まだ登録がありません。",
    overview: "概要",
    registeredDocuments: "記事数",
    publishedDocuments: "公開中",
    dashboardLead:
      "現在のサイト、公開状態、ドメイン、コンテンツ構造を一覧する画面です。",
    contentStatus: "コンテンツ状態",
    mediaStatus: "メディア状態",
    siteStatus: "サイト状態",
    publicDomainLabel: "公開ドメイン",
    developmentDomainLabel: "プレビューURL",
    defaultLangLabel: "基本言語",
    initialLangLabel: "初期作成言語",
    publishedCount: "公開済記事",
    draftCount: "下書き",
    hiddenCount: "非公開",
    recentDocuments: "最近の記事",
    setupHealth: "セットアップ状態",
    backupStatus: "バックアップ状態",
    notConnected: "未接続",
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
      "ドメイン、言語初期値、テーマカラー、ライセンス情報を設定します。",
    profileLead:
      "管理画面の個人設定、表示言語、Personal Access Token のブラウザ保存を管理します。",
    selectType: "タイプを選択",
    create: "作成",
    created: "作成しました",
    noTypes: "タイプが登録されていません",
    noLanguages: "言語が登録されていません",
    profileIdentity: "アカウント情報",
    profileSecurity: "セキュリティ",
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
    account: "アカウント",
    uid: "ユーザーID",
    email: "メール",
    roles: "権限",
    personalSettings: "個人設定",
    interfaceLanguage: "管理画面の言語",
    saveProfile: "プロフィールを保存",
    profileSaved: "プロフィールを保存しました。",
    adminRole: "管理者",
    authorRole: "投稿者",
    displayName: "ユーザー名",
    userIdLabel: "ユーザID",
    changePassword: "パスワード変更",
    currentPassword: "現在のパスワード",
    newPassword: "新しいパスワード",
    confirmNewPassword: "新しいパスワード確認",
    updateAccount: "アカウント更新",
    updatePassword: "パスワード更新",
    passwordUpdated: "パスワードを更新しました。",
    darkMode: "ダークモード",
    darkModeHelp: "管理画面全体のカラーモードを切り替えます。",
    patManager: "Personal Access Token",
    tokenName: "トークン名",
    generate: "生成",
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
    notRegistered: "未登録",
    imageFileRequired: "選択されたファイルは画像ではありません。",
    imageDimensionsFailed: "画像サイズを取得できませんでした。",
    imageResizeUnsupported: "画像の縮小処理はサポートされていません。",
    revokeToken: "トークン取り消し",
    tokenRevoked: "トークンを取り消しました。",
    tokenHistory: "トークン履歴",
    uploadImage: "画像を登録",
    uploadVideo: "動画を登録",
    uploadAudio: "音楽を登録",
    filename: "ファイル名",
    mime: "MIMEタイプ",
    extension: "拡張子",
    sizeBytes: "サイズ bytes",
    dimensions: "サイズ",
    width: "幅",
    height: "高さ",
    publicPath: "公開パス",
    noMedia: "メディアはまだありません。",
    managementScreen: "管理画面",
    previewReadOnly: "プレビューモードのため、この画面は読み取り専用です。",
    searchPlaceholder: "タイトルまたはスラッグを検索",
    entriesPerPage: "件 / ページ",
    search: "検索",
    noDocuments: "記事はまだありません。",
    untitled: "（無題）",
    title: "タイトル",
    slug: "スラッグ",
    type: "タイプ",
    mode: "状態",
    languages: "言語",
    updated: "更新日",
    draft: "下書き",
    published: "公開",
    hidden: "非表示",
    publishAt: "公開日",
    summary: "概要",
    bodyHtml: "本文HTML",
    editorView: "編集画面",
    sourceView: "ソース表示",
    createAndSave: "作成して保存",
    reloadTypes: "タイプ再読み込み",
    articleCreated: "記事を作成しました。",
    userManager: "ユーザー管理",
    backup: "バックアップ",
    backupTabBackup: "バックアップ",
    backupTabRestore: "レストア",
    backupDesc:
      "KuroCMS のすべてのコンテンツと設定（記事・翻訳・カテゴリ・タクソノミー・メディア管理情報・テンプレート・サイト設定・SNS 連携）を、画像／動画／音楽の実ファイルとともに 1 つの ZIP に保存します。ログインアカウントと認証情報（ユーザー・パスキー・個人アクセストークン）は含まれません。なお SNS 連携のトークンは含まれるため、バックアップファイルは厳重に保管してください。選択したファイルへ直接ストリーミング保存するため、大規模サイトでもメモリ不足になりません。",
    backupStart: "バックアップ…",
    backupDone: "バックアップが完了しました。",
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
    restoreFailed: "復元に失敗しました",
    restoreBadFile: "有効な KuroCMS バックアップファイルではありません。",
    restoreConfirmTitle: "すべてのデータを置き換えますか？",
    restoreConfirmBody:
      "現在のコンテンツ・メディア・設定をすべて削除し、選択したバックアップから復元します。この操作は取り消せません。",
    restoreConfirmYes: "すべて置き換える",
    restorePhaseWipe: "既存データを削除中…",
    inviteUser: "ユーザーを招待",
    siteSettings: "サイト設定",
    settingsTabBasic: "基本",
    settingsTabDesign: "デザイン",
    settingsTabSns: "SNS連動",
    settingsTabLicense: "ライセンス表示",
    settingsTabImport: "インポート",
    blueskyHandle: "Blueskyハンドル",
    blueskyHandleHelp:
      "Blueskyのハンドル名（例: yourname.bsky.social）。空白で非表示。",
    blueskyShowFeed: "公開ページにフィードを表示",
    blueskyShowFeedHelp: "公開ページのサイドバーにBlueskyの投稿を表示します。",
    blueskyFeedPosition: "フィード表示位置",
    left: "左",
    right: "右",
    threadsHandle: "Threadsハンドル",
    threadsHandleHelp: "Threadsのユーザー名（例: @yourname）。",
    threadsShowFeed: "Threadsフィード表示",
    threadsShowFeedHelp: "公開ページにThreadsの投稿を表示します（将来対応）。",
    threadsApiNote:
      "Threads API は Meta の審査制です。アクセス許可後に有効になります。",
    licenseAttributionPhrase: "帰属フレーズ",
    licenseText: "ライセンス文",
    acceptedAt: "同意日時",
    siteName: "サイト名",
    siteNameHelp:
      "管理画面やメタ情報で表示されるサイト名です。テンプレートでは [[site.name]] で表示できます。",
    adminUrlLabel: "KuroCMS管理画面URL",
    adminUrlDerivedFromBootstrap:
      "env.bootstrapのドメイン設定によって決定されます。",
    publicDomain: "公開ドメイン",
    publicDomainHelp:
      "サイトの公開 URL です。Cloudflare でドメインを契約すると独自ドメインを設定できます。未設定の場合は workers.dev の URL をそのまま使用できます（例: https://yoursite.workers.dev/）。",
    developmentDomain: "プレビューURL",
    developmentDomainHelp: "公開URL配下の内部プレビューパスです。",
    workerOriginUrl: "Worker オリジン URL（workers.dev）",
    workerOriginHelp:
      "KuroCMS Worker の workers.dev 直接 URL です（カスタムドメイン未設定時の既定の公開 URL）。",
    customDomainTitle: "カスタムドメイン（Cloudflare）",
    currentCustomDomains: "設定済みカスタムドメイン",
    noCustomDomains: "カスタムドメインは未設定です。",
    customDomainHelp:
      "ご自身の Cloudflare アカウントで管理しているドメインを入力してください。Cloudflare が DNS レコードと SSL 証明書を自動作成します（CNAME の手動追加は不要）。設定には worker トークンに DNS 編集権限が必要です（新規インストール／再ブートストラップ時に付与）。",
    customDomainPermNote:
      "権限エラーで失敗した場合、worker トークンに DNS 編集権限がありません。再ブートストラップでトークンを再生成するか、Cloudflare ダッシュボードからドメインを追加してください。",
    setCustomDomain: "カスタムドメインを設定",
    customDomainAdded:
      "カスタムドメインを割り当てました。Cloudflare が DNS と SSL を自動構成中です（数分）。完了後、上の「公開ドメイン」に設定して保存してください。",
    r2SetupTitle: "R2 メディアストレージ",
    r2SetupHelp:
      "R2 の利用は任意です。Cloudflare ダッシュボードで R2 の利用を承認した後、下のボタンを押すと R2 バケットを作成して KuroCMS に接続します。",
    r2SetupDashboard: "Cloudflare で R2 を確認",
    r2SetupButton: "R2 利用開始",
    r2SetupReady: "R2 メディアストレージは利用可能です。",
    r2SetupWorking: "R2 バケットを作成して接続しています...",
    r2SetupDone: "R2 の準備が完了しました。KuroCMS を再読み込みします...",
    cfManualSteps:
      "Cloudflare ダッシュボードから追加します：Workers & Pages → お使いの KuroCMS Worker → 設定 → ドメインとルート → 追加 → カスタムドメイン → ドメインを入力。DNS と SSL は Cloudflare が自動作成します。数分後、上の「公開ドメイン」に設定して保存してください。",
    checkDns: "DNS を確認",
    dnsOk: "DNS が正しく解決されています。",
    dnsFail: "DNS がまだ伝播していません。数分後に再試行してください。",
    defaultLanguage: "基本言語",
    defaultLanguageHelp:
      "ユーザーが記事を見た時に、翻訳がない記事の場合に利用するフォールバック言語を選択します。",
    initialAuthoringLanguage: "初期作成言語",
    initialAuthoringLanguageHelp: "記事を作成するときの初期選択言語です。",
    enabledLanguages: "有効言語",
    enabledLanguagesHelp:
      "多言語コンテンツとカテゴリ名で利用する言語を選択します。",
    theme: "テーマ",
    accentColor: "アクセントカラー",
    accentHelp: "ボタン、マーク、重要な操作。",
    sidebarColor: "サイドバー色",
    sidebarHelp: "メインナビゲーションの背景。",
    mainPaneColor: "メインペイン色",
    mainPaneHelp: "作業領域と選択中メニューの背景。",
    saveSiteSettings: "サイト設定を保存",
    maintenanceTitle: "メンテナンス",
    cleanupStylesHelp:
      "旧バージョンのエディタで貼り付けた本文に Chrome のリッチコピーが焼き込んだスタイルノイズ（revert-layer の大量羅列やテーマ色の固定値）を除去し、あわせてプレーンな外部リンクを KuroEditor のリンク記法（[[url|表示テキスト]]）に正規化します。コピー由来の署名がある style 属性だけが対象で、意図的に付けた装飾には触れません。記法で表現できないリンク（http以外・装飾入りリンク等）はそのまま維持されます。変更された記事の元本文はリビジョン履歴に保存されます。実行後はビルドを実行して掃除後のページを再生成してください。",
    cleanupStylesButton: "スタイルノイズ掃除＆リンク記法の正規化",
    cleanupStylesProgress: "掃除中… ここまでの変更:",
    cleanupStylesDone:
      "完了: {n} 件の翻訳を掃除しました（対象候補 {s} 件）。ビルドを実行すると掃除後のページが公開されます。",
    cleanupStylesNothing: "コピー由来のスタイルノイズは見つかりませんでした。",
    cleanupStylesToast: "スタイル掃除が完了しました",
    siteSettingsSaved: "サイト設定を保存しました。",
    workerSecrets: "Workers Secret登録",
    workerSecretsLead:
      "KuroCMS 自動化で使うCloudflare運用値を登録します。APIトークンの生値はD1には保存しません。",
    cfAccountId: "Cloudflare Account ID",
    cfZoneId: "Cloudflare Zone ID",
    opsWorkerName: "Ops Worker名",
    accessAudience: "Access Audience (aud)",
    cfApiToken: "Cloudflare API Token",
    cfApiTokenHelp:
      "デプロイ/ビルド実行に必要な最小権限トークンを入力します。本番ではWorkers Secretとして反映してください。",
    registerWorkerSecret: "Workers Secretを登録",
    workerSecretsSaved: "Workers Secret登録を保存しました。",
    apiTokenMasked: "登録済みトークン",
    name: "名前",
    requiredAttribution: "必須表示",
    acceptedBy: "承認者",
    newType: "新規タイプ",
    id: "ID",
    createType: "タイプ作成",
    newCategory: "新規カテゴリ",
    createCategory: "カテゴリ作成",
    typeCreated: "タイプを作成しました。",
    categoryCreated: "カテゴリを作成しました。",
    error: "エラー",
    chooseCategory: "カテゴリを選択",
    atLeastOneLanguage: "有効言語を1つ以上選択してください。",
    availableLanguages: "利用可能な言語",
    searchLanguagePlaceholder: "入力して検索（例: ビルマ, my）...",
    noMatches: "該当する言語がありません",
    selectedLanguages: "登録済み言語",
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
    lostDevice: "デバイスを紛失した場合",
    recoverRequestLead:
      "登録済みのメールアドレスを入力してください。新しいパスキーを登録するためのリンクを送信します。",
    recoverSendLink: "再設定リンクを送信",
    recoverSent:
      "登録があれば、再設定リンクを送信しました。メールをご確認ください。",
    recoverTitle: "アクセスを復旧",
    recoverLead: "このアカウントに新しいパスキーを登録します。",
    logout: "ログアウト",
    adminLogo: "管理画面ロゴURL",
    adminLogoHelp:
      "ロゴ画像への直接リンク、またはSVGデータを入力してください。",
    version: "バージョン",
    latestVersion: "最新",
    nodeVersion: "Worker実行環境",
    edition: "エディション",
    communityEdition: "コミュニティ版",
    editorEngine: "エディター",
    bundledVersion: "同梱版",
    details: "詳細情報",
    customization: "カスタマイズ",
    actions: "操作",
    edit: "修正",
    delete: "削除",
    update: "更新",
    save: "保存",
    updateDone: "更新しました。",
    deleteDone: "削除しました。",
    confirmDeleteType: "このタイプを削除しますか？",
    confirmDeleteCategory: "このカテゴリを削除しますか？",
    editNamePrompt: "名前",
    editSlugPrompt: "slug",
    addRegister: "追加登録",
    registeredImagesList: "登録されている画像の一覧",
    registeredVideosList: "登録されている動画の一覧",
    registeredAudiosList: "登録されている音楽・音声の一覧",
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
    buildCancel: "中止",
    buildCancelled: "ビルドを中止しました",
    buildErrorPrefix: "ビルドエラー: ",
    unknownError: "不明なエラー",
    mediaLabel: "メディア",
    installedVersionLabel: "導入バージョン",
    stableVersionLabel: "安定バージョン",
    latestVersionLabel: "最新バージョン",
    updateChannelLabel: "常に最新版に更新",
    updateChannelHint:
      "ON: 更新ボタンは最新版（リリースのたび）を対象にします。OFF: 安定版（管理者が昇格したリリース）のみを対象にします。",
    checking: "確認中…",
    updateNow: "今すぐ更新",
    checkForUpdate: "今すぐ更新のチェック",
    alreadyLatest: "最新バージョンです。",
    updating: "更新中…",
    updateSuccessReload: "更新しました。ページをリロードしてください。",
    updateConfirm: "KuroCMS を最新バージョンに更新しますか？",
    storageFreeUsage: "CF 無料枠使用状況",
    freeLimitLabel: "無料枠上限: ",
    r2Unavailable: "R2未契約",
    r2Media: "R2 メディア",
    d1Database: "D1 データベース",
    kvPages: "KV 公開ページ",
    kvWritesToday: "KV 書き込み（本日）",
    kvReadsLabel: "読み取り",
    kvResetLabel: "リセット",
    kvOpsUnavailable: "データなし",
    articleCountTitle: "記事数",
    collectionArticleCount: "コレクション記事数",
    sortOrder: "ソート順",
    sortUpdatedDesc: "更新日 新しい順",
    sortUpdatedAsc: "更新日 古い順",
    sortPublishDesc: "公開日 新しい順",
    sortPublishAsc: "公開日 古い順",
    sortTitleAsc: "タイトル A→Z",
    categoryFilter: "カテゴリ",
    allCategories: "すべて",
    buildSite: "サイトをビルド",
    buildModeLabel: "ビルド設定",
    buildModeManual: "手動ビルドのみ",
    buildModeAuto: "公開予定記事をその時間に自動ビルド",
    buildModeAlways: "未来記事も無条件にビルド",
    buildModeForceAll: "強制的に全件をビルド",
    siteBuildBarHint:
      "記事・テンプレート・文字情報の変更を公開サイトに反映します。",
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
    snsPostBtn: "投稿",
    snsPostingBtn: "投稿中…",
    snsPostConfirm:
      "この記事を Bluesky に投稿しますか？（タイトル・リンク・カバー画像）",
    snsPostDone: "{service} に投稿しました。",
    snsMarkOnlyBtn: "実際に投稿せず完了とする",
    snsMarkOnlyHelp:
      "実際には投稿せず、投稿済みフラグだけをONにします（記事の差し替えなどで既に投稿済みの場合に）。",
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
    fontMoveUp: "上へ",
    fontMoveDown: "下へ",
    fontBaseMark: "基本フォント",
    fontBaseNone: "テンプレート既定",
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
    communityPublishedBtn: "● コミュニティ公開中",
    communityUnpublishedBtn: "○ コミュニティに公開",
    communityUpdateBtn: "↻ 公開テンプレートを更新",
    tmplRenameBtn: "名前変更",
    tmplRenamePrompt: "新しいテンプレート名:",
    tmplRenamed: "テンプレート名を変更しました。",
    communityEditHint:
      "テンプレート編集タブで HTML を編集・保存すると公開できます",
    communityNameConflictHint:
      "同じ名前の公開テンプレートが既に存在するため公開できません。",
    communityUpdateConfirm:
      "このテンプレートで公開テンプレートを更新しますか？",
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
    newTemplateNamePrompt: "このテンプレートの新しい名前を入力してください。",
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
    bodyConflictConfirm:
      "この記事の本文は、開いた後に別のクライアント（AI など）によって更新されています。\n\nOK: 自分の本文で上書きする（相手の版はリビジョン履歴に残ります）\nキャンセル: 今は保存しない（最新版を読むには記事を開き直してください）",
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
    changeToDraft: "下書きに変更",
    changeToDraftEditable: "下書き（編集可能）に変更",
    changeToPublished: "公開に切り替え",
    editLockedHint:
      "編集するには右上のボタンで下書きモードに切り替えてください",
    articleTypeLabel: "記事タイプ",
    statusFieldLabel: "ステータス",
    categoryLabel: "カテゴリ",
    categoryAddBtn: "カテゴリ追加",
    publishTimeLabel: "公開時刻",
    hashtagLabel: "ハッシュタグ",
    coverImageLabel: "カバー画像",
    notSelected: "未選択",
    selectCoverBtn: "画像をファイルから読込む",
    clearCoverBtn: "解除",
    coverDropHint: "ドロップまたはファイルから読込む",
    coverMidHint:
      "画像ID（例: [[img-xxx]]）でカバーを指定。フォーカスを外すと読み込みます。",
    coverMidNotFound: "そのIDの画像が見つかりません。",
    r2CoverUnavail: "R2 が使えないとメディアファイルは使えません。",
    slugReadonly: "Slug は変更できません",
    slugLabelNote: "slugは変更不可。クリックでコピー",
    slugCopyHint: "クリックでコピー",
    slugHint:
      "半角英数・ハイフン・アンダースコアのみ。作成後は変更できません。",
    articleTitlePlaceholder: "記事タイトルを入力",
    summaryPlaceholder: "記事の概要（200文字まで・SNS 投稿でも使用）",
    bodyLabel: "記事本文",
    selectTypeEmpty: "タイプを選択…",
    langLoadFailed: "言語の読み込み失敗",
    typeLoadFailed: "タイプの読み込み失敗",
    unregisteredSuffix: "(未登録)",
    catLoadFailed: "カテゴリ読み込み失敗: ",
    dropZoneLead: "ここにファイルをドロップ、またはクリックして選択",
    r2EnableTitle: "Cloudflare上でR2を有効化してください。",
    r2EnableDesc:
      "画像・動画・音楽のアップロードには Cloudflare R2 の有効化が必要です。追加契約ですが、無料枠である10GBまでの容量であれば課金されません。",
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
    unsupportedUrl:
      "対応していないURLです。YouTube / SoundCloud / Spotify の URL を入力してください。",
    helpRoleLabel: "役割の説明",
    helpCanDoLabel: "出来る事",
    helpNotesLabel: "注意点",
    publishDateLabel: "公開日",
    imageTypeLabel: "画像",
    videoTypeLabel: "動画",
    audioTypeLabel: "音楽",
    r2MediaUnavailMsg: "R2 未契約のため<br>メディア管理不可",
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
    tmplDetailClose: "閉じる",
    tmplDeleteConfirm: "このテンプレートを削除しますか？",
    tmplNoTemplateSelected: "テンプレートが選択されていません",
    tmplEditorNotSelected: "テンプレートが選択されていません",
    tmplCurrentTemplate: "選択中のテンプレート：",
    contentEditorTitle: "サイトの文字情報",
    contentEditorHint:
      "テンプレートが参照するキー（例: top-hero-title）ごとに内容を登録します。キーが一致しないと該当箇所が空白になります。",
    contentAddBtn: "＋ キー登録",
    contentBaseLang: "基本",
    contentLangLabel: "言語",
    contentAddKeyNote: "※ キーは全言語に追加されます。",
    contentDeleteAllLangsNote:
      "※ 削除されるキーはすべての言語から削除されます。",
    communityDeleteFailed: "コミュニティからの削除に失敗しました",
    communityPublishFailed: "コミュニティへの登録に失敗しました",
    tmplEmptyState:
      "テンプレートが無いのでテンプレート選択からテンプレートを選択してください",
    tmplSaved: "保存しました",
    tmplSavedAndPreview: "保存しました / プレビューも更新しました",
    tmplNameRequired: "テンプレート名を入力してください",
    tmplDetailInfo: "詳細情報",
    noneRegistered: "登録されていません",
    noImages: "画像が登録されていません",
    noCategories: "カテゴリが登録されていません",
    noUsers: "ユーザーが登録されていません",
    backToArticles: "記事一覧に戻る",
    selectCoverImageTitle: "カバー画像を選択",
    allCategoriesSelected: "すべてのカテゴリが選択済みです",
    addCategoryTitle: "カテゴリを追加",
    add: "追加",
    selectCategoryMsg: "カテゴリを選択してください",
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
    contentInsertImgBtn: "画像を挿入",
    mediaTableMid: "MID",
    mediaTablePreview: "",
    mediaTableFile: "ファイル名",
    mediaTableSize: "サイズ",
    copyMidTooltip: "クリックで [[{mid}]] をコピー",
    copyBtn: "コピー",
    genEmbedBtn: "コード生成",
    embedCodeLabel: "埋め込みコード（記事本文に貼り付け）",
    embedWarning:
      "⚠️ 大きいファイルは無料枠（R2: 10GB）を大きく圧迫するため、極力 YouTube などのリンク型での表示を選ぶようにしてください。",
    embedSectionTitle: "外部動画・音楽リンクの埋め込みコード生成",
    embedSectionDesc:
      "YouTube・SoundCloud・Spotify などの URL を入力すると、記事本文に貼り付けられる &lt;iframe&gt; コードを生成します。",
    mediaInfoNonePre: "現在 ",
    mediaInfoNoneSuf: " ファイルは登録されていません。",
    mediaInfoCountPre: "現在の",
    mediaInfoCountMid1: "ファイル ",
    mediaInfoCountMid2: " 件、合計 ",
    mediaInfoCountEnd: " の R2 容量を使用しています。",
    helpBasic: "基本",
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
    snsInstanceUrl: "インスタンスURL",
    snsApiComingSoon: "※ API 連携機能は今後のアップデートで対応予定です。",
    snsDeleteMsgPre: "",
    snsDeleteMsgSuf: " の連動設定を削除しますか？",
    helpPageLead: "各機能画面の役割・操作方法・注意点をまとめたガイドです。",
    siteManagementLead:
      "テンプレートの表示・選択・編集と、ヒーローテキスト・About 等の固定コンテンツを管理します。",
    previewFetchFailed: "プレビュー取得失敗: ",
    contentKeyRequired: "キーを入力してください",
    contentValueRequired: "内容を入力してください",
    articleNotFound: "記事が見つかりません",
    articleLoadFailed: "記事の読み込みに失敗しました: ",
    changeToDraftConfirm: "ステータスを「下書き」に変更しますか？",
    addFile: "+ ファイルを追加",
    purgeDataSuffix: "件のデータを完全に削除する",
    refetchError: "再取得エラー: ",
    strapiSettingsSaved: "Strapi 接続設定を保存しました",
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
    importError: "インポートエラー: ",
    previewFetchError: "プレビュー取得エラー: ",
    kurocmsLastUpdated: "KuroCMS 最終更新: ",
    strapiConflictWarning:
      "全件インポートは全記事を Strapi 版で上書きします。以下の記事はインポート後に KuroCMS で編集されています。残したい記事はチェックを外してください（上書きせず保護します）。",
    strapiConflictNoCheck: "チェックなし = KuroCMS 版を保持（上書きしない）",
    importAllConflictTitle: "全件インポート — 競合確認",
    runImport: "インポート実行",
    strapiImportAllConfirmMsg:
      "Strapi の全記事をインポートします。既にインポート済みのものはスキップされます。",
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
    importProgressPage: "ページ",
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
  adminLogo: string;
  preview: boolean;
  colorMode: "dark" | "light";
  articleEditor: KuroEditorInstance | null;
  isAdmin: boolean;
  storageAlert: boolean;
  /** アクティブテンプレートの body 配色（/api/fonts の editorCanvas）。
      KuroEditor の canvasColors に渡し、通常モードのキャンバスを実サイトの
      配色に一致させる（ダーク系テンプレートでも WYSIWYG になる）。 */
  editorCanvasColors: { bg?: string; text?: string } | null;
};

const state: AdminState = {
  token: localStorage.getItem(tokenKey) || "",
  themeLoaded: false,
  themeSettings: null,
  currentUser: null,
  uiLang: detectLocale(),
  adminLogo: defaultAdminLogo,
  preview: previewParams.get("preview") === "1",
  colorMode:
    savedColorMode === "dark" || (!savedColorMode && prefersDark)
      ? "dark"
      : "light",
  articleEditor: null,
  isAdmin: false,
  storageAlert: false,
  editorCanvasColors: null,
};

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
  if (state.adminLogo) {
    return (
      "<img src='" +
      escapeHtml(state.adminLogo) +
      "' style='width:38px; height:38px; border-radius:8px; object-fit:cover;' />"
    );
  }
  return "<div class='brandMark'><svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><path d='M45,35 L85,35 L85,85 L45,85 Z' fill='currentColor' opacity='0.2' transform='rotate(5 65 60)'/><path d='M35,25 L75,25 L75,75 L35,75 Z' fill='currentColor' opacity='0.4' transform='rotate(-3 55 50)'/><rect x='20' y='20' width='45' height='55' rx='6' fill='currentColor' opacity='0.9'/><path d='M28,20 C28,5 34,0 36,15 L40,20' fill='currentColor'/><path d='M45,20 C45,5 51,0 53,15 L57,20' fill='currentColor'/><circle cx='33' cy='32' r='2.5' fill='var(--accent)'/></svg></div>";
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

function normalizeLanguages(values: Dynamic, fallback = ["en"]) {
  const source = Array.isArray(values)
    ? values
    : typeof values === "string"
      ? values.split(",")
      : [];
  const list = source
    .map((value) =>
      String(value || "")
        .trim()
        .toLowerCase(),
    )
    .filter((value) => value && supportedLocales.includes(value));
  const unique = Array.from(new Set(list));
  const fallbackList = fallback
    .map((value) =>
      String(value || "")
        .trim()
        .toLowerCase(),
    )
    .filter((value) => value && supportedLocales.includes(value));
  return unique.length ? unique : fallbackList.length ? fallbackList : ["en"];
}

function normalizeAdminLogo(value: Dynamic) {
  const logo = String(value || "").trim();
  if (!logo) return defaultAdminLogo;
  if (
    logo.startsWith("data:image/svg+xml") &&
    logo.includes("M45,35 L85,35 L85,85 L45,85") &&
    logo.includes("circle cx='33' cy='32' r='2.5'")
  ) {
    return defaultAdminLogo;
  }
  return logo;
}

async function loadTheme() {
  if (state.themeLoaded) return;
  try {
    const data = await api("/api/settings");
    state.adminLogo = normalizeAdminLogo(data.settings.adminLogo);
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

function kuroLicenseText() {
  return `Kuro License

Copyright (c) 2026 Kuro-Boo

This license is the MIT License with one additional attribution requirement:
when the Software is used to provide a public-facing or user-facing interface,
the phrase "with KuroCMS" must be shown in an appropriate attribution area,
such as the final page, About screen, footer, credits screen, documentation
page, or an equivalent location.

The attribution is intended only to identify KuroCMS. It does not imply
endorsement by Kuro-Boo or any KuroCMS contributor.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice, this permission notice, and the KuroCMS
attribution requirement above shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
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
) {
  const backdrop = createPopupBackdrop();
  backdrop.innerHTML =
    "<div class='popupCard' role='dialog' aria-modal='true'><form id='entryDialogForm' class='stack'><h3 class='popupTitle'>" +
    escapeHtml(title) +
    "</h3><div class='popupBody'>" +
    bodyHtml +
    "</div><div class='popupActions'><button type='button' class='secondary' id='entryDialogCancel'>" +
    escapeHtml(t("cancel")) +
    "</button><button type='submit'" +
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
    if (event.target === backdrop) cancel();
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
    sweptCount = 0;
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
        byId("bpPhase")!.textContent = "0 / " + total;
        appendLog(
          "skipped",
          t("buildLogLangs") +
            ev.langs +
            t("buildLogLangsSep") +
            ev.articles +
            t("buildLogArticlesSep") +
            total +
            t("buildLogPagesSuffix"),
        );
      }
    } else if (ev.type === "page") {
      if (ev.status === "built") {
        builtCount++;
        donePaths.add(ev.path);
        byId("bpBuilt")!.textContent = String(builtCount);
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
      } else if (ev.status === "error") {
        errorCount++;
        byId("bpErrors")!.textContent = String(errorCount);
        appendLog(
          "error",
          "✕ [" + ev.lang + "] " + ev.path + " — " + (ev.reason || t("error")),
        );
      }
      updateCounts();
    } else if (ev.type === "done") {
      // Per-pass completion: `more` true ⇒ budget spent, another pass follows.
      moreToCome = !!ev.more;
      // Orphan pages removed by the final pass's mark-and-sweep.
      if (ev.swept) sweptCount += ev.swept;
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
        builtCount +
        t("buildDoneSkipped") +
        Math.max(0, donePaths.size - builtCount) +
        t("buildDoneErrors") +
        errorCount,
    );
    if (sweptCount > 0)
      appendLog("skipped", t("buildSweptPrefix") + sweptCount);
    if (errorCount === 0 && !fatalError) {
      api("/api/v1/published", {
        method: "PUT",
        body: JSON.stringify({ published: true }),
      }).catch(function () {});
    }
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
    const token = localStorage.getItem("kurocms_pat") || "";
    const MAX_PASSES = 60; // safety cap against an unexpected non-terminating loop
    do {
      passIndex++;
      errorCount = 0;
      const errEl = byId("bpErrors");
      if (errEl) errEl.textContent = "0";
      const prevDone = donePaths.size;
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
      } catch (passErr) {
        // A user cancel aborts the fetch — stop quietly, not as an error.
        if (cancelled) break;
        throw passErr;
      }
      // Guard: if a pass claims "more" but made no progress, stop to avoid a loop.
      if (moreToCome && donePaths.size === prevDone) break;
    } while (moreToCome && !fatalError && !cancelled && passIndex < MAX_PASSES);
    if (cancelled) finalizeCancelled();
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

function makePieChart(
  pct: Dynamic,
  label: Dynamic,
  used: Dynamic,
  maxLabel: Dynamic,
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
    escapeHtml(t("freeLimitLabel")) +
    escapeHtml(maxLabel) +
    "</div>" +
    "</div>"
  );
}

const helpContent: Record<string, Dynamic> = {
  basic: {
    title: "KuroCMS 基本ガイド",
    role: "KuroCMS は Cloudflare Workers + D1 上で動作する個人用ヘッドレス CMS です。記事・メディア・設定を Web ブラウザから管理し、公開ページを KV キャッシュ経由で高速配信します。PC 不要で、すべての管理作業をブラウザのみで完結できます。",
    canDo:
      "記事の作成・多言語対応・公開管理 / 画像・動画・音楽のアップロード（R2 必須）/ カテゴリ・タイプ・言語の管理 / デザインテンプレートの選択・編集とフォント設定 / SNS（Bluesky・X・Threads）への記事投稿 / 複数ユーザーの招待・管理 / バックアップの作成・復元 / REST API 経由での記事登録（PAT 使用）",
    notes:
      "D1（5GB）・R2（10GB）・KV（1 日あたりの書き込み回数）などの Cloudflare 無料枠を超えると課金が発生します。使用状況はダッシュボードで確認してください。R2 を利用するにはクレジットカードの登録が必要です（無料枠内は課金なし）。パスキーは複数のデバイスに登録しておくことを強く推奨します。",
  },
  dashboard: {
    title: "ダッシュボード",
    role: "サイト全体の状態を一目で把握するホーム画面です。ストレージ使用量・記事数・メディア数などの統計をグラフと数値で表示します。",
    canDo:
      "D1（データベース）・R2（メディア）の使用量と KV（ページキャッシュ）の 1 日あたり書き込み回数を円グラフで確認 / 公開済み・下書き・非公開の記事数を確認 / 画像・動画・音楽の登録件数と合計容量を確認 / バージョンカードで導入中・安定版・最新版のバージョン確認と「今すぐ更新」の実行、「常に最新版に更新」トグルの切り替え",
    notes:
      "使用量が 70% を超えると黄色、90% を超えると赤で警告表示されます。赤になる前に不要なデータを削除してください。R2 使用量はアップロードされたファイルの合計サイズ、D1 の使用量は推定値です。KV はページキャッシュの 1 日あたり書き込み回数で、Cloudflare 無料枠の上限を超えると公開ビルドに失敗することがあります。",
  },
  articles: {
    title: "記事管理",
    role: "登録されているすべての記事を一覧・検索・並べ替えできる画面です。タイトルをクリックすると記事の編集画面に移動します。",
    canDo:
      "ソート順プルダウンで更新日・公開日・タイトル順に並べ替え / キーワードで記事を検索 / タイトルをクリックして記事編集画面へ移動 / 「公開する」「非公開に」ボタンで公開フラグを切り替え / SNS（Bluesky・X・Threads）への投稿ボタンで記事を投稿 / 下部ビルドバーでビルド設定（手動／自動／常時）の切り替えと「今すぐビルド」の実行 / 対応言語数の確認",
    notes:
      "記事の新規作成はサイドバーの「記事作成」から行います。公開・非公開の切り替えは「フラグ」の設定であり、ビルドを実行するまで公開サイトには一切反映されません（手動モードでは「今すぐビルド」、自動モードでは cron が自動反映）。SNS への投稿は公開済みかつビルド済みの記事のみ可能です。検索はタイトルと Slug を対象に行います。",
  },
  newArticle: {
    title: "記事作成 / 編集",
    role: "新しい記事の作成と、既存記事の本文・設定編集を行う画面です。新規作成時はタイプ・Slug・初期言語を登録します。記事一覧からタイトルをクリックすると編集モードで開きます。",
    canDo:
      "記事タイプの選択（Collection タイプのみ）/ Slug の設定 / 初期言語の選択 / 公開日時の設定 / タイトル・要約・本文（リッチエディタ）の編集 / カバー画像の設定 / カテゴリの割り当て / ハッシュタグの設定 / 公開・下書き・非公開の切り替え",
    notes:
      "Slug は小文字英数字とハイフンのみ使用可能（先頭は英数字、アンダースコア不可）で、作成後に変更できません。タイプが登録されていない場合は先にタイプ管理画面でタイプを作成してください。カバー画像は画像管理でアップロード済みの画像から選択します。公開への切り替えはフラグの設定のみで、ビルドを実行するまで公開サイトには反映されません。",
  },
  images: {
    title: "画像管理",
    role: "R2 に保存された画像ファイルのアップロード・一覧・削除を管理する画面です。",
    canDo:
      "画像ファイルのドラッグ＆ドロップまたはクリックでアップロード / アップロード済み画像の一覧表示（サムネイル付き）/ 画像の削除（R2 と D1 から同時削除）/ 「画像サイズの自動縮小」でアップロード時の縮小上限を選択（縮小なし・200KB・500KB・1MB・2MB）",
    notes:
      "R2 の有効化（クレジットカード登録）が必要です。「画像サイズの自動縮小」は選択した瞬間に自動保存され、以後のアップロードに適用されます（毎回の設定は不要）。この設定はブラウザごとに保存されるため、別のブラウザ・端末では既定値の 1MB に戻ります。登録済みの画像には影響しません。同一内容のファイルを再アップロードした場合は既存の画像が再利用され、重複登録されません。アップロードした画像は URL が分かれば誰でもアクセス可能です。機密画像はアップロードしないでください。R2 無料枠は 10GB です。不要な画像は定期的に削除してください。",
  },
  videos: {
    title: "動画管理",
    role: "動画ファイルのアップロード管理と、YouTube 等の外部サービスの埋め込みコード生成を行う画面です。",
    canDo:
      "動画ファイルのアップロード（R2 必須）/ YouTube・Vimeo・NicoNico の埋め込み iframe コード生成 / アップロード済み動画の一覧と削除",
    notes:
      "動画ファイルは容量が大きく、R2 の無料枠（10GB）をすぐに使い切ります。極力 YouTube などの外部リンク型を使ってください。外部リンク型は R2 の容量を消費しません。",
  },
  audios: {
    title: "音楽管理",
    role: "音楽・音声ファイルのアップロード管理と、SoundCloud・Spotify の埋め込みコード生成を行う画面です。",
    canDo:
      "音楽ファイルのアップロード（R2 必須）/ SoundCloud・Spotify の埋め込み iframe コード生成 / アップロード済み音楽ファイルの一覧と削除",
    notes:
      "音楽ファイルも動画と同様に容量が大きいため、SoundCloud や Spotify の外部リンク型を優先してください。外部リンク型は R2 を消費しません。",
  },
  categories: {
    title: "カテゴリ管理",
    role: "記事の分類に使うカテゴリを管理する画面です。",
    canDo: "カテゴリの追加・編集・削除 / カテゴリ一覧の確認",
    notes:
      "カテゴリを削除すると、そのカテゴリが割り当てられた記事との関連データも削除されます。初期値として Business・Hobby・Sports・Money・Life が登録されています。",
  },
  languages: {
    title: "言語管理",
    role: "KuroCMS で使用する言語を登録・管理する画面です。REST API で記事を登録する際の言語コードのバリデーションにも使用されます。",
    canDo: "対応言語の追加・削除 / 登録言語一覧の確認",
    notes:
      "REST API で記事を登録する際、ここに登録されていない言語コードは受け付けません。言語を削除すると、その言語の翻訳データもすべて削除できます（削除時に選択）。言語コードは小文字 2〜3 文字＋任意の地域サブタグ（例: ja, en, pt-br）を使用します。追加ダイアログは ISO 639-1 全言語から検索式で選択できます。",
  },
  types: {
    title: "タイプ管理",
    role: "記事の種別（ブログ・ニュース等）を管理する画面です。Collection（複数記事）と Single（1 件のみ）の 2 種類があります。",
    canDo:
      "Collection タイプの追加・編集（記事管理画面に表示されるブログ等）/ Single タイプの追加・編集（TOP・About 等の固定ページ）/ タイプの削除",
    notes:
      "記事が 1 件でも存在するタイプは削除できません（先に記事を削除するか、記事のタイプを変更してください）。初期登録の news・blog タイプは削除しないことを強く推奨します。Single タイプは 1 タイプにつき 1 記事しか持てません。",
  },
  settings: {
    title: "設定",
    role: "サイト全体の設定を管理する画面です。基本・SNS・ライセンス・インポートの 4 タブ構成です（インポートタブ内で Strapi と KuroCMS を切り替えます）。",
    canDo:
      "公開ドメイン・独自ドメイン（Cloudflare）・R2 の設定 / 基本言語の設定 / SNS 外部連動（Bluesky・X・Threads）の設定 / ライセンス表示の確認 / Strapi からの記事インポート / 他の KuroCMS からのデータ読み込み",
    notes:
      "サイト名はサイト管理画面、テーマ（デザイン）はテンプレートで設定します。管理画面 URL・Worker 名・D1 名は bootstrap スクリプトで設定し、この画面からは変更できません。SNS への投稿は記事一覧の投稿ボタンから記事ごと・SNS ごとに手動で行えます（公開済みかつビルド済みの記事のみ）。SNS タブでは各サービスの「全件投稿済みにする／解除」の一括操作もできます。Strapi インポートは Strapi v4/v5 の REST API に対応しています。",
  },
  siteManagement: {
    title: "サイト管理",
    role: "公開サイトのテンプレート・固定コンテンツ・フォント・計測を管理する画面です。テンプレート表示・テンプレート選択・テンプレート編集・サイト文字編集・フォント管理・計測の 6 タブ構成です。",
    canDo:
      "テンプレート表示：PC・スマホ表示のプレビュー確認とテンプレート公開 / テンプレート選択：ローカル・公開テンプレートの選択と適用 / テンプレート編集：テンプレートの HTML ソースを直接編集 / サイト文字編集：サイト名と多言語の固定コンテンツを編集 / フォント管理：Web フォントの読み込みと基本フォントの指定 / 計測：GA4 計測 ID と SEO 用サイト説明文の設定",
    notes:
      "テンプレートを変更した後は「テンプレート表示」タブの「テンプレート公開」ボタンで反映してください。サイト文字・フォント・計測の変更後は下部の「今すぐビルド」ボタンで公開サイトに反映します。テンプレート編集には HTML の知識が必要です。テンプレート公開ボタンはテンプレートを選択または編集した後に有効になります。",
  },
  profile: {
    title: "プロフィール",
    role: "ログイン中のユーザーの個人設定と Personal Access Token（PAT）を管理する画面です。",
    canDo:
      "管理画面の表示言語の切り替え / ダークモードの切り替え / パスキーの追加登録 / PAT の発行・一覧確認・取り消し",
    notes:
      "PAT は REST API アクセス用のトークンです。外部に漏れると不正アクセスの原因になります。不要な PAT はすぐに取り消してください。パスキーのバックアップを複数デバイスで設定しておくと、デバイス紛失時もログインできます。",
  },
  users: {
    title: "ユーザー管理",
    role: "管理者が複数のユーザー（管理者・投稿者）を招待・管理する画面です。管理者専用です。",
    canDo:
      "招待リンクの発行によるユーザー追加 / 権限（管理者・投稿者）の設定 / ユーザーの削除",
    notes:
      "権限は管理者と投稿者の2種類で、管理者は投稿者の権限も兼ねます。招待リンクは第三者に共有しないでください。管理者は最低1名必要です。",
  },
  backup: {
    title: "バックアップ",
    role: "サイト全体のデータを ZIP ファイルとして書き出し、復元する画面です。管理者専用で、バックアップ・復元の 2 タブ構成です。",
    canDo:
      "記事・タクソノミー・設定・メディアを含む ZIP バックアップの作成 / ZIP ファイルからの復元（レストア）",
    notes:
      "バックアップ ZIP には SNS 連携トークンや Bluesky のパスワード等の機密情報が含まれます。ファイルは厳重に保管してください。復元は既存データを上書きする可能性があるため、実行前に内容をよく確認してください。バックアップ・復元はすべてブラウザ内で処理されます。",
  },
  faq: {
    title: "よくある質問 (Q&A)",
    faqs: [
      {
        q: "別のドメイン（インスタンス）に引っ越したい",
        a: "サイドバーの「バックアップ」から ZIP を書き出し、新しいインスタンスで bootstrap.sh を実行した後、同画面の「レストア」で復元します。設定の「インポート」タブから、稼働中の別 KuroCMS のデータを直接読み込むこともできます。Worker・D1・R2 のバインドは bootstrap スクリプトが自動で行います。",
      },
      {
        q: "Strapi からインポートした記事を上書きしたい",
        a: "インポート画面の「全件インポート」ボタンを押すと、KuroCMS で編集済みの記事を自動検出します（「修正済」バッジで表示）。上書きする記事を個別にチェックしてから実行できます。チェックしなかった記事は KuroCMS 版のまま保持されます。",
      },
      {
        q: "パスキーを登録したデバイスを紛失したら？",
        a: "プロフィール画面から複数のデバイスにパスキーを事前登録しておくことを強く推奨します。すべてのデバイスを失った場合は、初期設定で構成したメールアドレスへの OTP ログイン（Cloudflare Access）が使用できます。",
      },
      {
        q: "記事の slug は後から変更できますか？",
        a: "できません。Slug は作成時に確定し、以降は変更不可です。URL の永続性を保証するための設計です。変更が必要な場合は記事を削除して再作成してください。",
      },
      {
        q: "無料枠を超えた場合はどうなりますか？",
        a: "Cloudflare から自動的に従量課金されます（後払い）。ダッシュボードで D1・R2・KV の使用量を定期的に確認してください。70% を超えると黄色、90% を超えると赤で警告が表示されます。不要なメディアファイルは定期的に削除することを推奨します。",
      },
      {
        q: "REST API で記事を登録・取得するには？",
        a: "プロフィール画面で Personal Access Token（PAT）を発行し、Authorization: Bearer <token> ヘッダーを付けて API にアクセスします。エンドポイント一覧と使い方は /api/help を参照してください。AI（LLM）ツールからの記事投稿にも利用できます。",
      },
      {
        q: "R2 なしでも使えますか？",
        a: "テキストのみの記事であれば R2 なしでも動作します。画像・動画・音楽ファイルのアップロードには R2 が必須です。R2 を有効化するには Cloudflare アカウントにクレジットカードを登録する必要があります（無料枠内は課金なし）。",
      },
      {
        q: "複数ユーザーで使えますか？",
        a: "複数ユーザーの登録に対応しています。管理者は「ユーザー管理」画面から招待リンクを発行してユーザーを追加できます。権限は管理者と投稿者の2種類で、管理者は投稿者の権限も兼ねます。",
      },
    ],
  },
};

const helpContentEn: Record<string, Dynamic> = {
  basic: {
    title: "KuroCMS Getting Started Guide",
    role: "KuroCMS is a personal headless CMS running on Cloudflare Workers + D1. Manage articles, media, and settings from any web browser and deliver public pages fast via KV cache. No PC required — all admin tasks can be completed entirely in the browser.",
    canDo:
      "Create & manage articles with multilingual support / Upload images, video, and audio (R2 required) / Manage categories, types, and languages / Choose and edit design templates and fonts / Post articles to SNS (Bluesky, X, Threads) / Invite and manage multiple users / Create and restore backups / Register articles via REST API (PAT authentication)",
    notes:
      "Cloudflare free tier limits: D1 (5 GB), R2 (10 GB), KV (daily write operations). Exceeding these limits will incur charges. Monitor usage on the Dashboard. R2 requires a credit card on file (no charge within free tier). Strongly recommended: register passkeys on multiple devices.",
  },
  dashboard: {
    title: "Dashboard",
    role: "The home screen for a quick overview of your entire site. Displays storage usage, article counts, and media statistics in charts and numbers.",
    canDo:
      'Check D1 (database) and R2 (media) usage plus KV (page cache) daily write operations in pie charts / View published, draft, and hidden article counts / Check image, video, and audio counts with total storage / Use the version card to see the installed, stable, and latest versions, run "Update Now", and toggle "Always update to latest"',
    notes:
      "Usage above 70% shows a yellow warning; above 90% shows red. Delete unnecessary data before it turns red. R2 usage reflects total uploaded file size; D1 usage is an estimate. KV is shown as daily page-cache write operations — exceeding the Cloudflare free-tier limit can cause site builds to fail.",
  },
  articles: {
    title: "Article Manager",
    role: "List, search, and sort all registered articles. Click a title to open the article editor.",
    canDo:
      "Sort by updated date, publish date, or title using the dropdown / Search articles by keyword / Click a title to edit / Toggle the publish flag with the Publish and Unpublish buttons / Post articles to SNS (Bluesky, X, Threads) with the post buttons / Switch build mode (manual・auto・always) and run Build Now from the bottom build bar / Check supported language count per article",
    notes:
      'Create new articles from the "New Article" sidebar item. Toggling publish/unpublish only sets a FLAG — nothing changes on the public site until a build runs ("Build Now" in manual mode; the cron applies it automatically in auto mode). SNS posting is only available for articles that are published AND built. Search covers titles and slugs.',
  },
  newArticle: {
    title: "New Article / Edit Article",
    role: "Create new articles and edit body, settings, and metadata of existing articles. On first creation, set the type, slug, and initial language. Click a title in the article list to open in edit mode.",
    canDo:
      "Select article type (Collection types only) / Set slug / Select initial language / Set publish date and time / Edit title, summary, and body (rich editor) / Set cover image / Assign categories / Add hashtags / Toggle published, draft, or hidden",
    notes:
      "Slugs may only contain lowercase letters, numbers, and hyphens (must start with a letter or number; underscores are not allowed) and cannot be changed after creation. If no types are registered, create one in Types first. Cover images are selected from images already uploaded in Image Manager. Switching to published only sets the flag — the public site does not change until a build runs.",
  },
  images: {
    title: "Image Manager",
    role: "Manage image files stored in R2 — upload, list, and delete.",
    canDo:
      'Upload image files via drag & drop or click / Browse uploaded images with thumbnails / Delete images (removes from both R2 and D1) / Choose the upload size limit with "Automatic image resizing" (no resize / 200 KB / 500 KB / 1 MB / 2 MB)',
    notes:
      'R2 must be enabled (credit card registration required). The "Automatic image resizing" choice is saved automatically the moment you select it and applies to subsequent uploads (it is stored per browser in localStorage, so a different browser or device falls back to the default 1 MB; already-uploaded images are not affected). Re-uploading a file with identical content reuses the existing image instead of registering a duplicate. Uploaded images are publicly accessible via URL. Do not upload confidential images. R2 free tier is 10 GB. Delete unused images regularly.',
  },
  videos: {
    title: "Video Manager",
    role: "Upload and manage video files, and generate embed codes for YouTube and other external services.",
    canDo:
      "Upload video files (R2 required) / Generate embed iframe code for YouTube, Vimeo, NicoNico / List and delete uploaded videos",
    notes:
      "Video files are large and quickly consume the R2 free tier (10 GB). Use external services like YouTube whenever possible. External links do not consume R2 storage.",
  },
  audios: {
    title: "Audio Manager",
    role: "Upload and manage audio files, and generate embed codes for SoundCloud and Spotify.",
    canDo:
      "Upload audio files (R2 required) / Generate embed iframe code for SoundCloud and Spotify / List and delete uploaded audio files",
    notes:
      "Audio files are also large. Prefer external links (SoundCloud, Spotify) to avoid consuming R2 storage.",
  },
  categories: {
    title: "Category Manager",
    role: "Manage categories used to classify articles.",
    canDo: "Add, edit, and delete categories / View category list",
    notes:
      "Deleting a category removes article-category associations for that category. Initial categories include Business, Hobby, Sports, Money, and Life.",
  },
  languages: {
    title: "Language Manager",
    role: "Register and manage the languages used in KuroCMS. Also used to validate language codes when registering articles via REST API.",
    canDo: "Add and remove supported languages / View registered language list",
    notes:
      "Language codes not registered here will be rejected by the REST API. When deleting a language you can optionally purge all translation data for that language (chosen in the delete dialog). Use lowercase 2–3 letter codes with an optional region subtag (such as ja, en, pt-br). The add dialog offers a searchable picker covering all ISO 639-1 languages.",
  },
  types: {
    title: "Type Manager",
    role: "Manage article types (blog, news, etc.). Two kinds: Collection (multiple articles) and Single (one article only).",
    canDo:
      "Add and edit Collection types (blog, etc.) / Add and edit Single types (fixed pages like TOP or About) / Delete types",
    notes:
      "A type cannot be deleted while any article uses it (delete those articles first, or change their type). It is strongly recommended not to delete the initial news and blog types. A Single type can only hold one article.",
  },
  settings: {
    title: "Settings",
    role: "Manage site-wide settings. Organized into 4 tabs: Basic, SNS, License, and Import (the Import tab toggles between Strapi and KuroCMS).",
    canDo:
      "Set public domain, custom domain (Cloudflare), and R2 / Configure the default language / Set up SNS integrations (Bluesky, X, Threads) / View license / Import articles from Strapi / Load data from another KuroCMS",
    notes:
      'Site name is set in Site Manager, and theme (design) is set per template. The admin URL, Worker name, and D1 name are set by the bootstrap script and cannot be changed here. SNS posting is done manually per article and per service via the post buttons in the article list (only for articles that are published AND built). The SNS tab also offers bulk "mark all as posted / unmark all" actions per service. Strapi import supports Strapi v4/v5 REST API.',
  },
  siteManagement: {
    title: "Site Manager",
    role: "Manage templates, static content, fonts, and analytics for the public site. 6 tabs: Template Preview, Select Template, Edit Template, Edit Site Text, Font Management, and Analytics.",
    canDo:
      "Template Preview: check desktop/mobile previews and publish the template / Select Template: choose and apply a local or community template / Edit Template: edit the template HTML source directly / Edit Site Text: edit the site name and multilingual fixed content / Font Management: load web fonts and pick a base font / Analytics: set the GA4 measurement ID and SEO site description",
    notes:
      'After changing a template, click "Publish Template" in the Template Preview tab to apply. After editing site text, fonts, or analytics, click "Build Now" to reflect changes on the public site. Editing templates requires HTML knowledge. The publish button activates after selecting or editing a template.',
  },
  profile: {
    title: "Profile",
    role: "Manage personal settings and Personal Access Tokens (PAT) for the currently logged-in user.",
    canDo:
      "Switch admin UI language / Toggle dark mode / Register additional passkeys / Issue, list, and revoke PATs",
    notes:
      "PATs are tokens for REST API access. A leaked PAT can lead to unauthorized access — revoke unused PATs promptly. Register passkeys on multiple devices to maintain login access if a device is lost.",
  },
  users: {
    title: "User Management",
    role: "Admin-only screen to invite and manage multiple users (admins / authors).",
    canDo:
      "Add users via invite links / Set roles (admin / author) / Remove users",
    notes:
      "There are two roles, admin and author; an admin also has author privileges. Do not share invite links with third parties. At least one admin is required.",
  },
  backup: {
    title: "Backup",
    role: "Admin-only screen to export the entire site as a ZIP file and restore it. Two tabs: Backup and Restore.",
    canDo:
      "Create a ZIP backup including articles, taxonomy, settings, and media / Restore from a ZIP file",
    notes:
      "The backup ZIP contains sensitive data such as SNS integration tokens and your Bluesky password — store the file securely. Restore may overwrite existing data, so review the contents before running it. Backup and restore are processed entirely in the browser.",
  },
  faq: {
    title: "FAQ (Q&A)",
    faqs: [
      {
        q: "I want to migrate to a different domain (instance)",
        a: "Export a ZIP from the Backup screen in the sidebar, run bootstrap.sh on the new instance, then restore it from the same screen. You can also load data directly from another running KuroCMS via the Import tab in Settings. The bootstrap script automatically configures Worker, D1, and R2 bindings.",
      },
      {
        q: "I want to overwrite articles imported from Strapi",
        a: 'Click "Import All" on the Import screen to automatically detect KuroCMS-edited articles (shown with an edited badge). Check the ones you want to overwrite before running. Unchecked articles remain as they are in KuroCMS.',
      },
      {
        q: "What if I lose the device with my passkey?",
        a: "It is strongly recommended to register passkeys on multiple devices in advance from the Profile screen. If all devices are lost, you can use OTP login (Cloudflare Access) via the email address configured during initial setup.",
      },
      {
        q: "Can I change an article slug after creation?",
        a: "No. The slug is finalized at creation and cannot be changed. This is by design to ensure URL permanence. If a change is needed, delete the article and recreate it.",
      },
      {
        q: "What happens if I exceed the free tier?",
        a: "Cloudflare will automatically bill you on a pay-as-you-go basis. Regularly check D1, R2, and KV usage on the Dashboard. Yellow warning appears above 70%, red above 90%. It is recommended to delete unnecessary media files regularly.",
      },
      {
        q: "How do I register and retrieve articles via REST API?",
        a: "Issue a Personal Access Token (PAT) from the Profile screen, then access the API with an Authorization: Bearer <token> header. See /api/help for endpoint list and usage. Can also be used for posting articles from AI (LLM) tools.",
      },
      {
        q: "Can I use KuroCMS without R2?",
        a: "Yes, for text-only articles. R2 is required for image, video, and audio file uploads. To enable R2, register a credit card with your Cloudflare account (no charge within the free tier).",
      },
      {
        q: "Can multiple users share KuroCMS?",
        a: "Yes, multiple users are supported. Administrators can invite users from the User Manager screen. There are two roles: Admin and Author; an admin also has author privileges.",
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

async function render() {
  try {
    if (state.preview) {
      enablePreviewMode();
    } else {
      // Check setup status
      const setupStatusResponse = await fetch(withBase("/api/setup/status"));
      if (setupStatusResponse.ok) {
        const setupStatus = await setupStatusResponse.json();
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
      } catch {
        return loginScreen();
      }
    }
    await loadTheme();
    setTimeout(checkStorageAlertOnce, 0);
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

document.body.addEventListener("click", (event: Dynamic) => {
  const helpTrigger = event.target.closest("[data-help-key]");
  if (helpTrigger) {
    showHelpDialog(helpTrigger.dataset.helpKey);
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
