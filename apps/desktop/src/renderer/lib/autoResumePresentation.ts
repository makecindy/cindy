import {
  codexQuotaResumeKind,
  type CodexQuotaResumeKind,
} from '@cindy/maker-shared/synthetic-trigger';
import type { ChatMessage, ContinuationInFlightProjectionCapability } from './makerChatStore';

export interface AutoResumeCardInfo {
  error?: string;
  attempt?: number;
  maxAttempts?: number;
  sessionTotal?: number;
  outcome?: 'succeeded' | 'failed';
  /** Codex 配额耗尽后的处理（检查配额 / 用了重置 / 配额已恢复），不是连接中断后的重连。 */
  quotaKind?: CodexQuotaResumeKind;
}

/** Silent-stop continuations have no interruption context and are not reconnects. */
export function hasInterruptionContext(info: AutoResumeCardInfo): boolean {
  return (
    info.quotaKind !== undefined ||
    info.error !== undefined ||
    info.attempt !== undefined ||
    info.maxAttempts !== undefined ||
    info.sessionTotal !== undefined ||
    info.outcome !== undefined
  );
}

export function readAutoResumeInfo(data?: Record<string, unknown>): AutoResumeCardInfo {
  const quotaKind = codexQuotaResumeKind(data?.reason);
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
    ...(quotaKind ? { quotaKind } : {}),
  };
}

/** 落库续跑记录在结果定格后的文案 key（检查配额只会出现在进行中，按重连处理）。 */
export function recordedAutoResumeLabelKey(
  quotaKind: CodexQuotaResumeKind | undefined,
  outcome: AutoResumeCardInfo['outcome'],
): string {
  const keys =
    quotaKind === 'reset'
      ? ['resetCreditLabel', 'resetCreditLabelFailed', 'resetCreditLabelNeutral']
      : quotaKind === 'restored'
        ? ['quotaRestoredLabel', 'quotaRestoredLabelFailed', 'quotaRestoredLabelNeutral']
        : ['label', 'labelFailed', 'labelNeutral'];
  const key = outcome === 'succeeded' ? keys[0] : outcome === 'failed' ? keys[1] : keys[2];
  return `chat.systemCard.autoResume.${key}`;
}

/** 进行中的续跑在状态栏与活动行上的文案 key。 */
export function autoResumePendingLabel(
  info: AutoResumeCardInfo,
): { key: string; params?: Record<string, number> } {
  if (info.quotaKind === 'checking') {
    return { key: 'chat.systemCard.autoResumePending.resetCreditChecking' };
  }
  if (info.quotaKind === 'reset') return { key: 'chat.systemCard.autoResumePending.resetCredit' };
  if (info.quotaKind === 'restored') {
    return { key: 'chat.systemCard.autoResumePending.quotaRestored' };
  }
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
