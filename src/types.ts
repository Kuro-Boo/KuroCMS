export interface Env {
  DB: D1Database;
  DEBUG_DB?: D1Database;
  // ⚠ optional。ローカル開発（public/ を wrangler が配る）にだけ存在し、
  //    **インストール済みの本番 Worker には無い**（アセットは KV → GitHub release で解決する）。
  //    必須で宣言すると、無い環境で `env.ASSETS.fetch` が
  //    "Cannot read properties of undefined" を投げるのを型検査が見逃す。
  ASSETS?: Fetcher;
  // PUBLIC_PAGES is a required core binding. Do not make it optional or silently
  // tolerate missing KV; public-page persistence and cache behavior depend on it.
  PUBLIC_PAGES: KVNamespace;
  MEDIA_BUCKET?: R2Bucket;
  IMAGES?: ImagesBinding;
  DEBUG_LOG_ENABLED?: string;
  SITE_DEFAULT_LANG?: string;
  ACCESS_ADMIN_URL?: string;
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
  BLUESKY_HANDLE?: string;
  BLUESKY_APP_PASSWORD?: string;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_WORKER_NAME?: string;
  COMMUNITY_PAT?: string;
  COMMUNITY_API?: Fetcher;
  /**
   * Entamy Mailer の送信先。**未設定なら基盤の本番**(mailer.entamy.com)。
   *
   * 鍵はここに置かない —— entamy-connect が SAT で取り直し、KV に控える
   * (2026-08-23 に旧送信キーの控えを撤去)。
   */
  KUROMAILER_URL?: string;
  /**
   * 差出人。Entamy Mailer の sender_domain に登録されたドメインであること。
   * 未設定なら no-reply@kuro.boo（移行前と同じ差出人）。
   */
  KUROCMS_MAIL_FROM?: string;
  /**
   * Free Email Routing send path. The binding is present only while the owner
   * has selected their own domain in Profile; the companion sender variable is
   * written at the same time from the Worker's Custom Domain.
   */
  EMAIL?: SendEmail;
  KUROCMS_EMAIL_ROUTING_FROM?: string;
}

export interface AuthUser {
  uid: string;
  email: string;
  isAdmin: boolean;
  isAuthor: boolean;
  tokenId?: string;
  sessionId?: string;
  /** Passkey credential that authenticated the current session (if any). */
  currentCredentialId?: string | null;
  authSource?: "pat" | "session";
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
