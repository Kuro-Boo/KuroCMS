// 型定義: src/kuro-links.js（DOM 非依存の [[...]] リンク/メディアレンダラ）。
// KuroEditor が単一の正として保守し、dist/kuro-links.d.ts として emit する。
// ホスト（KuroCMS 等）はこれを vendored して型安全に判定ロジックを共有する。

/** classifyLink が返すホスト非依存の記述子（判定結果）。マークアップ生成は各ホストの責務。 */
export type LinkDescriptor =
  | { kind: "card"; raw: string; url: string }
  | { kind: "urlcard"; slug: string; url: string }
  | {
      kind: "iframe";
      slug: string;
      url: string;
      embedUrl: string;
      size: string | null;
      align: string | null;
    }
  | {
      kind: "media";
      slug: string;
      url: string;
      size: string | null;
      align: string | null;
      link: string | null;
      mediaKind: "video" | "audio" | "image";
      /** ホストの supportedKinds に mediaKind が含まれないとき true。ホストは
       *  再生要素でなく通常リンクに落とす（data-kuro-media でトークンは保持）。 */
      unsupported: boolean;
    }
  | { kind: "wikilink"; slug: string; url: string; label: string; isExternal: boolean }
  | { kind: "hyperlink"; slug: string; url: string; isExternal: boolean }
  | { kind: "text" };

export interface LinkGroups {
  card?: string;
  wikiSlug?: string;
  wikiLabel?: string;
  hyper?: string;
}

export type SlugResolver = (slug: string) => string;

/** 共有 [[...]] トークン正規表現（card > wiki > hyper の単一パス）。 */
export const LINK_TOKEN_RE: RegExp;

/**
 * メディア資産 ID の接頭辞（img-/vid-/aud-/mid-）。slug がこれに一致すれば
 * 「これはメディア」の正規シグナル（拡張子網羅に依存しない判定）。
 */
export const MEDIA_ID_RE: RegExp;

/** ホストが表示に対応するメディア種別の集合（null = 全対応）。 */
export type MediaKind = "image" | "video" | "audio";
export type SupportedKinds = Set<MediaKind> | null;

/**
 * メディア種別を【接頭辞】で確定する（vid-→video / aud-→audio / img-・mid-→image）。
 * 接頭辞が付かない裸 http URL のときだけ URL 拡張子でフォールバック（既定 image）。
 * blob: の様に拡張子の無い URL でも接頭辞から正しく判定できる。
 */
export function mediaKindFromSlug(slug: string, url?: string): MediaKind;

/** ホストの mediaKinds 宣言を Set に正規化（falsy / 空 → null = 全対応）。 */
export function normalizeMediaKinds(
  kinds: MediaKind[] | MediaKind | null | undefined,
): SupportedKinds;

/**
 * 1 つの [[...]] トークンをホスト非依存の記述子へ分類する。メディア判定・埋め込み
 * 判定・パラメータ解析・優先順位という「editor と public で一致すべき判定」を
 * 一本化する。マークアップの emit は各ホストが記述子から行う。
 * supportedKinds を渡すと、対応外種別のメディアに unsupported:true を立てる。
 */
export function classifyLink(
  groups: LinkGroups,
  resolver?: SlugResolver,
  supportedKinds?: SupportedKinds,
): LinkDescriptor;

/** [[...]] を editor 用マークアップ（round-trip 用 data-kuro-* 付き）へ展開。
 *  supportedKinds を渡すと、対応外種別は通常リンクに落として描画する。 */
export function renderSpecialLinks(
  text: string,
  resolver?: SlugResolver,
  supportedKinds?: SupportedKinds,
): string;

/** 既定 slug→URL 解決（http は外部、その他は相対パス）。 */
export function defaultResolver(slug: string): string;

/** YouTube/Vimeo 等の埋め込み URL を返す（非対応は null）。 */
export function resolveEmbedUrl(url: string): string | null;

/** メディア slug のパラメータ部（"size,align|link"）を解析。 */
export function parseMediaParams(params: string): {
  size: string | null;
  align: string | null;
  link: string | null;
};

/** wikiLabel が表示テキストでなくメディアパラメータらしいかの判定。 */
export function _looksLikeMediaParams(label: string): boolean;

/** data-kuro-media 属性値（URI エンコード済み [[slug|params]]）を組む。 */
export function buildMediaAttr(
  slug: string,
  size?: string | null,
  align?: string | null,
  link?: string | null,
): string;

/** URL カード内部（アイコン＋タイトル/URL＋任意メタ）のマークアップ。 */
export function _urlCardInner(
  slug: string,
  url: string,
  meta?: { title?: string; description?: string; favicon?: string; image?: string } | null,
): string;

/** URL カードのアンカー（[[slug|]]、editor 用）。 */
export function _buildUrlCard(slug: string, url: string): string;

/** URL カードの「読込みエラー」内側マークアップ（対象 404/到達不可）。呼び手は
 *  `kuro-url-card--error` を付与。editor と公開クライアントが同一表示を出す単一の正。 */
export function _urlCardErrorInner(slug: string, url: string): string;

/** メディア(img/vid/aud)の src ロード失敗プレースホルダ `.kuro-media-broken` の
 *  マークアップ。editor の error ハンドラと公開の error リスナが共有する単一の正。 */
export function buildBrokenMedia(src: string): string;

/** 埋め込み iframe の figure（editor 用）。 */
export function _buildIframeFigure(
  embedUrl: string,
  enc: string,
  size: string | null,
  align: string | null,
): string;

/** HTML テキスト/属性値としての安全なエスケープ。 */
export function _escapeHtml(s: unknown): string;

/** favicon/og:image 用に http(s)・data:image のみ許可（それ以外は空文字）。 */
export function _safeImgUrl(u: unknown): string;

export const MEDIA_EXT_RE: RegExp;
export const VIDEO_EXT_RE: RegExp;
export const AUDIO_EXT_RE: RegExp;
export const URL_CARD_ICON: string;
