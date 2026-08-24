/**
 * UsageTokenBars — 近 30 天每日 token 堆叠柱状图 (设置 → 用量历史)。
 *
 * 与首页的 UsageDailyBars 是姊妹组件, 但**不是它的 token 分支**: 那个组件的币种选取、
 * api / 订阅估算分段、金额 tooltip 都是围绕金额长出来的, 塞进 metric 分支等于让一个
 * 组件同时维护两套逻辑。本页只统计 token (issue #2785), 分段规则简化成"按天 × rank 求和"。
 *
 * 从 UsageDailyBars 照搬的两处视觉规则 (不搬会比首页看板简陋):
 *   - niceTicks(): max/4 取整到 1 / 2 / 2.5 / 5 / 10 档, 最多 3 条; Y 轴列固定 30px 宽,
 *     避免数字位数变化引起布局抖动
 *   - 柱高 max(3, round(ratio × H)); 零值日固定 2px, 保留"那天有格子但没用量"的视觉
 *
 * 日期推算一律以 main 返回的 todayKey 为锚, renderer 不自己取系统日期。
 * 30 根柱子用原生 title 做 tooltip (Radix per-cell 实例太重, 同热力图取舍)。
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { formatCompactTokens } from '@/lib/usageFormat';
import type { UsageHistoryModelDay } from '@/hooks/useUsageHistory';
import { usageModelKey, usageRankColor, usageRankOf } from '@/components/new-chat/usagePalette';

const WINDOW_DAYS = 30;
const CHART_HEIGHT_PX = 96;

interface DaySegment {
  rank: number;
  label: string;
  tokens: number;
}

interface DayBar {
  day: string;
  tokens: number;
  /** rank 升序 (rank 0 = 最大头模型, 渲染在柱子底部)。 */
  segments: DaySegment[];
}

function shiftDayKeyLocal(dayKey: string, deltaDays: number): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const date = new Date(y, (m ?? 1) - 1, (d ?? 1) + deltaDays);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${mm}-${dd}`;
}

/** 与 UsageDailyBars 同一套刻度算法, 保证两张图的刻度密度一致。 */
function niceTicks(max: number): number[] {
  if (!(max > 0)) return [];
  const rawStep = max / 4;
  const pow = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rawStep) ?? 10 * pow;
  const ticks: number[] = [];
  for (let v = step; v <= max * 0.95 && ticks.length < 3; v += step) ticks.push(v);
  return ticks;
}

export function UsageTokenBars({
  modelDaily,
  colorOrder,
  todayKey,
}: {
  modelDaily: UsageHistoryModelDay[];
  /** 前 N 名模型 key (payload.models 排序), 决定分段与图例配色。 */
  colorOrder: string[];
  todayKey: string;
}): React.JSX.Element {
  const { t } = useTranslation();

  const bars = useMemo(() => {
    const segsByDay = new Map<string, Map<number, DaySegment>>();
    for (const row of modelDaily) {
      if (row.tokens <= 0) continue;
      const rank = usageRankOf(colorOrder, usageModelKey(row.agentKind, row.model));
      let daySegs = segsByDay.get(row.day);
      if (!daySegs) {
        daySegs = new Map();
        segsByDay.set(row.day, daySegs);
      }
      const seg = daySegs.get(rank);
      if (seg) {
        seg.tokens += row.tokens;
        // 尾部档 (rank === colorOrder.length) 会把所有非前 N 名模型并进同一分段,
        // 保留首个模型名会把合计错误地挂到它头上 —— 改标「其它」, 与图例同义。
        if (rank >= colorOrder.length) seg.label = t('usageDashboard.othersLegend');
      } else {
        daySegs.set(rank, {
          rank,
          label: rank >= colorOrder.length ? t('usageDashboard.othersLegend') : row.model,
          tokens: row.tokens,
        });
      }
    }

    const list: DayBar[] = [];
    for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
      const day = shiftDayKeyLocal(todayKey, -i);
      const segments = [...(segsByDay.get(day)?.values() ?? [])].sort((a, b) => a.rank - b.rank);
      list.push({
        day,
        tokens: segments.reduce((sum, s) => sum + s.tokens, 0),
        segments,
      });
    }
    return { list, max: Math.max(...list.map((b) => b.tokens), 0) };
  }, [modelDaily, colorOrder, todayKey, t]);

  const ticks = niceTicks(bars.max);

  return (
    <div className="flex gap-1.5" style={{ height: CHART_HEIGHT_PX }}>
      {/* Y 轴 token 刻度 (有数据才显示; 宽度固定避免数字位数变化引起布局抖动) */}
      {ticks.length > 0 && (
        <div className="relative w-[30px] shrink-0">
          {ticks.map((v) => (
            <span
              key={v}
              className="absolute right-0 translate-y-1/2 text-10 leading-none tabular-nums text-[var(--text-tertiary)]"
              style={{ bottom: (v / bars.max) * CHART_HEIGHT_PX }}
            >
              {formatCompactTokens(v)}
            </span>
          ))}
        </div>
      )}
      <div className="relative min-w-0 flex-1">
        {/* 横向参考线 (柱子后面, 半透明) */}
        {ticks.map((v) => (
          <div
            key={v}
            className="absolute left-0 right-0 border-t border-[var(--border-default)] opacity-50"
            style={{ bottom: (v / bars.max) * CHART_HEIGHT_PX }}
          />
        ))}
        <div className="absolute inset-0 flex items-end gap-[3px]">
          {bars.list.map((b) => {
            const ratio = bars.max > 0 ? b.tokens / bars.max : 0;
            const height = b.tokens > 0 ? Math.max(3, Math.round(ratio * CHART_HEIGHT_PX)) : 2;
            const titleLines = [
              `${b.day} · ${
                b.tokens > 0
                  ? t('usageDashboard.tokensOnly', { tokens: formatCompactTokens(b.tokens) })
                  : t('usageHistory.heatmap.emptyCell')
              }`,
              ...b.segments.map(
                (s) =>
                  `${s.label}: ${t('usageDashboard.tokensOnly', {
                    tokens: formatCompactTokens(s.tokens),
                  })}`,
              ),
            ];
            return (
              <div
                key={b.day}
                title={titleLines.join('\n')}
                // 列容器只负责高度与圆角裁切; 分段自上而下 = rank 降序 ("其它"在顶, 大头在底)
                className="flex min-w-0 flex-1 flex-col justify-end overflow-hidden rounded-[2px]"
                style={{
                  height,
                  backgroundColor: b.segments.length === 0 ? 'var(--surface-chip)' : undefined,
                }}
              >
                {[...b.segments].reverse().map((s) => (
                  <div
                    key={s.rank}
                    style={{
                      height: `${(s.tokens / b.tokens) * 100}%`,
                      backgroundColor: usageRankColor(s.rank),
                    }}
                  />
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
