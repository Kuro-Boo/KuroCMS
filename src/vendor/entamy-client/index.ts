/**
 * entamy-connect の代替（公開ミラー専用のスタブ）。
 *
 * ## なぜ本体が入っていないのか
 *
 * 基盤へ繋ぐ実装は別の場所（Entamy の非公開のリポジトリにある entamy-connect）にあり、
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

/** 宛先の解決。スタブは基盤へ繋がないので、Billing の宛先は空(料金は出さない)。 */
export function resolveConfig(_config: EntamyConfig): { billingBaseUrl: string } {
  return { billingBaseUrl: "" };
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
  /** 委託運用 ⇄ 顧客導入の引っ越し(導入口)。基盤が無いので頼めない。 */
  startSiteMove(
    _body: Record<string, unknown>,
    _lang: string,
  ): Promise<EntamyResult<{ jobId: string; statusUrl: string }>> {
    return refuse<{ jobId: string; statusUrl: string }>();
  }
  siteMoveStatusUrl(_jobId: string): string {
    return "";
  }
  siteMoveStatus(
    _jobId: string,
  ): Promise<EntamyResult<Record<string, unknown>>> {
    return refuse<Record<string, unknown>>();
  }
  resumeSiteMove(_jobId: string): Promise<EntamyResult<void>> {
    return refuse<void>();
  }
  siteDomain(
    _body: Record<string, unknown>,
  ): Promise<EntamyResult<Record<string, unknown>>> {
    return refuse<Record<string, unknown>>();
  }
  siteCheckUpdate(
    _body: Record<string, unknown>,
  ): Promise<EntamyResult<Record<string, unknown>>> {
    return refuse<Record<string, unknown>>();
  }
  siteOwner(
    _worker: string,
    _proof?: string,
  ): Promise<
    EntamyResult<{ owner: "record" | "id" | null; minVersion: string | null }>
  > {
    return refuse<{
      owner: "record" | "id" | null;
      minVersion: string | null;
    }>();
  }
  // 導入の持ち主(ID 第7章)。公開の写しでは基盤へ繋がないので、どれも断る
  // (管理画面は「いまは確認できません」を出し、ダイアログは出さない)。
  ownerLink(): Promise<EntamyResult<EntamyOwnerState>> {
    return refuse<EntamyOwnerState>();
  }
  beginOwnerLink(
    _email: string,
    _continueUrl: string,
    _options: { consentVersion: string; subject: string; text: string },
  ): Promise<EntamyResult<void>> {
    return refuse<void>();
  }
  removeOwnerLink(): Promise<EntamyResult<{ removed: boolean }>> {
    return refuse<{ removed: boolean }>();
  }
  rekeyInstall(_newInstallId: string): Promise<EntamyResult<{ rekeyed: boolean }>> {
    return refuse<{ rekeyed: boolean }>();
  }
}

/**
 * 保管庫を封じる(本体は entamy-connect の service/src/sealed-secrets.ts)。公開ミラーでは
 * 基盤へ繋がず、控える資格も無いので、封じずにそのまま渡す。配布する worker.js には本体が入る。
 */
export function sealedSecrets(inner: EntamySecrets, _keySpec: string | undefined): EntamySecrets {
  return inner;
}

export interface EntamyOwnerState {
  owner: {
    email: string;
    consentVersion: string;
    consentedAt: string;
    linkedAt: string;
  } | null;
  pending: { email: string; expiresAt: string } | null;
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
    readonly options: {
      store?: EntamyStore;
      fetch?: typeof fetch;
      /** 基盤の同意の記録(公開版は基盤とつながらないので使わない)。 */
      agreements?: unknown;
    } = {},
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
  /** 取れないので空(**提示できない文面に同意させない**)。 */
  fetchDocuments(
    _docTypes: readonly string[] = [],
    _lang = "ja",
    _options: { accountId?: string } = {},
  ): Promise<LegalDocument[]> {
    return Promise.resolve([]);
  }
}

export interface LegalDocument {
  docType: string;
  version?: string;
  body: string;
  format: string;
  canonicalLang?: string;
  isTranslation: boolean;
  requiresReconsent: boolean;
}

/** 規約の本文のかたまり(正本は entamy-connect/web/ui の document.ts)。 */
export type LegalBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[] };

/** 本文を解かずに 1 段落として返す(スタブでは文書が取れないので使われない)。 */
export function parseLegalBody(body: string, _format = "markdown"): LegalBlock[] {
  return body.trim() ? [{ kind: "paragraph", text: body.trim() }] : [];
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

// ── お知らせ ────────────────────────────────────────────────────────────
/** 何も引かない。お知らせが無いのと同じに見える(画面は「お知らせはありません」)。 */
export type EntamyNoticeKind =
  | "critical"
  | "important"
  | "info_product"
  | "info_other";
export interface EntamyNoticeItem {
  id: string;
  kind: EntamyNoticeKind;
  section: "product" | "other";
  lang: string;
  title: string;
  body: string;
  action: { kind: "ack" | "open"; label?: string | null; url?: string };
  publishedAt: string | null;
  direct?: boolean;
  topic?: string;
  answers?: Array<{ id: string; label: string; url?: string }>;
}
export interface EntamyNoticeState {
  notices: EntamyNoticeItem[];
  acked: string[];
  otherEnabled: boolean;
  signedIn: boolean;
  fetchedAt: string | null;
}
const EMPTY_NOTICES: EntamyNoticeState = {
  notices: [],
  acked: [],
  otherEnabled: true,
  signedIn: false,
  fetchedAt: null,
};
export class EntamyNotice {
  constructor(
    readonly config: EntamyConfig,
    readonly session: EntamySession,
    readonly store: EntamyStore,
    readonly options: {
      version?: string;
      platform?: "ios" | "android" | "web";
      lang?: string;
      timeZone?: string;
    } = {},
  ) {}
  load(): Promise<EntamyNoticeState> {
    return Promise.resolve(EMPTY_NOTICES);
  }
  state(): EntamyNoticeState {
    return EMPTY_NOTICES;
  }
  refresh(): Promise<EntamyResult<EntamyNoticeState>> {
    return refuse<EntamyNoticeState>();
  }
  dialogs(): EntamyNoticeItem[] {
    return [];
  }
  unreadCount(): number {
    return 0;
  }
  ack(_id: string): Promise<EntamyResult<boolean>> {
    return refuse<boolean>();
  }
  setOtherEnabled(_enabled: boolean): Promise<EntamyResult<boolean>> {
    return refuse<boolean>();
  }
  answer(_id: string, _answer: string): Promise<EntamyResult<boolean>> {
    return refuse<boolean>();
  }
  history(_page = 1): Promise<EntamyResult<EntamyNoticeHistory>> {
    return refuse<EntamyNoticeHistory>();
  }
}

/** 読んだものの一覧(公開版は基盤とつながらないので、いつも断る)。 */
export interface EntamyNoticeHistory {
  items: Array<{ id: string; kind: string; title: string; body: string; at: string; answer: string | null; answerLabel: string | null }>;
  page: number;
  pages: number;
  total: number;
}

// ── 不具合の報告 ────────────────────────────────────────────────────────
/** 何も送らない。報告は本体でも「失敗しても黙って戻る」ので、呼ぶ側の挙動は変わらない。 */
export class EntamyDefects {
  constructor(
    readonly config: EntamyConfig,
    readonly session: EntamySession,
  ) {}
  report(
    _code: string,
    _options: {
      osVersion?: string;
      deviceModel?: string;
      detail?: Record<string, unknown>;
      verbose?: string;
      record?: boolean;
    } = {},
  ): Promise<EntamyFailure | null> {
    return Promise.resolve(null);
  }
}

// ── 接続元の登録（IP 制限）の共通部分 ─────────────────────────────────────
// 本体は回線を判定し、登録した回線からだけ管理画面に入れる。スタブは**回線が
// 分からない**（requestNetwork が null）として振る舞うので、KuroCMS の IP 制限は
// 掛からない（ログインそのものは動く）。配布されている worker.js には本体が入っている。
export type IpGateFamily = "v4" | "v6";
export interface Network {
  family: IpGateFamily;
  net: string;
  ip: string;
}
export interface IpGateConfig {
  enabled: boolean;
  ipv6: boolean;
  ipv4: boolean;
  ttl_v6_days: number;
  ttl_v4_days: number;
  pat: boolean;
  trial_until: number | null;
}
export interface IpGateDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
      all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
      run(): Promise<{ meta?: { changes?: number } }>;
    };
  };
}
export interface IpGateStore {
  db: IpGateDb;
  table: string;
  scope: string;
}
export const IP_GATE_REQUEST_TTL_MS = 30 * 60 * 1000;
export const IP_GATE_MAX_PER_SUBJECT = 20;
export const IP_GATE_PINNED_UNTIL = 253402300799000;
export class NetInputError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
// 手で足す回線も、スタブでは受けない（制限そのものが掛からない）。
export function parseManualNet(_raw: string): {
  family: IpGateFamily;
  net: string;
} {
  throw new NetInputError(
    "unavailable",
    "IP restriction is not available in this build.",
  );
}
export function requestNetwork(_request: Request): Network | null {
  return null;
}
export function lineDescription(_request: Request): string {
  return "";
}
export const shownNet = (
  net: string,
  description: string | null | undefined,
): string => (description ? `${net} · ${description}` : net);
export function normalizeIpGateConfig(
  v: Partial<IpGateConfig>,
  defaults: IpGateConfig,
): IpGateConfig {
  return { ...defaults, ...v };
}
export const familyAllowed = (cfg: IpGateConfig, f: IpGateFamily): boolean =>
  f === "v6" ? cfg.ipv6 : cfg.ipv4;
export async function subjectAllowed(
  _store: IpGateStore,
  _cfg: IpGateConfig,
  _subject: string,
  _conn: Network | null,
  _now: number,
): Promise<boolean> {
  return true;
}
export async function connectionCount(
  _store: IpGateStore,
  _subject: string,
  _now: number,
): Promise<number> {
  return 0;
}
export async function registerConnection(
  _store: IpGateStore,
  _cfg: IpGateConfig,
  _subject: string,
  _conn: Network,
  _label: string,
  _now: number,
): Promise<boolean> {
  return false;
}
export async function purgeExpiredConnections(
  _store: IpGateStore,
  _now: number,
): Promise<number> {
  return 0;
}

/**
 * 稼働地域(本体は entamy-connect の worker/src/region.ts)。公開ミラーでは測らず、
 * すべて「分からない」(null)を返す。設定の「稼働地域」は「不明」と出す。
 */
export async function regionReport(
  _db: unknown,
  _request: Request,
  _lang: string,
): Promise<{
  worker_colo: string | null;
  entry_colo: string | null;
  d1_region: string | null;
  d1_colo: string | null;
  d1_primary: boolean | null;
  rtt_ms: number | null;
  same: boolean | null;
  names: {
    worker: string | null;
    entry: string | null;
    d1_region: string | null;
    d1_colo: string | null;
  };
}> {
  return {
    worker_colo: null,
    entry_colo: null,
    d1_region: null,
    d1_colo: null,
    d1_primary: null,
    rtt_ms: null,
    same: null,
    names: { worker: null, entry: null, d1_region: null, d1_colo: null },
  };
}

/**
 * 公開サイトの CSP(本体は entamy-connect の service/src/csp.ts)。公開ミラーでは
 * 見出しを付けず(空)、報告も読まない。配布する worker.js には本体が入る。
 */
/** 応答ごとの nonce(16 バイトの乱数を base64)。正本と同じ。 */
export function cspNonce(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b));
}

/** HTML のインラインの `<script>` に nonce を付ける。正本と同じ。 */
export function withScriptNonce(html: string, nonce: string): string {
  return html.replace(/<script(?=[\s>])/g, `<script nonce="${nonce}"`);
}

export function cspHeaders(_o: {
  mode: "report" | "enforce";
  productId: string;
  nonce?: string;
  reportUri?: string;
  scriptSrc?: string[];
  connectSrc?: string[];
  imgSrc?: string[];
  frameSrc?: string[];
  styleSrc?: string[];
  fontSrc?: string[];
  frameAncestors?: string[];
}): Record<string, string> {
  return {};
}

export function parseCspReports(
  _body: unknown,
): Array<{
  directive: string;
  blocked: string;
  disposition: "report" | "enforce";
}> {
  return [];
}
