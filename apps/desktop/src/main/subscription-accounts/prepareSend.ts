import type { SessionRowSnapshot } from '../localDb/sessionDispatchSnapshot.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { readAccountBinding, readPool } from './store.js';
import { acquireSubscriptionAccount } from './runtime.js';

interface PrepareAccountSendDeps {
  readSession(id: string): Promise<SessionRowSnapshot | null>;
  isRunning(id: string): boolean;
  /** Retires only this runtime and durably retains its context before clearing the native id. */
  rebuild(id: string, assertCurrent: () => void): Promise<void>;
}

/** Called under the ordinary send lock, before lazy bootstrap or reuse of a live handle.
 * Disabling an account is an explicit routing decision. Quota exhaustion alone is not.
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
  const row = await deps.readSession(sessionId);
  assertOwner();
  if (!row || row.status === 'deleted' || row.remoteHostId || row.agentDeviceId) return false;
  const provider = row.providerId;
  if (provider !== 'openai' && !(provider === 'anthropic' && row.agentKind === 'cc')) return false;
  const pool = readPool(provider);
  if (!pool || pool.disconnected) return false;
  const binding = readAccountBinding(`task:${sessionId}`, provider)
    ?? (row.sdkSessionId ? readAccountBinding(`native:${row.sdkSessionId}`, provider) : undefined)
    // Pre-pool Claude tasks resume the official default home (same as agent.ts).
    ?? (provider === 'anthropic' && row.sdkSessionId ? { accountId: 'default' } : undefined);
  if (!binding) return false;
  const original = pool.accounts.find(account => account.id === binding.accountId);
  if (original && !original.paused) return false;
  if (deps.isRunning(sessionId)) throw new Error('Cannot switch a running task subscription account');

  // Reserve a usable replacement before touching the old runtime or its history.
  const lease = await acquireSubscriptionAccount(provider, row.model ?? undefined, []);
  if (!lease) throw new Error('No subscription account is available');
  try {
    const assertCurrent = () => {
      assertOwner();
      lease.assertDispatchable();
      if (deps.isRunning(sessionId)) throw new Error('Cannot switch a running task subscription account');
    };
    assertCurrent();
    await deps.rebuild(sessionId, assertCurrent);
    assertCurrent();
    // Commit context first. A failed binding write leaves a recoverable handoff on the
    // old account; a retry can switch again. Never rebind old native ids to a new home.
    await lease.bind([`task:${sessionId}`]);
    lease.reserveForTask(sessionId);
    return true;
  } finally {
    lease.release();
  }
}
