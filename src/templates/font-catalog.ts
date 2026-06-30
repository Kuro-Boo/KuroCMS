// Curated catalog of web fonts offered in the admin "Font Management" tab.
//
// Fonts are delivered from Google Fonts but SELF-HOSTED in KV (see src/fonts.ts):
// the catalog only declares which families are selectable. Japanese-friendly
// families come first since machine-independent typography is the main goal.
//
// The catalog lives only in the worker. The admin UI (built separately by
// scripts/build-admin.js) receives it via GET /api/fonts — do NOT duplicate it
// in admin sources.

export type FontCategory =
  | "jp"
  | "serif-jp"
  | "zh"
  | "serif-zh"
  | "kr"
  | "serif-kr"
  | "arabic"
  | "serif-arabic"
  | "sans"
  | "serif"
  | "display"
  | "mono";

export type FontScript =
  | "latin"
  | "japanese"
  | "chinese-simplified"
  | "chinese-traditional"
  | "korean"
  | "cyrillic"
  | "arabic";

export interface FontCatalogEntry {
  /** Google Fonts family name, used verbatim in CSS `font-family` and the API. */
  family: string;
  /** Display label for the admin list (kept equal to family for simplicity). */
  label: string;
  category: FontCategory;
  /** Scripts/language groups this family is a good base-font candidate for. */
  scripts: FontScript[];
  /** Weights loaded by default when the font is added (kept lean: regular+bold). */
  defaultWeights: number[];
}

/**
 * Built-in system font stacks. Always shown in the loaded list, selectable as the
 * base font, but machine-dependent — they cannot be removed/reordered (locked).
 */
export interface SystemFontEntry {
  id: string;
  label: string;
  /** CSS font-family stack applied when chosen as base font. */
  stack: string;
}

const FALLBACK: Record<FontCategory, string> = {
  jp: '"Hiragino Kaku Gothic ProN", "Yu Gothic", Meiryo, sans-serif',
  "serif-jp": '"Hiragino Mincho ProN", "Yu Mincho", serif',
  zh: '"Noto Sans CJK SC", "Microsoft YaHei", sans-serif',
  "serif-zh": '"Noto Serif CJK SC", SimSun, serif',
  kr: '"Noto Sans CJK KR", "Malgun Gothic", sans-serif',
  "serif-kr": '"Noto Serif CJK KR", Batang, serif',
  arabic: 'Tahoma, "Geeza Pro", sans-serif',
  "serif-arabic": '"Times New Roman", serif',
  sans: "ui-sans-serif, system-ui, sans-serif",
  serif: "ui-serif, Georgia, serif",
  display: "ui-sans-serif, system-ui, sans-serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

export const SYSTEM_FONTS: SystemFontEntry[] = [
  {
    id: "__sys_sans__",
    label: "システム ゴシック体 / System Sans",
    stack:
      'ui-sans-serif, system-ui, -apple-system, "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Yu Gothic", Meiryo, sans-serif',
  },
  {
    id: "__sys_serif__",
    label: "システム 明朝体 / System Serif",
    stack:
      'ui-serif, "Hiragino Mincho ProN", "Yu Mincho", YuMincho, "Noto Serif CJK JP", serif',
  },
  {
    id: "__sys_mono__",
    label: "システム 等幅 / System Mono",
    stack:
      'ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace',
  },
];

export const FONT_CATALOG: FontCatalogEntry[] = [
  // ── 日本語ゴシック ────────────────────────────────────────────────
  {
    family: "Noto Sans JP",
    label: "Noto Sans JP",
    category: "jp",
    scripts: ["japanese", "latin"],
    defaultWeights: [400, 700],
  },
  {
    family: "M PLUS 1p",
    label: "M PLUS 1p",
    category: "jp",
    scripts: ["japanese", "latin"],
    defaultWeights: [400, 700],
  },
  {
    family: "M PLUS Rounded 1c",
    label: "M PLUS Rounded 1c",
    category: "jp",
    scripts: ["japanese", "latin"],
    defaultWeights: [400, 700],
  },
  {
    family: "Zen Kaku Gothic New",
    label: "Zen Kaku Gothic New",
    category: "jp",
    scripts: ["japanese", "latin"],
    defaultWeights: [400, 700],
  },
  {
    family: "Zen Maru Gothic",
    label: "Zen Maru Gothic",
    category: "jp",
    scripts: ["japanese", "latin"],
    defaultWeights: [400, 700],
  },
  {
    family: "BIZ UDPGothic",
    label: "BIZ UDPGothic",
    category: "jp",
    scripts: ["japanese", "latin"],
    defaultWeights: [400, 700],
  },
  {
    family: "Kosugi",
    label: "Kosugi",
    category: "jp",
    scripts: ["japanese", "latin"],
    defaultWeights: [400],
  },
  {
    family: "Kosugi Maru",
    label: "Kosugi Maru",
    category: "jp",
    scripts: ["japanese", "latin"],
    defaultWeights: [400],
  },
  {
    family: "Sawarabi Gothic",
    label: "Sawarabi Gothic",
    category: "jp",
    scripts: ["japanese", "latin"],
    defaultWeights: [400],
  },
  {
    family: "Murecho",
    label: "Murecho",
    category: "jp",
    scripts: ["japanese", "latin"],
    defaultWeights: [400, 700],
  },
  {
    family: "RocknRoll One",
    label: "RocknRoll One",
    category: "jp",
    scripts: ["japanese", "latin"],
    defaultWeights: [400],
  },
  {
    family: "Kaisei Decol",
    label: "Kaisei Decol",
    category: "jp",
    scripts: ["japanese", "latin"],
    defaultWeights: [400, 700],
  },
  {
    family: "Mochiy Pop One",
    label: "Mochiy Pop One",
    category: "jp",
    scripts: ["japanese", "latin"],
    defaultWeights: [400],
  },
  {
    family: "Dela Gothic One",
    label: "Dela Gothic One",
    category: "display",
    scripts: ["japanese", "latin"],
    defaultWeights: [400],
  },
  {
    family: "Klee One",
    label: "Klee One",
    category: "jp",
    scripts: ["japanese", "latin"],
    defaultWeights: [400, 600],
  },
  // ── 日本語明朝 ──────────────────────────────────────────────────
  {
    family: "Noto Serif JP",
    label: "Noto Serif JP",
    category: "serif-jp",
    scripts: ["japanese", "latin"],
    defaultWeights: [400, 700],
  },
  {
    family: "Zen Old Mincho",
    label: "Zen Old Mincho",
    category: "serif-jp",
    scripts: ["japanese", "latin"],
    defaultWeights: [400, 700],
  },
  {
    family: "Shippori Mincho",
    label: "Shippori Mincho",
    category: "serif-jp",
    scripts: ["japanese", "latin"],
    defaultWeights: [400, 700],
  },
  {
    family: "BIZ UDPMincho",
    label: "BIZ UDPMincho",
    category: "serif-jp",
    scripts: ["japanese", "latin"],
    defaultWeights: [400],
  },
  {
    family: "Sawarabi Mincho",
    label: "Sawarabi Mincho",
    category: "serif-jp",
    scripts: ["japanese", "latin"],
    defaultWeights: [400],
  },
  {
    family: "Hina Mincho",
    label: "Hina Mincho",
    category: "serif-jp",
    scripts: ["japanese", "latin"],
    defaultWeights: [400],
  },
  {
    family: "Kaisei Tokumin",
    label: "Kaisei Tokumin",
    category: "serif-jp",
    scripts: ["japanese", "latin"],
    defaultWeights: [400, 700],
  },
  {
    family: "Yuji Syuku",
    label: "Yuji Syuku",
    category: "serif-jp",
    scripts: ["japanese", "latin"],
    defaultWeights: [400],
  },
  {
    family: "Zen Antique",
    label: "Zen Antique",
    category: "serif-jp",
    scripts: ["japanese", "latin"],
    defaultWeights: [400],
  },
  // ── 中国語・韓国語 ───────────────────────────────────────────────
  {
    family: "Noto Sans SC",
    label: "Noto Sans SC",
    category: "zh",
    scripts: ["chinese-simplified", "latin"],
    defaultWeights: [400, 700],
  },
  {
    family: "Noto Serif SC",
    label: "Noto Serif SC",
    category: "serif-zh",
    scripts: ["chinese-simplified", "latin"],
    defaultWeights: [400, 700],
  },
  {
    family: "Noto Sans TC",
    label: "Noto Sans TC",
    category: "zh",
    scripts: ["chinese-traditional", "latin"],
    defaultWeights: [400, 700],
  },
  {
    family: "Noto Serif TC",
    label: "Noto Serif TC",
    category: "serif-zh",
    scripts: ["chinese-traditional", "latin"],
    defaultWeights: [400, 700],
  },
  {
    family: "Noto Sans KR",
    label: "Noto Sans KR",
    category: "kr",
    scripts: ["korean", "latin"],
    defaultWeights: [400, 700],
  },
  {
    family: "Noto Serif KR",
    label: "Noto Serif KR",
    category: "serif-kr",
    scripts: ["korean", "latin"],
    defaultWeights: [400, 700],
  },
  // ── アラビア文字 ────────────────────────────────────────────────
  {
    family: "Noto Sans Arabic",
    label: "Noto Sans Arabic",
    category: "arabic",
    scripts: ["arabic", "latin"],
    defaultWeights: [400, 700],
  },
  {
    family: "Noto Naskh Arabic",
    label: "Noto Naskh Arabic",
    category: "serif-arabic",
    scripts: ["arabic", "latin"],
    defaultWeights: [400, 700],
  },
  // ── 欧文サンセリフ ──────────────────────────────────────────────
  {
    family: "Inter",
    label: "Inter",
    category: "sans",
    scripts: ["latin"],
    defaultWeights: [400, 700],
  },
  {
    family: "Roboto",
    label: "Roboto",
    category: "sans",
    scripts: ["latin", "cyrillic"],
    defaultWeights: [400, 700],
  },
  {
    family: "Open Sans",
    label: "Open Sans",
    category: "sans",
    scripts: ["latin", "cyrillic"],
    defaultWeights: [400, 700],
  },
  {
    family: "Lato",
    label: "Lato",
    category: "sans",
    scripts: ["latin"],
    defaultWeights: [400, 700],
  },
  {
    family: "Montserrat",
    label: "Montserrat",
    category: "sans",
    scripts: ["latin", "cyrillic"],
    defaultWeights: [400, 700],
  },
  {
    family: "Poppins",
    label: "Poppins",
    category: "sans",
    scripts: ["latin"],
    defaultWeights: [400, 700],
  },
  {
    family: "Nunito",
    label: "Nunito",
    category: "sans",
    scripts: ["latin"],
    defaultWeights: [400, 700],
  },
  {
    family: "Work Sans",
    label: "Work Sans",
    category: "sans",
    scripts: ["latin"],
    defaultWeights: [400, 700],
  },
  {
    family: "Raleway",
    label: "Raleway",
    category: "sans",
    scripts: ["latin"],
    defaultWeights: [400, 700],
  },
  {
    family: "Source Sans 3",
    label: "Source Sans 3",
    category: "sans",
    scripts: ["latin", "cyrillic"],
    defaultWeights: [400, 700],
  },
  // ── 欧文セリフ ──────────────────────────────────────────────────
  {
    family: "Playfair Display",
    label: "Playfair Display",
    category: "serif",
    scripts: ["latin", "cyrillic"],
    defaultWeights: [400, 700],
  },
  {
    family: "Merriweather",
    label: "Merriweather",
    category: "serif",
    scripts: ["latin", "cyrillic"],
    defaultWeights: [400, 700],
  },
  {
    family: "Lora",
    label: "Lora",
    category: "serif",
    scripts: ["latin", "cyrillic"],
    defaultWeights: [400, 700],
  },
  {
    family: "Source Serif 4",
    label: "Source Serif 4",
    category: "serif",
    scripts: ["latin", "cyrillic"],
    defaultWeights: [400, 700],
  },
  {
    family: "PT Serif",
    label: "PT Serif",
    category: "serif",
    scripts: ["latin", "cyrillic"],
    defaultWeights: [400, 700],
  },
  // ── 等幅 ────────────────────────────────────────────────────────
  {
    family: "Roboto Mono",
    label: "Roboto Mono",
    category: "mono",
    scripts: ["latin", "cyrillic"],
    defaultWeights: [400, 700],
  },
];

export function findCatalogEntry(family: string): FontCatalogEntry | undefined {
  return FONT_CATALOG.find((f) => f.family === family);
}

export function findSystemFont(id: string): SystemFontEntry | undefined {
  return SYSTEM_FONTS.find((s) => s.id === id);
}

/** CSS font-family value for a catalog family, including a category fallback. */
export function familyStack(family: string): string {
  const entry = findCatalogEntry(family);
  const fallback = entry ? FALLBACK[entry.category] : FALLBACK.sans;
  return `"${family}", ${fallback}`;
}
