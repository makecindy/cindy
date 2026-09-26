/**
 * UsageTaskTable — 「最耗 token 的任务」(设置 → 用量历史)。
 *
 * 数据来自用量历史 payload 的 taskDaily / tasks(main 侧 daily_session_usage,多设备范围
 * 合并了其它电脑同步来的行):按所选时间范围对每个任务**在该范围内**产生的 token 求和,
 * 取前 TOP_TASKS 名。每日 × 任务的记录从功能上线起积累,更早的用量不计入 —— 所选范围
 * 早于最早记录时,卡片副标题注明「按天统计从 X 起」。
 *
 * 任务标题是跳转到该任务的链接;整行是鼠标的放大命中区(键盘仍只落在链接上)。其它电脑
 * 的任务只有在远程设备列表里能找到时才可点击(需要该设备已连接)。
 *
 * 标题 / 模型 / 供应商 / 上下文取任务当前值,不是每轮事实;providerId 为 null 留空。
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';

import { cn } from '@/lib/utils';
import { formatCompactTokens, formatModelShort } from '@/lib/usageFormat';
import { formatSidebarTime } from '@/features/cc-agent/lib/formatSidebarTime';
import { useProviders } from '@/hooks/useProviders';
import type { UsageHistoryDevice, UsageHistoryPayload } from '@/hooks/useUsageHistory';
import { usageRankColor } from '@/components/new-chat/usagePalette';
import { providerDisplayNameById } from '@/lib/providerDisplayName';
import { resolveSessionRoute } from '@/lib/orcaSessionIdentity';
import { useRemoteProjectSessions } from '@/features/device-link/remoteProjectsStore';
import { formatUsagePercent } from './formatUsagePercent';
import { isUsageDayInRange, type UsageHistoryRange } from './usageHistoryStats';

/** 展示条数 —— 与"最耗"的语义匹配, 不做成完整列表 (那是任务侧栏的事)。 */
const TOP_TASKS = 8;
const UNKNOWN_VALUE = '—';
/** payload 里本机任务的设备键(见 main usageHistory LOCAL_TASK_DEVICE)。 */
const LOCAL_TASK_DEVICE = 'local';

/**
 * 列宽口径: 右侧五列都是短的定长内容, 按各自内容取满宽; 任务名是自由文本, 只能吃剩下
 * 的空间。`w-full + max-w-0` 让任务列先塌到 0 再领走余量, 内层 truncate 才生效。
 */
const TH_CLASS =
  'whitespace-nowrap border-b border-[var(--border-default)] pb-2 pl-3 text-right text-12 font-medium text-[var(--text-secondary)]';
const TD_CLASS =
  'whitespace-nowrap border-b border-[var(--border-default)] py-2 pl-3 text-right text-13 tabular-nums';
const TASK_COL_CLASS = 'w-full max-w-0 pl-0';

export interface UsageTaskRow {
  taskKey: string;
  deviceId: string;
  sessionId: string;
  title: string;
  model: string;
  providerId: string | null;
  contextTokens: number;
  contextWindow: number;
  lastActiveAt: number;
  /** 所选范围内的 token。 */
  tokens: number;
}

/** 按所选范围汇总每个任务的 token,降序取前 TOP_TASKS。 */
export function buildUsageTaskRows(
  history: UsageHistoryPayload | null,
  range: UsageHistoryRange,
): UsageTaskRow[] {
  if (!history?.taskDaily || !history.tasks || !history.todayKey) return [];
  const tokensByTask = new Map<string, number>();
  for (const row of history.taskDaily) {
    if (!isUsageDayInRange(row.day, history.todayKey, range)) continue;
    tokensByTask.set(row.taskKey, (tokensByTask.get(row.taskKey) ?? 0) + row.tokens);
  }
  const rows: UsageTaskRow[] = [];
  for (const task of history.tasks) {
    const tokens = tokensByTask.get(task.taskKey) ?? 0;
    if (tokens > 0) rows.push({ ...task, tokens });
  }
  return rows.sort((a, b) => b.tokens - a.tokens).slice(0, TOP_TASKS);
}

/**
 * 最早有每日 × 任务记录的日期;所选范围早于它时返回它(用于「按天统计从 X 起」),
 * 否则返回 null。
 */
export function usageTaskCoverageStart(
  history: UsageHistoryPayload | null,
  range: UsageHistoryRange,
): string | null {
  if (!history?.taskDaily?.length || !history.todayKey) return null;
  const earliest = history.taskDaily.reduce(
    (min, row) => (row.day < min ? row.day : min),
    history.taskDaily[0].day,
  );
  // 所选范围内是否有早于最早记录的日期:检查最早记录的前一天是否落在范围里。
  const [y, m, d] = earliest.split('-').map(Number);
  const prev = new Date(y, (m ?? 1) - 1, (d ?? 1) - 1);
  const prevKey = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}-${String(prev.getDate()).padStart(2, '0')}`;
  return isUsageDayInRange(prevKey, history.todayKey, range) ? earliest : null;
}

export function UsageTaskTable({
  rows,
  rangeLabel,
  devices,
}: {
  rows: UsageTaskRow[];
  rangeLabel: string;
  devices?: readonly UsageHistoryDevice[];
}): React.JSX.Element {
  const { t } = useTranslation();
  const { providers } = useProviders();
  const navigate = useNavigate();
  const remoteSessions = useRemoteProjectSessions();
  const deviceNames = new Map((devices ?? []).map((device) => [device.deviceId, device.name]));

  const openRow = (row: UsageTaskRow): void => {
    const remote =
      row.deviceId === LOCAL_TASK_DEVICE
        ? null
        : (remoteSessions.find((session) => session.id === row.sessionId) ?? null);
    void resolveSessionRoute(row.sessionId, remote).then((route) => navigate(route));
  };

  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          <th className={cn(TH_CLASS, TASK_COL_CLASS, 'text-left')}>
            {t('usageHistory.tasks.col.task')}
          </th>
          <th className={TH_CLASS}>{t('usageHistory.tasks.col.model')}</th>
          <th className={TH_CLASS} title={t('usageHistory.tasks.providerTooltip')}>
            {t('usageHistory.tasks.col.provider')}
          </th>
          <th
            className={TH_CLASS}
            title={t('usageHistory.tasks.tokensTooltip', { range: rangeLabel })}
          >
            {t('usageHistory.tasks.col.tokens')}
          </th>
          <th className={TH_CLASS}>{t('usageHistory.tasks.col.context')}</th>
          <th className={TH_CLASS}>{t('usageHistory.tasks.col.lastActive')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => {
          const isLocal = row.deviceId === LOCAL_TASK_DEVICE;
          const openable =
            isLocal || remoteSessions.some((session) => session.id === row.sessionId);
          const deviceName = isLocal ? null : (deviceNames.get(row.deviceId) ?? null);
          const providerName = row.providerId
            ? providerDisplayNameById(row.providerId, providers, t)
            : null;
          const contextRatio = row.contextWindow > 0 ? row.contextTokens / row.contextWindow : null;
          const title = row.title || UNKNOWN_VALUE;
          return (
            <tr
              key={row.taskKey}
              data-task-key={row.taskKey}
              className={cn(
                openable && 'cursor-pointer transition-colors hover:bg-[var(--surface-hover)]',
              )}
              // 整行只是鼠标的放大命中区;键盘与读屏仍落在标题链接上。
              onClick={openable ? () => openRow(row) : undefined}
            >
              <td className={cn(TD_CLASS, TASK_COL_CLASS, 'text-left')}>
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className="size-2 shrink-0 rounded-[2px]"
                    style={{ backgroundColor: usageRankColor(index) }}
                  />
                  <span className="flex min-w-0 flex-col">
                    {openable ? (
                      <Link
                        to={`/cc-agent/${row.sessionId}`}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          openRow(row);
                        }}
                        className="truncate rounded-[4px] font-medium text-[var(--text-primary)] underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                        title={title}
                      >
                        {title}
                      </Link>
                    ) : (
                      <span className="truncate font-medium" title={title}>
                        {title}
                      </span>
                    )}
                    {deviceName ? (
                      <span className="truncate text-12 font-normal text-[var(--text-tertiary)]">
                        {deviceName}
                      </span>
                    ) : null}
                  </span>
                </span>
              </td>
              <td className={cn(TD_CLASS, 'text-[var(--text-tertiary)]')}>
                {row.model ? formatModelShort(row.model) : UNKNOWN_VALUE}
              </td>
              <td className={cn(TD_CLASS, 'text-[var(--text-tertiary)]')}>
                {providerName ?? UNKNOWN_VALUE}
              </td>
              <td className={TD_CLASS}>{formatCompactTokens(row.tokens)}</td>
              <td className={cn(TD_CLASS, 'text-[var(--text-tertiary)]')}>
                {contextRatio === null ? UNKNOWN_VALUE : formatUsagePercent(contextRatio)}
              </td>
              <td className={cn(TD_CLASS, 'text-[var(--text-tertiary)]')}>
                {row.lastActiveAt > 0
                  ? formatSidebarTime(new Date(row.lastActiveAt).toISOString(), t) || UNKNOWN_VALUE
                  : UNKNOWN_VALUE}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
