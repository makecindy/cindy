import {
  projectSessionActivity,
  resolveSessionRightStatus,
  type SessionActivitySnapshot,
  type SessionInterruptionState,
  type SessionRightStatus,
} from '@cindy/maker-shared/session-activity';

import type { AttentionKind } from '@/lib/sessionAttentionStore';

export { resolveSessionRightStatus as resolveSidebarRightStatus } from '@cindy/maker-shared/session-activity';

/**
 * 会话行右侧状态档位：共享的五档之外，桌面端本地多一档「排队中」。
 *
 * 这一档不进共享协议：它只描述本机输入队列（队列里还有没派发的消息），
 * 不是跨电脑的会话活动相位。
 */
export type SidebarRightStatusKind = SessionRightStatus | 'queued';

export interface SidebarRightStatusInput {
  interruption?: SessionInterruptionState;
  pendingIssueConfirm?: boolean;
  sessionId: string;
  title?: string | null;
  recordStatus?: SessionActivitySnapshot['recordStatus'];
  liveActivity?: {
    phase: SessionActivitySnapshot['phase'];
    recordStatus?: SessionActivitySnapshot['recordStatus'];
    compactDetail?: string;
    currentActionSummary?: string | null;
    interactionKind?: string;
    attention?: boolean;
    currentTurnActive?: boolean;
    startedAtMs?: number | null;
    lastActivityAtMs?: number | null;
    source?: SessionActivitySnapshot['source'];
  } | null;
  /**
   * store 记录的 attention kind(按 sessionId 精准订阅取得);
   * 定时任务未读(attentionKind 缺失)语义等同 'done'。
   */
  attentionKind: AttentionKind | undefined;
  /** 定时任务未读且失败/中断(failed/interrupted)—— 语义等同 error。 */
  isUrgentFromContext: boolean;
  isRunning: boolean;
  hasAttentionNotification: boolean;
}

/** Collapse local/remote live state and legacy attention fallbacks into one model. */
export function projectSidebarSessionActivity({
  interruption,
  pendingIssueConfirm,
  sessionId,
  title,
  recordStatus,
  liveActivity,
  attentionKind,
  isUrgentFromContext,
  isRunning,
  hasAttentionNotification,
}: SidebarRightStatusInput): SessionActivitySnapshot {
  const errorAttention =
    isUrgentFromContext || (hasAttentionNotification && attentionKind === 'error');
  const awaitingAttention = hasAttentionNotification && attentionKind === 'awaiting';
  const doneAttention = hasAttentionNotification && !errorAttention && !awaitingAttention;
  return projectSessionActivity({
    interruption,
    sessionId,
    recordStatus: liveActivity?.recordStatus ?? recordStatus,
    title,
    source: liveActivity?.source ?? 'fallback',
    livePhase: liveActivity?.phase ?? null,
    running: isRunning || liveActivity?.currentTurnActive === true,
    waitingForUser: awaitingAttention || pendingIssueConfirm === true,
    terminal: errorAttention ? 'error' : doneAttention ? 'completed' : null,
    startedAtMs: liveActivity?.startedAtMs,
    lastActivityAtMs: liveActivity?.lastActivityAtMs,
    currentActionSummary: liveActivity?.currentActionSummary ?? null,
    interactionKind: liveActivity?.interactionKind,
    // Automation failure urgency intentionally lives outside the regular
    // attention-notification store. Preserve it in the canonical projection so
    // restart/expiry/acknowledgement cannot erase the existing red error state.
    attention: liveActivity?.attention === true || hasAttentionNotification || isUrgentFromContext,
  });
}

/**
 * 会话行右侧状态：共享五档之外，闲置(空闲)且队列里还有没派发的输入时显示「排队中」。
 *
 * 只覆盖 `time`(空闲)一档：出错红点、待处理蓝点、运行中 spinner、完成绿点各自
 * 已经是"有事发生"的信号，压过排队提示；空闲才是「气泡说排队、会话说空闲」的那一处
 * 矛盾(#11299)。
 */
export function resolveSessionRowRightStatus(
  activity: Pick<SessionActivitySnapshot, 'phase' | 'attention'>,
  hasQueuedInput: boolean,
): SidebarRightStatusKind {
  const kind = resolveSessionRightStatus(activity);
  return kind === 'time' && hasQueuedInput ? 'queued' : kind;
}
