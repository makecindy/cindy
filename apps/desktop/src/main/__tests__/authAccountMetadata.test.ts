import { describe, expect, it } from 'vitest';

import { reconcileSavedAccountMetadata, type StoredAccountMetadata } from '../authAccountMetadata';

function metadata(
  membershipId: string,
  passportId: string,
  displayName: string,
  avatarUrl: string | null,
): StoredAccountMetadata {
  return {
    membershipId,
    passportId,
    displayName,
    email: `${membershipId}@example.com`,
    avatarUrl,
    kind: 'personal',
    role: 'owner',
    orgId: null,
    orgName: null,
    orgLogoUrl: null,
  };
}

describe('saved account metadata reconciliation', () => {
  it('patches the matching resource and Passport entry after a profile edit', () => {
    const stale = metadata('membership-1', 'passport-1', 'Old name', 'old-avatar');
    const sibling = metadata('membership-2', 'passport-2', 'Sibling', null);
    const vault = {
      resources: {
        current: { realm: 'global' as const, metadata: stale },
        sibling: { realm: 'global' as const, metadata: sibling },
      },
      passports: {
        current: {
          realm: 'global' as const,
          passportId: 'passport-1',
          memberships: [stale],
        },
        sibling: {
          realm: 'global' as const,
          passportId: 'passport-2',
          memberships: [sibling],
        },
      },
    };
    const latest = metadata('membership-1', 'passport-1', 'New name', 'new-avatar');

    expect(
      reconcileSavedAccountMetadata(vault, {
        realm: 'global',
        passportId: 'passport-1',
        memberships: [latest],
        passportMode: 'patch-known',
      }),
    ).toBe(true);
    expect(vault.resources.current.metadata).toBe(latest);
    expect(vault.passports.current.memberships).toEqual([latest]);
    expect(vault.resources.sibling.metadata).toBe(sibling);
    expect(vault.passports.sibling.memberships).toEqual([sibling]);
  });

  it('uses an authoritative Passport sync to refresh resource metadata without crossing realms', () => {
    const stale = metadata('membership-1', 'passport-1', 'Old name', 'old-avatar');
    const cnStale = metadata('membership-1', 'passport-1', 'CN name', 'cn-avatar');
    const vault = {
      resources: {
        global: {
          realm: 'global' as const,
          refreshToken: 'resource-refresh-token',
          metadata: stale,
        },
        cn: { realm: 'cn' as const, metadata: cnStale },
      },
      passports: {
        global: {
          realm: 'global' as const,
          passportId: 'passport-1',
          accountRefreshToken: 'account-refresh-token',
          memberships: [stale],
        },
        cn: {
          realm: 'cn' as const,
          passportId: 'passport-1',
          memberships: [cnStale],
        },
      },
    };
    const latest = metadata('membership-1', 'passport-1', 'Synced name', 'synced-avatar');
    const added = metadata('membership-3', 'passport-1', 'New membership', null);

    reconcileSavedAccountMetadata(vault, {
      realm: 'global',
      passportId: 'passport-1',
      memberships: [latest, added],
      passportMode: 'replace-passport',
    });

    expect(vault.resources.global.metadata).toBe(latest);
    expect(vault.passports.global.memberships).toEqual([latest, added]);
    expect(vault.resources.global.refreshToken).toBe('resource-refresh-token');
    expect(vault.passports.global.accountRefreshToken).toBe('account-refresh-token');
    expect(vault.resources.cn.metadata).toBe(cnStale);
    expect(vault.passports.cn.memberships).toEqual([cnStale]);
  });

  it('does not add an unknown membership during a profile-edit patch', () => {
    const known = metadata('membership-1', 'passport-1', 'Known', null);
    const vault = {
      resources: {},
      passports: {
        current: {
          realm: 'global' as const,
          passportId: 'passport-1',
          memberships: [known],
        },
      },
    };

    expect(
      reconcileSavedAccountMetadata(vault, {
        realm: 'global',
        passportId: 'passport-1',
        memberships: [metadata('unknown', 'passport-1', 'Unknown', null)],
        passportMode: 'patch-known',
      }),
    ).toBe(false);
    expect(vault.passports.current.memberships).toEqual([known]);
  });
});
