/**
 * sessionRightStatus —— 会话行右侧状态槽的档位判定(纯函数,便于单测)。
 *
 * 与桌面版侧栏 `sidebarRightStatus.ts` 同一套五档优先级与全端统一色表:
 *   1. error(出错未读)          → 红点(--card-status-error / colors.statusError)
 *   2. awaiting(等待回复/选择)  → TapTap 蓝点(colors.statusAwaiting)
 *   3. running                    → spinner 动画(中性色,橙色语义由行首 vendor icon 呼吸表达)
 *   4. done(完成未读)           → 绿点(colors.statusDone)
 *   5. time                       → 最近活动时间文字
 *
 * 手机端信号来源(与桌面的 attention store 对应关系):
 *   - liveActivity(桌面 main 的会话活动 relay,#368):phase 四态 + attention 未读标志。
 *     attention 的已读语义由 main 侧维护(error 未读要等真实展示才清,与桌面一致),
 *     手机端只消费,不自己猜。
 *   - pendingInteractionCount:实时待处理交互数(ask-user / 权限 / 计划审阅)——
 *     即使 liveActivity 缺失(relay 断连)也能点亮 awaiting。
 *   - scheduleUnreadCount / scheduleHasUnreadFailedRun:同桌面自动化运行账本。
 */
import {
  projectSessionActivity,
  resolveSessionRightStatus,
  resolveCollapsedGroupRightStatus,
  type SessionRightStatus,
  type SessionInterruptionState,
} from '@cindy/maker-shared/session-activity';

type SessionRow = import('@cindy/maker-shared/session-list').RemoteSessionListItem;
export type MobileSessionRightStatus = SessionRightStatus;

export function latestMobileSessionRow(item: SessionRow): SessionRow {
  return (
    item.automationGroup?.items.reduce((a, b) =>
      Date.parse(b.session.userSendAt ?? b.session.updatedAt ?? b.session.createdAt) >
      Date.parse(a.session.userSendAt ?? a.session.updatedAt ?? a.session.createdAt)
        ? b
        : a,
    ) ?? item
  );
}

export interface MobileSessionRightStatusInput {
  interruption?: SessionInterruptionState;
  /** liveActivity.phase(缺失 = 无 relay 数据)。 */
  livePhase: 'running' | 'needs-interaction' | 'completed' | 'error' | undefined;
  /** liveActivity.attention === true(未读标志,main 侧维护已读语义)。 */
  liveAttention: boolean;
  /** 实时待处理交互数(ask-user / 权限 / 计划审阅)。 */
  pendingInteractionCount: number;
  /** 会话(或其绑定 schedule)是否正在运行。 */
  running: boolean;
  /** 定时任务未读运行数。 */
  scheduleUnreadCount: number;
  scheduleHasUnreadFailedRun?: boolean;
}

export function resolveMobileSessionRightStatus({
  interruption,
  livePhase,
  liveAttention,
  pendingInteractionCount,
  running,
  scheduleUnreadCount,
  scheduleHasUnreadFailedRun = false,
}: MobileSessionRightStatusInput): MobileSessionRightStatus {
  return resolveSessionRightStatus(
    projectSessionActivity({
      interruption,
      sessionId: '',
      livePhase,
      running,
      waitingForUser: pendingInteractionCount > 0,
      terminal: scheduleHasUnreadFailedRun ? 'error' : scheduleUnreadCount > 0 ? 'completed' : null,
      attention:
        liveAttention ||
        pendingInteractionCount > 0 ||
        scheduleUnreadCount > 0 ||
        scheduleHasUnreadFailedRun,
    }),
  );
}

/** Group header mirrors the latest run; collapsed errors remain discoverable. */
export function resolveMobileSessionRowStatus(
  item: import('@cindy/maker-shared/session-list').RemoteSessionListItem,
  running: boolean,
  expanded = false,
): { status: MobileSessionRightStatus; target: import('@cindy/maker-shared/session-list').RemoteSessionListItem } {
  const children = item.automationGroup?.items;
  const latest = latestMobileSessionRow(item);
  const statusOf = (row: typeof item, isRunning: boolean) =>
    resolveMobileSessionRightStatus({
      interruption: row.session,
      livePhase: row.liveActivity?.phase,
      liveAttention: row.liveActivity?.attention === true,
      pendingInteractionCount: row.pendingInteractionCount,
      running:
        isRunning || row.liveActivity?.phase === 'running' || row.scheduleInfo?.running === true,
      scheduleUnreadCount: row.scheduleInfo?.unreadCount ?? 0,
      scheduleHasUnreadFailedRun: row.scheduleInfo?.hasUnreadFailedRun,
    });
  const error = children?.find((row) => statusOf(row, false) === 'error');
  const hasDone = children?.some((row) => statusOf(row, false) === 'done');
  return {
    status: resolveCollapsedGroupRightStatus({
      collapsed: !expanded,
      latestKind: statusOf(latest, running),
      tone: error ? 'error' : hasDone ? 'done' : null,
    }),
    target: !expanded && error ? error : latest,
  };
}
