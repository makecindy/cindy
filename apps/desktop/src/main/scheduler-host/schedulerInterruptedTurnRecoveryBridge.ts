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
}

interface RecoveryLifecycle {
  registerOutcome(sessionId: string, runId: string, clientId: string): void;
  releaseOutcome(sessionId: string, runId: string, clientId: string): void;
  settleOutcome(sessionId: string, runId: string, outcome: 'succeeded' | 'failed'): void;
  discardSuppressedError(sessionId: string, runId: string): void;
  finalizeSuppressedError(sessionId: string, runId: string): void;
}

const recoveryHandlers = new Map<string, Map<string, RecoveryRegistration>>();
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
): () => void {
  let registrations = recoveryHandlers.get(sessionId);
  if (!registrations) {
    registrations = new Map();
    recoveryHandlers.set(sessionId, registrations);
  }
  const registration = { handler, onReset };
  registrations.set(runId, registration);
  return () => {
    const current = recoveryHandlers.get(sessionId);
    if (current?.get(runId) !== registration) return;
    current.delete(runId);
    if (current.size === 0) recoveryHandlers.delete(sessionId);
  };
}

/** Called synchronously by register.ts before it broadcasts or persists a terminal error. */
export function claimSchedulerInterruptedTurnRecovery(
  sessionId: string,
  event: AgentEvent,
): SchedulerInterruptedTurnRecoveryClaim | null {
  const registrations = recoveryHandlers.get(sessionId);
  if (!registrations) return null;
  const claim = (
    runId: string,
    registration: RecoveryRegistration | undefined,
  ): SchedulerInterruptedTurnRecoveryClaim | null => {
    const disposition = registration?.handler(event) ?? null;
    return disposition ? { runId, disposition } : null;
  };
  const eventRunId = event.turnOrigin?.runId;
  if (typeof eventRunId === 'string' && eventRunId) {
    return claim(eventRunId, registrations.get(eventRunId));
  }
  // Older providers can omit turnOrigin. Only fall back when ownership is unambiguous;
  // otherwise a concurrent Schedule run could claim and persist another run's failure.
  if (registrations.size !== 1) return null;
  const [runId, registration] = registrations.entries().next().value ?? [];
  return typeof runId === 'string' ? claim(runId, registration) : null;
}

/** Stop every pending recovery lifecycle owned by this session before reset/close continues. */
export function resetSchedulerInterruptedTurnRecovery(
  sessionId: string,
  reason: SchedulerInterruptedTurnRecoveryResetReason,
): void {
  const registrations = recoveryHandlers.get(sessionId);
  if (!registrations) return;
  recoveryHandlers.delete(sessionId);
  for (const registration of [...registrations.values()]) registration.onReset(reason);
}

/**
 * Tell every waiter that a real user message entered the session queue.
 *
 * Intervention revokes future recovery ownership immediately so a later error cannot enqueue a
 * hidden continuation ahead of the user's message. The waiter callback decides whether an
 * already-pending continuation must also settle the Schedule run.
 */
export function supersedeSchedulerInterruptedTurnRecovery(sessionId: string): void {
  const registrations = recoveryHandlers.get(sessionId);
  if (!registrations) return;
  recoveryHandlers.delete(sessionId);
  for (const registration of [...registrations.values()]) {
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
