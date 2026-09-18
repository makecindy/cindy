import { describe, expect, it, vi } from 'vitest';
import {
  doesRuntimeRefreshOwnActiveSession,
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
  const persistedCompatibilityReplacement = {
    requestedTokenStillStored: true,
    accountKey: 'global:account-a',
    activeAccountKey: null,
    allowUnclaimedVault: true,
    vaultResourceCount: 0,
    vaultHasSignedOutTombstone: false,
    accountIsLoggedOut: false,
  };

  it('reclaims an unowned target while preserving unrelated inactive account resources', () => {
    const replacementWithInactiveAccounts = {
      ...persistedCompatibilityReplacement,
      // The expiry CAS removed account A, but account B remains inactive.
      vaultResourceCount: 1,
    };

    expect(doesRuntimeRefreshOwnActiveSession(replacementWithInactiveAccounts)).toBe(true);
  });

  it.each([
    ['the replacement is no longer persisted', { requestedTokenStillStored: false }],
    ['reclaim was not explicitly enabled', { allowUnclaimedVault: false }],
    ['a newer account owns the vault', { activeAccountKey: 'global:account-b' }],
    ['the vault has a signed-out tombstone', { vaultHasSignedOutTombstone: true }],
    ['the target account has a logout tombstone', { accountIsLoggedOut: true }],
  ])('does not let a stale refresh reclaim when %s', (_label, override) => {
    expect(
      doesRuntimeRefreshOwnActiveSession({
        ...persistedCompatibilityReplacement,
        ...override,
      }),
    ).toBe(false);
  });

  it('keeps ownership for the currently active target account', () => {
    const activeReplacement = {
      requestedTokenStillStored: true,
      accountKey: 'global:account-a',
      activeAccountKey: 'global:account-a',
      allowUnclaimedVault: false,
      vaultResourceCount: 1,
      vaultHasSignedOutTombstone: true,
      accountIsLoggedOut: true,
    };

    expect(doesRuntimeRefreshOwnActiveSession(activeReplacement)).toBe(true);
  });

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

  it('does not commit expiry when a shared-userData client replaces credentials during teardown', async () => {
    let persistedGeneration: 'rejected' | 'replacement' = 'rejected';
    const teardownStarted = deferred<void>();
    const replacementWritten = deferred<void>();
    const commitApplied = vi.fn();
    const run = runGuardedRuntimeAuthExpiry({
      isCurrent: () => true,
      isPersistedCredentialCurrent: () => persistedGeneration === 'rejected',
      removeRejectedCredentials: async () => 'removed',
      commit: async (guards) => {
        guards.markTeardownStarted();
        teardownStarted.resolve();
        await replacementWritten.promise;
        if (!guards.validateBeforeCommit()) throw new Error('superseded before commit');
        commitApplied();
      },
    });

    await teardownStarted.promise;
    persistedGeneration = 'replacement';
    replacementWritten.resolve();

    await expect(run).resolves.toBe('stale-credential-after-teardown');
    expect(commitApplied).not.toHaveBeenCalled();
  });

  it('retries when the persisted credential recheck becomes unavailable during teardown', async () => {
    const credentialStoreUnavailable = new Error('credential store unavailable');
    let persistedChecks = 0;
    const commitApplied = vi.fn();

    await expect(
      runGuardedRuntimeAuthExpiry({
        isCurrent: () => true,
        isPersistedCredentialCurrent: () => {
          persistedChecks += 1;
          if (persistedChecks === 1) return true;
          throw credentialStoreUnavailable;
        },
        removeRejectedCredentials: async () => 'removed',
        isRetryableError: (error) => error === credentialStoreUnavailable,
        commit: async (guards) => {
          guards.markTeardownStarted();
          if (!guards.validateBeforeCommit()) throw new Error('superseded before commit');
          commitApplied();
        },
      }),
    ).resolves.toBe('retry-after-teardown');
    expect(persistedChecks).toBe(2);
    expect(commitApplied).not.toHaveBeenCalled();
  });

  it('does not request runtime restoration when retry happens before teardown', async () => {
    const credentialStoreUnavailable = new Error('credential store unavailable');
    let persistedChecks = 0;

    await expect(
      runGuardedRuntimeAuthExpiry({
        isCurrent: () => true,
        isPersistedCredentialCurrent: () => {
          persistedChecks += 1;
          if (persistedChecks === 1) return true;
          throw credentialStoreUnavailable;
        },
        isRetryableError: (error) => error === credentialStoreUnavailable,
        commit: async (guards) => {
          guards.validateBeforeCommit();
        },
      }),
    ).resolves.toBe('retry');
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
