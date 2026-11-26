import type { InteractionDecision, InteractionRequest } from '@cindy/maker-core';
import type { SharedPermission } from './sharedPermission.js';

const PERMISSION_INTERACTION_TIMEOUT_MS = 10 * 60 * 1000;

export interface PendingInteractionTimeoutEntry {
  sharedPermission?: SharedPermission;
  sessionId: string;
  kind: InteractionRequest['kind'];
  request: InteractionRequest;
  resolve: (decision: InteractionDecision) => void;
  timeoutId?: ReturnType<typeof setTimeout>;
  timeoutDeadlineAt?: number;
  timeoutRemainingMs?: number;
  questionTimerSnoozed?: boolean;
  /** IM owns presentation/timeouts; Host retains the execution and cancellation boundary. */
  migrated?: boolean;
}

/** Permission safety time counts only while its owning task can accept input. */
export function schedulePendingInteractionTimeout<Entry extends PendingInteractionTimeoutEntry>(
  requestId: string,
  entry: Entry,
  deps: {
    getPending(id: string): Entry | undefined;
    isExecutionPaused(sessionId: string): boolean;
    clearPending(id: string): Entry | null;
    dismiss(entry: Entry, id: string): void;
    publishTimeout(entry: Entry, id: string): void;
    onInteractionTimedOut(sessionId: string): void;
  },
): void {
  const optionalQuestion = entry.request.kind === 'ask_user_question'
    && entry.request.isBlocking === false
    && !entry.questionTimerSnoozed;
  if (entry.migrated || entry.sharedPermission || (entry.kind !== 'permission' && !optionalQuestion)
    || entry.timeoutId !== undefined || deps.getPending(requestId) !== entry
    || deps.isExecutionPaused(entry.sessionId)) return;

  const remaining = entry.timeoutRemainingMs ?? (entry.kind === 'ask_user_question' ? 120_000 : PERMISSION_INTERACTION_TIMEOUT_MS);
  entry.timeoutDeadlineAt = Date.now() + remaining;
  entry.timeoutId = setTimeout(() => {
    if (deps.getPending(requestId) !== entry) return;
    entry.timeoutId = undefined;
    entry.timeoutRemainingMs = 0;
    entry.timeoutDeadlineAt = undefined;
    // Also guard an already-due callback at the pause boundary.
    if (deps.isExecutionPaused(entry.sessionId)) return;
    const pending = deps.clearPending(requestId);
    if (!pending) return;
    deps.dismiss(pending, requestId);
    pending.resolve(entry.kind === 'ask_user_question'
      ? { kind: 'ask_user_question', answers: {}, dismissed: true }
      : { kind: 'permission', behavior: 'deny', reason: 'timeout' });
    deps.publishTimeout(pending, requestId);
    deps.onInteractionTimedOut(pending.sessionId);
  }, remaining);
}
