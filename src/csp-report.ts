/**
 * 公開サイトの CSP の違反の報告を受ける口(`{publicBase}/_csp`・cms-cms-security「CSP」)。
 *
 * ## なぜ Defects へ直接送らせないか
 *
 * ブラウザーから Entamy へ直接送らせると、読者の IP とページの URL が Entamy に届く ——
 * 顧客運用の約束(データはお客様の口座だけ・不具合の報告は符号と数値だけ)に反する。
 * だからサイトが受けて、**指示・出どころ(ホスト名か inline などの種類)・報告だけか止めたか**
 * だけにする。絞り方は Defects の受け口と同じ部品(entamy-connect の parseCspReports)。
 *
 * ## 数える・初めての組だけ送る
 *
 * 同じ違反は何百件も届く。D1 の表で組ごとに数を足すだけにし、**初めて見た組の時だけ**
 * Defects へ `csp_violation` を送る(導入の名乗りで送るので、どのサイトかが分かる)。
 * 誰でも送れる口なので、組の数に上限を置き、上限を超えた新しい組は数えない。
 */
import { readLimitedText } from "./http.ts";
import { parseCspReports } from "./vendor/entamy-client/index.ts";
import { entamyPort } from "./entamy-port.ts";
import type { Env } from "./types.ts";

/** 数える組の上限。正しいサイトの漏れは数十組に収まる。超えるのは悪戯の報告。 */
export const CSP_REPORT_MAX_KINDS = 200;
/** 読む本文の上限(ブラウザーの報告は数 KB)。 */
const MAX_BODY = 64 * 1024;

export async function cspReportEndpoint(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  // 上限まで読んで打ち切る(全部読んでから大きさを見ない・課題 cfaaee70)。超えたら数えない。
  const body = await readLimitedText(request, MAX_BODY).catch(() => "");
  // 管理画面は報告先に ?p=admin を付ける(site-csp.ts)。強制に上げてよいかを、頁の種類ごとに見るため。
  const page: CspPage =
    new URL(request.url).searchParams.get("p") === "admin" ? "admin" : "site";
  const fresh = await recordCspReports(env, body, Date.now(), page);
  if (fresh.length) {
    ctx.waitUntil(
      (async () => {
        try {
          const { defects } = await entamyPort(env);
          for (const v of fresh)
            await defects.report("csp_violation", { detail: { ...v } });
        } catch {
          /* 報告が通らないことは、報告したかった事実より軽い */
        }
      })(),
    );
  }
  // ブラウザーは応答を読まない。
  return new Response(null, { status: 204 });
}

/**
 * 報告の本文を数える。**初めて見た組**を返す(Defects へ送る分)。決して投げない。
 * ⚠ ここは cloudflare:workers を読まない(node で直接試験する)。
 */
export type CspPage = "site" | "admin";

export async function recordCspReports(
  env: Pick<Env, "DB">,
  raw: string,
  now = Date.now(),
  page: CspPage = "site",
): Promise<
  Array<{
    page: CspPage;
    directive: string;
    blocked: string;
    disposition: string;
  }>
> {
  if (!raw || raw.length > MAX_BODY) return [];
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return [];
  }
  const fresh: Array<{
    page: CspPage;
    directive: string;
    blocked: string;
    disposition: string;
  }> = [];
  for (const v of parseCspReports(body)) {
    try {
      const seen = await env.DB.prepare(
        `UPDATE csp_page_reports SET count = count + 1, last_at = ?4
          WHERE directive = ?1 AND blocked = ?2 AND disposition = ?3 AND page = ?5`,
      )
        .bind(v.directive, v.blocked, v.disposition, now, page)
        .run();
      if ((seen.meta?.changes ?? 0) > 0) continue;
      const added = await env.DB.prepare(
        `INSERT INTO csp_page_reports (page, directive, blocked, disposition, count, first_at, last_at)
         SELECT ?6, ?1, ?2, ?3, 1, ?4, ?4
          WHERE (SELECT COUNT(*) FROM csp_page_reports) < ?5
         ON CONFLICT (page, directive, blocked, disposition) DO NOTHING`,
      )
        .bind(
          v.directive,
          v.blocked,
          v.disposition,
          now,
          CSP_REPORT_MAX_KINDS,
          page,
        )
        .run();
      if ((added.meta?.changes ?? 0) > 0) fresh.push({ page, ...v });
    } catch {
      /* 表がまだ無い(移行前)・書けない —— 報告は捨ててよい */
    }
  }
  return fresh;
}

/** 管理画面に出す数(版・状態の画面)。多い順。 */
export async function cspReportSummary(env: Pick<Env, "DB">): Promise<{
  kinds: Array<{
    page: CspPage;
    directive: string;
    blocked: string;
    disposition: string;
    count: number;
    first_at: number;
    last_at: number;
  }>;
}> {
  const rows = await env.DB.prepare(
    `SELECT page, directive, blocked, disposition, count, first_at, last_at
       FROM csp_page_reports ORDER BY count DESC LIMIT ?1`,
  )
    .bind(CSP_REPORT_MAX_KINDS)
    .all<{
      page: CspPage;
      directive: string;
      blocked: string;
      disposition: string;
      count: number;
      first_at: number;
      last_at: number;
    }>()
    .catch(() => ({ results: [] }));
  return { kinds: rows.results ?? [] };
}
