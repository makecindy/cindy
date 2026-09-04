/**
 * UsageHeatmap — GitHub 风格的日活跃热力图 (强度 = 当日花费 USD)。
 *
 * 数据: useUsageHistory 的 days (稀疏, 无消费日无行) + todayKey 锚点。
 * 日期推算一律从 todayKey 出发 (renderer 不自己取系统日期, 与 main 同口径)。
 *
 * 强度口径由 `metric` 决定: 'money' (默认, 首页仪表盘) 或 'tokens' (设置 → 用量历史,
 * 那个页面不出现任何金额, 见 issue #2785)。两种口径共用同一套分位分桶与色阶。
 *
 * 视觉: 7 行 (周日起) × 至少 20 列周网格, 单色阶 — 非零值按 4 分位分桶,
 * 用 color-mix 在 --accent-emphasis 上做透明度阶梯 (黑白反色设计, 不引入彩色)。
 * 格子用原生 title 做 tooltip (Radix per-cell 实例太重)。
 */

import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { formatCompactTokens, formatMoney } from '@/lib/usageFormat';
import { DEFAULT_USAGE_CURRENCY, type RegionalMoney } from '../../../shared/regionalMoney';

const CELL_PX = 12;
const INTERACTIVE_CELL_PX = 24;
const GAP_PX = 3;
const MIN_HEATMAP_WEEKS = 20;
const EMPTY_MONEY_CURRENCY = DEFAULT_USAGE_CURRENCY;
/** 非零值分桶的 color-mix 浓度阶梯 (level 1..4)。 */
const LEVEL_MIX = [0.22, 0.42, 0.68, 1];

interface HeatCell {
  day: string;
  money: RegionalMoney;
  /** 当日 token 合计 (daily_model_usage 上线前的历史日为 0 → tooltip 不显示)。 */
  tokens: number;
  /** 0 = 无消费, 1..4 = 分位桶。 */
  level: number;
  /** 占位 (起始周对齐 / 未来日) — 渲染透明格。 */
  placeholder: boolean;
}

function parseDayKey(dayKey: string): Date {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function toDayKey(date: Date): string {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${mm}-${dd}`;
}

function startOfWeek(date: Date): Date {
  const result = new Date(date);
  result.setHours(12, 0, 0, 0);
  result.setDate(result.getDate() - result.getDay());
  return result;
}

function calendarDayDistance(from: Date, to: Date): number {
  const fromUtc = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const toUtc = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((toUtc - fromUtc) / 86_400_000);
}

function fitWeeksForWidth(width: number, cellSize = CELL_PX): number {
  if (!(width > 0)) return 0;
  return Math.max(1, Math.floor((width + GAP_PX) / (cellSize + GAP_PX)));
}

/**
 * 周网格按周日对齐时，当前周的未来占位也会占用格子。返回覆盖完整
 * `windowDays` 历史的最小周数，避免周日等锚点把窗口前端截掉。
 */
export function heatmapWeeksForWindow(todayKey: string, windowDays: number): number {
  const today = parseDayKey(todayKey);
  if (!todayKey || Number.isNaN(today.getTime()) || !(windowDays > 0)) return MIN_HEATMAP_WEEKS;
  const windowStart = new Date(today);
  windowStart.setDate(windowStart.getDate() - Math.ceil(windowDays) + 1);
  return Math.floor(calendarDayDistance(startOfWeek(windowStart), startOfWeek(today)) / 7) + 1;
}

/** 至少保留 20 周；有更早数据且容器放得下时，尽量展示更多历史。 */
export function resolveHeatmapWeeks({
  days,
  todayKey,
  availableWidth,
  minimumWeeks = MIN_HEATMAP_WEEKS,
  windowDays,
  metric,
  cellSize = CELL_PX,
}: {
  days: Array<{ day: string; money?: RegionalMoney; tokens?: number }>;
  todayKey: string;
  availableWidth: number;
  minimumWeeks?: number;
  windowDays?: number;
  metric?: 'money' | 'tokens';
  cellSize?: number;
}): number {
  const minWeeks = Math.max(
    MIN_HEATMAP_WEEKS,
    Math.ceil(minimumWeeks),
    windowDays === undefined ? 0 : heatmapWeeksForWindow(todayKey, windowDays),
  );
  const today = parseDayKey(todayKey);
  if (!todayKey || Number.isNaN(today.getTime())) return minWeeks;

  const intensityOf = (day: { money?: RegionalMoney; tokens?: number }): number =>
    metric === 'tokens' ? (day.tokens ?? 0) : (day.money?.amount ?? 0);
  const earliestDay = days
    .filter(
      (day) => day.day && day.day <= todayKey && (metric === undefined || intensityOf(day) > 0),
    )
    .map((day) => day.day)
    .sort()[0];
  const dataWeeks = earliestDay
    ? Math.floor(
        calendarDayDistance(startOfWeek(parseDayKey(earliestDay)), startOfWeek(today)) / 7,
      ) + 1
    : 0;
  const fitWeeks = fitWeeksForWidth(availableWidth, cellSize);
  const widthLimit = fitWeeks > 0 ? fitWeeks : minWeeks;
  return Math.max(minWeeks, Math.min(Math.max(minWeeks, dataWeeks), widthLimit));
}

/** 非零花费的 4 分位阈值 → level 1..4。 */
function levelFor(cost: number, thresholds: [number, number, number]): number {
  if (cost <= 0) return 0;
  if (cost <= thresholds[0]) return 1;
  if (cost <= thresholds[1]) return 2;
  if (cost <= thresholds[2]) return 3;
  return 4;
}

export function UsageHeatmap({
  days,
  todayKey,
  windowDays,
  metric = 'money',
  selectedDay,
  onDayClick,
  onVisibleWeeksChange,
}: {
  days: Array<{ day: string; money: RegionalMoney; tokens?: number }>;
  todayKey: string;
  windowDays: number;
  /** 格子深浅按哪一维分桶。'tokens' 下 tooltip 也只显示 token, 不出现金额。 */
  metric?: 'money' | 'tokens';
  selectedDay?: string | null;
  onDayClick?: (day: string) => void;
  onVisibleWeeksChange?: (weeks: number) => void;
}): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const plotRef = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, { year: 'numeric', month: 'short', day: 'numeric' }),
    [i18n.language],
  );

  useLayoutEffect(() => {
    const element = plotRef.current;
    if (!element) return undefined;

    const updateWidth = (width: number): void => {
      const nextWidth = Math.max(0, Math.round(width));
      setAvailableWidth((previous) => (previous === nextWidth ? previous : nextWidth));
    };
    updateWidth(element.clientWidth);
    if (typeof ResizeObserver === 'undefined') return undefined;

    const observer = new ResizeObserver((entries) => {
      updateWidth(entries[0]?.contentRect.width ?? element.clientWidth);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const minimumWeeks = Math.max(MIN_HEATMAP_WEEKS, Math.ceil(windowDays / 7));
  const cellSize = onDayClick ? INTERACTIVE_CELL_PX : CELL_PX;
  const visibleWeeks = resolveHeatmapWeeks({
    days,
    todayKey,
    availableWidth,
    minimumWeeks,
    windowDays,
    metric,
    cellSize,
  });

  useLayoutEffect(() => {
    onVisibleWeeksChange?.(visibleWeeks);
  }, [onVisibleWeeksChange, visibleWeeks]);

  const { columns, monthLabels } = useMemo(() => {
    const spendByDay = new Map(days.map((d) => [d.day, d.money]));
    const tokensByDay = new Map(days.map((d) => [d.day, d.tokens ?? 0]));
    const intensityOf = (row: { money: RegionalMoney; tokens?: number }): number =>
      metric === 'tokens' ? (row.tokens ?? 0) : row.money.amount;
    const today = parseDayKey(todayKey);
    const start = startOfWeek(today);
    start.setDate(start.getDate() - (visibleWeeks - 1) * 7);
    const startKey = toDayKey(start);

    // 分桶只反映当前屏幕可见的日期。全量历史中较早的极端值不应改变
    // 用户正在看的这些格子的相对深浅。
    const nonZero = days
      .filter((day) => day.day >= startKey && day.day <= todayKey)
      .map(intensityOf)
      .filter((v) => v > 0)
      .sort((a, b) => a - b);
    const q = (p: number): number =>
      nonZero.length ? nonZero[Math.min(nonZero.length - 1, Math.floor(p * nonZero.length))] : 0;
    const thresholds: [number, number, number] = [q(0.25), q(0.5), q(0.75)];

    const cells: HeatCell[] = [];
    const cursor = new Date(start);
    for (let index = 0; index < visibleWeeks * 7; index += 1) {
      const key = toDayKey(cursor);
      // `cursor` stays at noon so DST transitions cannot skip a calendar day;
      // compare the rendered day keys instead of Date instants so today's cell
      // is not mistaken for a future placeholder.
      const placeholder = key > todayKey;
      const money = spendByDay.get(key) ?? {
        amount: 0,
        currency: days[0]?.money.currency ?? EMPTY_MONEY_CURRENCY,
        approximate: false,
        kind: 'actual-cost' as const,
      };
      cells.push({
        day: key,
        money,
        tokens: tokensByDay.get(key) ?? 0,
        level: levelFor(intensityOf({ money, tokens: tokensByDay.get(key) ?? 0 }), thresholds),
        placeholder,
      });
      cursor.setDate(cursor.getDate() + 1);
    }

    const cols: HeatCell[][] = [];
    for (let i = 0; i < cells.length; i += 7) cols.push(cells.slice(i, i + 7));

    // 月份标签: 列内包含 1 号时标记该列; 与上一个标签隔 <2 列时跳过防重叠
    const fmt = new Intl.DateTimeFormat(i18n.language, { month: 'short' });
    const labels: Array<{ col: number; text: string }> = [];
    cols.forEach((col, idx) => {
      const firstOfMonth = col.find((c) => !c.placeholder && c.day.endsWith('-01'));
      if (!firstOfMonth) return;
      if (labels.length > 0 && idx - labels[labels.length - 1].col < 2) return;
      labels.push({ col: idx, text: fmt.format(parseDayKey(firstOfMonth.day)) });
    });

    return { columns: cols, monthLabels: labels };
  }, [days, todayKey, visibleWeeks, i18n.language, metric]);

  const colPitch = cellSize + GAP_PX;

  return (
    <div ref={plotRef} className="w-full min-w-0 overflow-x-auto">
      <div className="flex min-w-max flex-col gap-1.5">
        {/* 月份标签行。nowrap 防止最右侧月份被挤成上下两行。 */}
        <div className="relative h-[14px]" style={{ width: columns.length * colPitch - GAP_PX }}>
          {monthLabels.map((m) => (
            <span
              key={`${m.col}-${m.text}`}
              className="absolute top-0 whitespace-nowrap text-10 leading-[1.4] text-[var(--text-tertiary)]"
              style={{ left: m.col * colPitch }}
            >
              {m.text}
            </span>
          ))}
        </div>
        {/* 网格 */}
        <div className="flex" style={{ gap: GAP_PX }}>
          {columns.map((col, ci) => (
            <div key={ci} className="flex flex-col" style={{ gap: GAP_PX }}>
              {col.map((cell, ri) => {
                if (cell.placeholder) {
                  return <div key={ri} style={{ width: cellSize, height: cellSize }} />;
                }

                const usageSummary =
                  metric === 'tokens'
                    ? cell.tokens > 0
                      ? t('usageDashboard.tokensOnly', {
                          tokens: formatCompactTokens(cell.tokens),
                        })
                      : t('usageHistory.heatmap.emptyCell')
                    : `${formatMoney(cell.money)}${
                        cell.tokens > 0
                          ? ` · ${t('usageDashboard.tokensOnly', { tokens: formatCompactTokens(cell.tokens) })}`
                          : ''
                      }`;
                const title = `${cell.day} · ${usageSummary}`;
                const accessibleLabel = `${dateFormatter.format(parseDayKey(cell.day))} · ${usageSummary}`;
                const visualClassName = onDayClick ? 'rounded-full' : 'rounded-[3px]';
                const visualStyle = {
                  width: CELL_PX,
                  height: CELL_PX,
                  backgroundColor:
                    cell.level === 0
                      ? 'var(--surface-chip)'
                      : `color-mix(in srgb, var(--accent-emphasis) ${LEVEL_MIX[cell.level - 1] * 100}%, var(--surface-chip))`,
                  outline:
                    selectedDay === cell.day ? '2px solid var(--focus-ring-soft)' : undefined,
                  outlineOffset: selectedDay === cell.day ? '1px' : undefined,
                };
                const visual = (
                  <div title={title} className={visualClassName} style={visualStyle} />
                );

                return onDayClick ? (
                  <button
                    key={ri}
                    type="button"
                    aria-label={accessibleLabel}
                    aria-pressed={selectedDay === cell.day}
                    onClick={() => onDayClick(cell.day)}
                    className="flex cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]"
                    style={{ width: cellSize, height: cellSize }}
                  >
                    {visual}
                  </button>
                ) : (
                  <div key={ri}>{visual}</div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
