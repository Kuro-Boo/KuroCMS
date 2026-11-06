/**
 * 機能の旗(仕様 core-feature-flags 3節・2026-11-02)。
 *
 * 各製品は自分のコードに旗の表を 1 つ持ち(`defineFlags`)、旗が効くかはここの `flagOn` だけで決める(製品ごとに書かない)。
 *
 *   export const FLAGS = defineFlags({
 *     contract_auto_return: { audience: 'dev', since: '2026-11-02', owner: 'billing' },
 *   });
 *   if (flagOn(FLAGS, 'contract_auto_return', claims)) …
 *
 * - `audience: 'dev'` は開発アカウント(トークンの `dev`)にだけ、`'all'` は全員に効く。一般へ出すときは 'all' に変えて安定版で出す。
 * - 旗は「見せるか」だけに使う。権限・お金の判断に使わない。サーバーの処理はサーバーで旗を見る。
 * - `stopped` は Admin の「止める旗の一覧」(止めるだけ・点けられない)。載っていれば、audience にかかわらず効かない。
 * - 旗の id は commit の「Flag:」行と同じ形(ops/flag_trailer.mjs)。since と owner は古い 'dev' の旗を知らせるのに使う。
 */

export type FlagAudience = 'dev' | 'all';

export interface FlagDef {
  audience: FlagAudience;
  /** 足した日(YYYY-MM-DD)。 */
  since: string;
  /** 受け持ち(部分・機能の名前)。 */
  owner: string;
}

const ID_RE = /^[a-z][a-z0-9_.-]{1,63}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 旗の表を作る。id・since・owner の形が違えば、作った時点で投げる(足し間違いを試験で見つける)。 */
export function defineFlags<T extends Record<string, FlagDef>>(flags: T): Readonly<T> {
  for (const [id, f] of Object.entries(flags)) {
    if (!ID_RE.test(id)) throw new TypeError(`flag id ${id} must match ${ID_RE}`);
    if (f.audience !== 'dev' && f.audience !== 'all') throw new TypeError(`flag ${id}: audience must be dev or all`);
    if (!DAY_RE.test(f.since)) throw new TypeError(`flag ${id}: since must be YYYY-MM-DD`);
    if (!f.owner) throw new TypeError(`flag ${id}: owner is required`);
  }
  return Object.freeze({ ...flags });
}

/** その旗が、この人に効くか。表に無い旗は効かない(足し忘れを開ける側に倒さない)。 */
export function flagOn(
  flags: Readonly<Record<string, FlagDef>>,
  id: string,
  who: { developer?: boolean } | null | undefined,
  stopped: ReadonlySet<string> | readonly string[] = [],
): boolean {
  const f = Object.prototype.hasOwnProperty.call(flags, id) ? flags[id] : undefined;
  if (!f) return false;
  if ((stopped instanceof Set ? stopped : new Set(stopped)).has(id)) return false;
  return f.audience === 'all' || (f.audience === 'dev' && who?.developer === true);
}

/** 足してから days 日を過ぎた 'dev' の旗(一般へ出すか、消すかを決める時期)。検査が知らせるのに使う。 */
export function staleDevFlags(flags: Readonly<Record<string, FlagDef>>, today: string, days = 60): string[] {
  const t = Date.parse(`${today}T00:00:00Z`);
  return Object.entries(flags)
    .filter(([, f]) => f.audience === 'dev' && t - Date.parse(`${f.since}T00:00:00Z`) > days * 86_400_000)
    .map(([id]) => id);
}
