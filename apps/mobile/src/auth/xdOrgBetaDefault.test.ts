import { describe, expect, it } from 'vitest';

import {
  isXdOrgUser,
  maybeEnableXdOrgBetaDefault,
  type XdOrgBetaDefaultDeps,
  type XdOrgBetaUser,
} from './xdOrgBetaDefault';

const XD_USER: XdOrgBetaUser = {
  membershipKind: 'org',
  orgSlug: 'xd',
  orgName: '心动网络',
};

function deps(
  overrides: Partial<XdOrgBetaDefaultDeps> = {},
): XdOrgBetaDefaultDeps {
  return {
    readCurrentAuthIdentity: () => ({ authGeneration: 3, userId: 'user-1' }),
    readChannelState: () => ({ enableBeta: false, isCustomized: false }),
    probeBetaManifest: async () => true,
    enableBeta: async () => true,
    ...overrides,
  };
}

describe('xd org beta default', () => {
  it('orgSlug 是权威身份，只在缺失时回退组织名', () => {
    expect(isXdOrgUser(XD_USER)).toBe(true);
    expect(isXdOrgUser({ ...XD_USER, orgSlug: 'other' })).toBe(false);
    expect(isXdOrgUser({ ...XD_USER, orgSlug: null, orgName: ' XD ' })).toBe(true);
    expect(isXdOrgUser({ ...XD_USER, membershipKind: 'personal' })).toBe(false);
  });

  it('当前未自定义的 xd 身份且 beta 可用时开启', async () => {
    await expect(
      maybeEnableXdOrgBetaDefault(
        { expectedAuthGeneration: 3, expectedUserId: 'user-1', user: XD_USER },
        deps(),
      ),
    ).resolves.toEqual({ kind: 'enabled' });
  });

  it('保留用户 opt-out，并拒绝迟到身份', async () => {
    await expect(
      maybeEnableXdOrgBetaDefault(
        { expectedAuthGeneration: 3, expectedUserId: 'user-1', user: XD_USER },
        deps({ readChannelState: () => ({ enableBeta: false, isCustomized: true }) }),
      ),
    ).resolves.toEqual({ kind: 'skipped', reason: 'user-customized' });

    await expect(
      maybeEnableXdOrgBetaDefault(
        { expectedAuthGeneration: 3, expectedUserId: 'user-1', user: XD_USER },
        deps({
          readCurrentAuthIdentity: () => ({ authGeneration: 4, userId: 'user-2' }),
        }),
      ),
    ).resolves.toEqual({ kind: 'skipped', reason: 'stale-auth' });
  });
});
