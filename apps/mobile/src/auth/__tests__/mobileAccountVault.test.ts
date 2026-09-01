import { beforeEach, describe, expect, it, vi } from 'vitest';

const secureStorage = vi.hoisted(() => ({
  value: null as string | null,
  readError: null as Error | null,
  delete: vi.fn(async () => {
    secureStorage.value = null;
  }),
  set: vi.fn(async (_key: string, value: string) => {
    secureStorage.value = value;
  }),
}));

vi.mock('../secureStorage', () => ({
  deleteSecureItem: secureStorage.delete,
  getSecureItem: vi.fn(async () => {
    if (secureStorage.readError) throw secureStorage.readError;
    return secureStorage.value;
  }),
  setSecureItem: secureStorage.set,
}));

import {
  clearMobileAccountVault,
  clearMobileLoginCredentialsForLogout,
  commitMobileLoginSessions,
  commitMobileRuntimeResourceSession,
  commitMobileSavedAccountActivation,
  listMobileSavedAccounts,
  mutateMobileAccountVault,
  parseMobileAccountVault,
  reconcileMobileActiveAuthSession,
  removeMobilePassportSessionIfCurrent,
  removeMobileResourceSessionIfCurrent,
  replaceMobilePassportSessionIfCurrent,
  replaceMobileResourceSessionIfCurrent,
  transactMobileAccountVault,
} from '../mobileAccountVault';

const metadata = {
  membershipId: 'membership-1',
  passportId: 'passport-1',
  displayName: 'Cao Jianbo',
  email: 'cao@example.com',
  avatarUrl: 'https://example.com/user.png',
  kind: 'org' as const,
  role: 'member' as const,
  orgId: 'org-1',
  orgName: 'Cindy',
  orgLogoUrl: 'https://example.com/org.png',
};

describe('mobile account vault', () => {
  beforeEach(() => {
    secureStorage.value = null;
    secureStorage.readError = null;
    vi.clearAllMocks();
  });

  it('falls back to an empty read-only projection for malformed encrypted content', () => {
    expect(parseMobileAccountVault('{bad-json')).toEqual({
      version: 1,
      activeAccountKey: null,
      resources: {},
      passports: {},
    });
  });

  it('filters damaged children only from the read-only projection', () => {
    const accountKey = JSON.stringify(['global', metadata.membershipId]);
    const raw = JSON.stringify({
      version: 1,
      activeAccountKey: accountKey,
      resources: {
        [accountKey]: {
          realm: 'global',
          refreshToken: 'resource-refresh',
          metadata,
          lastUsedAt: 10,
        },
        damaged: { realm: 'global', refreshToken: 'must-not-be-rewritten' },
      },
      passports: {},
    });

    expect(parseMobileAccountVault(raw).resources).toEqual({
      [accountKey]: expect.objectContaining({ refreshToken: 'resource-refresh' }),
    });
  });

  it('deduplicates resource and Passport projections and marks the active account', () => {
    const accountKey = JSON.stringify(['global', 'membership-1']);
    const raw = JSON.stringify({
      version: 1,
      activeAccountKey: accountKey,
      resources: {
        [accountKey]: {
          realm: 'global',
          refreshToken: 'resource-refresh',
          metadata,
          lastUsedAt: 10,
        },
      },
      passports: {
        passport: {
          realm: 'global',
          passportId: 'passport-1',
          accountRefreshToken: 'account-refresh',
          memberships: [metadata],
        },
      },
    });

    expect(listMobileSavedAccounts(parseMobileAccountVault(raw))).toEqual([
      expect.objectContaining({
        accountKey,
        isCurrent: true,
        orgName: 'Cindy',
        orgLogoUrl: 'https://example.com/org.png',
      }),
    ]);
    expect(listMobileSavedAccounts(parseMobileAccountVault(raw), null)).toEqual([
      expect.objectContaining({ accountKey, isCurrent: false }),
    ]);
  });

  it('preserves divergent compatibility and vault generations as refresh candidates', async () => {
    const accountKey = JSON.stringify(['global', metadata.membershipId]);
    secureStorage.value = JSON.stringify({
      version: 1,
      activeAccountKey: accountKey,
      resources: {
        [accountKey]: {
          realm: 'global',
          refreshToken: 'resource-new',
          metadata,
          lastUsedAt: 10,
        },
      },
      passports: {},
    });
    let session: {
      version: 1;
      realm: 'cn' | 'global';
      refreshToken: string;
    } = {
      version: 1,
      realm: 'global',
      refreshToken: 'resource-old',
    };
    const writePersistedSession = vi.fn(
      async (refreshToken: string, realm: 'cn' | 'global') => {
        session = { version: 1, realm, refreshToken };
      },
    );
    const clearPersistedSession = vi.fn(async () => undefined);

    const reconciled = await reconcileMobileActiveAuthSession({
      readPersistedSession: async () => session,
      writePersistedSession,
      clearPersistedSession,
    });

    expect(reconciled.session).toEqual({
      version: 1,
      realm: 'global',
      refreshToken: 'resource-old',
    });
    expect(reconciled.refreshCandidates).toEqual([
      { version: 1, realm: 'global', refreshToken: 'resource-old' },
      { version: 1, realm: 'global', refreshToken: 'resource-new' },
    ]);
    expect(writePersistedSession).not.toHaveBeenCalled();
    expect(clearPersistedSession).not.toHaveBeenCalled();
    expect(secureStorage.set).not.toHaveBeenCalled();

    secureStorage.value = JSON.stringify({
      version: 1,
      activeAccountKey: null,
      resources: {},
      passports: {},
      signedOutAt: 123,
    });
    await expect(
      reconcileMobileActiveAuthSession({
        readPersistedSession: async () => session,
        writePersistedSession,
        clearPersistedSession,
      }),
    ).resolves.toEqual(expect.objectContaining({ session: null }));
    expect(clearPersistedSession).toHaveBeenCalledTimes(1);
  });

  it('repairs a missing compatibility projection from the active vault', async () => {
    const accountKey = JSON.stringify(['global', metadata.membershipId]);
    secureStorage.value = JSON.stringify({
      version: 1,
      activeAccountKey: accountKey,
      resources: {
        [accountKey]: {
          realm: 'global',
          refreshToken: 'resource-new',
          metadata,
          lastUsedAt: 10,
        },
      },
      passports: {},
    });
    const writePersistedSession = vi.fn(async () => undefined);

    await expect(
      reconcileMobileActiveAuthSession({
        readPersistedSession: async () => null,
        writePersistedSession,
        clearPersistedSession: vi.fn(async () => undefined),
      }),
    ).resolves.toMatchObject({
      session: {
        version: 1,
        realm: 'global',
        refreshToken: 'resource-new',
      },
      refreshCandidates: [
        {
          version: 1,
          realm: 'global',
          refreshToken: 'resource-new',
        },
      ],
    });
    expect(writePersistedSession).toHaveBeenCalledWith(
      'resource-new',
      'global',
    );
  });

  it('does not trust an active key whose resource credential is missing', () => {
    const raw = JSON.stringify({
      version: 1,
      activeAccountKey: 'missing',
      resources: {},
      passports: {},
    });
    expect(parseMobileAccountVault(raw).activeAccountKey).toBeNull();
  });

  it('persists a Passport rotation only while the consumed token is current', async () => {
    secureStorage.value = JSON.stringify({
      version: 1,
      activeAccountKey: null,
      resources: {},
      passports: {
        [JSON.stringify(['global', 'passport-1'])]: {
          realm: 'global',
          passportId: 'passport-1',
          accountRefreshToken: 'refresh-old',
          memberships: [metadata],
        },
      },
    });

    await expect(
      replaceMobilePassportSessionIfCurrent({
        realm: 'global',
        passportId: 'passport-1',
        expectedAccountRefreshToken: 'refresh-old',
        accountRefreshToken: 'refresh-new',
        memberships: [metadata],
      }),
    ).resolves.toBe(true);
    await expect(
      replaceMobilePassportSessionIfCurrent({
        realm: 'global',
        passportId: 'passport-1',
        expectedAccountRefreshToken: 'refresh-old',
        accountRefreshToken: 'refresh-late',
        memberships: [metadata],
      }),
    ).resolves.toBe(false);

    expect(
      parseMobileAccountVault(secureStorage.value).passports[
        JSON.stringify(['global', 'passport-1'])
      ]?.accountRefreshToken,
    ).toBe('refresh-new');
  });

  it('does not delete a Passport generation replaced by another refresh', async () => {
    secureStorage.value = JSON.stringify({
      version: 1,
      activeAccountKey: null,
      resources: {},
      passports: {
        [JSON.stringify(['global', 'passport-1'])]: {
          realm: 'global',
          passportId: 'passport-1',
          accountRefreshToken: 'refresh-new',
          memberships: [metadata],
        },
      },
    });

    await expect(
      removeMobilePassportSessionIfCurrent(
        'global',
        'passport-1',
        'refresh-old',
      ),
    ).resolves.toBe(false);
    expect(parseMobileAccountVault(secureStorage.value).passports).not.toEqual(
      {},
    );

    await expect(
      removeMobilePassportSessionIfCurrent(
        'global',
        'passport-1',
        'refresh-new',
      ),
    ).resolves.toBe(true);
    expect(parseMobileAccountVault(secureStorage.value).passports).toEqual({});
  });

  it('replaces a Resource generation only while its consumed token is current', async () => {
    const accountKey = JSON.stringify(['global', metadata.membershipId]);
    secureStorage.value = JSON.stringify({
      version: 1,
      activeAccountKey: null,
      resources: {
        [accountKey]: {
          realm: 'global',
          refreshToken: 'resource-old',
          metadata,
          lastUsedAt: 10,
        },
      },
      passports: {},
    });
    const pair = {
      accessToken: 'access-new',
      refreshToken: 'resource-new',
      membership: {
        id: metadata.membershipId,
        passportId: metadata.passportId,
        displayName: metadata.displayName,
        email: metadata.email,
        avatarUrl: metadata.avatarUrl,
        kind: metadata.kind,
        role: metadata.role,
        orgId: metadata.orgId,
        orgName: metadata.orgName,
        orgLogoUrl: metadata.orgLogoUrl,
      },
    };

    await expect(
      replaceMobileResourceSessionIfCurrent({
        accountKey,
        expectedRefreshToken: 'resource-old',
        pair,
        realm: 'global',
        passportId: metadata.passportId,
      }),
    ).resolves.toBe('stored');
    await expect(
      replaceMobileResourceSessionIfCurrent({
        accountKey,
        expectedRefreshToken: 'resource-old',
        pair: { ...pair, refreshToken: 'resource-late' },
        realm: 'global',
        passportId: metadata.passportId,
      }),
    ).resolves.toBe('stale');
    expect(
      parseMobileAccountVault(secureStorage.value).resources[accountKey]
        ?.refreshToken,
    ).toBe('resource-new');
  });

  it('preserves an inactive refresh without letting it reclaim the active account', async () => {
    const accountKey = JSON.stringify(['global', metadata.membershipId]);
    const otherAccountKey = JSON.stringify(['global', 'membership-2']);
    const afterPersist = vi.fn(async () => undefined);
    const pair = {
      accessToken: 'access-late',
      refreshToken: 'resource-late',
      membership: {
        id: metadata.membershipId,
        passportId: metadata.passportId,
        displayName: metadata.displayName,
        email: metadata.email,
        avatarUrl: metadata.avatarUrl,
        kind: metadata.kind,
        role: metadata.role,
        orgId: metadata.orgId,
        orgName: metadata.orgName,
        orgLogoUrl: metadata.orgLogoUrl,
      },
    };
    secureStorage.value = JSON.stringify({
      version: 1,
      activeAccountKey: otherAccountKey,
      resources: {
        [accountKey]: {
          realm: 'global',
          refreshToken: 'resource-old',
          metadata,
          lastUsedAt: 10,
        },
        [otherAccountKey]: {
          realm: 'global',
          refreshToken: 'resource-new-login',
          metadata: { ...metadata, membershipId: 'membership-2' },
          lastUsedAt: 20,
        },
      },
      passports: {},
    });

    await expect(
      commitMobileRuntimeResourceSession({
        expectedRefreshToken: 'resource-old',
        pair,
        realm: 'global',
        passportId: metadata.passportId,
        afterPersist,
      }),
    ).resolves.toBe('inactive');
    const vault = parseMobileAccountVault(secureStorage.value);
    expect(vault.activeAccountKey).toBe(otherAccountKey);
    expect(vault.resources[accountKey]?.refreshToken).toBe('resource-late');
    expect(vault.resources[otherAccountKey]?.refreshToken).toBe(
      'resource-new-login',
    );
    expect(afterPersist).not.toHaveBeenCalled();

    secureStorage.value = JSON.stringify({
      version: 1,
      activeAccountKey: accountKey,
      resources: {
        [accountKey]: {
          realm: 'global',
          refreshToken: 'resource-new-login',
          metadata,
          lastUsedAt: 30,
        },
      },
      passports: {},
    });
    await expect(
      commitMobileRuntimeResourceSession({
        expectedRefreshToken: 'resource-old',
        pair,
        realm: 'global',
        passportId: metadata.passportId,
        afterPersist,
      }),
    ).resolves.toBe('stale');
    expect(
      parseMobileAccountVault(secureStorage.value).resources[accountKey]
        ?.refreshToken,
    ).toBe('resource-new-login');
    expect(afterPersist).not.toHaveBeenCalled();

    secureStorage.value = JSON.stringify({
      version: 1,
      activeAccountKey: accountKey,
      resources: {
        [accountKey]: {
          realm: 'global',
          refreshToken: 'resource-old',
          metadata,
          lastUsedAt: 40,
        },
      },
      passports: {},
    });
    await expect(
      commitMobileRuntimeResourceSession({
        expectedRefreshToken: 'resource-old',
        pair,
        realm: 'global',
        passportId: metadata.passportId,
        afterPersist,
      }),
    ).resolves.toBe('active');
    expect(
      parseMobileAccountVault(secureStorage.value).resources[accountKey]
        ?.refreshToken,
    ).toBe('resource-late');
    expect(afterPersist).toHaveBeenCalledTimes(1);
  });

  it('commits a refresh that proves a newer compatibility generation', async () => {
    const accountKey = JSON.stringify(['global', metadata.membershipId]);
    const pair = {
      accessToken: 'access-latest',
      refreshToken: 'resource-latest',
      membership: {
        id: metadata.membershipId,
        passportId: metadata.passportId,
        displayName: metadata.displayName,
        email: metadata.email,
        avatarUrl: metadata.avatarUrl,
        kind: metadata.kind,
        role: metadata.role,
        orgId: metadata.orgId,
        orgName: metadata.orgName,
        orgLogoUrl: metadata.orgLogoUrl,
      },
    };
    secureStorage.value = JSON.stringify({
      version: 1,
      activeAccountKey: accountKey,
      resources: {
        [accountKey]: {
          realm: 'global',
          refreshToken: 'vault-older',
          metadata,
          lastUsedAt: 10,
        },
      },
      passports: {},
    });

    await expect(
      commitMobileRuntimeResourceSession({
        expectedRefreshToken: 'compatibility-newer',
        compatibilityRefreshTokens: ['vault-older'],
        pair,
        realm: 'global',
        passportId: metadata.passportId,
      }),
    ).resolves.toBe('active');
    expect(
      parseMobileAccountVault(secureStorage.value).resources[accountKey]
        ?.refreshToken,
    ).toBe('resource-latest');
  });

  it('does not recreate a runtime Resource after a signed-out tombstone', async () => {
    const pair = {
      accessToken: 'access-late',
      refreshToken: 'resource-late',
      membership: {
        id: metadata.membershipId,
        passportId: metadata.passportId,
        displayName: metadata.displayName,
        email: metadata.email,
        avatarUrl: metadata.avatarUrl,
        kind: metadata.kind,
        role: metadata.role,
        orgId: metadata.orgId,
        orgName: metadata.orgName,
        orgLogoUrl: metadata.orgLogoUrl,
      },
    };
    secureStorage.value = JSON.stringify({
      version: 1,
      activeAccountKey: null,
      resources: {},
      passports: {},
      signedOutAt: 123,
    });

    await expect(
      commitMobileRuntimeResourceSession({
        expectedRefreshToken: 'resource-old',
        pair,
        realm: 'global',
        passportId: metadata.passportId,
      }),
    ).resolves.toBe('stale');
    expect(parseMobileAccountVault(secureStorage.value)).toEqual(
      expect.objectContaining({
        activeAccountKey: null,
        resources: {},
        signedOutAt: 123,
      }),
    );
  });

  it('does not delete a Resource generation replaced by a later login', async () => {
    const accountKey = JSON.stringify(['global', metadata.membershipId]);
    secureStorage.value = JSON.stringify({
      version: 1,
      activeAccountKey: accountKey,
      resources: {
        [accountKey]: {
          realm: 'global',
          refreshToken: 'resource-new-login',
          metadata,
          lastUsedAt: 20,
        },
      },
      passports: {},
    });

    await expect(
      removeMobileResourceSessionIfCurrent({
        accountKey,
        expectedRefreshToken: 'resource-old-request',
      }),
    ).resolves.toBe('stale');
    expect(
      parseMobileAccountVault(secureStorage.value).resources[accountKey]
        ?.refreshToken,
    ).toBe('resource-new-login');

    await expect(
      removeMobileResourceSessionIfCurrent({
        accountKey,
        expectedRefreshToken: 'resource-new-login',
      }),
    ).resolves.toBe('removed');
    expect(parseMobileAccountVault(secureStorage.value).resources).toEqual({});
  });

  it('does not overwrite saved credentials when SecureStore cannot be read', async () => {
    const original = JSON.stringify({
      version: 1,
      activeAccountKey: null,
      resources: {},
      passports: { passport: { accountRefreshToken: 'keep-me' } },
    });
    secureStorage.value = original;
    secureStorage.readError = new Error('keychain temporarily unavailable');

    await expect(
      mutateMobileAccountVault((vault) => {
        vault.passports = {};
      }),
    ).rejects.toThrow('keychain temporarily unavailable');

    await expect(
      commitMobileLoginSessions(
        {
          pair: {
            accessToken: 'access',
            refreshToken: 'resource-refresh',
            membership: {
              id: metadata.membershipId,
              passportId: metadata.passportId,
              displayName: metadata.displayName,
              email: metadata.email,
              avatarUrl: metadata.avatarUrl,
              kind: metadata.kind,
              role: metadata.role,
              orgId: metadata.orgId,
              orgName: metadata.orgName,
              orgLogoUrl: metadata.orgLogoUrl,
            },
          },
          realm: 'global',
          passportId: metadata.passportId,
          accountRefreshToken: null,
          memberships: [metadata],
        },
        async () => undefined,
      ),
    ).rejects.toThrow('keychain temporarily unavailable');

    expect(secureStorage.value).toBe(original);
    expect(secureStorage.set).not.toHaveBeenCalled();
  });

  it('does not overwrite saved credentials when encrypted content is malformed', async () => {
    secureStorage.value = '{bad-json';

    await expect(
      mutateMobileAccountVault((vault) => {
        vault.passports = {};
      }),
    ).rejects.toThrow();

    expect(secureStorage.value).toBe('{bad-json');
    expect(secureStorage.set).not.toHaveBeenCalled();
  });

  it('lets a completed explicit login recover malformed content with exact rollback', async () => {
    const malformed = '{bad-json';
    const input = {
      pair: {
        accessToken: 'access',
        refreshToken: 'resource-refresh',
        membership: {
          id: metadata.membershipId,
          passportId: metadata.passportId,
          displayName: metadata.displayName,
          email: metadata.email,
          avatarUrl: metadata.avatarUrl,
          kind: metadata.kind,
          role: metadata.role,
          orgId: metadata.orgId,
          orgName: metadata.orgName,
          orgLogoUrl: metadata.orgLogoUrl,
        },
      },
      realm: 'global' as const,
      passportId: metadata.passportId,
      accountRefreshToken: 'account-refresh',
      memberships: [metadata],
    };
    secureStorage.value = malformed;

    await expect(
      commitMobileLoginSessions(input, async () => {
        throw new Error('owner commit failed');
      }),
    ).rejects.toThrow('owner commit failed');
    expect(secureStorage.value).toBe(malformed);

    await commitMobileLoginSessions(input, async () => undefined);

    const recovered = parseMobileAccountVault(secureStorage.value);
    const accountKey = JSON.stringify(['global', metadata.membershipId]);
    expect(recovered.activeAccountKey).toBe(accountKey);
    expect(recovered.resources[accountKey]?.refreshToken).toBe('resource-refresh');
    expect(recovered.passports).toEqual(
      expect.objectContaining({
        [JSON.stringify(['global', metadata.passportId])]: expect.objectContaining({
          accountRefreshToken: 'account-refresh',
        }),
      }),
    );
  });

  it('preserves valid vault children while explicit login filters a damaged child', async () => {
    const existingKey = JSON.stringify(['global', metadata.membershipId]);
    const newMetadata = {
      ...metadata,
      membershipId: 'membership-2',
      passportId: 'passport-2',
      displayName: 'Second Account',
    };
    secureStorage.value = JSON.stringify({
      version: 1,
      activeAccountKey: existingKey,
      resources: {
        [existingKey]: {
          realm: 'global',
          refreshToken: 'existing-refresh',
          metadata,
          lastUsedAt: 10,
        },
        damaged: { realm: 'global', refreshToken: 'damaged-refresh' },
      },
      passports: {},
    });

    await commitMobileLoginSessions(
      {
        pair: {
          accessToken: 'new-access',
          refreshToken: 'new-refresh',
          membership: {
            id: newMetadata.membershipId,
            passportId: newMetadata.passportId,
            displayName: newMetadata.displayName,
            email: newMetadata.email,
            avatarUrl: newMetadata.avatarUrl,
            kind: newMetadata.kind,
            role: newMetadata.role,
            orgId: newMetadata.orgId,
            orgName: newMetadata.orgName,
            orgLogoUrl: newMetadata.orgLogoUrl,
          },
        },
        realm: 'global',
        passportId: newMetadata.passportId,
        accountRefreshToken: null,
        memberships: [newMetadata],
      },
      async () => undefined,
    );

    const recovered = parseMobileAccountVault(secureStorage.value);
    const newKey = JSON.stringify(['global', newMetadata.membershipId]);
    expect(recovered.resources[existingKey]?.refreshToken).toBe('existing-refresh');
    expect(recovered.resources[newKey]?.refreshToken).toBe('new-refresh');
    expect(recovered.resources.damaged).toBeUndefined();
  });

  it('does not rewrite a vault containing a damaged resource child', async () => {
    const original = JSON.stringify({
      version: 1,
      activeAccountKey: null,
      resources: {
        damaged: { realm: 'global', refreshToken: 'must-not-be-deleted' },
      },
      passports: {},
    });
    secureStorage.value = original;

    await expect(
      mutateMobileAccountVault((vault) => {
        vault.activeAccountKey = null;
      }),
    ).rejects.toThrow('Saved resource credential could not be read safely');

    expect(secureStorage.value).toBe(original);
    expect(secureStorage.set).not.toHaveBeenCalled();
  });

  it('does not rewrite a Passport containing damaged membership metadata', async () => {
    const original = JSON.stringify({
      version: 1,
      activeAccountKey: null,
      resources: {},
      passports: {
        passport: {
          realm: 'global',
          passportId: 'passport-1',
          accountRefreshToken: 'must-not-be-deleted',
          memberships: [metadata, { membershipId: 'damaged' }],
        },
      },
    });
    secureStorage.value = original;

    await expect(
      mutateMobileAccountVault((vault) => {
        vault.activeAccountKey = null;
      }),
    ).rejects.toThrow('Saved Passport membership could not be read safely');

    expect(secureStorage.value).toBe(original);
    expect(secureStorage.set).not.toHaveBeenCalled();
  });

  it('rolls the exact vault snapshot back before releasing a failed transaction', async () => {
    const original = JSON.stringify({
      version: 1,
      activeAccountKey: null,
      resources: {},
      passports: {},
    });
    secureStorage.value = original;

    await expect(
      transactMobileAccountVault(
        (vault) => {
          vault.resources.added = {
            realm: 'global',
            refreshToken: 'cancelled-resource',
            metadata,
            lastUsedAt: 20,
          };
        },
        async () => {
          throw new Error('AUTH_FLOW_SUPERSEDED');
        },
      ),
    ).rejects.toThrow('AUTH_FLOW_SUPERSEDED');

    expect(secureStorage.value).toBe(original);
    expect(secureStorage.set).toHaveBeenCalledTimes(2);
  });

  it('commits Passport, resource, and active account in one vault transaction', async () => {
    const afterPersist = vi.fn(async () => undefined);
    await commitMobileLoginSessions(
      {
        pair: {
          accessToken: 'access',
          refreshToken: 'resource-refresh',
          membership: {
            id: metadata.membershipId,
            passportId: metadata.passportId,
            displayName: metadata.displayName,
            email: metadata.email,
            avatarUrl: metadata.avatarUrl,
            kind: metadata.kind,
            role: metadata.role,
            orgId: metadata.orgId,
            orgName: metadata.orgName,
            orgLogoUrl: metadata.orgLogoUrl,
          },
        },
        realm: 'global',
        passportId: metadata.passportId,
        accountRefreshToken: 'account-refresh',
        memberships: [metadata],
      },
      afterPersist,
    );

    const vault = parseMobileAccountVault(secureStorage.value);
    const accountKey = JSON.stringify(['global', metadata.membershipId]);
    expect(vault.activeAccountKey).toBe(accountKey);
    expect(vault.resources[accountKey]?.refreshToken).toBe('resource-refresh');
    expect(
      vault.passports[JSON.stringify(['global', metadata.passportId])]
        ?.accountRefreshToken,
    ).toBe('account-refresh');
    expect(afterPersist).toHaveBeenCalledTimes(1);
    expect(secureStorage.set).toHaveBeenCalledTimes(1);
  });

  it('restores the previous active account when runtime commit is superseded', async () => {
    const oldKey = JSON.stringify(['global', metadata.membershipId]);
    const targetKey = JSON.stringify(['global', 'membership-2']);
    const original = JSON.stringify({
      version: 1,
      activeAccountKey: oldKey,
      resources: {
        [oldKey]: {
          realm: 'global',
          refreshToken: 'old-refresh',
          metadata,
          lastUsedAt: 10,
        },
        [targetKey]: {
          realm: 'global',
          refreshToken: 'target-refresh',
          metadata: { ...metadata, membershipId: 'membership-2' },
          lastUsedAt: 20,
        },
      },
      passports: {},
    });
    secureStorage.value = original;

    await expect(
      commitMobileSavedAccountActivation(targetKey, async () => {
        throw new Error('AUTH_FLOW_SUPERSEDED');
      }),
    ).rejects.toThrow('AUTH_FLOW_SUPERSEDED');

    expect(secureStorage.value).toBe(original);
    expect(secureStorage.set).toHaveBeenCalledTimes(2);
  });

  it('keeps a signed-out tombstone and restores the vault if session deletion fails', async () => {
    const original = JSON.stringify({
      version: 1,
      activeAccountKey: null,
      resources: {},
      passports: {},
    });
    secureStorage.value = original;

    await expect(
      clearMobileAccountVault(async () => {
        throw new Error('keychain delete failed');
      }),
    ).rejects.toThrow('keychain delete failed');
    expect(secureStorage.value).toBe(original);

    await clearMobileAccountVault();
    expect(parseMobileAccountVault(secureStorage.value).signedOutAt).toEqual(
      expect.any(Number),
    );
  });

  it('lets explicit logout replace a malformed vault without parsing it', async () => {
    const malformed = '{bad-json';
    secureStorage.value = malformed;

    await expect(clearMobileAccountVault()).resolves.toBeUndefined();
    expect(parseMobileAccountVault(secureStorage.value)).toMatchObject({
      activeAccountKey: null,
      passports: {},
      resources: {},
      signedOutAt: expect.any(Number),
    });

    secureStorage.value = malformed;
    await expect(
      clearMobileAccountVault(async () => {
        throw new Error('session delete failed');
      }),
    ).rejects.toThrow('session delete failed');
    expect(secureStorage.value).toBe(malformed);
  });

  it('rolls vault and compatibility session back when receipt deletion fails', async () => {
    const originalVault = JSON.stringify({
      version: 1,
      activeAccountKey: null,
      resources: {},
      passports: {},
    });
    secureStorage.value = originalVault;
    let sessionRaw: string | null = 'original-session';
    const clearReceipt = vi.fn(async () => {
      throw new Error('receipt delete failed');
    });

    await expect(
      clearMobileLoginCredentialsForLogout({
        readSessionRaw: async () => sessionRaw,
        clearSession: async () => {
          sessionRaw = null;
        },
        restoreSessionRaw: async (raw) => {
          sessionRaw = raw;
        },
        clearReceipt,
      }),
    ).rejects.toThrow('receipt delete failed');

    expect(secureStorage.value).toBe(originalVault);
    expect(sessionRaw).toBe('original-session');
    expect(clearReceipt).toHaveBeenCalledOnce();
  });

  it('commits vault, compatibility session, and receipt clearing together', async () => {
    secureStorage.value = JSON.stringify({
      version: 1,
      activeAccountKey: null,
      resources: {},
      passports: {},
    });
    let sessionRaw: string | null = 'original-session';
    const clearReceipt = vi.fn(async () => undefined);

    await clearMobileLoginCredentialsForLogout({
      readSessionRaw: async () => sessionRaw,
      clearSession: async () => {
        sessionRaw = null;
      },
      restoreSessionRaw: async (raw) => {
        sessionRaw = raw;
      },
      clearReceipt,
    });

    expect(parseMobileAccountVault(secureStorage.value).signedOutAt).toEqual(
      expect.any(Number),
    );
    expect(sessionRaw).toBeNull();
    expect(clearReceipt).toHaveBeenCalledOnce();
  });
});
