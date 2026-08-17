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

const QUOTA_SEVERITY_RANK: Record<QuotaSeverity, number> = {
  normal: 0,
  warn: 1,
  crit: 2,
};

/**
 * 非字符串按缺失处理；字符串空值或 normal 才是无告警，未知非空值至少保留为 warn。
 * 与共享告警谓词“任何非 normal severity 均告警”保持一致，避免上游新增级别被静默降级。
 */
function serverQuotaSeverity(value: unknown): QuotaSeverity {
  if (typeof value !== 'string') return 'normal';
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'normal') return 'normal';
  if (normalized === 'warning') return 'warn';
  const parts = normalized.split(/[^a-z]+/).filter(Boolean);
  if (parts.includes('exceeded') || parts.includes('critical')) return 'crit';
  return 'warn';
}

/** 本地利用率与服务端告警等级取更严重者，作为窗口的最终等级。 */
export function effectiveQuotaSeverity(
  usedPercent: number,
  serverSeverity: unknown,
): QuotaSeverity {
  const localSeverity = quotaSeverity(usedPercent);
  const upstreamSeverity = serverQuotaSeverity(serverSeverity);
  return QUOTA_SEVERITY_RANK[upstreamSeverity] > QUOTA_SEVERITY_RANK[localSeverity]
    ? upstreamSeverity
    : localSeverity;
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
