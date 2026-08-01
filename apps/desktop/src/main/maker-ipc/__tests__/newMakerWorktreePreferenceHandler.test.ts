import { describe, expect, it, vi } from 'vitest';

import { MAKER_INVOKE, MAKER_PUSH } from '../channels';
import {
  registerNewMakerWorktreePreferenceHandler,
  type NewMakerWorktreePreferenceHandlerDeps,
} from '../newMakerWorktreePreferenceHandler';
import { IpcHarness } from './helpers/ipcHarness';

function createDeps(
  overrides: Partial<NewMakerWorktreePreferenceHandlerDeps> = {},
): NewMakerWorktreePreferenceHandlerDeps {
  return {
    isDeviceLinkInvoke: vi.fn(() => false),
    assertTrustedCaller: vi.fn(),
    broadcast: vi.fn(),
    ...overrides,
  };
}

describe('maker:apply-new-maker-worktree-pref IPC handler', () => {
  it('guards local callers before validating or broadcasting the preference', async () => {
    const harness = new IpcHarness();
    const rejection = new Error('untrusted renderer');
    const deps = createDeps({
      assertTrustedCaller: vi.fn(() => {
        throw rejection;
      }),
    });
    registerNewMakerWorktreePreferenceHandler(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.APPLY_NEW_MAKER_WORKTREE_PREF, {
        worktreeEnabled: true,
      }),
    ).rejects.toBe(rejection);

    expect(deps.assertTrustedCaller).toHaveBeenCalledTimes(1);
    expect(deps.broadcast).not.toHaveBeenCalled();
  });

  it('retains the allowlisted device-link path without requiring an Electron sender', async () => {
    const harness = new IpcHarness();
    const deps = createDeps({
      isDeviceLinkInvoke: vi.fn(() => true),
    });
    registerNewMakerWorktreePreferenceHandler(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.APPLY_NEW_MAKER_WORKTREE_PREF, {
        worktreeEnabled: false,
      }),
    ).resolves.toBeUndefined();

    expect(deps.assertTrustedCaller).not.toHaveBeenCalled();
    expect(deps.broadcast).toHaveBeenCalledWith(MAKER_PUSH.WORKTREE_PREF_APPLY, {
      worktreeEnabled: false,
    });
  });

  it('rejects invalid payloads without broadcasting', async () => {
    const harness = new IpcHarness();
    const deps = createDeps();
    registerNewMakerWorktreePreferenceHandler(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.APPLY_NEW_MAKER_WORKTREE_PREF, {
        worktreeEnabled: 'yes',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });

    expect(deps.assertTrustedCaller).toHaveBeenCalledTimes(1);
    expect(deps.broadcast).not.toHaveBeenCalled();
  });
});
