// 型定義: src/blocks.js（DOM 非依存のブロック単位 tokenizer / 3-way マージ）。
// KuroEditor が単一の正として保守し、dist/kuro-blocks.d.ts として emit する。
// ホスト（KuroCMS 等）はこれを vendored する（手書き .d.ts のドリフトを断つ）。

export type KuroBlockSegment = {
  html: string;
  bid: string | null;
};

export type MergeConflict = {
  bid: string | null;
  base: string | null;
  local: string | null;
  remote: string | null;
};

export type MergeResult = {
  html: string;
  conflicts: MergeConflict[];
  warnings: string[];
};

/** bid 文字列が有効な形式か。 */
export function isValidBid(id: unknown): boolean;

/** 新しい一意な bid を生成するファクトリの既定実装。 */
export function defaultBidFactory(): string;

/** data-bid / data-cbid を公開 HTML から除去する（構造走査・DOM 非依存）。 */
export function stripInternalIds(html: string): string;

/** data-bid のみを除去する（data-cbid は残す）。 */
export function stripBlockIds(html: string): string;

/** トップレベルブロックの HTML 文字列配列へ分割。 */
export function splitTopLevelBlocks(html: string): string[];

/** トップレベルブロックへの分解（空白ランは除去。壊れた HTML は []）。 */
export function parseBlocks(html: string): KuroBlockSegment[];

/** 全トップレベルブロックへ一意な data-bid を保証する（欠落・不正・重複は採番）。 */
export function normalizeBlockIds(html: string, idFactory?: () => string): string;

/**
 * ブロック単位 3-way マージ。勝敗は決めない: 分岐ブロックは html に local を
 * 保持し conflicts に三つ組を報告する（解決はホストの責務）。
 */
export function mergeBlocks(
  baseHtml: string,
  localHtml: string,
  remoteHtml: string,
): MergeResult;

/** 1 ブロックの 3-way マージ判定（内部ユーティリティ）。 */
export function mergeBlock(
  base: string | null,
  local: string | null,
  remote: string | null,
): { html: string | null; conflict: boolean };

/** 分岐を複製で解決（local 保持 + remote を新 bid で直後に挿入 = データ非消失）。 */
export function resolveConflictsAsDuplicates(
  result: MergeResult,
  idFactory?: () => string,
): string;

/** ブロック順序を既知集合に照らして整合させる。 */
export function reconcileOrder(order: string[], known: Iterable<string>): string[];

/** before→after のブロック差分を操作列として返す。 */
export function diffBlocks(before: string, after: string): unknown[];

/** diffBlocks の操作列を before に適用して after 相当を得る。 */
export function applyBlockOps(before: string, ops: unknown[]): string;
