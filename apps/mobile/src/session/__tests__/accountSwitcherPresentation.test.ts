import { describe, expect, it } from 'vitest';

import { presentSavedAccount } from '../accountSwitcherPresentation';

const base = {
  accountKey: 'account-key',
  realm: 'global' as const,
  isCurrent: false,
  lastUsedAt: 0,
  membershipId: 'membership-1',
  passportId: 'passport-1',
  displayName: 'Cao Jianbo',
  email: 'cao@example.com',
  avatarUrl: 'https://example.com/user.png',
  role: 'member' as const,
  orgId: null,
  orgName: null,
  orgLogoUrl: null,
};

describe('account switcher presentation', () => {
  it('shows organization name above username and uses the organization logo', () => {
    expect(
      presentSavedAccount({
        ...base,
        kind: 'org',
        orgId: 'org-1',
        orgName: 'Cindy',
        orgLogoUrl: 'https://example.com/org.png',
      }),
    ).toEqual({
      isOrg: true,
      imageUrl: 'https://example.com/org.png',
      title: 'Cindy',
      subtitle: 'Cao Jianbo',
    });
  });

  it('shows a personal name above email and uses the personal avatar', () => {
    expect(presentSavedAccount({ ...base, kind: 'personal' })).toEqual({
      isOrg: false,
      imageUrl: 'https://example.com/user.png',
      title: 'Cao Jianbo',
      subtitle: 'cao@example.com',
    });
  });
});
