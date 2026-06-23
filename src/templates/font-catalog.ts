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
  | "sans"
  | "serif"
  | "display"
  | "mono";

export interface FontCatalogEntry {
  /** Google Fonts family name, used verbatim in CSS `font-family` and the API. */
  family: string;
  /** Display label for the admin list (kept equal to family for simplicity). */
  label: string;
  category: FontCategory;
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
    defaultWeights: [400, 700],
  },
  {
    family: "M PLUS 1p",
    label: "M PLUS 1p",
    category: "jp",
    defaultWeights: [400, 700],
  },
  {
    family: "M PLUS Rounded 1c",
    label: "M PLUS Rounded 1c",
    category: "jp",
    defaultWeights: [400, 700],
  },
  {
    family: "Zen Kaku Gothic New",
    label: "Zen Kaku Gothic New",
    category: "jp",
    defaultWeights: [400, 700],
  },
  {
    family: "Zen Maru Gothic",
    label: "Zen Maru Gothic",
    category: "jp",
    defaultWeights: [400, 700],
  },
  {
    family: "BIZ UDPGothic",
    label: "BIZ UDPGothic",
    category: "jp",
    defaultWeights: [400, 700],
  },
  { family: "Kosugi", label: "Kosugi", category: "jp", defaultWeights: [400] },
  {
    family: "Kosugi Maru",
    label: "Kosugi Maru",
    category: "jp",
    defaultWeights: [400],
  },
  {
    family: "Sawarabi Gothic",
    label: "Sawarabi Gothic",
    category: "jp",
    defaultWeights: [400],
  },
  {
    family: "Murecho",
    label: "Murecho",
    category: "jp",
    defaultWeights: [400, 700],
  },
  {
    family: "RocknRoll One",
    label: "RocknRoll One",
    category: "jp",
    defaultWeights: [400],
  },
  {
    family: "Kaisei Decol",
    label: "Kaisei Decol",
    category: "jp",
    defaultWeights: [400, 700],
  },
  {
    family: "Mochiy Pop One",
    label: "Mochiy Pop One",
    category: "jp",
    defaultWeights: [400],
  },
  {
    family: "Dela Gothic One",
    label: "Dela Gothic One",
    category: "display",
    defaultWeights: [400],
  },
  {
    family: "Klee One",
    label: "Klee One",
    category: "jp",
    defaultWeights: [400, 600],
  },
  // ── 日本語明朝 ──────────────────────────────────────────────────
  {
    family: "Noto Serif JP",
    label: "Noto Serif JP",
    category: "serif-jp",
    defaultWeights: [400, 700],
  },
  {
    family: "Zen Old Mincho",
    label: "Zen Old Mincho",
    category: "serif-jp",
    defaultWeights: [400, 700],
  },
  {
    family: "Shippori Mincho",
    label: "Shippori Mincho",
    category: "serif-jp",
    defaultWeights: [400, 700],
  },
  {
    family: "BIZ UDPMincho",
    label: "BIZ UDPMincho",
    category: "serif-jp",
    defaultWeights: [400],
  },
  {
    family: "Sawarabi Mincho",
    label: "Sawarabi Mincho",
    category: "serif-jp",
    defaultWeights: [400],
  },
  {
    family: "Hina Mincho",
    label: "Hina Mincho",
    category: "serif-jp",
    defaultWeights: [400],
  },
  {
    family: "Kaisei Tokumin",
    label: "Kaisei Tokumin",
    category: "serif-jp",
    defaultWeights: [400, 700],
  },
  {
    family: "Yuji Syuku",
    label: "Yuji Syuku",
    category: "serif-jp",
    defaultWeights: [400],
  },
  {
    family: "Zen Antique",
    label: "Zen Antique",
    category: "serif-jp",
    defaultWeights: [400],
  },
  // ── 欧文サンセリフ ──────────────────────────────────────────────
  {
    family: "Inter",
    label: "Inter",
    category: "sans",
    defaultWeights: [400, 700],
  },
  {
    family: "Roboto",
    label: "Roboto",
    category: "sans",
    defaultWeights: [400, 700],
  },
  {
    family: "Open Sans",
    label: "Open Sans",
    category: "sans",
    defaultWeights: [400, 700],
  },
  {
    family: "Lato",
    label: "Lato",
    category: "sans",
    defaultWeights: [400, 700],
  },
  {
    family: "Montserrat",
    label: "Montserrat",
    category: "sans",
    defaultWeights: [400, 700],
  },
  {
    family: "Poppins",
    label: "Poppins",
    category: "sans",
    defaultWeights: [400, 700],
  },
  {
    family: "Nunito",
    label: "Nunito",
    category: "sans",
    defaultWeights: [400, 700],
  },
  {
    family: "Work Sans",
    label: "Work Sans",
    category: "sans",
    defaultWeights: [400, 700],
  },
  {
    family: "Raleway",
    label: "Raleway",
    category: "sans",
    defaultWeights: [400, 700],
  },
  {
    family: "Source Sans 3",
    label: "Source Sans 3",
    category: "sans",
    defaultWeights: [400, 700],
  },
  // ── 欧文セリフ ──────────────────────────────────────────────────
  {
    family: "Playfair Display",
    label: "Playfair Display",
    category: "serif",
    defaultWeights: [400, 700],
  },
  {
    family: "Merriweather",
    label: "Merriweather",
    category: "serif",
    defaultWeights: [400, 700],
  },
  {
    family: "Lora",
    label: "Lora",
    category: "serif",
    defaultWeights: [400, 700],
  },
  {
    family: "Source Serif 4",
    label: "Source Serif 4",
    category: "serif",
    defaultWeights: [400, 700],
  },
  {
    family: "PT Serif",
    label: "PT Serif",
    category: "serif",
    defaultWeights: [400, 700],
  },
  // ── 等幅 ────────────────────────────────────────────────────────
  {
    family: "Roboto Mono",
    label: "Roboto Mono",
    category: "mono",
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
