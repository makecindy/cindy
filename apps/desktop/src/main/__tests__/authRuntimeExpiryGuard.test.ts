import { describe, expect, it, vi } from 'vitest';
import {
  removeRejectedRuntimeCredentialCopies,
  runGuardedRuntimeAuthExpiry,
  type RuntimeCompatibilityRemovalResult,
  type RuntimeCredentialVault,
} from '../authRuntimeExpiryGuard';

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

  it('keeps the clear-on-failure fallback for the expiry transition own epoch bump', async () => {
    let epoch = 1;
    let clearOnFailure = false;
    const failure = new Error('durable signed-out commit failed');
    const run = runGuardedRuntimeAuthExpiry({
      isCurrent: () => epoch === 1,
      removeRejectedCredentials: async () => 'removed',
      commit: async (guards) => {
        guards.markSelfCleared();
        epoch = 2;
        clearOnFailure = guards.shouldClearOnFailure();
        throw failure;
      },
    });

    await expect(run).rejects.toBe(failure);
    expect(clearOnFailure).toBe(true);
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

  it('preserves a replacement generation written while waiting for the vault lock', async () => {
    let vault: RuntimeCredentialVault<'global'> = {
      activeAccountKey: 'global:account-a',
      resources: {
        'global:account-a': { realm: 'global', refreshToken: 'rejected-token' },
      },
    };
    let session = 'global:rejected-token';
    let legacy = 'rejected-token';
    const entered = deferred<void>();
    const release = deferred<void>();
    const run = removeRejectedRuntimeCredentialCopies({
      realm: 'global',
      rejectedRefreshTokens: ['rejected-token'],
      validateBeforeWrite: () => undefined,
      mutateVault: async (operation) => {
        entered.resolve();
        await release.promise;
        return operation(vault);
      },
      serializeSession: (realm, token) => `${realm}:${token}`,
      removeSessionIfUnchanged: (expected) =>
        removeMemoryValue(
          expected,
          () => session,
          (v) => {
            session = v;
          },
        ),
      removeLegacyIfUnchanged: (expected) =>
        removeMemoryValue(
          expected,
          () => legacy,
          (v) => {
            legacy = v;
          },
        ),
    });

    await entered.promise;
    vault = {
      activeAccountKey: 'global:account-a',
      resources: {
        'global:account-a': { realm: 'global', refreshToken: 'replacement-token' },
      },
    };
    session = 'global:replacement-token';
    legacy = 'replacement-token';
    release.resolve();

    await expect(run).resolves.toBe('stale');
    expect(vault.resources['global:account-a']?.refreshToken).toBe('replacement-token');
    expect(session).toBe('global:replacement-token');
    expect(legacy).toBe('replacement-token');
  });

  it('treats a compatibility replacement after vault deletion as a stale credential', async () => {
    const vault: RuntimeCredentialVault<'global'> = {
      activeAccountKey: 'global:account-a',
      resources: {
        'global:account-a': { realm: 'global', refreshToken: 'rejected-token' },
      },
    };
    let session = 'global:rejected-token';

    await expect(
      removeRejectedRuntimeCredentialCopies({
        realm: 'global',
        rejectedRefreshTokens: ['rejected-token'],
        validateBeforeWrite: () => undefined,
        mutateVault: async (operation) => {
          const outcome = operation(vault);
          session = 'global:replacement-token';
          return outcome;
        },
        serializeSession: (realm, token) => `${realm}:${token}`,
        removeSessionIfUnchanged: (expected) =>
          removeMemoryValue(
            expected,
            () => session,
            (value) => {
              session = value;
            },
          ),
      }),
    ).resolves.toBe('stale');
    expect(vault.activeAccountKey).toBeNull();
    expect(session).toBe('global:replacement-token');
  });

  it('removes a rejected generation from the vault and both compatibility projections', async () => {
    const vault: RuntimeCredentialVault<'global'> = {
      activeAccountKey: 'global:account-a',
      resources: {
        'global:account-a': { realm: 'global', refreshToken: 'rejected-token-2' },
      },
    };
    let session = 'global:rejected-token-2';
    let legacy = 'rejected-token-2';
    await expect(
      removeRejectedRuntimeCredentialCopies({
        realm: 'global',
        rejectedRefreshTokens: ['rejected-token-1', 'rejected-token-2'],
        validateBeforeWrite: () => undefined,
        mutateVault: async (operation) => operation(vault),
        serializeSession: (realm, token) => `${realm}:${token}`,
        removeSessionIfUnchanged: (expected) =>
          removeMemoryValue(
            expected,
            () => session,
            (value) => {
              session = value;
            },
          ),
        removeLegacyIfUnchanged: (expected) =>
          removeMemoryValue(
            expected,
            () => legacy,
            (value) => {
              legacy = value;
            },
          ),
      }),
    ).resolves.toBe('removed');
    expect(vault.activeAccountKey).toBeNull();
    expect(vault.resources).toEqual({});
    expect(session).toBe('');
    expect(legacy).toBe('');
  });
});

function removeMemoryValue(
  expected: string,
  read: () => string,
  write: (value: string) => void,
): RuntimeCompatibilityRemovalResult {
  if (read() !== expected) return 'changed';
  write('');
  return 'deleted';
}
