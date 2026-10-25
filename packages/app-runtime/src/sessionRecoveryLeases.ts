import type { Session } from '@cindy/maker-core';
import type { AgentInputCoordinator } from './agent-input-coordinator.js';
import type { AutoResumeBookkeeping } from './autoResumeBookkeeping.js';
import { shouldPreserveWaitingContinuationOnlyAutoResume, shouldPreserveRuntimeFallbackAutoResume, type InterruptedTurnAutoResumeGuard } from './interruptedTurnAutoResume.js';

/** Exact-session leases shared by Desktop and Node during native replacement. */
export function createSessionRecoveryLeases(host: {
  coordinator(): AgentInputCoordinator | null | undefined;
  interruptedTurnAutoResumeGuard: InterruptedTurnAutoResumeGuard;
  autoResumeBookkeeping: AutoResumeBookkeeping;
  pendingContinuationOnlyAutoResumeRebuilds: WeakMap<Session, number>;
  pendingSessionRuntimeFallbackRebuilds: WeakMap<Session, number>;
}) {
const { interruptedTurnAutoResumeGuard, autoResumeBookkeeping, pendingContinuationOnlyAutoResumeRebuilds, pendingSessionRuntimeFallbackRebuilds } = host;
function bindContinuationOnlyAutoResumeLease(session: Session): void {
  const coordinator = host.coordinator();
  const token = coordinator?.getAutoResumeAttemptToken(session.id);
  if (
    typeof token !== 'number' ||
    coordinator?.isContinuationOnlyAutoResume(session.id) !== true ||
    !interruptedTurnAutoResumeGuard.isCurrentAttempt(session.id, token) ||
    !autoResumeBookkeeping.isCurrentAttempt(session.id, token)
  ) {
    return;
  }
  pendingContinuationOnlyAutoResumeRebuilds.set(session, token);
}

function shouldPreserveContinuationOnlyAutoResume(
  session: Session,
  closeReason: unknown,
): boolean {
  const coordinator = host.coordinator();
  const coordinatorAttemptToken = coordinator?.getAutoResumeAttemptToken(session.id);
  const leasedAttemptToken = pendingContinuationOnlyAutoResumeRebuilds.get(session);
  const attemptToken =
    leasedAttemptToken ??
    (typeof coordinatorAttemptToken === 'number' ? coordinatorAttemptToken : undefined);
  return shouldPreserveWaitingContinuationOnlyAutoResume({
    closeReason,
    leasedAttemptToken,
    guardIsCurrentAttempt:
      attemptToken !== undefined &&
      interruptedTurnAutoResumeGuard.isCurrentAttempt(session.id, attemptToken),
    bookIsCurrentAttempt:
      attemptToken !== undefined && autoResumeBookkeeping.isCurrentAttempt(session.id, attemptToken),
    coordinatorAttemptToken,
    hasLiveSchedule:
      attemptToken !== undefined && autoResumeBookkeeping.hasLiveSchedule(session.id, attemptToken),
    hasQueuedAutoResume: Boolean(coordinator?.hasQueuedAutoResume(session.id)),
    isContinuationOnly: coordinator?.isContinuationOnlyAutoResume(session.id) === true,
  });
}

/**
 * Runtime fallback runs inside the already-fired retry callback. A route change
 * may synchronously close the old process before autoRetryLastError can reuse
 * its recovery record, so preserve only that exact callback token across the
 * requested close/rebuild or cross-harness agent-switch handoff.
 */
function shouldPreserveSessionRuntimeFallbackAutoResume(
  session: Session,
  closeReason: unknown,
): boolean {
  const attemptToken = pendingSessionRuntimeFallbackRebuilds.get(session);
  const coordinator = host.coordinator();
  return shouldPreserveRuntimeFallbackAutoResume({
    closeReason,
    leasedAttemptToken: attemptToken,
    guardIsCurrentAttempt: attemptToken !== undefined && interruptedTurnAutoResumeGuard.isCurrentAttempt(session.id, attemptToken),
    bookIsCurrentAttempt: attemptToken !== undefined && autoResumeBookkeeping.isCurrentAttempt(session.id, attemptToken),
    coordinatorAttemptToken: coordinator?.getAutoResumeAttemptToken(session.id),
    isAutoResumePending: coordinator?.isAutoResumePending(session.id) === true,
    hasLiveSchedule: attemptToken !== undefined && autoResumeBookkeeping.hasLiveSchedule(session.id, attemptToken),
  });
}

return { bindContinuationOnlyAutoResumeLease, shouldPreserveContinuationOnlyAutoResume, shouldPreserveSessionRuntimeFallbackAutoResume, release(session: Session) { pendingContinuationOnlyAutoResumeRebuilds.delete(session); pendingSessionRuntimeFallbackRebuilds.delete(session); } };
}
