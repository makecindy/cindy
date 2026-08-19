import { describe, expect, it, vi } from 'vitest';

import {
  isXdOrgUser,
  maybeEnableXdOrgBetaDefault,
  maybeEnableNonXdOrgBetaDefault,
  shouldAttemptOrgBetaDefault,
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
    expect(isXdOrgUser({ ...XD_USER, orgSlug: null, orgName: ' XD ' })).toBe(
      true,
    );
    expect(isXdOrgUser({ ...XD_USER, membershipKind: 'personal' })).toBe(false);
  });

  it('xd 永远走老逻辑，非 xd 只有 flag=true 才尝试', () => {
    expect(
      shouldAttemptOrgBetaDefault({ user: XD_USER, defaultEnableBeta: false }),
    ).toBe('xd-legacy');
    expect(
      shouldAttemptOrgBetaDefault({
        user: { ...XD_USER, orgSlug: 'other' },
        defaultEnableBeta: true,
      }),
    ).toBe('flag-enable');
    expect(
      shouldAttemptOrgBetaDefault({ user: { ...XD_USER, orgSlug: 'other' } }),
    ).toBe('skip');
    expect(shouldAttemptOrgBetaDefault({ user: XD_USER })).toBe('xd-legacy');
    expect(
      shouldAttemptOrgBetaDefault({
        user: { ...XD_USER, membershipKind: 'personal' },
        defaultEnableBeta: true,
      }),
    ).toBe('skip');
  });

  it('非 xd 在 feature flag 允许时复用默认写盘路径', async () => {
    await expect(
      maybeEnableNonXdOrgBetaDefault(
        {
          expectedAuthGeneration: 3,
          expectedUserId: 'user-1',
          user: { ...XD_USER, orgSlug: 'other' },
        },
        deps(),
      ),
    ).resolves.toEqual({ kind: 'enabled' });
  });

  it.each([
    ['false', false],
    ['missing', undefined],
    ['string', 'true' as unknown as boolean],
    ['number', 1 as unknown as boolean],
  ])('非 xd + %s 走 skip', (_label, defaultEnableBeta) => {
    expect(
      shouldAttemptOrgBetaDefault({
        user: { ...XD_USER, orgSlug: 'other' },
        defaultEnableBeta,
      }),
    ).toBe('skip');
  });

  it('非 xd 已自定义时不 probe、不写盘', async () => {
    const probeBetaManifest = vi.fn(async () => true);
    const enableBeta = vi.fn(async () => true);
    await expect(
      maybeEnableNonXdOrgBetaDefault(
        {
          expectedAuthGeneration: 3,
          expectedUserId: 'user-1',
          user: { ...XD_USER, orgSlug: 'other' },
        },
        deps({
          readChannelState: () => ({ enableBeta: false, isCustomized: true }),
          probeBetaManifest,
          enableBeta,
        }),
      ),
    ).resolves.toEqual({ kind: 'skipped', reason: 'user-customized' });
    expect(probeBetaManifest).not.toHaveBeenCalled();
    expect(enableBeta).not.toHaveBeenCalled();
  });

  it('非 xd stale-auth 时不写盘', async () => {
    const enableBeta = vi.fn(async () => true);
    await expect(
      maybeEnableNonXdOrgBetaDefault(
        {
          expectedAuthGeneration: 3,
          expectedUserId: 'user-1',
          user: { ...XD_USER, orgSlug: 'other' },
        },
        deps({
          readCurrentAuthIdentity: () => ({
            authGeneration: 4,
            userId: 'user-2',
          }),
          enableBeta,
        }),
      ),
    ).resolves.toEqual({ kind: 'skipped', reason: 'stale-auth' });
    expect(enableBeta).not.toHaveBeenCalled();
  });

  it.each([false, 'throw'])(
    '非 xd manifest 不可用时不写盘: %s',
    async (mode) => {
      const probeBetaManifest = vi.fn(
        mode === 'throw'
          ? async () => {
              throw new Error('offline');
            }
          : async () => false,
      );
      const enableBeta = vi.fn(async () => true);
      await expect(
        maybeEnableNonXdOrgBetaDefault(
          {
            expectedAuthGeneration: 3,
            expectedUserId: 'user-1',
            user: { ...XD_USER, orgSlug: 'other' },
          },
          deps({ probeBetaManifest, enableBeta }),
        ),
      ).resolves.toEqual({ kind: 'skipped', reason: 'beta-unavailable' });
      expect(enableBeta).not.toHaveBeenCalled();
    },
  );

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
        deps({
          readChannelState: () => ({ enableBeta: false, isCustomized: true }),
        }),
      ),
    ).resolves.toEqual({ kind: 'skipped', reason: 'user-customized' });

    await expect(
      maybeEnableXdOrgBetaDefault(
        { expectedAuthGeneration: 3, expectedUserId: 'user-1', user: XD_USER },
        deps({
          readCurrentAuthIdentity: () => ({
            authGeneration: 4,
            userId: 'user-2',
          }),
        }),
      ),
    ).resolves.toEqual({ kind: 'skipped', reason: 'stale-auth' });
  });
});
