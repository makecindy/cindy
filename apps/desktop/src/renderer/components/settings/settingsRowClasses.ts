import { cn } from '@/lib/utils';

/**
 * 设置页「标题在卡片外 + 一张卡片放多行 + 行间分割线」的共用样式。
 * 行:左侧名称与说明,右侧控件;控件放不下时用 `cindy-segmented-row` 让整组换行。
 */
export const SETTINGS_CARD_CLASS = cn(
  'flex flex-col rounded-xl',
  'bg-[var(--settings-theme-card-bg)]',
  'border border-[var(--settings-theme-card-border)]',
);
export const SETTINGS_ROW_CLASS = 'flex items-center justify-between gap-3 px-4 py-4';
export const SETTINGS_ROW_LABEL_CLASS = 'text-13 font-medium text-[var(--settings-section-sublabel)]';
export const SETTINGS_ROW_HINT_CLASS =
  'text-12 leading-[1.4] text-[var(--text-secondary)]';
/** 行间分割线:左右缩进与行内边距对齐。 */
export const SETTINGS_ROW_DIVIDER_CLASS = 'mx-4 h-px bg-[var(--settings-theme-card-border)]';
export const SETTINGS_SECTION_TITLE_CLASS =
  'text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]';
