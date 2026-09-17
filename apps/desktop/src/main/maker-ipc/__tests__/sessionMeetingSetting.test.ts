import { describe, expect, it, vi } from 'vitest';
import { createSessionMeetingSettingGuard } from '../sessionMeetingSetting.js';
import { applyRuntimeSetModelChange } from '../runtimeSetModel.js';
import { commitRuntimeAxisAfterPersistence } from '../runtimeSelectionAxes.js';

function harness() {
  let current = true;
  const transaction = { admitted: false };
  const guard = createSessionMeetingSettingGuard({
    author: { meetingId: 'meeting', sessionId: 'task', memberId: 'guest', accountId: 'account', displayName: 'Guest' },
    isCurrent: () => current, authorize: () => current,
  }, 'task', transaction);
  return { guard, transaction, revoke() { current = false; } };
}
describe('meeting setting admission', () => {
  it('rechecks membership after async model preflight, before any runtime change', async () => {
    const h = harness();
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
    await expect(run).rejects.toThrow('Meeting task access denied');
    expect(setModel).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
  });
  it('finishes persistence of an admitted native operation after removal', async () => {
    const h = harness();
    h.guard.admit();
    h.revoke();
    const commit = vi.fn();
    await commitRuntimeAxisAfterPersistence({
      persist: async () => { h.guard(); }, commit, assertCanCommit: h.guard,
    });
    expect(commit).toHaveBeenCalledOnce();
  });
  it('does not block recovery when persistence fails after an admitted operation', async () => {
    const h = harness();
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
