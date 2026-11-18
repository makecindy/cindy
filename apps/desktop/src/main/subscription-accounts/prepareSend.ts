import type { SessionRowSnapshot } from '../localDb/sessionDispatchSnapshot.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { readAccountBinding, readPool } from './store.js';
import { acquireSubscriptionAccount, codexSubscriptionAccountForHistoryHome } from './runtime.js';
import { taskPoolRouteAllowsModel, readTaskPoolAccount } from './taskAccount.js';

interface PrepareAccountSendDeps {
  readSession(id: string): Promise<SessionRowSnapshot | null>;
  isRunning(id: string): boolean;
  /** Same owner-scoped, read-only canonical history lookup used by Codex startup. */
  resolveCodexHistoryHome?(threadId: string): Promise<string | undefined>;
  /** Retires only this runtime and durably retains its context before clearing the native id. */
  rebuild(id: string, assertCurrent: () => void): Promise<void>;
  /**
   * Moves an idle task off a merged connection id onto the account's current provider
   * after its context handoff (same as failover.ts). Without it such tasks are left as before.
   */
  moveRoute?(id: string, providerId: string, assertCurrent: () => void, fromProviderId: string): Promise<void>;
}

/** Called under the ordinary send lock, before lazy bootstrap or reuse of a live handle.
 * Disabling an account is an explicit routing decision. Quota exhaustion alone is not.
 * A task on a merged legacy connection hands off like any other (2026-11-13): pausing that
 * account in the merged OpenAI list is the only way left to move such tasks by hand.
 */
export async function prepareSubscriptionAccountForSend(
  sessionId: string,
  deps: PrepareAccountSendDeps,
): Promise<boolean> {
  const owner = activeOwnerScopeKey();
  const assertOwner = () => {
    if (owner !== activeOwnerScopeKey() || isAppSessionBoundaryPending())
      throw new Error('Subscription account owner changed');
  };
  assertOwner();
  const read = await deps.readSession(sessionId);
  assertOwner();
  // Keep comparing against what this send saw, even if the caller reuses its row object.
  const row = read && { ...read };
  let historyAccountId: string | undefined;
  // Startup can pin an unbound old thread by its canonical history home. Resolve that
  // affinity here too so a removed/paused account reaches the existing durable handoff.
  if (row?.status !== 'deleted' && row?.providerId === 'openai' && row.agentKind === 'codex'
    && row.sdkSessionId && !row.remoteHostId && !row.agentDeviceId && readPool('openai')
    && !readAccountBinding(`task:${sessionId}`, 'openai')
    && !readAccountBinding(`native:${row.sdkSessionId}`, 'openai') && deps.resolveCodexHistoryHome) {
    const home = await deps.resolveCodexHistoryHome(row.sdkSessionId);
    assertOwner();
    const latest = await deps.readSession(sessionId);
    assertOwner();
    if (!latest || latest.status !== row.status || latest.providerId !== row.providerId
      || latest.agentKind !== row.agentKind || latest.sdkSessionId !== row.sdkSessionId
      || latest.remoteHostId !== row.remoteHostId || latest.agentDeviceId !== row.agentDeviceId
      || latest.model !== row.model) throw new Error('The task route changed');
    historyAccountId = home ? codexSubscriptionAccountForHistoryHome(home) : undefined;
  }
  const task = row && readTaskPoolAccount(sessionId, row, historyAccountId);
  if (!task || (task.previousProviderId && !deps.moveRoute)) return false;
  const { provider } = task;
  const pool = readPool(provider);
  if (!pool || (pool.disconnected && task.providerId === provider)) return false;
  const original = pool.accounts.find(account => account.id === task.accountId);
  if (original && !original.paused) return false;
  if (deps.isRunning(sessionId)) throw new Error('Cannot switch a running task subscription account');
  // The merged route's own model switches still apply; never widen access by moving.
  if (!(await taskPoolRouteAllowsModel(task, row!.model ?? undefined)))
    throw new Error('No subscription account is available');
  assertOwner();

  // Reserve a usable replacement before touching the old runtime or its history.
  const lease = await acquireSubscriptionAccount(task.providerId, row!.model ?? undefined, []);
  if (!lease) throw new Error('No subscription account is available');
  try {
    const assertCurrent = () => {
      assertOwner();
      lease.assertDispatchable();
      const current = readTaskPoolAccount(sessionId, row!, historyAccountId);
      if (current?.providerId !== task.providerId || current.accountId !== task.accountId)
        throw new Error('The task subscription account changed');
      if (deps.isRunning(sessionId)) throw new Error('Cannot switch a running task subscription account');
    };
    assertCurrent();
    await deps.rebuild(sessionId, assertCurrent);
    assertCurrent();
    if (task.previousProviderId) {
      // The old id would pin the paused account again; continue on the merged route instead.
      const latest = await deps.readSession(sessionId);
      if (latest?.providerId !== task.previousProviderId) throw new Error('The task route changed');
      await deps.moveRoute!(sessionId, task.providerId, assertCurrent, task.previousProviderId);
      assertCurrent();
    }
    // Commit context first. A failed binding write leaves a recoverable handoff on the
    // old account; a retry can switch again. Never rebind old native ids to a new home.
    await lease.bind([`task:${sessionId}`]);
    lease.reserveForTask(sessionId);
    return true;
  } finally {
    lease.release();
  }
}
