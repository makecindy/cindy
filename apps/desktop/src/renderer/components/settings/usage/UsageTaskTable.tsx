/**
 * UsageTaskTable — 「最耗 token 的任务」。
 *
 * 数据来自会话列表 (useCCSessions → sessionsStore), 不新增 IPC:
 *   - tokens:  Session.totalTokenUsage
 *   - 上下文:  contextTokens / contextWindow
 *   - 供应商:  Session.providerId, 经 providerDisplayNameById 映射成展示名
 *              (内置 id 走设置页 i18n 标题, 自定义供应商回退目录里的 name)
 *   - 最后活跃: Session.updatedAt, 走 sidebar 同一套 formatSidebarTime (相对时间)
 *
 * 两处口径必须在 UI 上讲清楚, 否则会被误读:
 *   1. totalTokenUsage 是该任务的**生命周期累计**, 不是窗口内增量。本表筛的是
 *      "近 30 天内活跃过的任务", 所以一个三个月前开始、昨天还在跑的任务会带着
 *      它的全部累计出现 —— 表头 tooltip 写明这一点。
 *   2. providerId 是会话**当前值**而非每轮事实, 且可为 null (跟随默认路由)。
 *      null 留空 (照 SessionInfoMeta 既有的"无数据不显示"), 不臆造默认供应商;
 *      任务若中途切换过供应商, 早先的 token 也会归到当前这个上 —— 表头 tooltip
 *      写明"取当前选定的供应商", 不额外标记 (没有可靠的切换记录可依据)。
 *
 * 远程会话 (device-link) 的 token 字段可能缺失或为 0 —— 同样按"无数据不显示"过滤掉。
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { formatCompactTokens, formatModelShort } from '@/lib/usageFormat';
import { useCCSessions } from '@/hooks/useCCSessions';
import { formatSidebarTime } from '@/features/cc-agent/lib/formatSidebarTime';
import { useProviders } from '@/hooks/useProviders';
import { usageRankColor } from '@/components/new-chat/usagePalette';
import { providerDisplayNameById } from '@/lib/providerDisplayName';
import { formatUsagePercent } from './formatUsagePercent';

/** 展示条数 —— 与"最耗"的语义匹配, 不做成完整列表 (那是任务侧栏的事)。 */
const TOP_TASKS = 8;
/** 与本页其它区块一致的窗口。 */
const WINDOW_DAYS = 30;
const UNKNOWN_VALUE = '—';

const TH_CLASS =
  'whitespace-nowrap border-b border-[var(--border-default)] pb-2 text-right text-11 font-medium text-[var(--text-tertiary)]';
const TD_CLASS =
  'whitespace-nowrap border-b border-[var(--border-default)] py-2 text-right text-12 tabular-nums';

function activeWithinWindow(iso: string | null | undefined, cutoffMs: number): boolean {
  if (!iso) return false;
  const ts = Date.parse(iso);
  return Number.isFinite(ts) && ts >= cutoffMs;
}

export function UsageTaskTable(): React.JSX.Element | null {
  const { t } = useTranslation();
  // 归档的任务同样消耗过 token, 统计口径不该因为用户归档而变。
  const { sessions } = useCCSessions({ includeArchived: 'all' });
  const { providers } = useProviders();

  const rows = useMemo(() => {
    const cutoff = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;
    return sessions
      .filter(
        (session) =>
          session.totalTokenUsage > 0 &&
          (activeWithinWindow(session.updatedAt, cutoff) ||
            activeWithinWindow(session.userSendAt, cutoff)),
      )
      .sort((a, b) => b.totalTokenUsage - a.totalTokenUsage)
      .slice(0, TOP_TASKS);
  }, [sessions]);

  if (rows.length === 0) return null;

  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          <th className={cn(TH_CLASS, 'text-left')}>{t('usageHistory.tasks.col.task')}</th>
          <th className={TH_CLASS}>{t('usageHistory.tasks.col.model')}</th>
          <th className={TH_CLASS} title={t('usageHistory.tasks.providerTooltip')}>
            {t('usageHistory.tasks.col.provider')}
          </th>
          <th className={TH_CLASS} title={t('usageHistory.tasks.tokensTooltip')}>
            {t('usageHistory.tasks.col.tokens')}
          </th>
          <th className={TH_CLASS}>{t('usageHistory.tasks.col.context')}</th>
          <th className={TH_CLASS}>{t('usageHistory.tasks.col.lastActive')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((session, index) => {
          const providerName = session.providerId
            ? providerDisplayNameById(session.providerId, providers, t)
            : null;
          const contextRatio =
            session.contextWindow > 0 ? session.contextTokens / session.contextWindow : null;
          return (
            <tr key={session.id}>
              <td className={cn(TD_CLASS, 'text-left')}>
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className="size-2 shrink-0 rounded-[2px]"
                    style={{ backgroundColor: usageRankColor(index) }}
                  />
                  <span className="truncate">{session.title}</span>
                </span>
              </td>
              <td className={cn(TD_CLASS, 'text-[var(--text-tertiary)]')}>
                {formatModelShort(session.model)}
              </td>
              <td className={cn(TD_CLASS, 'text-[var(--text-tertiary)]')}>
                {providerName ?? UNKNOWN_VALUE}
              </td>
              <td className={TD_CLASS}>{formatCompactTokens(session.totalTokenUsage)}</td>
              <td className={cn(TD_CLASS, 'text-[var(--text-tertiary)]')}>
                {contextRatio === null ? UNKNOWN_VALUE : formatUsagePercent(contextRatio)}
              </td>
              <td className={cn(TD_CLASS, 'text-[var(--text-tertiary)]')}>
                {formatSidebarTime(session.updatedAt, t) || UNKNOWN_VALUE}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
