// 契約テスト (node で直接実行: `node src/contract-prices.test.ts`)。
//
// 設定の「契約」タブの料金(cms-pricing「契約のタブ」)。初めに出す地域は要求の国から選び、
// 料金は Billing の価格表の定期の月払い・年払いだけを拾う。届かなければ null(画面は契約の頁へ案内する)。
import { catalogPrices, regionOf } from "./contract-prices.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
  }
};

console.log("① 要求の国から地域");
check("日本は日本", regionOf("JP") === "jp");
check(
  "EU の加盟国は欧州(小文字も)",
  regionOf("de") === "eu" && regionOf("FR") === "eu",
);
check("EU 外の欧州の国は米国", regionOf("GB") === "us");
check("国が無ければ米国", regionOf(null) === "us");

console.log("② Billing の価格表");
const realFetch = globalThis.fetch;
globalThis.fetch = (async () =>
  Response.json({
    prices: [
      {
        sale: "recurring",
        period: "month",
        currency: "jpy",
        amount_minor: 980,
      },
      {
        sale: "recurring",
        period: "year",
        currency: "JPY",
        amount_minor: 6000,
      },
      { sale: "one_time", period: null, currency: "JPY", amount_minor: 100 },
    ],
  })) as typeof fetch;
const got = await catalogPrices();
check(
  "定期の月払い・年払いだけを拾う",
  JSON.stringify(got) ===
    JSON.stringify([
      { period: "month", currency: "JPY", amount_minor: 980 },
      { period: "year", currency: "JPY", amount_minor: 6000 },
    ]),
  JSON.stringify(got),
);
globalThis.fetch = (async () =>
  new Response("", { status: 503 })) as typeof fetch;
check("届かなければ null", (await catalogPrices()) === null);
globalThis.fetch = realFetch;

if (failures) {
  console.error(`\n${failures} 件失敗`);
  process.exit(1);
}
console.log("\nすべて通りました");
