import {
  projectSessionActivity,
  type SessionActivitySnapshot,
  type SessionInterruptionState,
} from '@cindy/maker-shared/session-activity';

import type { AttentionKind } from '@/lib/sessionAttentionStore';

export { resolveSessionRightStatus as resolveSidebarRightStatus } from '@cindy/maker-shared/session-activity';
export type { SessionRightStatus as SidebarRightStatusKind } from '@cindy/maker-shared/session-activity';

export interface SidebarRightStatusInput {
  interruption?: SessionInterruptionState;
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
