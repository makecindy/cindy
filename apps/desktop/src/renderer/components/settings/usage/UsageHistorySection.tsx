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
 *   - 热力图与连续活跃天数走 days[] (140 天 = 20 周)
 *   - 按模型 / 按 agent / 每日柱图走 models[] 与 modelDaily (30 天)
 *
 * 首页的 HomeUsageDashboard 是金额口径的姊妹实现, 本页不复用它的外壳组件
 * (见 UsageTokenBars 的注释), 但共享同一条聚合链路与配色。
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';

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
  isUsageHistoryEmpty,
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
        {subtitle ? (
          <span className="text-11 text-[var(--text-tertiary)]">{subtitle}</span>
        ) : null}
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
  const { t } = useTranslation();
  const { user } = useAuth();
  const { history, refreshing } = useUsageHistory({ userId: user?.id });

  const summary = useMemo(() => buildSummary(history), [history]);
  const modelRows = useMemo(() => buildModelRows(history), [history]);
  const agentRows = useMemo(() => buildAgentRows(history), [history]);
  // 配色顺序必须来自 modelRows 而不是 history.models: 后者由 main 按**可比金额**降序排
  // (usageHistory.ts 的 comparable), 本页只讲 token —— 直接用它会让同一个模型在柱图与
  // 模型表里配到不同颜色, 还会让"金额高但 token 很少"的模型挤掉真正的 token 前 N 名。
  const colorOrder = useMemo(
    () => modelRows.slice(0, USAGE_TOP_MODELS).map((m) => usageModelKey(m.agentKind, m.model)),
    [modelRows],
  );

  // 任务行与用量聚合是两条数据源: 聚合里有 token, 本地任务却可能一条都没有
  // (用户删光了会话, 或列表还没加载完)。空时整张卡片不渲染, 不留空壳。
  const taskRows = useTopTokenSessions();
  const empty = isUsageHistoryEmpty(history);

  return (
    <div className="pb-2">
      <h2 className="mb-1.5 text-15 font-semibold text-[var(--text-primary)]">
        {t('settings.tabs.usage')}
      </h2>
      <p className="mb-4 max-w-[640px] text-12 leading-[1.7] text-[var(--text-tertiary)]">
        {t('usageHistory.description')}
      </p>

      {empty ? (
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-8 text-center text-12 text-[var(--text-tertiary)]">
          {t('usageHistory.empty')}
        </div>
      ) : (
        <>
          <Card title={t('usageHistory.summary.title')} refreshing={refreshing}>
            <UsageStatRow summary={summary} />
          </Card>

          <Card
            title={t('usageHistory.heatmap.title')}
            subtitle={t('usageHistory.heatmap.subtitle')}
          >
            <UsageHeatmap
              days={history?.days ?? []}
              todayKey={history?.todayKey ?? ''}
              windowDays={HEATMAP_WINDOW_DAYS}
              metric="tokens"
            />
          </Card>

          <Card
            title={t('usageHistory.daily.title')}
            subtitle={t('usageHistory.daily.subtitle')}
          >
            <UsageTokenBars
              modelDaily={history?.modelDaily ?? []}
              colorOrder={colorOrder}
              todayKey={history?.todayKey ?? ''}
            />
          </Card>

          {agentRows.length > 0 && (
            <Card
              title={t('usageHistory.byAgent.title')}
              subtitle={t('usageHistory.byAgent.subtitle')}
            >
              <UsageAgentTable rows={agentRows} />
            </Card>
          )}

          {modelRows.length > 0 && (
            <Card
              title={t('usageHistory.byModel.title')}
              subtitle={t('usageHistory.byModel.subtitle')}
            >
              <UsageModelTable rows={modelRows} />
            </Card>
          )}

          {taskRows.length > 0 && (
            <Card
              title={t('usageHistory.tasks.title')}
              subtitle={t('usageHistory.tasks.subtitle')}
            >
              <UsageTaskTable rows={taskRows} />
            </Card>
          )}
        </>
      )}
    </div>
  );
}
