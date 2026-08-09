/**
 * UsageHeatmap — GitHub 风格的日活跃热力图 (强度 = 当日花费 USD)。
 *
 * 数据: useUsageHistory 的 days (稀疏, 无消费日无行) + todayKey 锚点。
 * 日期推算一律从 todayKey 出发 (renderer 不自己取系统日期, 与 main 同口径)。
 *
 * 视觉: 7 行 (周日起) × ~20 列周网格, 单色阶 — 非零值按 4 分位分桶,
 * 用 color-mix 在 --accent-emphasis 上做透明度阶梯 (黑白反色设计, 不引入彩色)。
 * 140 个格子用原生 title 做 tooltip (Radix per-cell 实例太重)。
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { formatCompactTokens, formatMoney } from '@/lib/usageFormat';
import {
  DEFAULT_USAGE_CURRENCY,
  type RegionalMoney,
} from '../../../shared/regionalMoney';

const CELL_PX = 12;
const GAP_PX = 3;
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
}: {
  days: Array<{ day: string; money: RegionalMoney; tokens?: number }>;
  todayKey: string;
  windowDays: number;
}): React.JSX.Element {
  const { t, i18n } = useTranslation();

  const { columns, monthLabels } = useMemo(() => {
    const spendByDay = new Map(days.map((d) => [d.day, d.money]));
    const tokensByDay = new Map(days.map((d) => [d.day, d.tokens ?? 0]));
    const nonZero = days.map((d) => d.money.amount).filter((v) => v > 0).sort((a, b) => a - b);
    const q = (p: number): number => (nonZero.length ? nonZero[Math.min(nonZero.length - 1, Math.floor(p * nonZero.length))] : 0);
    const thresholds: [number, number, number] = [q(0.25), q(0.5), q(0.75)];

    const today = parseDayKey(todayKey);
    const start = new Date(today);
    start.setDate(start.getDate() - (windowDays - 1));
    start.setDate(start.getDate() - start.getDay()); // 对齐到周日, 行号 = weekday

    const cells: HeatCell[] = [];
    const cursor = new Date(start);
    while (cursor <= today) {
      const key = toDayKey(cursor);
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
        level: levelFor(money.amount, thresholds),
        placeholder: false,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    // 末列补满 7 行 (未来日占位, 保持网格矩形)
    while (cells.length % 7 !== 0) {
      cells.push({
        day: '',
        money: {
          amount: 0,
          currency: days[0]?.money.currency ?? EMPTY_MONEY_CURRENCY,
          approximate: false,
          kind: 'actual-cost',
        },
        tokens: 0,
        level: 0,
        placeholder: true,
      });
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
  }, [days, todayKey, windowDays, i18n.language]);

  const colPitch = CELL_PX + GAP_PX;

  return (
    <div className="flex flex-col gap-1.5">
      {/* 月份标签行 */}
      <div className="relative h-[14px]" style={{ width: columns.length * colPitch - GAP_PX }}>
        {monthLabels.map((m) => (
          <span
            key={`${m.col}-${m.text}`}
            className="absolute top-0 text-10 leading-[1.4] text-[var(--text-tertiary)]"
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
            {col.map((cell, ri) =>
              cell.placeholder ? (
                <div key={ri} style={{ width: CELL_PX, height: CELL_PX }} />
              ) : (
                <div
                  key={ri}
                  title={`${cell.day} · ${formatMoney(cell.money)}${
                    cell.tokens > 0
                      ? ` · ${t('usageDashboard.tokensOnly', { tokens: formatCompactTokens(cell.tokens) })}`
                      : ''
                  }`}
                  className="rounded-[3px]"
                  style={{
                    width: CELL_PX,
                    height: CELL_PX,
                    backgroundColor:
                      cell.level === 0
                        ? 'var(--surface-chip)'
                        : `color-mix(in srgb, var(--accent-emphasis) ${LEVEL_MIX[cell.level - 1] * 100}%, var(--surface-chip))`,
                  }}
                />
              ),
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
