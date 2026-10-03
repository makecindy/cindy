import { describe, expect, it, vi } from 'vitest';
import { notBehindBase, pickSyncTarget, type SyncTargetDeps } from '../syncTarget';

const LATEST = 'a'.repeat(40);
const INSTALLED = 'b'.repeat(40);
const latest = { ref: 'v1.3.0', commit: LATEST, channel: 'release' as const };

function deps(overrides: Partial<SyncTargetDeps> = {}): SyncTargetDeps {
  return {
    latest,
    original: { version: '1.2.0', commit: INSTALLED },
    tagCommit: vi.fn(async () => INSTALLED),
    fetch: vi.fn(async () => {}),
    sameMigrations: vi.fn(async () => true),
    isAncestor: vi.fn(async () => true),
    ...overrides,
  };
}

describe('task preparation and builds', () => {
  it('never move the personal version to an older official version than its base', async () => {
    const BASE = 'c'.repeat(40);
    const target = { ref: 'v1.2.0', commit: INSTALLED };
    await expect(notBehindBase(target, BASE, async () => true)).resolves.toEqual({
      ref: 'v1.2.0',
      commit: BASE,
    });
    await expect(notBehindBase(target, BASE, async () => false)).resolves.toEqual(target);
    await expect(notBehindBase(target, undefined, async () => true)).resolves.toEqual(target);
  });
});

describe('official version Sync moves to', () => {
  it('follows the latest release while its database migrations match the installed Cindy', async () => {
    await expect(pickSyncTarget(deps())).resolves.toEqual({ ref: 'v1.3.0', commit: LATEST });
  });

  it('stays on the installed version when the latest release changes the migrations', async () => {
    const input = deps({ sameMigrations: vi.fn(async () => false) });
    await expect(pickSyncTarget(input)).resolves.toEqual({
      ref: 'v1.2.0',
      commit: INSTALLED,
      held: { ref: 'v1.3.0', commit: LATEST },
    });
    expect(input.fetch).toHaveBeenCalledWith([LATEST, INSTALLED]);
  });

  it('finds the installed version by its tag when the build commit is unknown or dirty', async () => {
    const input = deps({
      original: { version: '1.2.0', commit: INSTALLED, dirty: true },
      sameMigrations: vi.fn(async () => false),
    });
    await expect(pickSyncTarget(input)).resolves.toMatchObject({ commit: INSTALLED });
    expect(input.tagCommit).toHaveBeenCalledWith('v1.2.0');
  });

  it.each([
    ['a development build', { latest: { ...latest, ref: 'main', channel: 'dev' as const } }],
    ['an unknown original', { original: undefined }],
    ['an original newer than the release', { isAncestor: vi.fn(async () => false) }],
    ['the installed release itself', { original: { version: '1.3.0', commit: LATEST } }],
  ])(
    'follows the latest version for %s, fetched before it is compared',
    async (_case, overrides) => {
      const input = deps({ sameMigrations: vi.fn(async () => false), ...overrides });
      const target = await pickSyncTarget(input);
      expect(target.held).toBeUndefined();
      expect(target.commit).toBe(input.latest.commit);
      expect(vi.mocked(input.fetch).mock.calls[0][0]).toContain(input.latest.commit);
    },
  );

  it('moves nothing when the installed release cannot be compared', async () => {
    const input = deps({
      fetch: vi.fn(async () => {
        throw new Error('offline');
      }),
    });
    await expect(pickSyncTarget(input)).rejects.toThrow('offline');
  });
});
