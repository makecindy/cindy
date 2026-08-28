import {
  projectSessionActivity,
  type SessionActivitySnapshot,
} from '@cindy/maker-shared/session-activity';

import type { AttentionKind } from '@/lib/sessionAttentionStore';

export type SidebarRightStatusKind = 'error' | 'awaiting' | 'running' | 'done' | 'time';

export interface SidebarRightStatusInput {
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
    sessionId,
    recordStatus: liveActivity?.recordStatus ?? recordStatus,
    title,
    source: liveActivity?.source ?? 'fallback',
    livePhase: liveActivity?.phase ?? null,
    running: isRunning || liveActivity?.currentTurnActive === true,
    waitingForUser: awaitingAttention,
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
 * 右侧状态槽优先级:error > awaiting > running > done(完成未读)> time。
 * error / awaiting 拆成两档两色(红 / TapTap 蓝),与灵动岛 phase 色表一致;
 * 两者都压过 running spinner —— "需要你处理"永远最高。
 */
export function resolveSidebarRightStatus(
  activity: Pick<SessionActivitySnapshot, 'phase' | 'attention'>,
): SidebarRightStatusKind {
  if (activity.phase === 'error' && activity.attention) return 'error';
  if (activity.phase === 'needs-interaction') return 'awaiting';
  if (activity.phase === 'running') return 'running';
  if (activity.phase === 'completed' && activity.attention) return 'done';
  return 'time';
}
