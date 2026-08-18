/**
 * 交付物的纯展示规则:四型 + 兜底 → 图标 / 文案 key / 元信息串。
 * 与渲染分离,便于直接单测(不需要挂 React 树)。
 */

import { FileSpreadsheet, FileText, Image as ImageIcon, Paperclip, Presentation } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import {
  BOT_ARTIFACT_CATEGORIES,
  type BotArtifactCategory,
  type BotArtifactItem,
} from '../../../shared/botArtifact';

/** 仓库面板的过滤 chip 顺序:全部 + 四型 + 其它。 */
export const BOT_ARTIFACT_FILTERS: readonly (BotArtifactCategory | 'all')[] = [
  'all',
  ...BOT_ARTIFACT_CATEGORIES,
];

const ICONS: Record<BotArtifactCategory, LucideIcon> = {
  doc: FileText,
  sheet: FileSpreadsheet,
  image: ImageIcon,
  deck: Presentation,
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
    other: 0,
  };
  for (const item of items) counts[item.category] += 1;
  return counts;
}
