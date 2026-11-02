/**
 * 委託の製品の共通の表と、委託の契約の状態(core-offering 7 節・cms-pricing・mushmanager-subscription)。
 *
 * 委託で出す製品(KuroCMS・MushManager と、これから足す製品)は、契約の頁・無料期間の終わりのお知らせ・
 * 契約の無い委託の読み取りだけ、を同じ仕組みで持つ。製品ごとに違うのはこの表の 1 行だけで、
 * 導入口(契約の頁を組む)・Notice(お知らせとメールの文)・製品の app(契約の状態を読んで書き込みを止める)が
 * ここを引く。**製品を足すときは、ここに 1 行足す。** 各所に製品名の分岐を書かない。
 *
 * 契約の頁は、どの製品も `{LP}/contract/`。LP はその道を導入口の `/installer/contract/{製品}` へ渡すだけで、
 * 頁のコードを持たない(導入口がこの表から組む)。
 */

/** 契約の枠が直接話す Billing(本番と、テスト課金の口座の試験)。LP の CSP の connect-src に足す。 */
export const BILLING_ORIGINS: readonly string[] = ["https://api.entamy-pay.com", "https://billing-test.paytest-41a.workers.dev"];

type Words = { ja: string; en: string };

export interface ManagedProduct {
  /** 画面に出す製品名。 */
  name: string;
  /** 宣伝ページ(LP)の origin。契約の頁は `{lp}/contract/`、導入の窓もこの origin から開く。 */
  lp: string;
  /** 契約の頁の色(枠の --accent など)。 */
  accent: string;
  accentSoft: string;
  /** LP で選んだ言葉を覚える localStorage の鍵(無ければブラウザの言葉)。 */
  langKey?: string;
  /** 自分の Cloudflare へ引っ越せる(お知らせに「引っ越す」を出す)。 */
  movable: boolean;
  /** 公開のサイトを持つ(お知らせに「公開中のページを見る」「このサイトを削除する」を出す)。 */
  site: boolean;
  /** 消えるデータの呼び名(お知らせとメール)。 */
  data: Words;
  /** データを手元に残す方法(無ければ書かない)。 */
  backup: Words | null;
  /**
   * 委託のサイトの、契約を見る画面の道(住所の後ろ・2026-11-02)。契約の頁は、製品から戻り先が渡らなかったときも、
   * 持ち主の委託のサイトの住所 + この道へ「{製品} に戻る」を出す(行き止まりにしない)。無ければ戻るボタンを出さない。
   */
  contractScreenPath?: string;
}

export const MANAGED_PRODUCTS: Readonly<Record<string, ManagedProduct>> = {
  cms: {
    name: "KuroCMS",
    lp: "https://kurocms.entamy.com",
    accent: "#f97316",
    accentSoft: "#fff1e6",
    langKey: "kurocms-lang",
    movable: true,
    site: true,
    data: { ja: "サイトのデータ（記事・メディア・設定）", en: "the site's data (articles, media and settings)" },
    backup: { ja: "管理画面の「バックアップ」から ZIP を書き出してください", en: "export a ZIP from Backup in the admin panel" },
    contractScreenPath: "/kurocms/admin/settings?tab=hosting",
  },
  mushmanager: {
    name: "MushManager",
    lp: "https://mush.entamy.com",
    accent: "#16a34a",
    accentSoft: "#e8f7ee",
    movable: false,
    site: false,
    data: { ja: "農場のデータ（ロット・収穫・販売・設定）", en: "the farm's data (lots, harvests, sales and settings)" },
    backup: null,
  },
};

export function managedProduct(id: string): ManagedProduct | null {
  return Object.prototype.hasOwnProperty.call(MANAGED_PRODUCTS, id) ? MANAGED_PRODUCTS[id]! : null;
}

/** 契約の頁(申し込み・契約の表示・解約・サイトの削除)。表に無い製品は null。 */
export function contractPageUrl(id: string): string | null {
  const p = managedProduct(id);
  return p ? `${p.lp}/contract/` : null;
}

/**
 * 委託の契約の状態。導入口が毎時、委託の D1 の contract_info(1 行)へ書く(Install の contract-sync.ts)。
 * 製品は同じ形の表を migration で持つ(KuroCMS 0077・0081・0084、MushManager 0004)。
 */
export interface ContractRow {
  contract_at: number;
  trial_ends_at: number | null;
  trial_final_at: number | null;
  subscription: string | null;
  subscription_until: number | null;
  delete_at: number | null;
  synced_at: number;
}

interface ContractDb {
  prepare(sql: string): { first<T>(): Promise<T | null> };
}

/** 契約の行。表が無い・まだ届いていないなら null(分からない時に止めない)。 */
export async function readContract(db: ContractDb): Promise<ContractRow | null> {
  try {
    return await db.prepare(
      "SELECT contract_at, trial_ends_at, trial_final_at, subscription, subscription_until, delete_at, synced_at FROM contract_info WHERE id = 1",
    ).first<ContractRow>();
  } catch {
    return null;
  }
}

/** 最後の無料期間が終わり、契約が無い(読み取りだけにする)。 */
export function lockedBy(row: Pick<ContractRow, "subscription" | "trial_final_at"> | null, now = Date.now()): boolean {
  if (!row || row.trial_final_at == null) return false;
  return (row.subscription ?? "none") === "none" && now > row.trial_final_at;
}

export async function contractLocked(db: ContractDb, now = Date.now()): Promise<boolean> {
  return lockedBy(await readContract(db), now);
}

/**
 * 止めている間も通す要求か。読む要求(GET・HEAD・OPTIONS)と、製品が名指しした口(ログイン・自分のこと・
 * 書き出しなど)だけを通す。
 */
export function lockAllows(method: string, path: string, allowed: RegExp): boolean {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS" || allowed.test(path);
}

/** 画面に出す契約の様子(製品の「契約」の節・読み取りだけの帯)。 */
export interface ContractView {
  /** unknown: まだ届いていない / trial: 無料期間 / subscribed: 契約あり / ended: 無料期間が終わり契約が無い(読み取りだけ) */
  state: "unknown" | "trial" | "subscribed" | "ended";
  locked: boolean;
  trial_ends_at: number | null;
  subscription_until: number | null;
  delete_at: number | null;
  /** 申し込み・解約の頁。 */
  contract_url: string | null;
}

export function contractView(row: ContractRow | null, productId: string, now = Date.now()): ContractView {
  const locked = lockedBy(row, now);
  const state = !row ? "unknown" : (row.subscription ?? "none") !== "none" ? "subscribed" : locked ? "ended" : "trial";
  return {
    state,
    locked,
    trial_ends_at: row?.trial_final_at ?? row?.trial_ends_at ?? null,
    subscription_until: row?.subscription_until ?? null,
    delete_at: state === "ended" || state === "trial" ? row?.delete_at ?? null : null,
    contract_url: contractPageUrl(productId),
  };
}
