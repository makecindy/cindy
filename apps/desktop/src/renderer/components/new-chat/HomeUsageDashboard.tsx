/**
 * HomeUsageDashboard — 首页 (新建对话界面) 的 Token 用量与费用仪表盘。
 *
 * 三个区块:
 *   1. 统计条: 今日 (vs 软日限额) / Token / 本月 (vs 月度预算) / 连续活跃天数 / 近 30 天总额。
 *      今日花费 > 2× 前 7 日均值且 ≥$1 时, 今日格加 warning 色调 + tooltip (异常即时发现)。
 *   2. 活跃热力图 (UsageHeatmap): 近 20 周, 强度 = 当日花费, daily_spend 历史上线即有图。
 *   3. 按模型拆分 (UsageModelBreakdown): 近 30 天, daily_model_usage 从上线起积累。
 *
 * 数据全部由 main 聚合 (useUsageHistory → maker:usage:history), 本组件只渲染;
 * 月度预算复用 useClaudeAccountUsage (与右下角 TodaySpendChip 同口径)。
 *
 * 空态: 仍渲染同尺寸结构,未知数值用 "—" 占位。这样冷启动无 localStorage 快照时,
 * 数据回来只替换内容,不改变新建对话页整体高度。
 * 折叠态只留统计条, 状态存 localStorage。
 */

import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, RefreshCw } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import {
  DAILY_SOFT_LIMIT_FACTOR,
  formatCompactTokens,
  formatCompactMoney,
  formatMoney,
} from '@/lib/usageFormat';
import { useClaudeAccountUsage } from '@/hooks/useClaudeAccountUsage';
import { useUsageHistory, type UsageHistoryPayload } from '@/hooks/useUsageHistory';
import { useAuth } from '@/contexts/AuthContext';
import { UsageDailyBars } from './UsageDailyBars';
import { UsageHeatmap } from './UsageHeatmap';
import { USAGE_TOP_MODELS, usageModelKey } from './usagePalette';
import {
  gatewayMoney,
  type RegionalMoney,
  zeroUsageMoney,
} from '../../../shared/regionalMoney';

const COLLAPSED_STORAGE_KEY = 'homeUsageDashboard.collapsed';
/** 与 useUsageHistory 的拉取窗口一致 (20 周)。 */
const HEATMAP_WINDOW_DAYS = 140;
/** 美元金额展示到分, 1 美分内视为同一今日值, 避免账号快照和本地聚合微小舍入差异隐藏异常提示。 */
const ACCOUNT_LOCAL_TODAY_MATCH_EPSILON = 0.01;
const UNKNOWN_VALUE = '—';
const TOKEN_DISTRIBUTION_TOP_MODELS = 5;

const zeroMoney = () => zeroUsageMoney();

type TokenDistributionInput = {
  model: string;
  tokens: number;
};

export function buildTokenDistributionRows(
  rows: TokenDistributionInput[],
  limit: number = TOKEN_DISTRIBUTION_TOP_MODELS,
): TokenDistributionInput[] {
  const byModel = new Map<string, number>();

  for (const row of rows) {
    if (row.tokens <= 0) continue;
    byModel.set(row.model, (byModel.get(row.model) ?? 0) + row.tokens);
  }

  return Array.from(byModel, ([model, tokens]) => ({ model, tokens }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, limit);
}

function localDayKey(ts: number = Date.now()): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function createEmptyUsageHistoryPayload(): UsageHistoryPayload {
  return {
    generatedAt: Date.now(),
    todayKey: localDayKey(),
    estimatesPending: false,
    days: [],
    modelDaily: [],
    models: [],
    streak: { current: 0, longest: 0 },
    totals: {
      today: zeroMoney(),
      last30Days: zeroMoney(),
      last30DaysWithEstimatedValue: zeroMoney(),
      last30DaysEstimatedValue: zeroUsageMoney('value-estimate'),
      todayTokens: 0,
      last30DaysTokens: 0,
    },
    anomaly: { isAnomalous: false, trailing7DayAvg: null },
  };
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeCollapsedFlag(value: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_STORAGE_KEY, value ? '1' : '0');
  } catch {
    /* 存不上就只活在本次会话 */
  }
}

function isSameDisplayedTodaySpend(
  accountTodaySpend: RegionalMoney | null,
  localTodaySpend: RegionalMoney,
): boolean {
  if (accountTodaySpend === null) return true;
  return (
    accountTodaySpend.currency === localTodaySpend.currency &&
    Math.abs(accountTodaySpend.amount - localTodaySpend.amount) <=
      ACCOUNT_LOCAL_TODAY_MATCH_EPSILON
  );
}

function modelTokenTotal(model: UsageHistoryPayload['models'][number]): number {
  return model.inputTokens + model.outputTokens + model.cacheReadTokens + model.cacheCreateTokens;
}

/** 单个统计格: 值在上 (14px semibold), 标签在下 (11px tertiary)。 */
function StatCell({
  value,
  label,
  warning,
  warningTip,
}: {
  value: string;
  label: string;
  warning?: boolean;
  warningTip?: React.ReactNode | null;
}): React.JSX.Element {
  const cell = (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg bg-[var(--surface-chip)] px-3 py-2">
      <span
        className={cn(
          'truncate text-[14px] font-semibold leading-[20px] tabular-nums',
          warning ? 'text-[var(--warning-accent)]' : 'text-[var(--text-primary)]',
        )}
      >
        {value}
      </span>
      <span className="truncate text-[11px] leading-[14px] text-[var(--text-tertiary)]">
        {label}
      </span>
    </div>
  );
  return warningTip ? <Tip text={warningTip}>{cell}</Tip> : cell;
}

export function HomeUsageDashboard(): React.JSX.Element {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [collapsed, setCollapsed] = useState(() => readFlag(COLLAPSED_STORAGE_KEY));
  const [emptyLayoutHistory] = useState<UsageHistoryPayload>(() =>
    createEmptyUsageHistoryPayload(),
  );
  // 收起态暂停消费推送订阅 (展开瞬间 hook 自动补拉一次) — 收起用户零后台刷新成本
  const { history, refreshing: usageRefreshing } = useUsageHistory({ paused: collapsed, userId: user?.id });
  const layoutHistory = history ?? emptyLayoutHistory;
  const hasHistoryData = history !== null;
  // 月度预算与右下角 chip 同源 (XD gateway key 的 LiteLLM spend, 与 vendor 无关)
  const claudeQuota = useClaudeAccountUsage(true);

  const hasMonthly = !!claudeQuota && claudeQuota.maxBudget > 0;

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      writeCollapsedFlag(next);
      return next;
    });
  }, []);

  const accountTodayMoney =
    typeof claudeQuota?.todaySpend === 'number'
      ? gatewayMoney(claudeQuota.todaySpend)
      : null;
  const hasAccountTodaySpend = accountTodayMoney !== null;

  const displayTodaySpend = accountTodayMoney ?? layoutHistory.totals.today;
  const hasSpendValue = hasHistoryData || hasAccountTodaySpend;
  const showLocalSpendAnomaly =
    layoutHistory.anomaly.isAnomalous &&
    isSameDisplayedTodaySpend(accountTodayMoney, layoutHistory.totals.today);
  const softDailyLimit = hasMonthly ? (claudeQuota.maxBudget / 30) * DAILY_SOFT_LIMIT_FACTOR : null;
  const softDailyLimitMoney =
    softDailyLimit === null
      ? null
      : gatewayMoney(softDailyLimit);
  const todayValue = !hasSpendValue
    ? UNKNOWN_VALUE
    : softDailyLimitMoney
      ? `${formatMoney(displayTodaySpend)} / ${formatCompactMoney(softDailyLimitMoney)}`
      : formatMoney(displayTodaySpend);
  const anomalyTip = showLocalSpendAnomaly
    ? t('usageDashboard.anomalyTooltip', {
        avg: formatMoney(layoutHistory.anomaly.trailing7DayAvg ?? zeroMoney()),
      })
    : null;

  // token 数据来自 daily_model_usage (从上线起积累)。还没攒出数据时显示占位,
  // 不显示误导性的 0,同时保持统计条列数稳定。
  const hasTokens = layoutHistory.totals.last30DaysTokens > 0;
  const tokenValue =
    hasHistoryData && hasTokens
      ? `${formatCompactTokens(layoutHistory.totals.todayTokens)} / ${formatCompactTokens(layoutHistory.totals.last30DaysTokens)}`
      : `${UNKNOWN_VALUE} / ${UNKNOWN_VALUE}`;
  const tokenDistributionRows = hasHistoryData && hasTokens
    ? buildTokenDistributionRows(
        layoutHistory.models.map((m) => ({ model: m.model, tokens: modelTokenTotal(m) })),
      )
    : [];
  const tokenDistributionTip = tokenDistributionRows.length > 0
    ? (
        <div className="min-w-[220px] space-y-1">
          <div className="text-[12px] font-medium text-[var(--tooltip-text)]">
            {t('usageDashboard.tokenDistributionTitle', {
              total: formatCompactTokens(layoutHistory.totals.last30DaysTokens),
            })}
          </div>
          <div className="space-y-0.5">
            {tokenDistributionRows.map((row) => (
              <div key={row.model} className="flex items-center justify-between gap-4">
                <span className="min-w-0 truncate text-[12px] text-[var(--tooltip-text)]">
                  {row.model}
                </span>
                <span className="shrink-0 text-[12px] tabular-nums text-[var(--text-tertiary)]">
                  {t('usageDashboard.tokenDistributionRow', {
                    tokens: formatCompactTokens(row.tokens),
                    pct: Math.round((row.tokens / layoutHistory.totals.last30DaysTokens) * 100),
                  })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )
    : null;
  const streakValue = hasHistoryData
    ? t('usageDashboard.streakValue', {
        current: layoutHistory.streak.current,
        longest: layoutHistory.streak.longest,
      })
    : `${UNKNOWN_VALUE} / ${UNKNOWN_VALUE}`;
  const last30DaysValue = hasHistoryData
    ? formatMoney(layoutHistory.totals.last30DaysWithEstimatedValue)
    : UNKNOWN_VALUE;
  const last30DaysTip = hasHistoryData && layoutHistory.totals.last30DaysEstimatedValue.amount > 0
    ? t('usageDashboard.last30dTooltip', {
        api: formatMoney(layoutHistory.totals.last30Days),
        subscription: formatMoney(layoutHistory.totals.last30DaysEstimatedValue),
        total: formatMoney(layoutHistory.totals.last30DaysWithEstimatedValue),
      })
    : null;

  // 折叠态的一行摘要: 今日 $ (异常标橙) · Token · 连续天数 · 近 30 天 $
  const collapsedSummary = (
    <span className="min-w-0 flex-1 truncate text-right text-[11px] leading-[18px] tabular-nums text-[var(--text-tertiary)]">
      <span className={cn(showLocalSpendAnomaly && 'font-medium text-[var(--warning-accent)]')}>
        {t('usageDashboard.collapsedToday', {
          v: hasSpendValue ? formatMoney(displayTodaySpend) : UNKNOWN_VALUE,
        })}
      </span>
      {' · '}
      {t('usageDashboard.collapsedTokens', {
        v:
          hasHistoryData && hasTokens
            ? formatCompactTokens(layoutHistory.totals.todayTokens)
            : UNKNOWN_VALUE,
      })}
      {' · '}
      {hasHistoryData
        ? t('usageDashboard.collapsedStreak', { n: layoutHistory.streak.current })
        : UNKNOWN_VALUE}
      {' · '}
      {t('usageDashboard.collapsedLast30', { v: last30DaysValue })}
    </span>
  );

  return (
    <div
      // 折叠态整条可点击展开 (不只 chevron); 展开态只留 chevron 收起, 避免操作图表误触
      onClick={collapsed ? toggleCollapsed : undefined}
      className={cn(
        'w-full rounded-xl border border-[var(--border-default)] bg-[var(--surface)] p-3.5',
        collapsed && 'cursor-pointer transition-colors hover:bg-[var(--surface-elevated)]',
      )}
    >
      {/* 头部: 标题 + (折叠态) 一行摘要 + 折叠 chevron */}
      <div className={cn('flex items-center justify-between gap-3', !collapsed && 'mb-2.5')}>
        <span className="flex shrink-0 items-center gap-2 text-[12px] font-medium text-[var(--text-secondary)]">
          <span>{t('usageDashboard.title')}</span>
          {usageRefreshing && (
            <span className="inline-flex items-center gap-1 text-[10px] font-normal leading-none text-[var(--text-tertiary)]">
              <Spinner icon={RefreshCw} size={10} className="opacity-70" />
              {t('usageDashboard.updating')}
            </span>
          )}
        </span>
        {collapsed &&
          (showLocalSpendAnomaly && anomalyTip ? (
            <Tip text={anomalyTip}>{collapsedSummary}</Tip>
          ) : (
            collapsedSummary
          ))}
        <button
          type="button"
          onClick={(e) => {
            // 折叠态外层卡片也有 toggle onClick — 拦掉冒泡防止开了又关
            e.stopPropagation();
            toggleCollapsed();
          }}
          aria-label={collapsed ? t('usageDashboard.expand') : t('usageDashboard.collapse')}
          className="flex size-[22px] shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-chip)] hover:text-[var(--text-secondary)]"
        >
          <ChevronDown
            size={14}
            className={cn('transition-transform duration-200', collapsed && '-rotate-90')}
          />
        </button>
      </div>

      {/* 统计条 (仅展开态; 折叠态信息已并入头部摘要行) */}
      {!collapsed && (
        <div className="flex gap-2">
          <StatCell
            value={todayValue}
            label={t('usageDashboard.today')}
            warning={showLocalSpendAnomaly}
            warningTip={anomalyTip}
          />
          <StatCell
            value={tokenValue}
            label={t('usageDashboard.tokensCell')}
            warningTip={tokenDistributionTip}
          />
          <StatCell
            value={
              hasMonthly
                ? `${formatCompactMoney(gatewayMoney(claudeQuota.spend))} / ${formatCompactMoney(gatewayMoney(claudeQuota.maxBudget))}`
                : `${UNKNOWN_VALUE} / ${UNKNOWN_VALUE}`
            }
            label={t('usageDashboard.monthly')}
          />
          <StatCell value={streakValue} label={t('usageDashboard.streak')} />
          <StatCell
            value={last30DaysValue}
            label={
              layoutHistory.totals.last30DaysEstimatedValue.amount > 0
                ? t('usageDashboard.last30dWithEstimate')
                : t('usageDashboard.last30d')
            }
            warningTip={last30DaysTip}
          />
        </div>
      )}

      {/* 展开区: 热力图 + 右栏 (按模型拆分; 拆分数据未积累出来前退化为每日总额柱状图) */}
      {!collapsed && (
        <div className="mt-3.5 flex items-start gap-5">
          <UsageHeatmap
            days={layoutHistory.days}
            todayKey={layoutHistory.todayKey}
            windowDays={HEATMAP_WINDOW_DAYS}
          />
          <div className="min-w-0 flex-1 self-stretch border-l border-[var(--border-default)] pl-5">
            {/* 右栏: 每日堆叠柱状图 (高=日总额, 分段=模型构成)。不放图例 — 每日模型
                明细全在柱子 hover tooltip 里 (省空间, 用户确认的取舍)。
                拆分数据未积累出来前柱子整根中性色 + 一行积累提示。 */}
            <div className="mb-1.5 text-[11px] text-[var(--text-tertiary)]">
              {t('usageDashboard.dailyTotalsTitle')}
            </div>
            <UsageDailyBars
              days={layoutHistory.days}
              modelDaily={layoutHistory.modelDaily}
              colorOrder={layoutHistory.models
                .slice(0, USAGE_TOP_MODELS)
                .map((m) => usageModelKey(m.agentKind, m.model))}
              todayKey={layoutHistory.todayKey}
            />
            {layoutHistory.models.length === 0 && (
              <div className="mt-1.5 text-[10px] text-[var(--text-tertiary)] opacity-70">
                {t('usageDashboard.emptyModels')}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
