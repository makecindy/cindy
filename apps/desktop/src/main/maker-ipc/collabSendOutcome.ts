import type { SessionSendResult } from '@cindy/maker-core';

import {
  createHostSendFailure,
  sanitizeSendOutcomeError,
  toDesktopSessionDispatchOutcome,
  type DesktopSessionDispatchOutcome,
  type HostSendOutcome,
  type SendOutcomeLogContext,
} from '../maker-host/send-outcome.js';

export type CollabHostSendOutcome = HostSendOutcome & {
  source: string;
  context: string;
  /** Provider acceptance may have happened; callers must not rewind or replay automatically. */
  dispatchUnconfirmed?: true;
};

export type CollabDispatchSuccessOutcome = Extract<DesktopSessionDispatchOutcome, { dispatched: true }>;
export type CollabDispatchFailureOutcome =
  | CollabHostSendOutcome
  | Extract<DesktopSessionDispatchOutcome, { dispatched: false }>;
export type CollabDispatchOutcome = CollabDispatchSuccessOutcome | CollabDispatchFailureOutcome;

export type CollabDispatchQueuedOutcome = CollabDispatchSuccessOutcome & { wakeKind: 'queued' };
export type CollabDirectDispatchResult =
  | { dispatched: true; queued?: false; dispatchOutcome: CollabDispatchSuccessOutcome }
  | { dispatched: false; queued?: false; dispatchOutcome: CollabDispatchFailureOutcome };
export type CollabDispatchResult =
  | CollabDirectDispatchResult
  | { dispatched: false; queued: true; dispatchOutcome: CollabDispatchQueuedOutcome };

export interface CollabDispatchMeta {
  source: string;
  context: string;
}

type CollabDispatchLogger = Pick<Console, 'warn'>;

export interface CollabDispatchLogContext extends SendOutcomeLogContext {
  source?: string;
  workerId?: string;
  teamId?: string;
  leadSessionId?: string;
}

function isSessionRunningSendError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (code === 'SESSION_RUNNING') return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && message.startsWith('SESSION_RUNNING:');
}

export function isTurnDispatchUnconfirmedSendError(err: unknown): boolean {
  return Boolean(
    err
    && typeof err === 'object'
    && (err as { code?: unknown }).code === 'TURN_DISPATCH_UNCONFIRMED',
  );
}

function hostOutcomeForSendError(err: unknown, meta: CollabDispatchMeta): CollabHostSendOutcome {
  const dispatchUnconfirmed = isTurnDispatchUnconfirmedSendError(err);
  const code = isSessionRunningSendError(err) ? 'SESSION_RUNNING' : 'SEND_FAILED';
  return {
    ...createHostSendFailure(
      code,
      dispatchUnconfirmed
        ? `Collab delegate provider acceptance is unconfirmed: ${meta.context}`
        : `Collab delegate send failed before vendor dispatch: ${meta.context}`,
    ),
    source: meta.source,
    context: meta.context,
    ...(dispatchUnconfirmed ? { dispatchUnconfirmed: true as const } : {}),
  };
}

export async function resolveCollabDispatchResult(
  send: () => Promise<SessionSendResult>,
  meta: CollabDispatchMeta,
): Promise<CollabDirectDispatchResult> {
  try {
    const sendResult = await send();
    const dispatchOutcome = toDesktopSessionDispatchOutcome(sendResult, meta);
    if (dispatchOutcome.dispatched) {
      return { dispatched: true, dispatchOutcome };
    }
    return { dispatched: false, dispatchOutcome };
  } catch (err) {
    return {
      dispatched: false,
      dispatchOutcome: hostOutcomeForSendError(err, meta),
    };
  }
}

export function logCollabDispatchFailure(
  logger: CollabDispatchLogger,
  message: string,
  meta: CollabDispatchLogContext,
  outcome: CollabDispatchFailureOutcome,
  err?: unknown,
): void {
  // 派活失败日志只保留可关联的结构化元数据，避免把任务正文或异常里的敏感内容写进日志。
  const source = outcome.source;
  const context = outcome.context;
  logger.warn(message, {
    kind: outcome.kind,
    source,
    owner: meta.owner,
    entrypoint: meta.entrypoint,
    sessionId: meta.sessionId,
    agentKind: meta.agentKind,
    action: meta.action,
    ...(meta.workerId ? { workerId: meta.workerId } : {}),
    ...(meta.teamId ? { teamId: meta.teamId } : {}),
    ...(meta.leadSessionId ? { leadSessionId: meta.leadSessionId } : {}),
    ...(outcome.kind === 'host-send'
      ? { code: outcome.code }
      : { reason: outcome.reason }),
    context,
    ...(err !== undefined ? { error: sanitizeSendOutcomeError(err) } : {}),
  });
}
