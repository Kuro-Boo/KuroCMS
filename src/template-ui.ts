/**
 * 当社の組み込み部品のサイト文字(cms-cms-template 9.11・2026-10-25)。
 *
 * テンプレートは JS を書かず、`[[…]]` を置く。ここがパーサーの前にそれを展開する:
 *   - 動きの部品(`[[toggle:…]]` など)は部品の印(data-kuro-… の属性)にする。動かすのは公開ページで必ず読まれる
 *     当社の JS(src/site/kuro-site.ts)。テンプレートに `<script>` が無いので、サイトの CSP(自分のファイルだけ)でも動く
 *   - `[[counts]]`・`[[tailwind]]` は、前の書き方の当社の script に戻す(読み込み・Tailwind の静的 CSS への置き換えは
 *     前のとおり)
 * 名前・組・値は英小文字・数字・`-`・`_`(40 字まで)。形の違うものは展開しない(空にする —— 作者の書き損じを
 * 部品の印にしない)。
 */

const NAME = "[a-z0-9_-]{1,40}";

/**
 * 部品の一覧(説明の正本)。宣伝ページの「テンプレートのコード」の頁(LP_Template/src/pages/template-codes.astro)は
 * これを読んで描く —— 頁に手で書かない。どの例も expandTemplateParts で展開されることを試験が縛る
 * (template-ui.test.ts)。部品を足すときは、展開のコード・kuro-site.ts の動き・この一覧を一緒に直す。
 */
export interface TemplatePart {
  code: string;
  /** 置く場所。 */
  where: { ja: string; en: string };
  ja: string;
  en: string;
  /** そのまま展開できる例(試験が使う)。 */
  example: string;
}

export const TEMPLATE_PARTS: readonly TemplatePart[] = [
  {
    code: "[[toggle:{name}]]",
    where: { ja: "ボタンの開きタグの中", en: "Inside a button's opening tag" },
    ja: "押すと、同じ名前の [[panel:…]] の要素に class open を付け外しし、ボタンの aria-expanded を変える",
    en: "On click, toggles class open on the [[panel:…]] element with the same name and updates the button's aria-expanded",
    example: "<button [[toggle:nav]]>Menu</button>",
  },
  {
    code: "[[panel:{name}]]",
    where: {
      ja: "開け閉めする要素の開きタグの中",
      en: "Inside the opening tag of the element to open and close",
    },
    ja: "[[toggle:…]] の相手。閉じた見た目・開いた見た目は CSS で .open に付ける",
    en: "The target of [[toggle:…]]. Style the closed and open looks with CSS on .open",
    example: "<nav [[panel:nav]]>…</nav>",
  },
  {
    code: "[[tab:{group}]]",
    where: {
      ja: 'タブのボタンの開きタグの中。値は data-tab-value="web"（[[…]] の値を入れてよい。省くと「すべて」）',
      en: 'Inside a tab button\'s opening tag, with data-tab-value="web" ([[…]] values allowed; omit it for “all”)',
    },
    ja: '押すと、同じ組の [[tabitem:…]] のうち data-tab-values（空白区切り）にタブの値を含むものだけを見せ、押したタブに aria-pressed="true" を付ける。初めは値の無いタブ（すべて）が押された形。見た目は CSS で [aria-pressed="true"] に付ける（Tailwind なら aria-pressed:bg-…）',
    en: 'On click, shows only the [[tabitem:…]] items of the same group whose data-tab-values (space-separated) contain the tab\'s value, and sets aria-pressed="true" on the pressed tab. The tab without a value (“all”) starts pressed. Style it with CSS on [aria-pressed="true"] (in Tailwind, aria-pressed:bg-…)',
    example:
      '<button [[tab:works]]>All</button><button [[tab:works]] data-tab-value="web">Web</button>',
  },
  {
    code: "[[tabitem:{group}]]",
    where: {
      ja: '絞り込まれる項目の開きタグの中。値は data-tab-values="web design"',
      en: 'Inside a filtered item\'s opening tag, with data-tab-values="web design"',
    },
    ja: "[[tab:…]] の相手",
    en: "The target of [[tab:…]]",
    example:
      '<article [[tabitem:works]] data-tab-values="web design">…</article>',
  },
  {
    code: "[[linkfrom:{name}]]",
    where: { ja: "リンクの開きタグの中", en: "Inside a link's opening tag" },
    ja: "頁の中の最初の a[data-{name}][href] の href を写す（http・https だけ）。記事の本文の印を表紙のリンクに使う、など",
    en: "Copies the href of the first a[data-{name}][href] on the page (http and https only), e.g. to link a cover to a URL marked in the article body",
    example: '<a class="cover" [[linkfrom:brand-site]]>…</a>',
  },
  {
    code: "[[counts]]",
    where: { ja: "どこでも", en: "Anywhere" },
    ja: "ナビの記事数を出す（/_counts.js を読む）",
    en: "Fills in the article counts in the navigation (loads /_counts.js)",
    example: "[[counts]]",
  },
  {
    code: "[[tailwind]] / [[tailwind:{plugins}]]",
    where: { ja: "<head> の中", en: "Inside <head>" },
    ja: "Tailwind を使う（KuroCMS が静的な CSS に置き換える）。プラグインはカンマ区切り（例 typography,forms）",
    en: "Use Tailwind (KuroCMS swaps it for static CSS). Plugins are comma-separated (e.g. typography,forms)",
    example: "[[tailwind:typography,forms]]",
  },
];
const TAILWIND_CDN = "https://cdn.tailwindcss.com";

/** 前の書き方に戻す当社の script(`[[counts]]`・`[[tailwind]]`・`[[tailwind:typography,forms]]`)。 */
export function expandOwnScriptTokens(html: string): string {
  if (!html.includes("[[counts]]") && !html.includes("[[tailwind")) return html;
  return html
    .split("[[counts]]")
    .join('<script src="[[site.basePath]]/_counts.js"></script>')
    .replace(
      /\[\[tailwind(?::([a-z0-9,-]{1,80}))?\]\]/g,
      (_m, plugins?: string) =>
        plugins
          ? `<script src="${TAILWIND_CDN}?plugins=${plugins}"></script>`
          : `<script src="${TAILWIND_CDN}"></script>`,
    );
}

const UI_RE = new RegExp(
  `\\[\\[(toggle|panel|tab|tabitem|linkfrom):(${NAME})\\]\\]`,
  "g",
);

/** 動きの部品を部品の印にする。開きタグの中に置かれる前提(属性を書く)。 */
export function expandUiTokens(html: string): string {
  if (!html.includes("[[")) return html;
  return html.replace(UI_RE, (_m, kind: string, name: string) => {
    if (kind === "toggle")
      return `data-kuro-toggle="${name}" aria-expanded="false"`;
    if (kind === "panel") return `data-kuro-panel="${name}"`;
    // 押された印(aria-pressed)は部品の JS が付ける(値の無いタブが初めに押された形)。
    if (kind === "tab") return `data-kuro-tab="${name}"`;
    if (kind === "tabitem") return `data-kuro-tabitem="${name}"`;
    return `data-kuro-linkfrom="${name}"`;
  });
}

/** 公開ページの描画の入口で掛ける(当社の script に戻してから、動きの部品を印にする)。 */
export function expandTemplateParts(html: string): string {
  return expandUiTokens(expandOwnScriptTokens(html));
}
