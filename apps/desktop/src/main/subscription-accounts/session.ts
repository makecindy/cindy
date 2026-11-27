import type { AgentEvent, NativeSubscriptionAccount } from '@cindy/maker-core';
import type { OpenAiGroupProbeResult } from '../../shared/openAiAccountGroup.js';
import type { SubscriptionProvider } from '../../shared/subscriptionAccounts.js';

interface SessionSubscriptionAccountEntry {
  account: NativeSubscriptionAccount;
  accountId?: string;
}

// Only the executing host registers these capabilities. Callers resolve a
// business session through the existing authenticated proxy route first.
const sessions = new Map<string, SessionSubscriptionAccountEntry>();

export function registerSessionSubscriptionAccount(
  sessionId: string | undefined,
  account: NativeSubscriptionAccount,
  accountId?: string,
): () => void {
  if (!sessionId) return () => {};
  account.assertCurrent();
  const entry: SessionSubscriptionAccountEntry = { account, accountId };
  sessions.set(sessionId, entry);
  return () => {
    if (sessions.get(sessionId) === entry) sessions.delete(sessionId);
  };
}

export function getSessionSubscriptionAccount(
  sessionId: string | null | undefined,
): NativeSubscriptionAccount | undefined {
  const entry = sessionId ? sessions.get(sessionId) : undefined;
  entry?.account.assertCurrent();
  return entry?.account;
}

export function getSessionSubscriptionAccountId(
  sessionId: string | null | undefined,
  kind: SubscriptionProvider,
): string | undefined {
  const entry = sessionId ? sessions.get(sessionId) : undefined;
  if (!entry) return undefined;
  entry.account.assertCurrent();
  if (entry.accountId) return entry.accountId;
  const marker = `:${kind}:`;
  const index = entry.account.id.indexOf(marker);
  return index >= 0 ? entry.account.id.slice(index + marker.length) : entry.account.id;
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

// The execution host can use this before creating a guest recovery offer.
// It is deliberately kept out of events serialized to other clients.
export const poolFailuresAfterOutput = new WeakSet<AgentEvent>();
