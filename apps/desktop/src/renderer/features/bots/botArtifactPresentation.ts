/**
 * 交付物的纯展示规则:五型 + 兜底 → 图标 / 文案 key / 元信息串。
 * 与渲染分离,便于直接单测(不需要挂 React 树)。
 */

import {
  FileSpreadsheet,
  FileText,
  Film,
  Image as ImageIcon,
  Paperclip,
  Presentation,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import {
  BOT_ARTIFACT_CATEGORIES,
  type BotArtifactCategory,
  type BotArtifactItem,
} from '../../../shared/botArtifact';

/** 仓库面板的过滤 chip 顺序:全部 + 五型 + 其它。 */
export const BOT_ARTIFACT_FILTERS: readonly (BotArtifactCategory | 'all')[] = [
  'all',
  ...BOT_ARTIFACT_CATEGORIES,
];

const ICONS: Record<BotArtifactCategory, LucideIcon> = {
  doc: FileText,
  sheet: FileSpreadsheet,
  image: ImageIcon,
  deck: Presentation,
  video: Film,
  other: Paperclip,
};

export function botArtifactIcon(category: BotArtifactCategory): LucideIcon {
  return ICONS[category];
}

/** 类型标签的 i18n key(bots.artifacts.category.*)。 */
export function botArtifactCategoryKey(category: BotArtifactCategory | 'all'): string {
  return `bots.artifacts.category.${category}`;
}

/** 人类可读体积。null / 0 不显示(返回空串,调用方据此省略这一段)。 */
export function formatArtifactSize(sizeBytes: number | null): string {
  if (sizeBytes === null || !Number.isFinite(sizeBytes) || sizeBytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = sizeBytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded}${units[unit]}`;
}

/**
 * 相对时间的**判定**部分(纯函数,不碰 i18n)。渲染方拿到 kind + n 后自己去
 * 查文案,这样判定逻辑可以脱离 i18n 直接单测。
 */
export type ArtifactTimeLabel =
  | { kind: 'justNow' }
  | { kind: 'minutes' | 'hours' | 'days'; n: number }
  | { kind: 'date'; at: number };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function artifactTimeLabel(createdAt: number, now: number): ArtifactTimeLabel {
  const delta = now - createdAt;
  // 时钟回拨 / 未来时间戳:当「刚刚」处理,不显示负数。
  if (delta < MINUTE_MS) return { kind: 'justNow' };
  if (delta < HOUR_MS) return { kind: 'minutes', n: Math.floor(delta / MINUTE_MS) };
  if (delta < DAY_MS) return { kind: 'hours', n: Math.floor(delta / HOUR_MS) };
  if (delta < 7 * DAY_MS) return { kind: 'days', n: Math.floor(delta / DAY_MS) };
  return { kind: 'date', at: createdAt };
}

/**
 * 卡片元信息:「类型 · 规格 · 时间」。规格拿不到就整段省略,不显示占位符
 * (定稿口径:演示页数未知则省略,不编造)。
 */
export function botArtifactMetaParts(
  item: BotArtifactItem,
  translateCategory: (category: BotArtifactCategory) => string,
  formatTime: (createdAt: number) => string,
): string[] {
  const parts = [translateCategory(item.category)];
  const size = formatArtifactSize(item.sizeBytes);
  if (size) parts.push(size);
  const time = formatTime(item.createdAt);
  if (time) parts.push(time);
  return parts;
}

// ── 表格交付物的迷你预览 ──────────────────────────────────────────────────
//
// 定稿原型的 sheet 卡带一张 4 行小表。**数据必须是真的**:画一张编的小表是骗人。
// 因此只在能真读到文件时出预览(本机会话 + csv/tsv,读文件头);xlsx 需要解析器,
// 仓里没有依赖也不为此新增,一律回退图标。

/** 预览规模:与定稿原型一致的 4 行 × 3 列。 */
export const SHEET_PREVIEW_ROWS = 4;
export const SHEET_PREVIEW_COLUMNS = 3;

/** 单元格展示上限。截断由 CSS 做,这里只是防止超长单元格把 DOM 撑爆。 */
const SHEET_PREVIEW_CELL_CHARS = 64;

/** 可解析的分隔符;拿不到(xlsx / 未知扩展名)返回 null = 不出预览。 */
export function sheetPreviewDelimiter(ext: string): string | null {
  const normalized = ext.trim().toLowerCase();
  if (normalized === 'csv') return ',';
  if (normalized === 'tsv') return '\t';
  return null;
}

/**
 * 文件头文本 → 前 SHEET_PREVIEW_ROWS 行 × 前 SHEET_PREVIEW_COLUMNS 列。
 *
 * 按 RFC4180 处理双引号包裹(含 `""` 转义与字段内换行),否则带逗号的中文表头会
 * 被切碎成假数据。`truncated` = 传进来的只是文件头:此时最后一条记录可能被截断在
 * 半路,除非它已经被换行收尾,否则丢掉 —— 宁可少一行,也不显示半个值。
 */
export function parseSheetPreview(
  text: string,
  delimiter: string,
  options?: { truncated?: boolean },
): string[][] {
  const source = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let index = 0;
  for (; index < source.length && rows.length < SHEET_PREVIEW_ROWS; index += 1) {
    const char = source[index];
    if (inQuotes) {
      if (char !== '"') {
        field += char;
      } else if (source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        inQuotes = false;
      }
      continue;
    }
    if (char === '"' && field === '') {
      inQuotes = true;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\r') continue;
    if (char === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      continue;
    }
    field += char;
  }
  // 尾部没有换行收尾的那条记录:文件读全了就是完整的一行,只读了头就可能是半行。
  const hasTrailingRecord = field.length > 0 || row.length > 0;
  if (hasTrailingRecord && rows.length < SHEET_PREVIEW_ROWS && !options?.truncated) {
    row.push(field);
    rows.push(row);
  }
  return rows
    .filter((cells) => cells.some((cell) => cell.trim().length > 0))
    .map((cells) => {
      const shown = cells
        .slice(0, SHEET_PREVIEW_COLUMNS)
        .map((cell) => cell.trim().slice(0, SHEET_PREVIEW_CELL_CHARS));
      while (shown.length < SHEET_PREVIEW_COLUMNS) shown.push('');
      return shown;
    });
}

export function filterBotArtifacts(
  items: readonly BotArtifactItem[],
  filter: BotArtifactCategory | 'all',
): BotArtifactItem[] {
  return filter === 'all' ? [...items] : items.filter((item) => item.category === filter);
}

export function countBotArtifactsByCategory(
  items: readonly BotArtifactItem[],
): Record<BotArtifactCategory, number> {
  const counts: Record<BotArtifactCategory, number> = {
    doc: 0,
    sheet: 0,
    image: 0,
    deck: 0,
    video: 0,
    other: 0,
  };
  for (const item of items) counts[item.category] += 1;
  return counts;
}
