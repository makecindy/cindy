/** worktree 删除/归档预检的本机与 device-link 路由回归。 */
import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  countDirtyWorktreesForRemoval,
  fetchDirtyWorktreeForRemoval,
} from '../lib/worktreeRemovalWarning';
import { IPC_CHANNELS } from '@cindy/cindy-ipc';

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
    expect(remoteInvoke).toHaveBeenCalledWith(
      'device-1',
      IPC_CHANNELS.WORKTREE.REMOVAL_PREVIEW,
      ['s1'],
    );
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

describe('archive warning wiring', () => {
  it('preflights bulk archive, archive-all, and doc-mode tab close', () => {
    const sidebarSource = fs.readFileSync(
      new URL('../features/cc-agent/CCAgentSidebarUpper.tsx', import.meta.url),
      'utf8',
    );
    const docModeSource = fs.readFileSync(
      new URL('../features/cc-agent/workdir-browse/WorkdirBrowseRoute.tsx', import.meta.url),
      'utf8',
    );

    expect(sidebarSource.match(/countDirtyWorktreesForRemoval\(/g)).toHaveLength(3);
    expect(sidebarSource).toContain(
      "ccAgent.sidebar.bulkSelection.confirmArchive.dirtyWorktreeWarning",
    );
    expect(docModeSource).toContain('fetchDirtyWorktreeForRemoval(');
    expect(docModeSource).toContain('ccAgent.sidebar.confirmArchive.dirtyWorktreeWarning');
  });
});
