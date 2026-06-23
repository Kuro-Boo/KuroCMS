export interface Env {
  DB: D1Database;
  DEBUG_DB?: D1Database;
  ASSETS: Fetcher;
  // PUBLIC_PAGES is a required core binding. Do not make it optional or silently
  // tolerate missing KV; public-page persistence and cache behavior depend on it.
  PUBLIC_PAGES: KVNamespace;
  MEDIA_BUCKET?: R2Bucket;
  IMAGES?: ImagesBinding;
  DEBUG_LOG_ENABLED?: string;
  SITE_DEFAULT_LANG?: string;
  LOCAL_DEV_ADMIN_EMAIL?: string;
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
}

export interface AuthUser {
  uid: string;
  email: string;
  isAdmin: boolean;
  isAuthor: boolean;
  tokenId?: string;
  sessionId?: string;
  authSource?: "local" | "pat" | "session";
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
