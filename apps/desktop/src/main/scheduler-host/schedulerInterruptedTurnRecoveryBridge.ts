import type { AgentEvent } from '@cindy/maker-core';

type RecoveryHandler = (event: AgentEvent) => boolean;
export type SchedulerInterruptedTurnRecoveryResetReason =
  | 'session-reset'
  | 'session-closed';

interface RecoveryRegistration {
  handler: RecoveryHandler;
  onReset: (reason: SchedulerInterruptedTurnRecoveryResetReason) => void;
}

interface RecoveryLifecycle {
  registerOutcome(sessionId: string, clientId: string): void;
  releaseOutcome(sessionId: string, clientId: string): void;
  discardSuppressedError(sessionId: string): void;
  finalizeSuppressedError(sessionId: string): void;
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
): boolean {
  const registrations = recoveryHandlers.get(sessionId);
  if (!registrations) return false;
  const eventRunId = event.turnOrigin?.runId;
  if (typeof eventRunId === 'string' && eventRunId) {
    return registrations.get(eventRunId)?.handler(event) === true;
  }
  // Older providers can omit turnOrigin. Only fall back when ownership is unambiguous;
  // otherwise a concurrent Schedule run could claim and persist another run's failure.
  if (registrations.size !== 1) return false;
  return registrations.values().next().value?.handler(event) === true;
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

export function registerSchedulerInterruptedTurnResumeOutcome(
  sessionId: string,
  clientId: string,
): void {
  lifecycle?.registerOutcome(sessionId, clientId);
}

export function releaseSchedulerInterruptedTurnResumeOutcome(
  sessionId: string,
  clientId: string,
): void {
  lifecycle?.releaseOutcome(sessionId, clientId);
}

export function discardSchedulerInterruptedTurnSuppressedError(sessionId: string): void {
  lifecycle?.discardSuppressedError(sessionId);
}

export function finalizeSchedulerInterruptedTurnSuppressedError(sessionId: string): void {
  lifecycle?.finalizeSuppressedError(sessionId);
}
