/**
 * QuotaBar — 额度进度条，统一展示当前额度使用比例及预警等级。
 */

import React from 'react';

import { cn } from '@/lib/utils';

export type QuotaSeverity = 'normal' | 'warn' | 'crit';

export interface QuotaBarProps {
  usedPercent: number;
  size?: 'regular' | 'mini';
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
  normal: 'bg-[var(--quota-bar-fill,#DE7B52)]',
  warn: 'bg-[var(--quota-bar-warn,#E09A2F)]',
  crit: 'bg-[var(--quota-bar-crit,#E5484D)]',
};

export function QuotaBar({ usedPercent, size = 'regular', className }: QuotaBarProps) {
  const clampedPercent = clampPercent(usedPercent);
  const severity = quotaSeverity(clampedPercent);
  const isMini = size === 'mini';

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clampedPercent)}
      data-severity={severity}
      className={cn(
        'overflow-hidden rounded-full bg-[rgba(0,0,0,0.08)] dark:bg-[rgba(255,255,255,0.13)]',
        isMini ? 'inline-flex h-[5px] w-[32px]' : 'flex h-[7px] w-full',
        className,
      )}
    >
      <div
        className={cn(
          'h-full rounded-full transition-[width] duration-[var(--motion-base)] ease-[var(--motion-ease-move)] motion-reduce:transition-none',
          isMini ? 'min-w-[4px]' : 'min-w-[7px]',
          FILL_COLOR_CLASSES[severity],
        )}
        style={{ width: `${clampedPercent}%` }}
      />
    </div>
  );
}
