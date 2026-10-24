/**
 * 公開サイトの準備中(初期化の後、テンプレートを選ぶまで・課題 ae0d3248)。
 *
 * テンプレートが無いと公開ページを組み立てられず、loadTemplate が投げて 500 になっていた ——
 * 導入直後に公開 URL を開いたお客様には壊れて見える。公開の入口は、組み立てが失敗した時だけ
 * ここで確かめ、準備中なら準備中の頁(503)を返す。
 *
 * ⚠ ここは cloudflare:workers を読まない(node で直接試験する)。
 */
import { isKuroCmsHtmlTemplate } from "./templates/html-template.ts";
import type { Env } from "./types.ts";

/** テンプレートがまだ使える形で選ばれていないか。loadTemplate が投げる場面と同じ条件で見る。 */
export async function templateNotChosen(
  env: Pick<Env, "DB">,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT t.source_html AS source_html
       FROM site_settings s
       LEFT JOIN page_templates t ON t.id = s.template_id
      WHERE s.id = 1`,
  )
    .first<{ source_html: string | null }>()
    .catch(() => null);
  return !row || !isKuroCmsHtmlTemplate(row.source_html);
}
