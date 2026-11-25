import type { AgentEvent, NativeSubscriptionAccount } from '@cindy/maker-core';
import type { OpenAiGroupProbeResult } from '../../shared/openAiAccountGroup.js';

// Only the executing host registers these capabilities. Callers resolve a
// business session through the existing authenticated proxy route first.
const sessions = new Map<string, NativeSubscriptionAccount>();

export function registerSessionSubscriptionAccount(
  sessionId: string | undefined,
  account: NativeSubscriptionAccount,
): () => void {
  if (!sessionId) return () => {};
  account.assertCurrent();
  sessions.set(sessionId, account);
  return () => {
    if (sessions.get(sessionId) === account) sessions.delete(sessionId);
  };
}

export function getSessionSubscriptionAccount(
  sessionId: string | null | undefined,
): NativeSubscriptionAccount | undefined {
  const account = sessionId ? sessions.get(sessionId) : undefined;
  account?.assertCurrent();
  return account;
}

interface PoolExecutionRoute {
  providerId: string;
  connectionId: string;
  assertCurrent(model?: string): void;
  captureTurnRejection(): ((result: OpenAiGroupProbeResult) => void) | undefined;
}
const executions = new Map<string, PoolExecutionRoute>();

/** Local capability minted by the owner after a pool reservation. Never comes from IPC. */
export function bindPoolExecutionRoute(sessionId: string | undefined, route: PoolExecutionRoute): () => void {
  if (!sessionId) return () => {};
  route.assertCurrent();
  executions.set(sessionId, route);
  return () => { if (executions.get(sessionId) === route) executions.delete(sessionId); };
}

export function readPoolExecutionRoute(sessionId: string | null | undefined) {
  return sessionId ? executions.get(sessionId) : undefined;
}

// The execution host can use this before creating a guest recovery offer.
// It is deliberately kept out of events serialized to other clients.
export const poolFailuresAfterOutput = new WeakSet<AgentEvent>();
