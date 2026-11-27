import type { AgentEvent, NativeSubscriptionAccount } from '@cindy/maker-core';
import type { OpenAiGroupProbeResult } from '../../shared/openAiAccountGroup.js';
import { getSessionProvider, hasSessionProvider } from '../maker-host/session-provider-store.js';

// Only the executing host registers these capabilities. Callers resolve a
// business session through the existing authenticated proxy route first.
interface SessionSubscriptionAccountBinding {
  account: NativeSubscriptionAccount;
  /** Pool placement uses the lease's account ID, not Codex's host-scoped account ID. */
  poolAccountId: string;
  mixedOpenAiPool: boolean;
}
const sessions = new Map<string, SessionSubscriptionAccountBinding>();

export function registerSessionSubscriptionAccount(
  sessionId: string | undefined,
  account: NativeSubscriptionAccount,
  poolAccountId = account.id,
  mixedOpenAiPool = false,
): () => void {
  if (!sessionId) return () => {};
  account.assertCurrent();
  const binding = { account, poolAccountId, mixedOpenAiPool };
  sessions.set(sessionId, binding);
  return () => {
    if (sessions.get(sessionId) === binding) sessions.delete(sessionId);
  };
}

export function readSessionSubscriptionAccountBinding(
  sessionId: string | null | undefined,
): SessionSubscriptionAccountBinding | undefined {
  const binding = sessionId ? sessions.get(sessionId) : undefined;
  binding?.account.assertCurrent();
  return binding;
}

export function getSessionSubscriptionAccount(
  sessionId: string | null | undefined,
): NativeSubscriptionAccount | undefined {
  return readSessionSubscriptionAccountBinding(sessionId)?.account;
}

interface PoolSessionExecution {
  providerId: string;
  connectionId: string;
  assertCurrent(model?: string): void;
}

interface PoolExecutionRoute extends PoolSessionExecution {
  /** The live reservation owns the Pi alias; never infer it from request text. */
  logicalModel?(wireModel: string): string;
  captureTurnRejection(): ((result: OpenAiGroupProbeResult) => void) | undefined;
}

interface NativePoolSessionExecution extends PoolSessionExecution {
  account: NativeSubscriptionAccount;
}

const executions = new Map<string, PoolExecutionRoute | NativePoolSessionExecution>();

/** Local capability minted by the owner after a pool reservation. Never comes from IPC. */
function bindPoolSessionExecution(
  sessionId: string | undefined,
  route: PoolExecutionRoute | NativePoolSessionExecution,
): () => void {
  if (!sessionId) return () => {};
  executions.set(sessionId, route);
  return () => { if (executions.get(sessionId) === route) executions.delete(sessionId); };
}

export function bindPoolExecutionRoute(sessionId: string | undefined, route: PoolExecutionRoute): () => void {
  if (sessionId) route.assertCurrent();
  return bindPoolSessionExecution(sessionId, route);
}

export function bindNativePoolSessionExecution(sessionId: string | undefined, route: NativePoolSessionExecution): () => void {
  return bindPoolSessionExecution(sessionId, route);
}

/** Engine identity for control-plane decisions, not a proxy authorization. */
export function readPoolSessionExecution(sessionId: string | null | undefined) {
  return sessionId ? executions.get(sessionId) : undefined;
}

export function isPoolSessionExecutionCurrent(
  sessionId: string | undefined, route: PoolSessionExecution,
  providerId: string | null | undefined, model?: string,
): boolean {
  if (!sessionId || readPoolSessionExecution(sessionId) !== route || route.providerId !== providerId ||
    (hasSessionProvider(sessionId) && getSessionProvider(sessionId) !== providerId)) return false;
  try { route.assertCurrent(model); } catch { return false; }
  return true;
}

/** Only API reservations may redirect proxy traffic; native accounts use their own capability. */
export function readPoolExecutionRoute(sessionId: string | null | undefined) {
  const route = readPoolSessionExecution(sessionId);
  return route && 'captureTurnRejection' in route ? route : undefined;
}

/** A live local mixed-pool lease, whether it chose a Key or a subscription.
 * This is only a synchronous recovery hint; the allocator checks the current
 * binding, model, membership and switching policy again before handoff. */
export function isLocalAccountPoolTurn(sessionId: string): boolean {
  return readPoolExecutionRoute(sessionId) !== undefined || sessions.get(sessionId)?.mixedOpenAiPool === true;
}

// The execution host can use this before creating a guest recovery offer.
// It is deliberately kept out of events serialized to other clients.
export const poolFailuresAfterOutput = new WeakSet<AgentEvent>();
