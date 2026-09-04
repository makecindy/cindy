/**
 * UsageHistorySection — 设置 → 用量历史 (issue #2785)。
 *
 * 职责边界 (维护者裁决): Billing 管 Cindy AI 的账单与账户信息; 本页只统计
 * **本机 Cindy App 内产生的 token 消耗**, 不出现金额、账户额度、预算或限额窗口,
 * 也不纳入外部 Claude Code / Codex CLI / 网页版的用量 (那是 #2618)。
 *
 * 因此页面上每个数字都来自 useUsageHistory → maker:usage:history → 本地库,
 * 不读任何账号快照 —— local / cloud personal / cloud org 三种身份看到的是同一个页面。
 *
 * 两个窗口不同, 标题里分别写明:
 *   - 热力图走完整 days[]，按卡片实际宽度显示至少 20 周；连续活跃天数也走同一份历史
 *   - 按模型 / 按 agent 走按筛选范围重聚合的 models[] 与 modelDaily
 *   - 每日柱图固定展示近 30 天, 与筛选范围无关
 *
 * 首页的 HomeUsageDashboard 是金额口径的姊妹实现, 本页不复用它的外壳组件
 * (见 UsageTokenBars 的注释), 但共享同一条聚合链路与配色。
 */

import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as Select from '@radix-ui/react-select';
import { Check, ChevronDown, RefreshCw } from 'lucide-react';

import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/contexts/AuthContext';
import { useUsageHistory } from '@/hooks/useUsageHistory';
import { UsageHeatmap } from '@/components/new-chat/UsageHeatmap';
import { USAGE_TOP_MODELS, usageModelKey } from '@/components/new-chat/usagePalette';
import { UsageStatRow } from './UsageStatRow';
import { UsageTokenBars } from './UsageTokenBars';
import { UsageAgentTable, UsageModelTable } from './UsageBreakdownTables';
import { UsageTaskTable, useTopTokenSessions } from './UsageTaskTable';
import {
  buildAgentRows,
  buildModelRows,
  buildSummary,
  chartUsageHistoryPayload,
  filterUsageHistoryPayload,
  isUsageHistorySingleDay,
  isUsageHistoryEmpty,
  usageRangeDay,
  type UsageHistoryRange,
} from './usageHistoryStats';

/** 与 useUsageHistory 的拉取窗口一致 (20 周)。 */
const HEATMAP_WINDOW_DAYS = 140;

function Card({
  title,
  subtitle,
  refreshing,
  children,
}: {
  title: string;
  subtitle?: string;
  refreshing?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="mb-3.5 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4">
      <div className="mb-3 flex items-baseline gap-2">
        <span className="text-12 font-medium text-[var(--text-secondary)]">{title}</span>
        {subtitle ? <span className="text-11 text-[var(--text-tertiary)]">{subtitle}</span> : null}
        {refreshing ? (
          <span className="ml-auto inline-flex items-center gap-1 text-10 font-normal leading-none text-[var(--text-tertiary)]">
            <Spinner icon={RefreshCw} size={10} className="opacity-70" />
            {t('usageDashboard.updating')}
          </span>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function UsageHistorySection(): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const { history, refreshing } = useUsageHistory({
    userId: user?.id,
    days: 'all',
    modelDays: 'all',
    allowPendingEstimates: true,
  });
  const [range, setRange] = useState<UsageHistoryRange>('30d');
  const [heatmapWeeks, setHeatmapWeeks] = useState(20);

  // The Today option is an exact-day range too: use the payload's main-side
  // date anchor so both dropdown and chart entry points show the same selection.
  const selectedDay = usageRangeDay(range, history?.todayKey);
  const rangeLabel = useMemo(() => {
    if (selectedDay) {
      const [year, month, day] = selectedDay.split('-').map(Number);
      return new Intl.DateTimeFormat(i18n.language, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }).format(new Date(year, (month ?? 1) - 1, day ?? 1));
    }
    return t(`usageHistory.range.${range}`);
  }, [i18n.language, range, selectedDay, t]);
  const todayLabel = selectedDay
    ? t('usageHistory.stats.todayTokensInRange', { range: rangeLabel })
    : t('usageHistory.stats.todayTokens');
  const hideToday = isUsageHistorySingleDay(range);

  const filteredHistory = useMemo(
    () => filterUsageHistoryPayload(history, range),
    [history, range],
  );
  const chartHistory = useMemo(() => chartUsageHistoryPayload(history), [history]);
  const summary = useMemo(() => buildSummary(filteredHistory), [filteredHistory]);
  const modelRows = useMemo(() => buildModelRows(filteredHistory), [filteredHistory]);
  const agentRows = useMemo(() => buildAgentRows(filteredHistory), [filteredHistory]);
  // 配色顺序必须来自 modelRows 而不是 history.models: 后者由 main 按**可比金额**降序排
  // (usageHistory.ts 的 comparable), 本页只讲 token —— 直接用它会让同一个模型在柱图与
  // 模型表里配到不同颜色, 还会让"金额高但 token 很少"的模型挤掉真正的 token 前 N 名。
  const colorOrder = useMemo(
    () =>
      buildModelRows(chartHistory)
        .slice(0, USAGE_TOP_MODELS)
        .map((m) => usageModelKey(m.agentKind, m.model)),
    [chartHistory],
  );

  // 任务行与用量聚合是两条数据源: 聚合里有 token, 本地任务却可能一条都没有
  // (用户删光了会话, 或列表还没加载完)。空时整张卡片不渲染, 不留空壳。
  const taskRows = useTopTokenSessions(range, history?.todayKey, user?.id);
  const loading = history === null && refreshing;
  const loadFailed = history === null && !refreshing;
  const empty = history !== null && isUsageHistoryEmpty(history);

  const handleRangeChange = (value: string): void => {
    setRange(value as UsageHistoryRange);
  };

  const handleDayClick = (day: string): void => {
    setRange(`day:${day}` as UsageHistoryRange);
  };

  return (
    <div className="pb-2">
      <h2 className="mb-1.5 text-15 font-semibold text-[var(--text-primary)]">
        {t('settings.tabs.usage')}
      </h2>
      <p className="mb-4 max-w-[640px] text-12 leading-[1.7] text-[var(--text-tertiary)]">
        {t('usageHistory.description')}
      </p>

      <div className="mb-4 flex items-center justify-between gap-3">
        <span className="text-12 font-medium text-[var(--text-secondary)]">
          {t('usageHistory.range.label')}
        </span>
        <Select.Root value={range} onValueChange={handleRangeChange}>
          <Select.Trigger
            aria-label={t('usageHistory.range.ariaLabel')}
            className="flex h-9 w-[190px] items-center justify-between gap-2 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-12 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
          >
            <Select.Value />
            <Select.Icon asChild>
              <ChevronDown size={15} className="shrink-0 text-[var(--text-tertiary)]" />
            </Select.Icon>
          </Select.Trigger>
          <Select.Portal>
            <Select.Content
              position="popper"
              side="bottom"
              align="end"
              sideOffset={4}
              className="z-[10010] w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-1"
            >
              <Select.Viewport>
                {(['all', '30d', '7d', 'today'] as const).map((option) => (
                  <Select.Item
                    key={option}
                    value={option}
                    className="flex w-full cursor-pointer select-none items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-12 text-[var(--text-primary)] outline-none data-[highlighted]:bg-[var(--surface-hover)] data-[state=checked]:bg-[var(--settings-menu-bg-selected)] data-[state=checked]:font-medium data-[state=checked]:text-[var(--settings-menu-text-selected)]"
                  >
                    <Select.ItemText>{t(`usageHistory.range.${option}`)}</Select.ItemText>
                    <Select.ItemIndicator>
                      <Check size={14} strokeWidth={2.25} />
                    </Select.ItemIndicator>
                  </Select.Item>
                ))}
                {range.startsWith('day:') && selectedDay ? (
                  <Select.Item
                    value={range}
                    className="flex w-full cursor-pointer select-none items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-12 text-[var(--text-primary)] outline-none data-[highlighted]:bg-[var(--surface-hover)] data-[state=checked]:bg-[var(--settings-menu-bg-selected)] data-[state=checked]:font-medium data-[state=checked]:text-[var(--settings-menu-text-selected)]"
                  >
                    <Select.ItemText>{rangeLabel}</Select.ItemText>
                    <Select.ItemIndicator>
                      <Check size={14} strokeWidth={2.25} />
                    </Select.ItemIndicator>
                  </Select.Item>
                ) : null}
              </Select.Viewport>
            </Select.Content>
          </Select.Portal>
        </Select.Root>
      </div>

      {loading ? (
        <div
          className="flex min-h-[176px] items-center justify-center rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-tertiary)]"
          role="status"
          aria-label={t('usageDashboard.updating')}
        >
          <Spinner size={20} />
        </div>
      ) : loadFailed ? (
        <div
          className="flex min-h-[176px] items-center justify-center rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 text-center text-12 text-[var(--error-fg)]"
          role="alert"
        >
          {t('usageHistory.loadFailed')}
        </div>
      ) : empty ? (
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-8 text-center text-12 text-[var(--text-tertiary)]">
          {t('usageHistory.empty')}
        </div>
      ) : (
        <>
          <Card title={t('usageHistory.summary.title')} refreshing={refreshing}>
            <UsageStatRow
              summary={summary}
              rangeLabel={rangeLabel}
              todayLabel={todayLabel}
              hideToday={hideToday}
            />
          </Card>

          <Card
            title={t('usageHistory.heatmap.title')}
            subtitle={t('usageHistory.heatmap.subtitle', { count: heatmapWeeks })}
          >
            <UsageHeatmap
              days={chartHistory?.days ?? []}
              todayKey={chartHistory?.todayKey ?? ''}
              windowDays={HEATMAP_WINDOW_DAYS}
              metric="tokens"
              selectedDay={selectedDay}
              onDayClick={handleDayClick}
              onVisibleWeeksChange={setHeatmapWeeks}
            />
          </Card>

          <Card title={t('usageHistory.daily.title')} subtitle={t('usageHistory.daily.subtitle')}>
            <UsageTokenBars
              modelDaily={chartHistory?.modelDaily ?? []}
              colorOrder={colorOrder}
              todayKey={chartHistory?.todayKey ?? ''}
              selectedDay={selectedDay}
              onDayClick={handleDayClick}
            />
          </Card>

          {agentRows.length > 0 && (
            <Card title={t('usageHistory.byAgent.title')} subtitle={rangeLabel}>
              <div className="overflow-x-auto">
                <UsageAgentTable
                  rows={agentRows}
                  rangeLabel={rangeLabel}
                  todayLabel={todayLabel}
                  hideToday={hideToday}
                />
              </div>
            </Card>
          )}

          {modelRows.length > 0 && (
            <Card title={t('usageHistory.byModel.title')} subtitle={rangeLabel}>
              <div className="overflow-x-auto">
                <UsageModelTable rows={modelRows} rangeLabel={rangeLabel} colorOrder={colorOrder} />
              </div>
            </Card>
          )}

          {taskRows.length > 0 && (
            <Card
              title={t('usageHistory.tasks.title')}
              subtitle={t('usageHistory.tasks.subtitle', { range: rangeLabel })}
            >
              <div className="overflow-x-auto">
                <UsageTaskTable rows={taskRows} rangeLabel={rangeLabel} />
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
