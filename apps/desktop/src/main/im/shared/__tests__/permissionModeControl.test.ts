import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readPermissionMode: vi.fn(),
  updatePermissionMode: vi.fn(),
}));

vi.mock('../sessionRepo', () => ({
  readPermissionMode: mocks.readPermissionMode,
  updatePermissionMode: mocks.updatePermissionMode,
}));

import { ui } from '../../wecom/uiText';
import {
  changeSessionPermissionMode,
  permissionModeCommandContext,
  renderTextPermissionModePicker,
  renderTextPermissionModeResult,
  resolvePermissionMode,
} from '../permissionModeControl';

const modes = [
  { id: 'auto' as const, displayName: 'Auto', description: 'Safe default' },
  {
    id: 'bypassPermissions' as const,
    displayName: 'Full Access',
    description: 'No routine prompts',
  },
];

describe('shared IM permission mode control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readPermissionMode.mockResolvedValue('auto');
    mocks.updatePermissionMode.mockResolvedValue(undefined);
  });

  it('lists the agent modes and accepts text aliases', () => {
    const context = permissionModeCommandContext('session-1', 'auto', modes);
    expect(renderTextPermissionModePicker(ui, context)).toContain('/permission bypassPermissions');
    expect(resolvePermissionMode(modes, 'bypass')?.id).toBe('bypassPermissions');
    expect(resolvePermissionMode(modes, 'FULL-ACCESS')?.id).toBe('bypassPermissions');
  });

  it('requires a second explicit confirmation before Full Access', async () => {
    const setPermissionMode = vi.fn();
    const result = await changeSessionPermissionMode({
      sessionId: 'session-1',
      mode: 'bypassPermissions',
      modes,
      readPreviousMode: mocks.readPermissionMode,
      getLiveSession: () => ({ setPermissionMode }),
      persist: (mode) => mocks.updatePermissionMode('session-1', mode),
    });

    expect(result).toEqual({
      kind: 'confirmation-required',
      mode: 'bypassPermissions',
      label: 'Full Access',
    });
    expect(renderTextPermissionModeResult(ui, result)).toContain(
      '/permission bypassPermissions confirm',
    );
    expect(setPermissionMode).not.toHaveBeenCalled();
    expect(mocks.updatePermissionMode).not.toHaveBeenCalled();
  });

  it('updates the live session before persistence after confirmation', async () => {
    const setPermissionMode = vi.fn(async () => undefined);
    await expect(
      changeSessionPermissionMode({
        sessionId: 'session-1',
        mode: 'bypassPermissions',
        modes,
        confirmedFullAccess: true,
        readPreviousMode: mocks.readPermissionMode,
        getLiveSession: () => ({ setPermissionMode }),
        persist: (mode) => mocks.updatePermissionMode('session-1', mode),
      }),
    ).resolves.toEqual({
      kind: 'changed',
      mode: 'bypassPermissions',
      label: 'Full Access',
      live: true,
    });
    expect(setPermissionMode).toHaveBeenCalledWith('bypassPermissions');
    expect(mocks.updatePermissionMode).toHaveBeenCalledWith('session-1', 'bypassPermissions');
    expect(setPermissionMode.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.updatePermissionMode.mock.invocationCallOrder[0]!,
    );
  });

  it('rolls the live session back when persistence fails', async () => {
    const setPermissionMode = vi.fn(async () => undefined);
    mocks.readPermissionMode.mockResolvedValueOnce('ask');
    mocks.updatePermissionMode.mockRejectedValueOnce(new Error('db locked'));
    await expect(
      changeSessionPermissionMode({
        sessionId: 'session-1',
        mode: 'auto',
        modes,
        readPreviousMode: mocks.readPermissionMode,
        getLiveSession: () => ({ setPermissionMode }),
        persist: (mode) => mocks.updatePermissionMode('session-1', mode),
      }),
    ).resolves.toEqual({ kind: 'failed', reason: 'db locked' });
    expect(setPermissionMode.mock.calls).toEqual([['auto'], ['ask']]);
  });
});
