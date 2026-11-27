import type { AgentEvent, NativeSubscriptionAccount } from '@cindy/maker-core';
import type { OpenAiGroupProbeResult } from '../../shared/openAiAccountGroup.js';

// Only the executing host registers these capabilities. Callers resolve a
// business session through the existing authenticated proxy route first.
const sessions = new Map<string, { account: NativeSubscriptionAccount; mixedOpenAiPool: boolean }>();

export function registerSessionSubscriptionAccount(
  sessionId: string | undefined,
  account: NativeSubscriptionAccount,
  mixedOpenAiPool = false,
): () => void {
  if (!sessionId) return () => {};
  account.assertCurrent();
  const entry = { account, mixedOpenAiPool };
  sessions.set(sessionId, entry);
  return () => {
    if (sessions.get(sessionId) === entry) sessions.delete(sessionId);
  };
}

export function getSessionSubscriptionAccount(
  sessionId: string | null | undefined,
): NativeSubscriptionAccount | undefined {
  const account = sessionId ? sessions.get(sessionId)?.account : undefined;
  account?.assertCurrent();
  return account;
}

interface PoolExecutionRoute {
  providerId: string;
  connectionId: string;
  assertCurrent(model?: string): void;
  /** The live reservation owns the Pi alias; never infer it from request text. */
  logicalModel?(wireModel: string): string;
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

/** A live local mixed-pool lease, whether it chose a Key or a subscription.
 * This is only a synchronous recovery hint; the allocator checks the current
 * binding, model, membership and switching policy again before handoff. */
export function isLocalAccountPoolTurn(sessionId: string): boolean {
  return executions.has(sessionId) || sessions.get(sessionId)?.mixedOpenAiPool === true;
}

// The execution host can use this before creating a guest recovery offer.
// It is deliberately kept out of events serialized to other clients.
export const poolFailuresAfterOutput = new WeakSet<AgentEvent>();
