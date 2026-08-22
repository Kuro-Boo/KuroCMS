/**
 * entamy-connect の代替（公開ミラー専用のスタブ）。
 *
 * ## なぜ本体が入っていないのか
 *
 * 基盤へ繋ぐ実装は別のリポジトリ（EntamyCom/entamy-connect）にあり、
 * **所有者もライセンスも KuroCMS とは別**である。KuroCMS の公開ミラーは
 * Kuro License で配られるので、他所のコードを同じライセンスで再配布しない。
 *
 * ## これで何ができて、何ができないか
 *
 * **コンパイルは通る。** 型も関数の形も本体と同じにしてある。KuroCMS の
 * ソースを読む・改変する・自分のビルドを作ることはこのままできる。
 *
 * **メールは送れない。** すべての呼び出しが `unauthenticated` を返すので、
 * 送信経路は「資格情報が用意できない」として扱われる。KuroCMS 本体は
 * それを 503 `mailer_not_configured` に変換し、**他の機能は動き続ける**
 * （メールが無いと起動しない、という作りにはしていない）。
 *
 * ## 差し替えたい場合
 *
 * このファイルと同じ形の実装を置けば、そのまま動く。Entamy 基盤を使わず、
 * 自前の送信基盤に繋ぐこともできる —— そのための境界としてここを開けてある。
 *
 * 配布されている `worker.js`（GitHub Release）には本体が入っている。
 */

// ── 失敗の型（本体と同じ語彙）───────────────────────────────────────────
export type EntamyFailureKind =
  | "network"
  | "unauthenticated"
  | "denied"
  | "not_found"
  | "rate_limited"
  | "invalid"
  | "conflict"
  | "too_large"
  | "quota_exceeded"
  | "server";

export interface EntamyFailure {
  kind: EntamyFailureKind;
  message?: string;
  retryAfterSec?: number;
  status?: number;
}

export type EntamyResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: EntamyFailure };

const NOT_BUNDLED: EntamyFailure = {
  kind: "unauthenticated",
  message:
    "entamy-connect is not bundled in the public source mirror. " +
    "The published worker.js contains the real implementation; " +
    "supply your own module with the same shape to use a different backend.",
};

const refuse = <T>(): Promise<EntamyResult<T>> =>
  Promise.resolve({ ok: false as const, failure: NOT_BUNDLED });

// ── 保管庫 ──────────────────────────────────────────────────────────────
export interface EntamySecrets {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class EntamyStore {
  readonly namespace: string;
  readonly secrets: EntamySecrets;
  constructor(namespace: string, secrets?: EntamySecrets) {
    this.namespace = namespace;
    this.secrets = secrets ?? {
      async read() {
        return null;
      },
      async write() {},
      async delete() {},
    };
  }
  read(name: string): Promise<string | null> {
    return this.secrets.read(`${this.namespace}.${name}`);
  }
  write(name: string, value: string | null): Promise<void> {
    return value === null || value === ""
      ? this.secrets.delete(`${this.namespace}.${name}`)
      : this.secrets.write(`${this.namespace}.${name}`, value);
  }
}

// ── 設定 ────────────────────────────────────────────────────────────────
export interface EntamyConfig {
  productId: string;
  appVersion?: string;
  rpId?: string;
  idBaseUrl?: string;
  adminBaseUrl?: string;
  eedbBaseUrl?: string;
  accountBaseUrl?: string;
  clientBaseUrl?: string;
  mailerBaseUrl?: string;
  storageNamespace?: string;
}

// ── セッション ──────────────────────────────────────────────────────────
export interface SessionOptions {
  store?: EntamyStore;
  fetch?: typeof fetch;
  platform?: string;
  installId?: string | (() => Promise<string> | string);
}

export class EntamySession {
  constructor(
    readonly config: EntamyConfig,
    readonly options: SessionOptions = {},
  ) {}

  async installId(): Promise<string> {
    const given = this.options.installId;
    if (typeof given === "function") return given();
    return given ?? "";
  }
  accountId(): Promise<string | null> {
    return Promise.resolve(null);
  }
  reportInstall(
    _stats: Record<string, unknown> = {},
  ): Promise<EntamyResult<InstallReport>> {
    return refuse<InstallReport>();
  }
  ensureAccount(): Promise<EntamyResult<string>> {
    return refuse<string>();
  }
  accessToken(
    _options: { force?: boolean } = {},
  ): Promise<EntamyResult<string>> {
    return refuse<string>();
  }
  postJson(
    _url: string,
    _body: unknown,
    _headers: Record<string, string> = {},
  ): Promise<EntamyResult<Record<string, unknown>>> {
    return refuse<Record<string, unknown>>();
  }
  getJson(
    _url: string,
    _headers: Record<string, string> = {},
  ): Promise<EntamyResult<Record<string, unknown>>> {
    return refuse<Record<string, unknown>>();
  }
}

export interface InstallReport {
  recorded: number;
  /** 基盤が宣言していないキーはここに返る（捨てられた分）。 */
  ignored: string[];
  versionChanged: boolean;
}

// ── 法務文書 ────────────────────────────────────────────────────────────
export type LegalState = "required" | "none" | "unknown";

export interface LegalStatus {
  state: LegalState;
  version?: string;
  requiresReconsent: boolean;
  effectiveAt?: Date;
  canonicalLang?: string;
  isTranslation: boolean;
  termsUrl?: string;
  privacyUrl?: string;
  summary?: string | null;
}

export class EntamyLegal {
  constructor(
    readonly config: EntamyConfig,
    readonly options: { store?: EntamyStore; fetch?: typeof fetch } = {},
  ) {}
  /** 取れないので「求めない」を返す。**推測しない。** */
  fetchStatus(
    _docType = "terms",
    _lang = "ja",
    _options: { accountId?: string } = {},
  ): Promise<LegalStatus> {
    return Promise.resolve({
      state: "unknown",
      requiresReconsent: true,
      isTranslation: false,
    });
  }
  agreedVersion(): Promise<string | null> {
    return this.options.store?.read("terms_version") ?? Promise.resolve(null);
  }
  async agreedAt(): Promise<Date | null> {
    const raw = await (this.options.store?.read("terms_agreed_at") ??
      Promise.resolve(null));
    if (!raw) return null;
    const at = new Date(raw);
    return Number.isNaN(at.getTime()) ? null : at;
  }
  async record(version: string, at: Date = new Date()): Promise<void> {
    await this.options.store?.write("terms_version", version);
    await this.options.store?.write("terms_agreed_at", at.toISOString());
  }
}

/** 同意を求める必要があるか。取得できていなければ求めない。 */
export function needsAgreement(
  status: LegalStatus,
  agreedVersion: string | null,
): boolean {
  if (status.state !== "required") return false;
  if (!agreedVersion) return true;
  if (agreedVersion === status.version) return false;
  return status.requiresReconsent;
}

// ── SAT ─────────────────────────────────────────────────────────────────
export const EntamyService = {
  eedb: "eedb",
  account: "account",
  client: "client",
  mailer: "mailer",
} as const;

export class EntamySat {
  constructor(
    readonly config: EntamyConfig,
    readonly session: EntamySession,
    readonly store: EntamyStore,
  ) {}
  token(
    _service: string,
    _options: { force?: boolean } = {},
  ): Promise<EntamyResult<string>> {
    return refuse<string>();
  }
  send<T>(
    _service: string,
    _run: (sat: string) => Promise<EntamyResult<T>>,
  ): Promise<EntamyResult<T>> {
    return refuse<T>();
  }
  forget(_service: string): Promise<void> {
    return Promise.resolve();
  }
  forgetAll(): Promise<void> {
    return Promise.resolve();
  }
}

// ── Mailer ──────────────────────────────────────────────────────────────
export interface MailerCredential {
  key: string;
  tokenPrefix: string;
  sat: string;
  accountId: string;
  expiresAt: number;
  renewAfter: number;
}

export interface MailMessage {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  from: string;
  fromName?: string;
  replyTo?: string;
  idempotencyKey?: string;
}

export class EntamyMailer {
  constructor(
    readonly config: EntamyConfig,
    readonly session: EntamySession,
    readonly sat: EntamySat,
    readonly store: EntamyStore,
  ) {}
  credential(
    _options: { force?: boolean } = {},
  ): Promise<EntamyResult<MailerCredential>> {
    return refuse<MailerCredential>();
  }
  send(_message: MailMessage): Promise<EntamyResult<{ id?: string }>> {
    return refuse<{ id?: string }>();
  }
  forget(): Promise<void> {
    return Promise.resolve();
  }
}
