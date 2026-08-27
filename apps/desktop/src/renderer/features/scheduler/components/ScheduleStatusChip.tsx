/**
 * ScheduleStatusChip — pill chip 显示 schedule 当前状态
 * ---------------------------------------------------------------------------
 * 文字 only，**禁色**（docs/design-rules/cindy-design-system.md grayscale 原则；status chip 不用红绿）。
 * 区分通过：背景灰阶深浅 + 文字色。
 *
 * - active   → Light Gray pill, Near Black text
 * - paused   → transparent pill + Board border, Stone text
 * - expired  → transparent pill + Board border, Silver text
 * - running  → Light Gray pill, Near Black text；前置一个 spinner（用 ⟳ 字符避开 emoji 色）
 *              ⚠️ 临时态，由 'fired' 事件触发，'completed' / 'failed' 事件清除
 */

import { cn } from '@/lib/utils';
import type { ScheduleStatus } from '@cindy/maker-scheduler';
import { useTranslation } from 'react-i18next';

export type ChipVariant = ScheduleStatus | 'running';

interface Props {
  variant: ChipVariant;
  className?: string;
}

// 内部 status 'expired' 对外显示成 "Once" — 一次性任务跑完是预期终态，
// "Expired" 字样会让用户误以为任务出错。
export function ScheduleStatusChip({ variant, className }: Props) {
  const { t } = useTranslation();
  const label = t(`scheduler.presentation.status.${variant}`);
  const isFilled = variant === 'active' || variant === 'running';
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-11 font-medium',
        'leading-none whitespace-nowrap',
        isFilled
          ? 'bg-[var(--chat-input-chip-bg)] text-[var(--msg-assistant-text)]'
          : variant === 'paused'
            ? 'border border-[var(--cmd-palette-border)] bg-transparent text-[var(--cmd-palette-item-meta)]'
            : 'border border-[var(--cmd-palette-border)] bg-transparent text-[var(--settings-section-desc)]',
        className,
      )}
      aria-label={t('scheduler.runs.statusAria', { status: label })}
    >
      {variant === 'running' && (
        <span
          className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--msg-assistant-text)]"
          aria-hidden
        />
      )}
      {label}
    </span>
  );
}
