/**
 * Accounts inside one provider fail over like provider group members (2026-11-11 user decision;
 * provider-groups.md §5 发送前核对额度 and §6.1 自动换电脑, subscription-account-pools.md).
 *
 * A task stays on its bound account while that account works. Before the next send (a user
 * message, a retry or an automatic continuation), a bound account that remembers a real failure
 * (usage limit, sign-in, overload), whose trusted quota for the task model is exhausted, or that
 * is signed out moves the task to another usable account chosen by the pool policy. The running
 * turn is never interrupted, and with nowhere to go the message is sent to the original account.
 *
 * Paused or removed accounts are handled by their own pre-send handoff, not here.
 */
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import type { SubscriptionProvider } from '../../shared/subscriptionAccounts.js';
import { readAccountBinding, readLegacyCodexProviderId, readPool } from './store.js';
import { acquireSubscriptionAccount, readSubscriptionAccountBlocked } from './runtime.js';

export interface AccountFailoverSession {
  status: string;
  providerId: string | null;
  agentKind?: string | null;
  model?: string | null;
  sdkSessionId?: string | null;
  remoteHostId?: string | null;
  agentDeviceId?: string | null;
}

export interface AccountFailoverDeps {
  readSession(id: string): Promise<AccountFailoverSession | null>;
  /** A running turn, including background work after the main turn, is never moved. */
  isRunning(id: string): boolean;
  /**
   * Retires this task's idle runtime and durably saves a context handoff for a fresh native
   * session on the same route. Must call `assertCurrent` before committing.
   */
  rebuild(id: string, assertCurrent: () => void): Promise<void>;
  log?(message: string, fields: Record<string, unknown>): void;
}

interface BoundAccount {
  provider: SubscriptionProvider;
  accountId: string;
  model: string | undefined;
}

/** Local pool task and its current binding; SSH, other computers and legacy routes are excluded. */
function boundAccount(sessionId: string, row: AccountFailoverSession): BoundAccount | null {
  if (row.status === 'deleted' || row.remoteHostId || row.agentDeviceId) return null;
  const provider = row.providerId === 'openai' && ['codex', 'cc', 'claude-code', 'pi'].includes(row.agentKind ?? '')
    ? 'openai'
    : row.providerId === 'anthropic' && (row.agentKind === 'cc' || row.agentKind === 'claude-code')
      ? 'anthropic'
      : null;
  if (!provider) return null;
  const pool = readPool(provider);
  if (!pool || pool.disconnected || pool.accounts.length < 2) return null;
  const binding = readAccountBinding(`task:${sessionId}`, provider)
    ?? (row.sdkSessionId ? readAccountBinding(`native:${row.sdkSessionId}`, provider) : undefined);
  if (!binding) return null;
  // A merged legacy connection keeps its own grants and share route; it never moves accounts.
  if (provider === 'openai' && readLegacyCodexProviderId(binding.accountId)) return null;
  return { provider, accountId: binding.accountId, model: row.model ?? undefined };
}

function hasMultiAccountPool(): boolean {
  return (['anthropic', 'openai'] as const).some((provider) => {
    const pool = readPool(provider);
    return !!pool && !pool.disconnected && pool.accounts.length > 1;
  });
}

/** Whether another account can take this task right now (used to continue a failed turn at once). */
export async function canSwitchSubscriptionAccount(
  sessionId: string,
  readSession: AccountFailoverDeps['readSession'],
): Promise<boolean> {
  if (!hasMultiAccountPool()) return false;
  const row = await readSession(sessionId);
  const bound = row && boundAccount(sessionId, row);
  if (!bound || !readSubscriptionAccountBlocked(bound.provider, bound.accountId, bound.model)) return false;
  try {
    await acquireSubscriptionAccount(bound.provider, bound.model, [], false, {
      exclude: new Set([bound.accountId]), dryRun: true,
    });
    return true;
  } catch {
    return false;
  }
}

/** Called under the ordinary send lock before lazy bootstrap or reuse of a live runtime. */
export async function prepareSubscriptionAccountFailover(
  sessionId: string,
  deps: AccountFailoverDeps,
): Promise<boolean> {
  const owner = activeOwnerScopeKey();
  const assertOwner = () => {
    if (owner !== activeOwnerScopeKey() || isAppSessionBoundaryPending())
      throw new Error('Subscription account owner changed');
  };
  // Most sends have no multi-account pool: skip the session read entirely.
  if (!hasMultiAccountPool()) return false;
  const row = await deps.readSession(sessionId);
  assertOwner();
  const bound = row && boundAccount(sessionId, row);
  if (!bound || deps.isRunning(sessionId)) return false;
  if (!readSubscriptionAccountBlocked(bound.provider, bound.accountId, bound.model)) return false;
  // Reserve the replacement with the same pool policy, limits and quota order as a new task.
  // None left (all blocked or full): keep the original account and let the send report it.
  let lease: Awaited<ReturnType<typeof acquireSubscriptionAccount>>;
  try {
    lease = await acquireSubscriptionAccount(bound.provider, bound.model, [], false, {
      exclude: new Set([bound.accountId]),
    });
  } catch {
    return false;
  }
  if (!lease) return false;
  try {
    const assertCurrent = () => {
      assertOwner();
      lease!.assertDispatchable();
      if (deps.isRunning(sessionId)) throw new Error('Cannot switch a running task subscription account');
      const current = readAccountBinding(`task:${sessionId}`, bound.provider)
        ?? (row!.sdkSessionId ? readAccountBinding(`native:${row!.sdkSessionId}`, bound.provider) : undefined);
      if (current?.accountId !== bound.accountId) throw new Error('The task subscription account changed');
    };
    assertCurrent();
    // Keep the old native id bound to the account that owns its history; only the task moves.
    if (row!.sdkSessionId) await deps.rebuild(sessionId, assertCurrent);
    assertCurrent();
    await lease.bind([`task:${sessionId}`]);
    lease.reserveForTask(sessionId);
    deps.log?.('subscription account failover: moved task before send', {
      sessionId, provider: bound.provider, from: bound.accountId, to: lease.accountId,
    });
    return true;
  } finally {
    lease.release();
  }
}
