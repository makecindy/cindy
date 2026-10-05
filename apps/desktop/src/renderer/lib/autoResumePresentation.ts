import { CODEX_RESET_CREDIT_RESUME_REASON } from '../../shared/codexResetCreditAutoUse';
import type { ChatMessage, ContinuationInFlightProjectionCapability } from './makerChatStore';

export interface AutoResumeCardInfo {
  error?: string;
  attempt?: number;
  maxAttempts?: number;
  sessionTotal?: number;
  outcome?: 'succeeded' | 'failed';
  /** 这次续跑前先用了一次 Codex 重置（配额耗尽），不是连接中断后的重连。 */
  resetCredit?: true;
}

/** Silent-stop continuations have no interruption context and are not reconnects. */
export function hasInterruptionContext(info: AutoResumeCardInfo): boolean {
  return (
    info.error !== undefined ||
    info.attempt !== undefined ||
    info.maxAttempts !== undefined ||
    info.sessionTotal !== undefined ||
    info.outcome !== undefined
  );
}

export function readAutoResumeInfo(data?: Record<string, unknown>): AutoResumeCardInfo {
  const num = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
  return {
    ...(typeof data?.error === 'string' && data.error.length > 0 ? { error: data.error } : {}),
    ...(num(data?.attempt) !== undefined ? { attempt: num(data?.attempt) } : {}),
    ...(num(data?.maxAttempts) !== undefined ? { maxAttempts: num(data?.maxAttempts) } : {}),
    ...(num(data?.sessionTotal) !== undefined ? { sessionTotal: num(data?.sessionTotal) } : {}),
    ...(data?.outcome === 'succeeded' || data?.outcome === 'failed'
      ? { outcome: data.outcome }
      : {}),
    ...(data?.reason === CODEX_RESET_CREDIT_RESUME_REASON ? { resetCredit: true as const } : {}),
  };
}

/** 进行中的续跑在状态栏与活动行上的文案 key。 */
export function autoResumePendingLabel(
  info: AutoResumeCardInfo,
): { key: string; params?: Record<string, number> } {
  if (info.resetCredit) return { key: 'chat.systemCard.autoResumePending.resetCredit' };
  return info.attempt !== undefined && info.maxAttempts !== undefined
    ? {
        key: 'chat.systemCard.autoResumePending.labelWithProgress',
        params: { attempt: info.attempt, total: info.maxAttempts },
      }
    : { key: 'chat.systemCard.autoResumePending.label' };
}

/** Synthetic continuation inputs own turns; steering messages do not replace that owner. */
export function findLastUserInputClientId(messages: readonly ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && messages[i].delivery !== 'steer') {
      return messages[i].clientId;
    }
  }
  return null;
}

/**
 * Only legacy hosts may fall back to the last user input; newer hosts publish the turn owner.
 * That legacy heuristic cannot distinguish a Goal turn without a user row from a continuation,
 * so never apply it to supported/unknown hosts.
 */
export function isAutoResumeRowInFlight(args: {
  isContinuationTurnOwner: boolean;
  sessionRunning: boolean;
  isLastUserInput: boolean;
  projectionCapability: ContinuationInFlightProjectionCapability;
}): boolean {
  return (
    args.isContinuationTurnOwner ||
    (args.projectionCapability === 'legacy' && args.sessionRunning && args.isLastUserInput)
  );
}

/** The composer follows the same live rows and outcomes as the message stream. */
export function findActiveReconnect(args: {
  messages: readonly ChatMessage[];
  sessionRunning: boolean;
  continuationTurnClientId: string | null;
  projectionCapability: ContinuationInFlightProjectionCapability;
}): AutoResumeCardInfo | null {
  const lastInput =
    args.projectionCapability === 'legacy' ? findLastUserInputClientId(args.messages) : null;
  for (let i = args.messages.length - 1; i >= 0; i--) {
    const message = args.messages[i];
    if (message.systemCardType === 'auto-resume-pending') {
      // Also covers backoff: there may not be a running vendor turn yet.
      return readAutoResumeInfo(message.systemCardData);
    }
    if (message.role !== 'user' || message.systemCardType !== 'auto-resume') continue;
    const info = readAutoResumeInfo(message.systemCardData);
    if (
      hasInterruptionContext(info) &&
      info.outcome === undefined &&
      isAutoResumeRowInFlight({
        isContinuationTurnOwner: message.clientId === args.continuationTurnClientId,
        sessionRunning: args.sessionRunning,
        isLastUserInput: message.clientId === lastInput,
        projectionCapability: args.projectionCapability,
      })
    )
      return info;
  }
  return null;
}
