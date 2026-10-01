import { describe, expect, it } from 'vitest';

import { canAccessCindyMakeSettings } from '../cindyMakeVisibility';

describe('cindyMakeVisibility', () => {
  it('shows the settings tab only in development builds', () => {
    expect(canAccessCindyMakeSettings(true)).toBe(true);
    expect(canAccessCindyMakeSettings(false)).toBe(false);
  });
  it('keeps version management accessible in a packaged personal version', () => {
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
    expect(canAccessCindyMakeSettings(false, state)).toBe(true);
    expect(canAccessCindyMakeSettings(false, { ...state, currentId: 'original' })).toBe(false);
    expect(canAccessCindyMakeSettings(false, { ...state, versions: [original] })).toBe(true);
  });
  it('shows the packaged beta entry only to the XD organization', () => {
    const xdOrgUser = {
      membershipKind: 'org' as const,
      orgSlug: 'xd',
      orgName: '心动网络',
    };
    const otherOrgUser = { ...xdOrgUser, orgSlug: 'other-org' };

    expect(canAccessCindyMakeSettings(false, undefined, true, xdOrgUser)).toBe(true);
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
