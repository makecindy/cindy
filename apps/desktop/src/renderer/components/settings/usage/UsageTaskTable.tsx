/**
 * UsageTaskTable — 「最耗 token 的任务」。
 *
 * 数据来自会话列表 (useCCSessions → sessionsStore), 不新增 IPC:
 *   - tokens:  Session.totalTokenUsage
 *   - 上下文:  contextTokens / contextWindow
 *   - 供应商:  Session.providerId, 经 providerDisplayNameById 映射成展示名
 *              (内置 id 走设置页 i18n 标题, 自定义供应商回退目录里的 name)
 *   - 最后活跃: userSendAt / updatedAt 中较新者 (与 SessionItem 同一条时间轴 ——
 *              旧版 DB 行只写 userSendAt), 走 sidebar 同一套 formatSidebarTime
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
 *
 * 已知取舍: 候选集来自 sessionsStore 的列表桶 (DEFAULT_LIMIT = 1000, 按 updatedAt 降序),
 * 因此"近 30 天内更新过的会话超过 1000 条"时, 被截断的高用量会话进不了 Top N。
 * 修它需要一次按 total_token_usage 排序的专用查询 —— 那是新增 IPC, 不进本版。
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { formatCompactTokens, formatModelShort } from '@/lib/usageFormat';
import { useCCSessions } from '@/hooks/useCCSessions';
import type { Session } from '@/lib/ccAgent.types';
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

/**
 * 列宽口径: 右侧五列 (模型/供应商/token/上下文/最后活跃) 都是短的定长内容, 让它们
 * 按各自内容取满宽 —— 这几列是要被读数的, 不能被挤窄或截断; pl-3 是列间距, 否则
 * 相邻两列的数字会贴到一起。任务名是用户输入的自由文本, 长度没有上限, 只能反过来
 * 吃右侧列分完后剩下的空间。
 *
 * 列间距取 12px 而不是 16px: 侧栏可拉到 480 (useSidebarResize MAX_WIDTH), 主窗下限
 * 800, 此时设置页卡片内的表格只剩约 230px。列间距落在 nowrap 单元格上是**不可收缩**
 * 宽度, 五列就是 5 份 —— 12px 比 16px 省下 20px, 直接抬高开始溢出的窗口宽度。
 * 12 与 16 同在 DESIGN.md §5 间距刻度上, 这个字号下的分隔效果没有可见差别。
 *
 * 实现上靠 `w-full + max-w-0` (任务列自身 pl-0): 自动布局的表格若不加这一对,
 * 会先按 nowrap 的最长任务名算出列宽、把整张卡片横向撑开, 内层的 truncate 因为
 * 没有可收缩的宽度而失效。max-w-0 让这一列先塌到 0, w-full 再让它领走余量。
 */
const TH_CLASS =
  'whitespace-nowrap border-b border-[var(--border-default)] pb-2 pl-3 text-right text-11 font-medium text-[var(--text-tertiary)]';
const TD_CLASS =
  'whitespace-nowrap border-b border-[var(--border-default)] py-2 pl-3 text-right text-12 tabular-nums';
const TASK_COL_CLASS = 'w-full max-w-0 pl-0';

/** 与 SessionItem 一致: 取两者中较新的值, 兼容只写 userSendAt 的存量行。 */
function lastActiveIso(session: { updatedAt: string; userSendAt: string | null }): string {
  return session.userSendAt && session.userSendAt > session.updatedAt
    ? session.userSendAt
    : session.updatedAt;
}

function activeWithinWindow(iso: string | null | undefined, cutoffMs: number): boolean {
  if (!iso) return false;
  const ts = Date.parse(iso);
  return Number.isFinite(ts) && ts >= cutoffMs;
}

/**
 * 候选行 —— 单独暴露成 hook, 让调用方能在**渲染卡片之前**知道有没有行。
 * 组件内部返回 null 会留下一张只有标题、正文全空的卡片 (会话被删光 / 列表首次加载中)。
 */
export function useTopTokenSessions(): Session[] {
  // 归档的任务同样消耗过 token, 统计口径不该因为用户归档而变。
  const { sessions } = useCCSessions({ includeArchived: 'all' });

  return useMemo(() => {
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
}

export function UsageTaskTable({ rows }: { rows: Session[] }): React.JSX.Element {
  const { t } = useTranslation();
  const { providers } = useProviders();

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
              <td className={cn(TD_CLASS, TASK_COL_CLASS, 'text-left')}>
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className="size-2 shrink-0 rounded-[2px]"
                    style={{ backgroundColor: usageRankColor(index) }}
                  />
                  <span className="truncate" title={session.title}>
                    {session.title}
                  </span>
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
                {formatSidebarTime(lastActiveIso(session), t) || UNKNOWN_VALUE}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
