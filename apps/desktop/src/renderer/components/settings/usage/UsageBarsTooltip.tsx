/**
 * UsageBarsTooltip — 每日 token 柱图的悬停浮层 (设置 → 用量历史)。
 *
 * 取代原生 title: 原生提示由系统绘制, 无法对齐、无法配色, 模型一多就是一堵字墙。
 * 整张图只挂**一个**浮层实例, 跟随当前悬停 / 聚焦的柱子移动 (而不是每根柱子一个
 * Radix Tooltip —— 那是原来选原生 title 的理由)。
 *
 * 版式 (所有者 2026-09-26 要求「更好看、有设计感」):
 *   - 头部: 日期 (次要色) + 当日总量 (大号数字, 单位弱化)
 *   - 占比条: 与柱子同色、同顺序的横向分段, 一眼看出当天构成
 *   - 明细: 色块 · 模型名 · token · 占比, 按 token 降序, 数字等宽右对齐
 *   - 模型多于 MAX_ROWS 时折叠成「另有 N 个模型」一行, 浮层高度有上限
 *
 * 浮层走 portal + fixed 定位: 设置页滚动容器与卡片都不会裁掉它。优先放在柱图上方,
 * 上方空间不够时翻到下方; 水平方向以柱子为中心并夹在视口内。只做信息展示,
 * aria-hidden —— 柱子按钮自带完整的 aria-label。
 */

import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { formatCompactTokens } from '@/lib/usageFormat';

const MAX_ROWS = 6;
const GAP_PX = 8;
const VIEWPORT_MARGIN_PX = 8;

export interface UsageBarsTooltipSegment {
  key: string | number;
  label: string;
  tokens: number;
  color: string;
}

export interface UsageBarsTooltipData {
  day: string;
  tokens: number;
  segments: UsageBarsTooltipSegment[];
  /** 当前柱子点击区域的实时测量(视口坐标),决定水平位置。 */
  measureAnchor: () => DOMRect | null;
  /** 整个绘图区的实时测量(视口坐标),决定上下位置 —— 浮层不遮挡其它柱子。 */
  measurePlot: () => DOMRect | null;
  /** 滚动 / 尺寸变化计数:变化时重新测量。 */
  layoutTick: number;
}

/** 行按 token 降序; 超出 MAX_ROWS 的尾部合并计数。 */
export function tooltipRows(segments: readonly UsageBarsTooltipSegment[]): {
  rows: UsageBarsTooltipSegment[];
  hiddenCount: number;
  hiddenTokens: number;
} {
  const sorted = [...segments].sort((a, b) => b.tokens - a.tokens);
  const rows = sorted.slice(0, MAX_ROWS);
  const hidden = sorted.slice(MAX_ROWS);
  return {
    rows,
    hiddenCount: hidden.length,
    hiddenTokens: hidden.reduce((sum, s) => sum + s.tokens, 0),
  };
}

function formatShare(tokens: number, total: number): string {
  if (!(total > 0)) return '';
  const share = (tokens / total) * 100;
  if (share > 0 && share < 1) return '<1%';
  return `${Math.round(share)}%`;
}

export function UsageBarsTooltip({
  data,
}: {
  data: UsageBarsTooltipData | null;
}): React.JSX.Element | null {
  const { t, i18n } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    /** 首次定位不做过渡 (否则会从视口左上角滑入), 之后在柱子间平滑跟随。 */
    glide: boolean;
  } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!data || !el) {
      setPosition(null);
      return;
    }
    const anchor = data.measureAnchor();
    const plot = data.measurePlot();
    if (!anchor || !plot) {
      setPosition(null);
      return;
    }
    const { width, height } = el.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const centerX = anchor.left + anchor.width / 2;
    const left = Math.min(
      Math.max(centerX - width / 2, VIEWPORT_MARGIN_PX),
      viewportWidth - width - VIEWPORT_MARGIN_PX,
    );
    // 优先放在绘图区上方,放不下翻到下方;两边都放不下(如 3× 缩放的矮窗口)就夹在视口内,
    // 超出视口高度的部分由 max-height 截掉,头部的日期与总量始终可见。
    const bottomLimit = document.documentElement.clientHeight - VIEWPORT_MARGIN_PX;
    const above = plot.top - GAP_PX - height;
    const below = plot.bottom + GAP_PX;
    const top =
      above >= VIEWPORT_MARGIN_PX
        ? above
        : below + height <= bottomLimit
          ? below
          : Math.max(VIEWPORT_MARGIN_PX, bottomLimit - height);
    setPosition((prev) =>
      prev && prev.left === left && prev.top === top ? prev : { left, top, glide: prev !== null },
    );
  }, [data]);

  if (!data) return null;

  const [year, month, day] = data.day.split('-').map(Number);
  const dateLabel = new Intl.DateTimeFormat(i18n.language, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    weekday: 'short',
  }).format(new Date(year, (month ?? 1) - 1, day ?? 1));
  const { rows, hiddenCount, hiddenTokens } = tooltipRows(data.segments);

  return createPortal(
    <div
      ref={ref}
      aria-hidden="true"
      data-testid="usage-bars-tooltip"
      data-glide={position?.glide ? 'true' : undefined}
      className="usage-bars-tooltip animate-fade-in pointer-events-none fixed left-0 top-0 z-[10011] w-max min-w-[220px] max-w-[320px] max-h-[calc(100vh-16px)] overflow-hidden select-none rounded-xl bg-[var(--tooltip-bg)] px-3 py-2.5 text-[var(--tooltip-text)]"
      style={{
        transform: position ? `translate3d(${position.left}px, ${position.top}px, 0)` : undefined,
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      <div className="text-11 leading-none opacity-60">{dateLabel}</div>
      <div className="mt-1.5 flex items-baseline gap-1 leading-none">
        <span className="text-16 font-medium tabular-nums">
          {data.tokens > 0 ? formatCompactTokens(data.tokens) : '0'}
        </span>
        <span className="text-11 opacity-60">{t('usageHistory.daily.tooltip.unit')}</span>
      </div>

      {data.tokens > 0 ? (
        <>
          {/* 与明细同口径:前 MAX_ROWS 个模型各占一段,其余合成一段中性色,段数有上限不会被裁掉。 */}
          <div className="mt-2.5 flex h-1 gap-px overflow-hidden rounded-[2px]">
            {rows.map((s) => (
              <span
                key={s.key}
                className="h-full"
                style={{ flexGrow: s.tokens, flexBasis: 0, backgroundColor: s.color }}
              />
            ))}
            {hiddenTokens > 0 ? (
              <span
                className="h-full bg-current opacity-40"
                style={{ flexGrow: hiddenTokens, flexBasis: 0 }}
              />
            ) : null}
          </div>
          <div className="mt-2.5 grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-2 gap-y-1.5 text-12 leading-none">
            {rows.map((s) => (
              <React.Fragment key={s.key}>
                <span className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: s.color }} />
                <span className="truncate opacity-80">{s.label}</span>
                <span className="text-right font-medium tabular-nums">
                  {formatCompactTokens(s.tokens)}
                </span>
                <span className="min-w-[3.5ch] text-right tabular-nums opacity-50">
                  {formatShare(s.tokens, data.tokens)}
                </span>
              </React.Fragment>
            ))}
            {hiddenCount > 0 ? (
              <>
                <span className="h-2 w-2 rounded-[2px] border border-current opacity-40" />
                <span className="truncate opacity-60">
                  {t('usageHistory.daily.tooltip.more', { count: hiddenCount })}
                </span>
                <span className="text-right tabular-nums opacity-60">
                  {formatCompactTokens(hiddenTokens)}
                </span>
                <span className="min-w-[3.5ch] text-right tabular-nums opacity-50">
                  {formatShare(hiddenTokens, data.tokens)}
                </span>
              </>
            ) : null}
          </div>
        </>
      ) : (
        <div className="mt-2 text-12 opacity-60">{t('usageHistory.heatmap.emptyCell')}</div>
      )}
    </div>,
    document.body,
  );
}
