/**
 * KuroCMS の機能の旗の表(仕様 core-feature-flags 3節)。旗が効くかは entamy-connect の flagOn だけで決める。
 *
 * - 'dev' は持ち主が開発アカウントのサイトにだけ効く(api.ts の ownerIsDeveloper —— 導入の口座のトークンの dev)。
 * - 旗は「見せるか」だけ。サーバーの口もサーバーで旗を見る(画面で隠すだけにしない)。
 * - 一般へ出すときは audience を 'all' に変えて安定版で出す。
 */
import {
  defineFlags,
  flagOn,
} from "./vendor/entamy-flags/flags.ts";

export const FLAGS = defineFlags({
  /** 「Threads と接続」: Meta の許可画面から長期トークンを受け取る(threads-connect.ts)。 */
  "threads-connect": {
    audience: "all",
    since: "2026-11-06",
    owner: "cms-sns",
  },
});

export type CmsFlag = keyof typeof FLAGS;

export function cmsFlagOn(id: CmsFlag, developer: boolean): boolean {
  return flagOn(FLAGS, id, { developer });
}
