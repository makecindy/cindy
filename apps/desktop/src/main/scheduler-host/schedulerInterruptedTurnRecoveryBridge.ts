import type { AgentEvent } from '@cindy/maker-core';

type RecoveryHandler = (event: AgentEvent) => boolean;

interface RecoveryLifecycle {
  registerOutcome(sessionId: string, clientId: string): void;
  releaseOutcome(sessionId: string, clientId: string): void;
  discardSuppressedError(sessionId: string): void;
  finalizeSuppressedError(sessionId: string): void;
}

const recoveryHandlers = new Map<string, RecoveryHandler>();
let lifecycle: RecoveryLifecycle | null = null;

/**
 * register.ts owns persistence/UI bookkeeping and installs it once at module startup. Keeping
 * that dependency behind this bridge lets the scheduler runner stay usable in tests and hosts
 * that replace register.ts with a narrow IPC mock.
 */
export function configureSchedulerInterruptedTurnRecoveryLifecycle(next: RecoveryLifecycle): void {
  lifecycle = next;
}

/** One active Schedule run may own interrupted-turn recovery for a session at a time. */
export function registerSchedulerInterruptedTurnRecovery(
  sessionId: string,
  handler: RecoveryHandler,
): () => void {
  recoveryHandlers.set(sessionId, handler);
  return () => {
    if (recoveryHandlers.get(sessionId) === handler) recoveryHandlers.delete(sessionId);
  };
}

/** Called synchronously by register.ts before it broadcasts or persists a terminal error. */
export function claimSchedulerInterruptedTurnRecovery(
  sessionId: string,
  event: AgentEvent,
): boolean {
  return recoveryHandlers.get(sessionId)?.(event) === true;
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
