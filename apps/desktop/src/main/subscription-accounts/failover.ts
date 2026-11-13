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
 * Paused or removed accounts are handled by their own pre-send handoff, not here. A same-account
 * remote Agent task is handed off by the native-session recovery before send
 * (`needsSubscriptionAccountHandoff`); its executing computer picks the replacement account.
 *
 * Every local pool task can move (2026-11-13 user decision): after the merge users can no longer
 * switch connections by hand, so tasks on a merged legacy Codex connection, or bound to an account
 * that came from one, move like any other. A task still routed through the old connection id
 * continues on the merged `openai` route, whose own model switches must allow its model.
 */
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import type { SubscriptionProvider } from '../../shared/subscriptionAccounts.js';
import { readPool } from './store.js';
import {
  acquireSubscriptionAccount,
  readRemoteSubscriptionAccountSwitch,
  readSubscriptionAccountBlocked,
  type RemoteSubscriptionInvoke,
} from './runtime.js';
import { mergedRouteAllowsModel, readTaskPoolAccount, type TaskPoolAccount } from './taskAccount.js';

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
  /**
   * Moves an idle task off a merged legacy Codex connection id onto the merged `openai` route
   * (runtime routing and the saved task source), after its context handoff. Must call
   * `assertCurrent` before writing. Without it such tasks stay on their account.
   */
  moveRoute?(id: string, providerId: SubscriptionProvider, assertCurrent: () => void, fromProviderId: string): Promise<void>;
  /** Owner-only session-account read on the task's executing computer. */
  invokeRemote?: RemoteSubscriptionInvoke;
  log?(message: string, fields: Record<string, unknown>): void;
}

interface BoundAccount extends TaskPoolAccount {
  model: string | undefined;
}

/** Local pool task with at least two accounts to choose from; SSH and other computers are excluded. */
function boundAccount(sessionId: string, row: AccountFailoverSession): BoundAccount | null {
  const task = readTaskPoolAccount(sessionId, row);
  if (!task) return null;
  const pool = readPool(task.provider);
  if (!pool || pool.disconnected || pool.accounts.length < 2) return null;
  return { ...task, model: row.model ?? undefined };
}

/** A task leaving a merged connection id also needs the merged route to allow its model. */
async function routeAdmits(bound: BoundAccount): Promise<boolean> {
  return !bound.legacyRoute || mergedRouteAllowsModel(bound.model);
}

function hasMultiAccountPool(): boolean {
  return (['anthropic', 'openai'] as const).some((provider) => {
    const pool = readPool(provider);
    return !!pool && !pool.disconnected && pool.accounts.length > 1;
  });
}

/**
 * The bound account this task would move away from when another account can take it right now
 * (used to continue a failed turn at once); null otherwise. A same-account remote Agent task asks
 * its executing computer, whose next fresh start picks the replacement; SSH and provider shares
 * never move. The token only identifies the account within this task (no identity or directory).
 */
export async function readSubscriptionAccountSwitch(
  sessionId: string,
  readSession: AccountFailoverDeps['readSession'],
  invokeRemote?: RemoteSubscriptionInvoke,
): Promise<string | null> {
  const local = hasMultiAccountPool();
  // Most tasks have no multi-account pool anywhere: skip the session read entirely.
  if (!local && !invokeRemote) return null;
  const row = await readSession(sessionId);
  if (!row || row.status === 'deleted' || row.remoteHostId) return null;
  if (row.agentDeviceId) {
    return invokeRemote
      ? readRemoteSubscriptionAccountSwitch({ ...row, agentKind: row.agentKind ?? '' }, invokeRemote)
      : null;
  }
  const bound = local ? boundAccount(sessionId, row) : null;
  if (!bound || !readSubscriptionAccountBlocked(bound.provider, bound.accountId, bound.model)) return null;
  if (!(await routeAdmits(bound))) return null;
  try {
    await acquireSubscriptionAccount(bound.provider, bound.model, [], false, {
      exclude: new Set([bound.accountId]), dryRun: true,
    });
    return `local#${bound.provider}:${bound.accountId}`;
  } catch {
    return null;
  }
}

/** Whether another account can take this task right now (used to continue a failed turn at once). */
export async function canSwitchSubscriptionAccount(
  sessionId: string,
  readSession: AccountFailoverDeps['readSession'],
  invokeRemote?: RemoteSubscriptionInvoke,
): Promise<boolean> {
  return (await readSubscriptionAccountSwitch(sessionId, readSession, invokeRemote)) !== null;
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
  // Remote legacy aliases belong to their executor, even when this computer has no account pool.
  const local = hasMultiAccountPool();
  if (!local && !deps.invokeRemote) return false;
  const read = await deps.readSession(sessionId);
  assertOwner();
  // Later checks compare against what this send saw, even if the caller reuses its row object.
  const row = read && { ...read };
  if (row?.agentDeviceId && row.providerId && row.providerId !== 'openai' && row.providerId !== 'anthropic') {
    if (!deps.invokeRemote || !deps.moveRoute || deps.isRunning(sessionId)) return false;
    let available: string | null;
    try {
      available = await readRemoteSubscriptionAccountSwitch({ ...row, agentKind: row.agentKind ?? '' }, deps.invokeRemote);
    } catch {
      assertOwner();
      return false;
    }
    assertOwner();
    if (!available) return false;
    const assertCurrent = () => {
      assertOwner();
      if (deps.isRunning(sessionId)) throw new Error('Cannot switch a running task subscription account');
    };
    const assertSource = async (afterRebuild: boolean) => {
      const current = await deps.readSession(sessionId);
      assertCurrent();
      if (!current || current.status === 'deleted' || current.providerId !== row.providerId
        || current.agentDeviceId !== row.agentDeviceId || current.remoteHostId !== row.remoteHostId
        || current.model !== row.model
        || (afterRebuild ? !!current.sdkSessionId : current.sdkSessionId !== row.sdkSessionId))
        throw new Error('The task route changed');
    };
    await assertSource(false);
    if (row.sdkSessionId) await deps.rebuild(sessionId, assertCurrent);
    await assertSource(true);
    // The executing host admitted the merged destination; a fresh start there chooses the account.
    await deps.moveRoute(sessionId, 'openai', assertCurrent, row.providerId);
    deps.log?.('subscription account failover: moved remote legacy task before send', { sessionId });
    return true;
  }
  if (!local) return false;
  const bound = row && boundAccount(sessionId, row);
  if (!bound || deps.isRunning(sessionId)) return false;
  if (!readSubscriptionAccountBlocked(bound.provider, bound.accountId, bound.model)) return false;
  if (bound.legacyRoute && !deps.moveRoute) return false;
  if (!(await routeAdmits(bound))) return false;
  assertOwner();
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
      if (readTaskPoolAccount(sessionId, row!)?.accountId !== bound.accountId)
        throw new Error('The task subscription account changed');
    };
    assertCurrent();
    // Keep the old native id bound to the account that owns its history; only the task moves.
    if (row!.sdkSessionId) await deps.rebuild(sessionId, assertCurrent);
    assertCurrent();
    if (bound.legacyRoute) {
      // The old id would pin the old account again; continue on the merged route instead.
      const latest = await deps.readSession(sessionId);
      if (latest?.providerId !== bound.legacyRoute) throw new Error('The task route changed');
      await deps.moveRoute!(sessionId, bound.provider, assertCurrent, bound.legacyRoute);
      assertCurrent();
    }
    await lease.bind([`task:${sessionId}`]);
    lease.reserveForTask(sessionId);
    deps.log?.('subscription account failover: moved task before send', {
      sessionId, provider: bound.provider, from: bound.accountId, to: lease.accountId,
      ...(bound.legacyRoute ? { mergedRoute: true } : {}),
    });
    return true;
  } finally {
    lease.release();
  }
}
