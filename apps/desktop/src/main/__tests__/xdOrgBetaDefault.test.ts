import { describe, expect, it, vi } from 'vitest';

import {
  isXdOrgUser,
  maybeEnableXdOrgBetaDefault,
  maybeEnableNonXdOrgBetaDefault,
  shouldAttemptOrgBetaDefault,
  type XdOrgBetaDefaultDeps,
  type XdOrgBetaDefaultRequest,
  type XdOrgBetaUser,
} from '../xdOrgBetaDefault';

const REQUEST: XdOrgBetaDefaultRequest = {
  expectedAuthEpoch: 7,
  expectedUserId: 'user-1',
  user: {
    membershipKind: 'org',
    orgSlug: 'xd',
    orgName: '心动网络',
  },
};

function user(overrides: Partial<XdOrgBetaUser> = {}): XdOrgBetaUser {
  return {
    membershipKind: 'org',
    orgSlug: 'xd',
    orgName: '心动网络',
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<{
    authEpoch: number;
    userId: string | null;
    enableBeta: boolean;
    isCustomized: boolean;
    available: boolean;
    probeThrows: boolean;
  }> = {},
): XdOrgBetaDefaultDeps & {
  enableBeta: ReturnType<typeof vi.fn>;
  probeBetaManifest: ReturnType<typeof vi.fn>;
} {
  return {
    readCurrentAuthIdentity: vi.fn(() => ({
      authEpoch: overrides.authEpoch ?? REQUEST.expectedAuthEpoch,
      userId: overrides.userId === undefined ? REQUEST.expectedUserId : overrides.userId,
    })),
    readChannelState: vi.fn(() => ({
      enableBeta: overrides.enableBeta === true,
      isCustomized: overrides.isCustomized === true,
    })),
    probeBetaManifest: overrides.probeThrows
      ? vi.fn().mockRejectedValue(new Error('offline'))
      : vi.fn().mockResolvedValue(overrides.available !== false),
    enableBeta: vi.fn().mockResolvedValue(true),
  };
}

describe('isXdOrgUser', () => {
  it('allows xd org members by orgSlug', () => {
    expect(isXdOrgUser(user({ orgSlug: 'xd', orgName: '心动网络' }))).toBe(true);
  });

  it('denies non-xd slugs even when the display name looks like xd', () => {
    expect(isXdOrgUser(user({ orgSlug: 'disco-corp', orgName: '心动网络' }))).toBe(false);
    expect(isXdOrgUser(user({ orgSlug: 'xd-partner', orgName: 'xd' }))).toBe(false);
  });

  it('falls back to orgName only when orgSlug is missing', () => {
    expect(isXdOrgUser(user({ orgSlug: null, orgName: 'xd' }))).toBe(true);
    expect(isXdOrgUser(user({ orgSlug: null, orgName: ' XD ' }))).toBe(true);
    expect(isXdOrgUser(user({ orgSlug: null, orgName: '心动网络' }))).toBe(true);
    expect(isXdOrgUser(user({ orgSlug: null, orgName: 'Disco Corp' }))).toBe(false);
  });

  it('denies personal accounts and missing login state', () => {
    expect(isXdOrgUser(user({ membershipKind: 'personal', orgSlug: 'xd' }))).toBe(false);
    expect(isXdOrgUser(null)).toBe(false);
  });

});

describe('shouldAttemptOrgBetaDefault', () => {
  it.each([
    ['false', false],
    ['missing', undefined],
    ['string', 'true' as unknown as boolean],
    ['number', 1 as unknown as boolean],
  ])('非 xd + %s 走 skip', (_label, defaultEnableBeta) => {
    expect(
      shouldAttemptOrgBetaDefault({
        user: user({ orgSlug: 'other' }),
        defaultEnableBeta,
      }),
    ).toBe('skip');
  });

  it('非 xd 只有 flag=true 才尝试，xd 无论 flag 都走老逻辑', () => {
    expect(shouldAttemptOrgBetaDefault({ user: user(), defaultEnableBeta: false })).toBe(
      'xd-legacy',
    );
    expect(shouldAttemptOrgBetaDefault({ user: user(), defaultEnableBeta: true })).toBe(
      'xd-legacy',
    );
    expect(
      shouldAttemptOrgBetaDefault({ user: user({ orgSlug: 'other' }), defaultEnableBeta: true }),
    ).toBe('flag-enable');
    expect(shouldAttemptOrgBetaDefault({ user: user() })).toBe('xd-legacy');
    expect(
      shouldAttemptOrgBetaDefault({
        user: user({ membershipKind: 'personal', orgSlug: 'xd' }),
        defaultEnableBeta: true,
      }),
    ).toBe('skip');
  });
});

describe('maybeEnableXdOrgBetaDefault', () => {
  it('enables beta for an unused xd-org device after the probe succeeds', async () => {
    const deps = makeDeps();

    await expect(maybeEnableXdOrgBetaDefault(REQUEST, deps)).resolves.toEqual({ kind: 'enabled' });
    expect(deps.probeBetaManifest).toHaveBeenCalledOnce();
    expect(deps.enableBeta).toHaveBeenCalledOnce();
  });

  it('does not reopen beta after the user customized the switch off', async () => {
    const deps = makeDeps({ isCustomized: true, enableBeta: false });

    await expect(maybeEnableXdOrgBetaDefault(REQUEST, deps)).resolves.toEqual({
      kind: 'skipped',
      reason: 'user-customized',
    });
    expect(deps.probeBetaManifest).not.toHaveBeenCalled();
    expect(deps.enableBeta).not.toHaveBeenCalled();
  });

  it('skips non-xd accounts without probing', async () => {
    const deps = makeDeps();

    await expect(
      maybeEnableXdOrgBetaDefault(
        { ...REQUEST, user: user({ orgSlug: 'other', orgName: 'Other' }) },
        deps,
      ),
    ).resolves.toEqual({ kind: 'skipped', reason: 'not-xd-org' });
    expect(deps.probeBetaManifest).not.toHaveBeenCalled();
    expect(deps.enableBeta).not.toHaveBeenCalled();
  });

  it('enables beta for non-xd accounts only when feature flag allows it', async () => {
    const deps = makeDeps();
    await expect(
      maybeEnableNonXdOrgBetaDefault(
        { ...REQUEST, user: user({ orgSlug: 'other', orgName: 'Other' }) },
        deps,
      ),
    ).resolves.toEqual({ kind: 'enabled' });
    expect(deps.enableBeta).toHaveBeenCalledOnce();
  });

  it('non-xd rejects customized devices before probing or writing', async () => {
    const deps = makeDeps({ isCustomized: true });
    await expect(
      maybeEnableNonXdOrgBetaDefault(
        { ...REQUEST, user: user({ orgSlug: 'other', orgName: 'Other' }) },
        deps,
      ),
    ).resolves.toEqual({ kind: 'skipped', reason: 'user-customized' });
    expect(deps.probeBetaManifest).not.toHaveBeenCalled();
    expect(deps.enableBeta).not.toHaveBeenCalled();
  });

  it('non-xd rejects stale auth before writing', async () => {
    const deps = makeDeps({ authEpoch: REQUEST.expectedAuthEpoch + 1 });
    await expect(
      maybeEnableNonXdOrgBetaDefault(
        { ...REQUEST, user: user({ orgSlug: 'other', orgName: 'Other' }) },
        deps,
      ),
    ).resolves.toEqual({ kind: 'skipped', reason: 'stale-auth' });
    expect(deps.enableBeta).not.toHaveBeenCalled();
  });

  it.each([{ available: false }, { probeThrows: true }])(
    'non-xd rejects unavailable manifest without writing: %j',
    async (overrides) => {
      const deps = makeDeps(overrides);
      await expect(
        maybeEnableNonXdOrgBetaDefault(
          { ...REQUEST, user: user({ orgSlug: 'other', orgName: 'Other' }) },
          deps,
        ),
      ).resolves.toEqual({ kind: 'skipped', reason: 'beta-unavailable' });
      expect(deps.enableBeta).not.toHaveBeenCalled();
    },
  );

  it('skips when beta is already on', async () => {
    const deps = makeDeps({ enableBeta: true, isCustomized: true });

    await expect(maybeEnableXdOrgBetaDefault(REQUEST, deps)).resolves.toEqual({
      kind: 'skipped',
      reason: 'already-enabled',
    });
    expect(deps.probeBetaManifest).not.toHaveBeenCalled();
    expect(deps.enableBeta).not.toHaveBeenCalled();
  });

  it.each([{ available: false }, { probeThrows: true }])(
    'skips when the beta manifest is unavailable: %j',
    async (overrides) => {
      const deps = makeDeps(overrides);

      await expect(maybeEnableXdOrgBetaDefault(REQUEST, deps)).resolves.toEqual({
        kind: 'skipped',
        reason: 'beta-unavailable',
      });
      expect(deps.enableBeta).not.toHaveBeenCalled();
    },
  );

  it.each([
    { authEpoch: REQUEST.expectedAuthEpoch + 1, userId: REQUEST.expectedUserId },
    { authEpoch: REQUEST.expectedAuthEpoch, userId: 'user-2' },
    { authEpoch: REQUEST.expectedAuthEpoch, userId: null },
  ])('discards the write after auth changes: %j', async (current) => {
    const deps = makeDeps(current);

    await expect(maybeEnableXdOrgBetaDefault(REQUEST, deps)).resolves.toEqual({
      kind: 'skipped',
      reason: 'stale-auth',
    });
    expect(deps.enableBeta).not.toHaveBeenCalled();
  });

  it('discards a late probe success after logout or account switch', async () => {
    const deps = makeDeps();
    let identity = {
      authEpoch: REQUEST.expectedAuthEpoch,
      userId: REQUEST.expectedUserId as string | null,
    };
    deps.readCurrentAuthIdentity = vi.fn(() => identity);
    vi.mocked(deps.probeBetaManifest).mockImplementation(async () => {
      identity = { authEpoch: REQUEST.expectedAuthEpoch + 1, userId: 'user-2' };
      return true;
    });

    await expect(maybeEnableXdOrgBetaDefault(REQUEST, deps)).resolves.toEqual({
      kind: 'skipped',
      reason: 'stale-auth',
    });
    expect(deps.enableBeta).not.toHaveBeenCalled();
  });
});
