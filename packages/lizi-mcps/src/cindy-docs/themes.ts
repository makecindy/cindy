/**
 * cindy-docs/themes.ts —— 文档工具共用的克制色板。
 *
 * 主题是纯配置(色号 + 语义角色),不捆图片、不捆字体。模型只能从命名色板里选,
 * 不能自由喂色号 —— 自由配色几乎必然对比度翻车。三个命名色板覆盖浅底打印、
 * 深色投影、正式商务汇报;再加色板只加数据,不要改调用方。
 */

export const DOCS_THEME_NAMES = ['light', 'dark', 'navy'] as const;
export type DocsThemeName = (typeof DOCS_THEME_NAMES)[number];
export const DEFAULT_DOCS_THEME: DocsThemeName = 'light';

/** 色板字段一律 6 位十六进制、不带 #,三套出口(pptx / docx / xlsx / pdf CSS)自己加前缀。 */
export interface DocsTheme {
  /** 页/幻灯片底色。 */
  background: string;
  /** 卡片、表头浅底、引用底。 */
  surface: string;
  /**
   * 斑马纹底色。
   *
   * 必须和 `background` 拉开肉眼可辨的差(约 4–6%)。原来只差 2%,实机目检下来
   * 整张表看不出隔行 —— 打了跟没打一样,而它存在的唯一目的就是让眼睛横着扫
   * 一行不串到下一行。
   */
  zebra: string;
  /** 主标题、H1。 */
  title: string;
  /** 正文。 */
  body: string;
  /** 唯一强调色:分隔线、表头色带、封面竖条。 */
  accent: string;
  /** 强调色上的字(表头文字)。 */
  accentOn: string;
  /** 次要文字、页脚、题注。 */
  muted: string;
  /** 浅线、表格描边。 */
  line: string;
}

export const DOCS_THEMES: Record<DocsThemeName, DocsTheme> = {
  light: {
    background: 'FFFFFF',
    surface: 'F2F3F5',
    zebra: 'F0F2F6',
    title: '1B1F24',
    body: '2E3440',
    accent: '2F6FEB',
    accentOn: 'FFFFFF',
    muted: '6B7280',
    line: 'D8DCE2',
  },
  dark: {
    background: '14181D',
    surface: '1E242C',
    zebra: '1D242D',
    title: 'F5F7FA',
    body: 'D6DBE3',
    accent: '6AA6FF',
    accentOn: '0B1220',
    muted: '9AA3B0',
    line: '2C3440',
  },
  navy: {
    background: 'FFFFFF',
    surface: 'EEF2F7',
    zebra: 'EDF2F8',
    title: '0F2744',
    body: '243040',
    accent: '1F4E79',
    accentOn: 'FFFFFF',
    muted: '5C6470',
    line: 'D8DCE2',
  },
};

export function resolveDocsTheme(name: DocsThemeName | undefined): DocsTheme {
  return DOCS_THEMES[name ?? DEFAULT_DOCS_THEME];
}

/** exceljs 要 ARGB;入参可以是 6 位或已经带 alpha 的 8 位。 */
export function themeToArgb(hex: string): string {
  const clean = hex.replace('#', '').toUpperCase();
  if (clean.length === 8) return clean;
  return `FF${clean}`;
}

/** CSS / HTML 要 #RRGGBB。 */
export function themeToCssHex(hex: string): string {
  const clean = hex.replace('#', '');
  return `#${clean}`;
}

/** 本地日历日,不用 toISOString(UTC 会在东八区深夜错一天)。 */
export function formatDocsDate(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
