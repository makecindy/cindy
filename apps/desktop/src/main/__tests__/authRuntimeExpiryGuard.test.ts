import { describe, expect, it, vi } from 'vitest';
import { runGuardedRuntimeAuthExpiry } from '../authRuntimeExpiryGuard';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('runtime auth expiry guard', () => {
  it.each([
    ['same account re-login', { epoch: 2, realm: 'global', userId: 'account-a' }],
    ['different account login', { epoch: 2, realm: 'global', userId: 'account-b' }],
  ])('does not expire a newer identity after vault-lock wait: %s', async (_label, replacement) => {
    let identity = { epoch: 1, realm: 'global', userId: 'account-a' };
    const expected = identity;
    const removal = deferred<'removed'>();
    const commit = vi.fn();
    const run = runGuardedRuntimeAuthExpiry({
      isCurrent: () =>
        identity.epoch === expected.epoch &&
        identity.realm === expected.realm &&
        identity.userId === expected.userId,
      removeRejectedCredentials: () => removal.promise,
      commit,
    });

    identity = replacement;
    removal.resolve('removed');

    await expect(run).resolves.toBe('superseded');
    expect(commit).not.toHaveBeenCalled();
  });

  it('keeps a replacement token when the vault CAS reports a newer generation', async () => {
    const commit = vi.fn();
    await expect(
      runGuardedRuntimeAuthExpiry({
        isCurrent: () => true,
        removeRejectedCredentials: async () => 'stale',
        commit,
      }),
    ).resolves.toBe('stale-credential');
    expect(commit).not.toHaveBeenCalled();
  });

  it('guards both teardown commit and clear-on-failure against a login during teardown', async () => {
    let epoch = 1;
    let clearOnFailure = true;
    const superseded = new Error('superseded');
    const run = runGuardedRuntimeAuthExpiry({
      isCurrent: () => epoch === 1,
      removeRejectedCredentials: async () => 'removed',
      commit: async (guards) => {
        epoch = 2;
        expect(guards.validateBeforeCommit()).toBe(false);
        clearOnFailure = guards.shouldClearOnFailure();
        throw superseded;
      },
    });

    await expect(run).rejects.toBe(superseded);
    expect(clearOnFailure).toBe(false);
  });

  it('commits an unchanged definitive expiry with both guards active', async () => {
    const commit = vi.fn(async (guards) => {
      expect(guards.validateBeforeCommit()).toBe(true);
      expect(guards.shouldClearOnFailure()).toBe(true);
    });
    await expect(
      runGuardedRuntimeAuthExpiry({
        isCurrent: () => true,
        removeRejectedCredentials: async () => 'removed',
        commit,
      }),
    ).resolves.toBe('expired');
    expect(commit).toHaveBeenCalledOnce();
  });
});
