/**
 * QuotaBar — 额度进度条，统一展示当前额度使用比例及预警等级。
 */

import React from 'react';

import { cn } from '@/lib/utils';

export type QuotaSeverity = 'normal' | 'warn' | 'crit';

export interface QuotaBarProps {
  usedPercent: number;
  size?: 'regular' | 'mini';
  /** 调用方已合并本地阈值与上游信号后的展示级别。 */
  severity?: QuotaSeverity;
  /** 进度条的可访问名称；也可由 aria-labelledby 指向可见标题。 */
  ariaLabel?: string;
  'aria-labelledby'?: string;
  className?: string;
}

function clampPercent(usedPercent: number): number {
  if (!Number.isFinite(usedPercent)) return 0;
  return Math.min(100, Math.max(0, usedPercent));
}

/** 将上游用量统一归一化后判定额度预警等级。 */
export function quotaSeverity(usedPercent: number): QuotaSeverity {
  const clampedPercent = clampPercent(usedPercent);
  if (clampedPercent >= 90) return 'crit';
  if (clampedPercent > 70) return 'warn';
  return 'normal';
}

const FILL_COLOR_CLASSES: Record<QuotaSeverity, string> = {
  normal: 'bg-[var(--quota-bar-fill)]',
  warn: 'bg-[var(--quota-bar-warn)]',
  crit: 'bg-[var(--quota-bar-crit)]',
};

export function QuotaBar({
  usedPercent,
  size = 'regular',
  severity: severityOverride,
  ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  className,
}: QuotaBarProps) {
  const clampedPercent = clampPercent(usedPercent);
  const severity = severityOverride ?? quotaSeverity(clampedPercent);
  const isMini = size === 'mini';

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clampedPercent)}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      data-severity={severity}
      className={cn(
        'overflow-hidden rounded-full bg-[var(--quota-bar-track)]',
        isMini ? 'inline-flex h-[5px] w-[32px]' : 'flex h-[7px] w-full',
        className,
      )}
    >
      <div
        className={cn(
          'h-full rounded-full transition-[width] duration-[var(--motion-base)] ease-[var(--motion-ease-move)] motion-reduce:transition-none',
          clampedPercent > 0 && (isMini ? 'min-w-[4px]' : 'min-w-[7px]'),
          FILL_COLOR_CLASSES[severity],
        )}
        style={{ width: `${clampedPercent}%` }}
      />
    </div>
  );
}
