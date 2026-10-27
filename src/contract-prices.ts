/**
 * 委託契約の料金(設定の「契約」タブ・cms-pricing「契約のタブ」・2026-10-27)。
 *
 * 料金の正本は Entamy Billing の公開の価格表(GET /api/v1/catalog)。CMS は値を持たず、タブを開いたときに
 * サーバーから引く(ブラウザーから Billing へは送らない —— Billing は全顧客のドメインからの要求を許さない)。
 * 公開中の価格が無い(売り出す前・その通貨はまだ売らない)なら、その通貨の料金は出さない。
 *
 * 料金は日本(円)・米国(米ドル)・欧州(ユーロ)で決めてある(cms-pricing「払い方」)。初めに出す地域は
 * 要求の国(Cloudflare の request.cf.country)から選ぶ。EU の加盟国は欧州、日本は日本、ほかは米国。
 */
import { resolveConfig } from "./vendor/entamy-client/index.ts";
import { PRODUCT_ID } from "./entamy-port.ts";
import { KUROCMS_VERSION } from "./version.ts";

export type PriceRegion = "jp" | "us" | "eu";

export const REGION_CURRENCY: Record<PriceRegion, string> = {
  jp: "JPY",
  us: "USD",
  eu: "EUR",
};

// EU の加盟国(27・ISO 3166-1 alpha-2)。
const EU = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
]);

export function regionOf(country: string | null | undefined): PriceRegion {
  const c = String(country || "").toUpperCase();
  if (c === "JP") return "jp";
  if (EU.has(c)) return "eu";
  return "us";
}

/** 定期の 1 つの価格(額は通貨の最小単位の整数・税込み)。 */
export interface PlanPrice {
  period: "month" | "year";
  currency: string;
  amount_minor: number;
}

/** 公開中の定期の価格。Billing に届かなければ null(画面は「契約の頁でご確認ください」と出す)。 */
export async function catalogPrices(): Promise<PlanPrice[] | null> {
  const base = resolveConfig({
    productId: PRODUCT_ID,
    appVersion: KUROCMS_VERSION,
  }).billingBaseUrl;
  if (!base) return null;
  try {
    const res = await fetch(
      `${base}/api/v1/catalog?product_id=${encodeURIComponent(PRODUCT_ID)}`,
      {
        signal: AbortSignal.timeout(5_000),
        cf: { cacheTtl: 300, cacheEverything: true },
      } as RequestInit,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { prices?: unknown };
    const list = Array.isArray(body.prices) ? body.prices : [];
    const out: PlanPrice[] = [];
    for (const p of list as Record<string, unknown>[]) {
      if (!p || p.sale !== "recurring") continue;
      if (p.period !== "month" && p.period !== "year") continue;
      if (
        typeof p.currency !== "string" ||
        !Number.isSafeInteger(p.amount_minor)
      )
        continue;
      out.push({
        period: p.period,
        currency: p.currency.toUpperCase(),
        amount_minor: p.amount_minor as number,
      });
    }
    return out;
  } catch {
    return null;
  }
}
