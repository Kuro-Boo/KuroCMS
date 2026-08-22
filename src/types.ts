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
  // 自動取得へ移行する前の互換用。新しい導入は KV に期限付き鍵を保存する。
  /**
   * Entamy Mailer の旧送信キー。自動取得が一時的に失敗した場合の移行用控え。
   */
  MAILER_KEY?: string;
  /** 旧名。既存の導入が更新後も送れるように読み続ける。 */
  KUROCMS_AND_KUROMAILER_PAT?: string;
  KUROMAILER_URL?: string;
  /**
   * 差出人。Entamy Mailer の sender_domain に登録されたドメインであること。
   * 未設定なら no-reply@kuro.boo（移行前と同じ差出人）。
   */
  KUROCMS_MAIL_FROM?: string;
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
