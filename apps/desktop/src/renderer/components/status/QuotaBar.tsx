/**
 * QuotaBar — 额度进度条，统一展示当前额度使用比例及预警等级。
 */

import React from 'react';

import { quotaLevelFromUsed, type QuotaLevel } from '@cindy/maker-shared/quota-level';

import { cn } from '@/lib/utils';

export type QuotaSeverity = QuotaLevel;

export interface QuotaBarProps {
  usedPercent: number;
  /** Invert only the displayed value; warnings still follow usage. */
  showRemaining?: boolean;
  'aria-valuetext'?: string;
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

/** 额度预警等级：各端共用 `@cindy/maker-shared/quota-level`（剩 ≤30% 黄、≤10% 红）。 */
export function quotaSeverity(usedPercent: number): QuotaSeverity {
  return quotaLevelFromUsed(clampPercent(usedPercent));
}

/** 文字随额度变色时用的颜色类；正常时不着色。 */
export const QUOTA_TEXT_COLOR_CLASSES: Record<QuotaSeverity, string | undefined> = {
  normal: undefined,
  warn: 'text-[var(--quota-bar-warn)]',
  crit: 'text-[var(--quota-bar-crit)]',
};

export const QUOTA_FILL_COLOR_CLASSES: Record<QuotaSeverity, string> = {
  normal: 'bg-[var(--quota-bar-fill)]',
  warn: 'bg-[var(--quota-bar-warn)]',
  crit: 'bg-[var(--quota-bar-crit)]',
};

export function QuotaBar({
  usedPercent,
  showRemaining = false,
  'aria-valuetext': ariaValueText,
  size = 'regular',
  severity: severityOverride,
  ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  className,
}: QuotaBarProps) {
  const clampedPercent = clampPercent(usedPercent);
  const displayedPercent = showRemaining ? 100 - clampedPercent : clampedPercent;
  const severity = severityOverride ?? quotaSeverity(clampedPercent);
  const isMini = size === 'mini';

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(displayedPercent)}
      aria-valuetext={ariaValueText}
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
          displayedPercent > 0 && (isMini ? 'min-w-[4px]' : 'min-w-[7px]'),
          QUOTA_FILL_COLOR_CLASSES[severity],
        )}
        style={{ width: `${displayedPercent}%` }}
      />
    </div>
  );
}
