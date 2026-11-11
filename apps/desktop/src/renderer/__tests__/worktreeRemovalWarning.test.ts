/** worktree 删除/归档预检的本机与 device-link 路由回归。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  countDirtyWorktreesForRemoval,
  fetchDirtyWorktreeForRemoval,
} from '../lib/worktreeRemovalWarning';

const localPreview = vi.fn();
const remoteInvoke = vi.fn();

beforeEach(() => {
  localPreview.mockReset();
  remoteInvoke.mockReset();
  vi.stubGlobal('window', {
    electronAPI: {
      worktreeRemovalPreview: localPreview,
      deviceLink: { invoke: remoteInvoke },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchDirtyWorktreeForRemoval', () => {
  it('uses the local preview for a local session', async () => {
    localPreview.mockResolvedValue({ hasWorktree: true, dirty: true });

    await expect(fetchDirtyWorktreeForRemoval('s1')).resolves.toBe(true);
    expect(localPreview).toHaveBeenCalledWith('s1');
    expect(remoteInvoke).not.toHaveBeenCalled();
  });

  it('routes remote session preview to the controlled device', async () => {
    remoteInvoke.mockResolvedValue({ hasWorktree: true, dirty: true });

    await expect(fetchDirtyWorktreeForRemoval('s1', 'device-1')).resolves.toBe(true);
    expect(remoteInvoke).toHaveBeenCalledWith('device-1', 'worktree:removal-preview', ['s1']);
    expect(localPreview).not.toHaveBeenCalled();
  });

  it('keeps the non-blocking fallback when a remote preview is unavailable', async () => {
    remoteInvoke.mockRejectedValue(new Error('CHANNEL_NOT_ALLOWED'));

    await expect(fetchDirtyWorktreeForRemoval('s1', 'old-device')).resolves.toBe(false);
  });

  it('counts dirty local and remote worktrees with the same routing rules', async () => {
    localPreview.mockResolvedValue({ hasWorktree: true, dirty: true });
    remoteInvoke.mockResolvedValue({ hasWorktree: true, dirty: true });

    await expect(
      countDirtyWorktreesForRemoval([
        { id: 'local' },
        { id: 'remote', deviceLinkDeviceId: 'device-1' },
      ]),
    ).resolves.toBe(2);
  });
});
