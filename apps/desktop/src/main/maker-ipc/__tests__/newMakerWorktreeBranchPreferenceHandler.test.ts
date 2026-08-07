import { describe, expect, it, vi } from 'vitest';

import { MAKER_INVOKE, MAKER_PUSH } from '../channels';
import {
  registerNewMakerWorktreeBranchPreferenceHandler,
  type NewMakerWorktreeBranchPreferenceHandlerDeps,
} from '../newMakerWorktreeBranchPreferenceHandler';
import { IpcHarness } from './helpers/ipcHarness';

const SNAPSHOT = {
  baseRepo: '/tmp/repo',
  sourceBranch: 'feature/mobile',
  revision: 3,
};

function createDeps(
  overrides: Partial<NewMakerWorktreeBranchPreferenceHandlerDeps> = {},
): NewMakerWorktreeBranchPreferenceHandlerDeps {
  return {
    isDeviceLinkInvoke: vi.fn(() => false),
    assertTrustedCaller: vi.fn(),
    getPreference: vi.fn(() => null),
    applyPreference: vi.fn(() => SNAPSHOT),
    broadcast: vi.fn(),
    ...overrides,
  };
}

describe('New Maker worktree branch preference IPC', () => {
  it('returns null for a valid repository with no host selection', async () => {
    const harness = new IpcHarness();
    const deps = createDeps();
    registerNewMakerWorktreeBranchPreferenceHandler(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.GET_NEW_MAKER_WORKTREE_BRANCH_PREF, { baseRepo: '/tmp/repo' }),
    ).resolves.toBeNull();
    expect(deps.getPreference).toHaveBeenCalledWith('/tmp/repo');
  });

  it('applies and broadcasts the exact host snapshot', async () => {
    const harness = new IpcHarness();
    const deps = createDeps();
    registerNewMakerWorktreeBranchPreferenceHandler(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.APPLY_NEW_MAKER_WORKTREE_BRANCH_PREF, {
        baseRepo: '/tmp/repo',
        sourceBranch: ' feature/mobile ',
      }),
    ).resolves.toEqual(SNAPSHOT);

    expect(deps.applyPreference).toHaveBeenCalledWith({
      baseRepo: '/tmp/repo',
      sourceBranch: 'feature/mobile',
    });
    expect(deps.broadcast).toHaveBeenCalledWith(
      MAKER_PUSH.NEW_MAKER_WORKTREE_BRANCH_CHANGED,
      SNAPSHOT,
    );
  });

  it('allows a device-link invoke without an Electron sender', async () => {
    const harness = new IpcHarness();
    const deps = createDeps({ isDeviceLinkInvoke: vi.fn(() => true) });
    registerNewMakerWorktreeBranchPreferenceHandler(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.GET_NEW_MAKER_WORKTREE_BRANCH_PREF, { baseRepo: '/tmp/repo' }),
    ).resolves.toBeNull();
    expect(deps.assertTrustedCaller).not.toHaveBeenCalled();
  });

  it.each([
    [{ baseRepo: 'relative/repo' }, 'baseRepo must be absolute'],
    [{ baseRepo: '/tmp/repo', sourceBranch: '' }, 'sourceBranch is invalid'],
    [{ baseRepo: '/tmp/repo', sourceBranch: 'bad\0branch' }, 'sourceBranch is invalid'],
  ])('rejects invalid input %#', async (request, message) => {
    const harness = new IpcHarness();
    const deps = createDeps();
    registerNewMakerWorktreeBranchPreferenceHandler(harness, deps);
    const channel = Object.prototype.hasOwnProperty.call(request, 'sourceBranch')
      ? MAKER_INVOKE.APPLY_NEW_MAKER_WORKTREE_BRANCH_PREF
      : MAKER_INVOKE.GET_NEW_MAKER_WORKTREE_BRANCH_PREF;

    await expect(harness.invoke(channel, request)).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      message: `[INVALID_PARAMS] ${message}`,
    });
    expect(deps.broadcast).not.toHaveBeenCalled();
  });

  it('guards local callers before reading or mutating preferences', async () => {
    const harness = new IpcHarness();
    const rejection = new Error('untrusted renderer');
    const deps = createDeps({
      assertTrustedCaller: vi.fn(() => {
        throw rejection;
      }),
    });
    registerNewMakerWorktreeBranchPreferenceHandler(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.APPLY_NEW_MAKER_WORKTREE_BRANCH_PREF, {
        baseRepo: '/tmp/repo',
        sourceBranch: 'main',
      }),
    ).rejects.toBe(rejection);
    expect(deps.applyPreference).not.toHaveBeenCalled();
    expect(deps.broadcast).not.toHaveBeenCalled();
  });
});
