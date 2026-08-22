import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { WorktreeMeta } from '../worktree/types';

const backingStore: Record<string, unknown> = { worktrees: {} as Record<string, WorktreeMeta> };
const setWorktreePathInDbMock = vi.fn();

vi.mock('electron-store', () => ({
  default: class MockStore {
    get(key: string, fallback: unknown) {
      return backingStore[key] ?? fallback;
    }

    set(key: string, value: unknown) {
      backingStore[key] = value;
    }
  },
}));

vi.mock('../localDb/ipc/sessions', () => ({
  setWorktreePathInDb: (...args: unknown[]) => setWorktreePathInDbMock(...args),
}));

describe('worktreeStore', () => {
  beforeEach(async () => {
    backingStore.worktrees = {};
    delete backingStore.pendingSafeDirectoryCleanups;
    setWorktreePathInDbMock.mockReset();
    vi.resetModules();
  });

  it('keeps store metadata when DB sync fails', async () => {
    setWorktreePathInDbMock.mockRejectedValueOnce(new Error('db unavailable'));
    const store = await import('../worktree/worktreeStore');
    const meta: WorktreeMeta = {
      sessionId: 'session-1',
      name: 'auto-test',
      path: 'D:\\repo\\.xdt-worktrees\\auto-test',
      baseRepo: 'D:\\repo',
      branch: 'xdt/auto-test',
      sourceBranch: 'main',
      createdAt: '2026-05-26T00:00:00.000Z',
      ephemeral: false,
    };

    await expect(store.set(meta.sessionId, meta)).resolves.toBeUndefined();

    expect(store.get(meta.sessionId)).toEqual(meta);
    expect(setWorktreePathInDbMock).toHaveBeenCalledWith(meta.sessionId, meta.path);
  });

  it('adds and removes pending safe.directory cleanup paths (deduped)', async () => {
    const store = await import('../worktree/worktreeStore');

    expect(store.getPendingSafeDirectoryCleanups()).toEqual([]);

    store.addPendingSafeDirectoryCleanups(['/a', '/a', '/b']);
    expect(store.getPendingSafeDirectoryCleanups()).toEqual(['/a', '/b']);

    store.removePendingSafeDirectoryCleanups(['/a']);
    expect(store.getPendingSafeDirectoryCleanups()).toEqual(['/b']);

    store.removePendingSafeDirectoryCleanups(['/b']);
    expect(store.getPendingSafeDirectoryCleanups()).toEqual([]);
  });
});
