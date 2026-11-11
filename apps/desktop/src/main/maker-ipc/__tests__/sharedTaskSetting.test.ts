import { describe, expect, it, vi } from 'vitest';
import { authorizeSharedTaskOperation } from '@cindy/device-link';
import { createSharedTaskPendingSelectionGuard, createSharedTaskSettingGuard } from '../sharedTaskSetting.js';
import { applyRuntimeSetModelChange } from '../runtimeSetModel.js';
import { commitRuntimeAxisAfterPersistence } from '../runtimeSelectionAxes.js';

function harness(kind: 'setting' | 'pending' = 'setting') {
  let current = true;
  const transaction = { admitted: false };
  const capture = {
    author: { sharedTaskId: 'sharedTask', sessionId: 'task', memberId: 'guest', accountId: 'account', displayName: 'Guest' },
    isCurrent: () => current, authorize: () => current,
  };
  const guard = kind === 'pending'
    ? createSharedTaskPendingSelectionGuard(capture, 'task')
    : createSharedTaskSettingGuard(capture, 'task', transaction);
  return { guard, transaction, revoke() { current = false; } };
}
describe('sharedTask setting admission', () => {
  it('rejects an active guest at the model mutation boundary using the real permission policy', async () => {
    const transaction = { admitted: false };
    const guard = createSharedTaskSettingGuard({
      author: { sharedTaskId: 'sharedTask', sessionId: 'task', memberId: 'guest', accountId: 'account', displayName: 'Guest' },
      isCurrent: () => true,
      authorize: (operation) => authorizeSharedTaskOperation({
        sharedTaskId: 'sharedTask', sessionId: 'task', ownerAccountId: 'owner', hostDeviceId: 'host',
        status: 'active', revision: 1,
        guests: [{ memberId: 'guest', accountId: 'account', version: 1, deviceIds: ['phone'] }],
      }, { accountId: 'account', deviceId: 'phone' }, 'task', operation).allowed,
    }, 'task', transaction);
    const setModel = vi.fn();
    const closeSession = vi.fn();
    const session = { agentKind: 'claude-code' as const, model: 'host-model', setModel };

    await expect(applyRuntimeSetModelChange({
      maker: { getSession: () => session, listActiveSessions: () => [], closeSession },
      sessionId: 'task', model: 'guest-model', admit: guard.admit,
    })).rejects.toThrow('PERMISSION_DENIED');

    expect(transaction.admitted).toBe(false);
    expect(setModel).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
    expect(session.model).toBe('host-model');
  });
  // #7825: the pending-choice fence must survive runtime preflight but must not
  // prevent completion/rollback after mutation admission. These production
  // runtime boundaries are distinct from the pending-apply/ALS tests.
  it.each(['setting', 'pending'] as const)('rechecks %s membership after async model preflight, before any runtime change', async (kind) => {
    const h = harness(kind);
    const setModel = vi.fn();
    const closeSession = vi.fn();
    let resolve!: (value: boolean) => void;
    const session = { agentKind: 'claude-code' as const, model: 'old', setModel,
      requiresModelSwitchRebuild: () => new Promise<boolean>((done) => { resolve = done; }) };
    const run = applyRuntimeSetModelChange({
      maker: { getSession: () => session, listActiveSessions: () => [], closeSession },
      sessionId: 'task', model: 'new', admit: h.guard.admit,
    });
    h.revoke();
    resolve(false);
    await expect(run).rejects.toThrow('SharedTask task access denied');
    expect(setModel).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
  });
  it.each(['setting', 'pending'] as const)('finishes persistence of an admitted %s operation after removal', async (kind) => {
    const h = harness(kind);
    h.guard.admit();
    h.revoke();
    const commit = vi.fn();
    await commitRuntimeAxisAfterPersistence({
      persist: async () => { h.guard(); }, commit, assertCanCommit: h.guard,
    });
    expect(commit).toHaveBeenCalledOnce();
  });
  it.each(['setting', 'pending'] as const)('does not block recovery when persistence fails after an admitted %s operation', async (kind) => {
    const h = harness(kind);
    h.guard.admit();
    h.revoke();
    const recover = vi.fn(async () => {});
    const commit = vi.fn();
    await expect(commitRuntimeAxisAfterPersistence({
      persist: async () => { throw new Error('disk failed'); }, commit,
      assertCanCommit: h.guard, recoverAfterPersistenceFailure: recover,
    })).rejects.toThrow('disk failed');
    expect(recover).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
  });
});
