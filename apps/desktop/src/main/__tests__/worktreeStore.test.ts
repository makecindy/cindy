import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { WorktreeMeta } from '../worktree/types';

const backingStore = { worktrees: {} as Record<string, WorktreeMeta> };
const setWorktreePathInDbMock = vi.fn();

vi.mock('electron-store', () => ({
  default: class MockStore {
    get(key: 'worktrees', fallback: Record<string, WorktreeMeta>) {
      return backingStore[key] ?? fallback;
    }

    set(key: 'worktrees', value: Record<string, WorktreeMeta>) {
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
    setWorktreePathInDbMock.mockReset();
    vi.resetModules();
  });

  it('keeps store metadata when DB sync fails', async () => {
    setWorktreePathInDbMock.mockRejectedValueOnce(new Error('db unavailable'));
    const store = await import('../worktree/worktreeStore');
    const meta: WorktreeMeta = {
      sessionId: 'session-1',
      name: 'auto-abc123',
      path: 'D:\\repo\\.xdt-worktrees\\auto-abc123',
      baseRepo: 'D:\\repo',
      branch: 'xdt/auto-abc123',
      sourceBranch: 'main',
      createdAt: '2026-05-26T00:00:00.000Z',
      ephemeral: false,
    };

    await expect(store.set(meta.sessionId, meta)).resolves.toBeUndefined();

    expect(store.get(meta.sessionId)).toEqual(meta);
    expect(store.getAll()).toEqual([meta]);
    expect(setWorktreePathInDbMock).toHaveBeenCalledWith(meta.sessionId, meta.path);
  });
});
