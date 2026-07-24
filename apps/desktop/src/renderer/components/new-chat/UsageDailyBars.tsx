/**
 * UsageDailyBars — 近 30 天每日花费柱状图, 每根柱子按当日各模型消耗堆叠分段。
 *
 * 信息密度: 同时回答"每天花多少"(柱高 = daily_spend 日总额, canonical 口径) 和
 * "每天用了什么模型、各占多少"(分段 = daily_model_usage 当日各模型金额占比)。
 * daily_model_usage 上线前的历史日没有分段数据 → 整根中性色, 平滑过渡。
 *
 * 分段配色走 usagePalette 的 rank 映射 (rank = colorOrder 即 payload.models 排序)。
 * tooltip 用原生 title (30 根, 同热力图取舍), 含逐模型金额明细。
 * 日期推算一律以 main 返回的 todayKey 为锚。
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import {
  formatCompactMoney,
  formatCompactTokens,
  formatMoney,
} from '@/lib/usageFormat';
import type { UsageHistoryModelDay } from '@/hooks/useUsageHistory';
import { usageModelKey, usageRankColor, usageRankOf } from './usagePalette';
import { CURRENT_CINDY_REGION } from '../../../shared/brandRegion';
import {
  regionalCurrencyForRegion,
  type MoneyCurrency,
  type MoneyKind,
  type RegionalMoney,
} from '../../../shared/regionalMoney';

const WINDOW_DAYS = 30;
const CHART_HEIGHT_PX = 96;

function shiftDayKeyLocal(dayKey: string, deltaDays: number): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const date = new Date(y, (m ?? 1) - 1, (d ?? 1) + deltaDays);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${mm}-${dd}`;
}

interface DaySegment {
  rank: number;
  label: string;
  amount: number;
  apiAmount: number;
  subscriptionEstimateAmount: number;
  tokens: number;
}

interface DayBar {
  day: string;
  /** daily_spend 实报日总额 (仅 Claude 计入 $; Codex 不写 $ 入账)。 */
  actualAmount: number;
  tokens: number;
  /** rank 升序 (rank 0 = 最大头模型, 渲染在柱子底部)。 */
  segments: DaySegment[];
  /**
   * 柱高/总额显示值 = daily_spend 实报 + Codex 订阅价值估算。
   * 纯 Codex 订阅日 costUsd 为 0, 仍按估算分段撑起柱子。
   */
  effectiveAmount: number;
  /** 总额包含 Codex 订阅价值估算 → 总额前缀 ≈ 并展示 tooltip 解释。 */
  approximate: boolean;
}

export function UsageDailyBars({
  days,
  modelDaily,
  colorOrder,
  todayKey,
}: {
  days: Array<{ day: string; money: RegionalMoney; tokens?: number }>;
  modelDaily: UsageHistoryModelDay[];
  /** 前 N 名模型 key (payload.models 排序), 决定分段/图例配色。 */
  colorOrder: string[];
  todayKey: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const currency: MoneyCurrency =
    days[0]?.money.currency ??
    modelDaily[0]?.money.currency ??
    regionalCurrencyForRegion(CURRENT_CINDY_REGION);
  const money = (
    amount: number,
    approximate: boolean,
    kind: MoneyKind = 'actual-cost',
  ): RegionalMoney => ({
    amount,
    currency,
    approximate,
    kind,
    ...(approximate
      ? {
          estimateReasons:
            kind === 'value-estimate'
              ? (['subscription-value'] as const)
              : (['reference-price'] as const),
        }
      : {}),
  });

  const bars = useMemo(() => {
    const byDay = new Map(days.map((d) => [d.day, d]));
    // 按天聚出分段: 同 rank (含"其它"档) 合并金额与 token。
    // 无价格的 codex 行 (amountUsd=0) 也收进来 — 画不了分段 (无金额占比),
    // 但 tooltip 里要按 token 露出, 不能让它在明细里消失。
    const segsByDay = new Map<string, Map<number, DaySegment>>();
    for (const row of modelDaily) {
      if (row.money.amount <= 0 && row.tokens <= 0) continue;
      const rank = usageRankOf(colorOrder, usageModelKey(row.agentKind, row.model));
      let daySegs = segsByDay.get(row.day);
      if (!daySegs) {
        daySegs = new Map();
        segsByDay.set(row.day, daySegs);
      }
      const seg = daySegs.get(rank);
      if (seg) {
        seg.amount += row.money.amount;
        seg.apiAmount += row.apiMoney.amount;
        seg.subscriptionEstimateAmount +=
          row.subscriptionEstimateMoney.amount;
        seg.tokens += row.tokens;
        if (rank < colorOrder.length) seg.label = row.model;
      } else {
        daySegs.set(rank, {
          rank,
          label: rank < colorOrder.length ? row.model : t('usageDashboard.othersLegend'),
          amount: row.money.amount,
          apiAmount: row.apiMoney.amount,
          subscriptionEstimateAmount:
            row.subscriptionEstimateMoney.amount,
          tokens: row.tokens,
        });
      }
    }

    const list: DayBar[] = [];
    for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
      const day = shiftDayKeyLocal(todayKey, -i);
      const row = byDay.get(day);
      const segments = [...(segsByDay.get(day)?.values() ?? [])].sort((a, b) => a.rank - b.rank);
      const actualAmount = row?.money.amount ?? 0;
      const segSum = segments.reduce((a, s) => a + s.amount, 0);
      const subscriptionEstimateSum = segments.reduce(
        (a, s) => a + s.subscriptionEstimateAmount,
        0,
      );
      const effectiveAmount = Math.max(
        actualAmount + subscriptionEstimateSum,
        segSum,
      );
      list.push({
        day,
        actualAmount,
        tokens: row?.tokens ?? 0,
        segments,
        effectiveAmount,
        approximate:
          Boolean(row?.money.approximate) ||
          segments.some((segment) => segment.subscriptionEstimateAmount > 0),
      });
    }
    const max = Math.max(...list.map((b) => b.effectiveAmount), 0);
    return { list, max };
  }, [days, modelDaily, colorOrder, todayKey, t]);

  const ticks = niceTicks(bars.max);

  return (
    <div className="flex gap-1.5" style={{ height: CHART_HEIGHT_PX }}>
      {/* Y 轴金额刻度 (有数据才显示; 宽度固定避免数字位数变化引起布局抖动) */}
      {ticks.length > 0 && (
        <div className="relative w-[30px] shrink-0">
          {ticks.map((v) => (
            <span
              key={v}
              className="absolute right-0 translate-y-1/2 text-[9px] leading-none tabular-nums text-[var(--text-tertiary)]"
              style={{ bottom: (v / bars.max) * CHART_HEIGHT_PX }}
            >
              {tickLabel(v, currency)}
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
        const ratio = bars.max > 0 ? b.effectiveAmount / bars.max : 0;
        const h = b.effectiveAmount > 0 ? Math.max(3, Math.round(ratio * CHART_HEIGHT_PX)) : 2;
        // 画分段只看有金额的行; tooltip 明细全量列出 (无价格模型按 token 露出)
        const drawSegs = b.segments.filter((s) => s.amount > 0);
        const segSum = drawSegs.reduce((a, s) => a + s.amount, 0);
        const subscriptionEstimateSum = b.segments.reduce(
          (a, s) => a + s.subscriptionEstimateAmount,
          0,
        );
        // 未分类差额: 日总额里没被任何模型行覆盖的部分 (升级日早段消费 / 未计价行)。
        // 分段必须按 effectiveUsd 定比例 + 差额画中性段, 否则已知模型会撑满整根柱,
        // 视觉上把未分类的钱也算到它们头上 (>1% 才画, 吸收舍入噪声)。
        const remainder = Math.max(0, b.effectiveAmount - segSum);
        const showRemainder = segSum > 0 && remainder > b.effectiveAmount * 0.01;
        const titleLines = [
          `${b.day} · ${formatMoney(money(b.effectiveAmount, b.approximate))}${
            b.tokens > 0 ? ` · ${t('usageDashboard.tokensOnly', { tokens: formatCompactTokens(b.tokens) })}` : ''
          }`,
          ...(subscriptionEstimateSum > 0
            ? [
                t('usageDashboard.dailyEstimatedTooltip', {
                  api: formatMoney(money(b.actualAmount, false)),
                  subscription: formatMoney(
                    money(subscriptionEstimateSum, true, 'value-estimate'),
                  ),
                }),
              ]
            : []),
          ...b.segments.map((s) => {
            const tokensPart = t('usageDashboard.tokensOnly', { tokens: formatCompactTokens(s.tokens) });
            return s.amount > 0
              ? `${s.label}: ${formatMoney(money(s.amount, s.subscriptionEstimateAmount > 0))} · ${tokensPart}`
              : `${s.label}: ${tokensPart}`;
          }),
          ...(showRemainder
            ? [
                `${t('usageDashboard.unclassified')}: ${formatMoney(
                  money(remainder, b.approximate),
                )}`,
              ]
            : []),
        ];
        return (
          <div
            key={b.day}
            title={titleLines.join('\n')}
            // 列容器只负责高度与圆角裁切; 分段自上而下 = rank 降序 ("其它"在顶, 大头在底)
            className="flex min-w-0 flex-1 flex-col justify-end overflow-hidden rounded-[2px]"
            style={{ height: h, backgroundColor: segSum > 0 ? undefined : barFallbackColor(b.effectiveAmount, ratio) }}
          >
            {showRemainder && (
              // 未分类差额: 中性色顶段 (与零消费日同色, 区别于所有模型档)
              <div
                style={{
                  height: `${(remainder / b.effectiveAmount) * 100}%`,
                  backgroundColor: 'var(--surface-chip)',
                }}
              />
            )}
            {segSum > 0 &&
              [...drawSegs].reverse().map((s) => (
                <div
                  key={s.rank}
                  style={{
                    height: `${(s.amount / b.effectiveAmount) * 100}%`,
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

/** 无分段数据 (历史日 / 无消费日) 的整根柱颜色 — 与旧版纯总额柱一致。 */
function barFallbackColor(amount: number, ratio: number): string {
  return amount > 0
    ? `color-mix(in srgb, var(--accent-emphasis) ${Math.round(35 + ratio * 55)}%, var(--surface-chip))`
    : 'var(--surface-chip)';
}

/**
 * 刻度标签: 低消费日 max < $1 时刻度是 0.2 / 0.4 这类小数 — formatCompactUsd
 * 会把它们全部四舍五入成 "$0" (重复且误导), 这里 < $10 保留小数位。
 * Number() 去掉尾零: $0.2 而不是 $0.20。
 */
function tickLabel(v: number, currency: MoneyCurrency): string {
  const money: RegionalMoney = {
    amount: v,
    currency,
    approximate: false,
    kind: 'actual-cost',
  };
  if (v >= 10) return formatCompactMoney(money);
  return `${currency === 'CNY' ? '¥' : '$'}${Number(v.toFixed(2))}`;
}

/**
 * Y 轴"漂亮"刻度: 步长取 1/2/5 × 10^k, 让刻度落在 $250 / $500 这类整数上,
 * 最多 3 条 (顶部留 ~5% 余量防止刻度顶到最高柱上方被裁)。max<=0 → 无刻度。
 */
function niceTicks(max: number): number[] {
  if (!(max > 0)) return [];
  const rawStep = max / 4;
  const pow = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rawStep) ?? 10 * pow;
  const ticks: number[] = [];
  for (let v = step; v <= max * 0.95 && ticks.length < 3; v += step) ticks.push(v);
  return ticks;
}
