import type { AgentEvent } from '@cindy/maker-core';

export type SchedulerInterruptedTurnRecoveryDisposition = 'started' | 'duplicate';
export interface SchedulerInterruptedTurnRecoveryClaim {
  runId: string;
  disposition: SchedulerInterruptedTurnRecoveryDisposition;
}

type RecoveryHandler = (
  event: AgentEvent,
) => SchedulerInterruptedTurnRecoveryDisposition | null;
export type SchedulerInterruptedTurnRecoveryResetReason =
  | 'session-reset'
  | 'session-closed'
  | 'user-intervention';

interface RecoveryRegistration {
  handler: RecoveryHandler;
  onReset: (reason: SchedulerInterruptedTurnRecoveryResetReason) => void;
  isDispatchReserved: () => boolean;
  claimEnabled: boolean;
}

interface RecoverySession {
  registrations: Map<string, RecoveryRegistration>;
  /**
   * The Schedule run whose vendor turn currently owns origin-less AgentEvents.
   *
   * Registrations describe waiters that may recover in the future; they are not proof that
   * those waiters own the turn currently running in the shared Session. Keeping this lease
   * separately prevents two concurrent waiters from making every legacy event ambiguous.
   */
  eventOwnerRunId: string | null;
}

interface RecoveryLifecycle {
  registerOutcome(sessionId: string, runId: string, clientId: string): void;
  releaseOutcome(sessionId: string, runId: string, clientId: string): void;
  settleOutcome(sessionId: string, runId: string, outcome: 'succeeded' | 'failed'): void;
  discardSuppressedError(sessionId: string, runId: string): void;
  finalizeSuppressedError(sessionId: string, runId: string): void;
}

const recoverySessions = new Map<string, RecoverySession>();
let lifecycle: RecoveryLifecycle | null = null;

/**
 * register.ts owns persistence/UI bookkeeping and installs it once at module startup. Keeping
 * that dependency behind this bridge lets the scheduler runner stay usable in tests and hosts
 * that replace register.ts with a narrow IPC mock.
 */
export function configureSchedulerInterruptedTurnRecoveryLifecycle(next: RecoveryLifecycle): void {
  lifecycle = next;
}

/** Register one Schedule run as the owner of its own interrupted-turn recovery events. */
export function registerSchedulerInterruptedTurnRecovery(
  sessionId: string,
  runId: string,
  handler: RecoveryHandler,
  onReset: (reason: SchedulerInterruptedTurnRecoveryResetReason) => void,
  isDispatchReserved: () => boolean,
): () => void {
  let recoverySession = recoverySessions.get(sessionId);
  if (!recoverySession) {
    recoverySession = { registrations: new Map(), eventOwnerRunId: null };
    recoverySessions.set(sessionId, recoverySession);
  }
  const registration = { handler, onReset, isDispatchReserved, claimEnabled: true };
  recoverySession.registrations.set(runId, registration);
  return () => {
    const current = recoverySessions.get(sessionId);
    if (current?.registrations.get(runId) !== registration) return;
    current.registrations.delete(runId);
    if (current.eventOwnerRunId === runId) current.eventOwnerRunId = null;
    if (current.registrations.size === 0) recoverySessions.delete(sessionId);
  };
}

/** Mark the accepted/dispatching Schedule turn as the sole owner of origin-less events. */
export function markSchedulerInterruptedTurnEventOwner(
  sessionId: string,
  runId: string,
): boolean {
  const recoverySession = recoverySessions.get(sessionId);
  if (!recoverySession?.registrations.has(runId)) return false;
  recoverySession.eventOwnerRunId = runId;
  return true;
}

/** Backoff/dispatching recovery owns the session even before maker reports a running turn. */
export function isSchedulerInterruptedTurnRecoverySessionReserved(sessionId: string): boolean {
  const recoverySession = recoverySessions.get(sessionId);
  if (!recoverySession) return false;
  return [...recoverySession.registrations.values()].some(
    (registration) => registration.claimEnabled && registration.isDispatchReserved(),
  );
}

/**
 * Route ordinary turn events through the same owner boundary as terminal recovery claims.
 * Explicit run ids are authoritative; legacy events follow the accepted vendor-turn lease.
 */
export function isSchedulerInterruptedTurnEventOwnedBy(
  sessionId: string,
  runId: string,
  eventRunId: string | undefined,
): boolean {
  if (eventRunId) return eventRunId === runId;
  return recoverySessions.get(sessionId)?.eventOwnerRunId === runId;
}

/** Called synchronously by register.ts before it broadcasts or persists a terminal error. */
export function claimSchedulerInterruptedTurnRecovery(
  sessionId: string,
  event: AgentEvent,
): SchedulerInterruptedTurnRecoveryClaim | null {
  const recoverySession = recoverySessions.get(sessionId);
  if (!recoverySession) return null;
  const claim = (
    runId: string,
    registration: RecoveryRegistration | undefined,
  ): SchedulerInterruptedTurnRecoveryClaim | null => {
    if (!registration?.claimEnabled) return null;
    const disposition = registration.handler(event);
    return disposition ? { runId, disposition } : null;
  };
  const eventRunId = event.turnOrigin?.runId;
  if (typeof eventRunId === 'string' && eventRunId) {
    return claim(eventRunId, recoverySession.registrations.get(eventRunId));
  }
  const ownerRunId = recoverySession.eventOwnerRunId;
  return ownerRunId
    ? claim(ownerRunId, recoverySession.registrations.get(ownerRunId))
    : null;
}

/** Stop every pending recovery lifecycle owned by this session before reset/close continues. */
export function resetSchedulerInterruptedTurnRecovery(
  sessionId: string,
  reason: SchedulerInterruptedTurnRecoveryResetReason,
): void {
  const recoverySession = recoverySessions.get(sessionId);
  if (!recoverySession) return;
  recoverySessions.delete(sessionId);
  for (const registration of [...recoverySession.registrations.values()]) {
    registration.onReset(reason);
  }
}

/**
 * Tell every waiter that a real user message entered the session queue.
 *
 * Intervention revokes future recovery ownership immediately so a later error cannot enqueue a
 * hidden continuation ahead of the user's message. The waiter callback decides whether an
 * already-pending continuation must also settle the Schedule run.
 */
export function supersedeSchedulerInterruptedTurnRecovery(sessionId: string): void {
  const recoverySession = recoverySessions.get(sessionId);
  if (!recoverySession) return;
  for (const registration of [...recoverySession.registrations.values()]) {
    registration.claimEnabled = false;
    registration.onReset('user-intervention');
  }
}

export function registerSchedulerInterruptedTurnResumeOutcome(
  sessionId: string,
  runId: string,
  clientId: string,
): void {
  lifecycle?.registerOutcome(sessionId, runId, clientId);
}

export function releaseSchedulerInterruptedTurnResumeOutcome(
  sessionId: string,
  runId: string,
  clientId: string,
): void {
  lifecycle?.releaseOutcome(sessionId, runId, clientId);
}

export function settleSchedulerInterruptedTurnResumeOutcome(
  sessionId: string,
  runId: string,
  outcome: 'succeeded' | 'failed',
): void {
  lifecycle?.settleOutcome(sessionId, runId, outcome);
}

export function discardSchedulerInterruptedTurnSuppressedError(
  sessionId: string,
  runId: string,
): void {
  lifecycle?.discardSuppressedError(sessionId, runId);
}

export function finalizeSchedulerInterruptedTurnSuppressedError(
  sessionId: string,
  runId: string,
): void {
  lifecycle?.finalizeSuppressedError(sessionId, runId);
}
