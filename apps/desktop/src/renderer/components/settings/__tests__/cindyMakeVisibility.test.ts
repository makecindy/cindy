import { describe, expect, it } from 'vitest';

import { canAccessCindyMakeSettings } from '../cindyMakeVisibility';

describe('cindyMakeVisibility', () => {
  it('keeps the settings entry unavailable in every build', () => {
    expect(canAccessCindyMakeSettings(true)).toBe(false);
    const personal = {
      id: 'personal-1',
      kind: 'personal' as const,
      available: true,
      compatible: true,
    };
    const original = { ...personal, id: 'original', kind: 'original' as const };
    const state = {
      currentId: personal.id,
      selectedId: personal.id,
      switching: false,
      versions: [original, personal],
    };
    expect(canAccessCindyMakeSettings(true, state, true, {
      membershipKind: 'org',
      orgSlug: 'xd',
      orgName: '心动网络',
    })).toBe(false);
    expect(canAccessCindyMakeSettings(false, { ...state, currentId: 'original' })).toBe(false);
    expect(canAccessCindyMakeSettings(false, { ...state, versions: [original] })).toBe(false);
  });
  it('keeps packaged beta hidden for organization and personal accounts', () => {
    const xdOrgUser = {
      membershipKind: 'org' as const,
      orgSlug: 'xd',
      orgName: '心动网络',
    };
    const otherOrgUser = { ...xdOrgUser, orgSlug: 'other-org' };

    expect(canAccessCindyMakeSettings(false, undefined, true, xdOrgUser)).toBe(false);
    expect(canAccessCindyMakeSettings(false, undefined, true, otherOrgUser)).toBe(false);
    expect(
      canAccessCindyMakeSettings(false, undefined, true, {
        ...xdOrgUser,
        membershipKind: 'personal',
      }),
    ).toBe(false);
    expect(canAccessCindyMakeSettings(false, undefined, false, xdOrgUser)).toBe(false);
  });
});
