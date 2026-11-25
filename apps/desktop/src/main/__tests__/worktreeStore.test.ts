import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { WorktreeMeta } from '../worktree/types';

const setWorktreePathInDbMock = vi.fn();

vi.mock('../localDb/ipc/sessions', () => ({
  setWorktreePathInDb: (...args: unknown[]) => setWorktreePathInDbMock(...args),
}));

// Queue read/modify/write locking is covered separately; these tests focus on persistence semantics.
vi.mock('../device-link/crossProcessLock', () => ({
  withCrossProcessLock: (
    _lockPath: string,
    _opts: unknown,
    task: (status: unknown) => Promise<unknown>,
  ) => task({ held: true }),
}));

describe('worktreeStore', () => {
  let profile = '';

  beforeEach(async () => {
    setWorktreePathInDbMock.mockReset();
    vi.resetModules();
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-worktree-store-'));
    const { configureUserDataDir } = await import('../userDataPath');
    configureUserDataDir(profile);
    const { configureWorktreeStoreDbSync } = await import('../worktree/worktreeStoreCore');
    configureWorktreeStoreDbSync((sessionId, worktreePath) => setWorktreePathInDbMock(sessionId, worktreePath));
  });

  afterEach(() => {
    fs.rmSync(profile, { recursive: true, force: true });
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

    await store.addPendingSafeDirectoryCleanups(['/a', '/a', '/b']);
    expect(store.getPendingSafeDirectoryCleanups()).toEqual(['/a', '/b']);

    await store.removePendingSafeDirectoryCleanups(['/a']);
    expect(store.getPendingSafeDirectoryCleanups()).toEqual(['/b']);

    await store.removePendingSafeDirectoryCleanups(['/b']);
    expect(store.getPendingSafeDirectoryCleanups()).toEqual([]);
  });

  it('queue writes live in a separate store file from worktrees', async () => {
    const store = await import('../worktree/worktreeStore');
    const meta: WorktreeMeta = {
      sessionId: 'session-1',
      name: 'auto-test',
      path: '/repo/.xdt-worktrees/auto-test',
      baseRepo: '/repo',
      branch: 'xdt/auto-test',
      sourceBranch: 'main',
      createdAt: '2026-05-26T00:00:00.000Z',
      ephemeral: false,
    };

    await store.set(meta.sessionId, meta);
    await store.addPendingSafeDirectoryCleanups(['/deferred']);

    const registry = JSON.parse(fs.readFileSync(path.join(profile, 'worktrees.json'), 'utf8'));
    const cleanup = JSON.parse(fs.readFileSync(path.join(profile, 'worktree-safe-directory-cleanup.json'), 'utf8'));
    expect(Object.keys(registry)).toEqual(['worktrees']);
    expect(registry.worktrees).toEqual({ [meta.sessionId]: meta });
    expect(cleanup).toEqual({ pending: ['/deferred'] });
  });

  it('does not publish metadata when the locked mutation guard fails', async () => {
    const store = await import('../worktree/worktreeStore');
    const meta: WorktreeMeta = {
      sessionId: 'guarded', name: 'guarded', path: '/repo/.cindy-worktrees/guarded',
      baseRepo: '/repo', branch: 'cindy/guarded', sourceBranch: 'main',
      createdAt: '2026-05-26T00:00:00.000Z', ephemeral: false,
    };

    await expect(store.set(meta.sessionId, meta, async () => {
      throw new Error('profile held');
    })).rejects.toThrow('profile held');
    expect(store.get(meta.sessionId)).toBeNull();
    expect(setWorktreePathInDbMock).not.toHaveBeenCalled();
  });

  it('replaces pooled generations atomically in the registry', async () => {
    const store = await import('../worktree/worktreeStore');
    const previous: WorktreeMeta = {
      sessionId: 'previous', name: 'old', path: '/repo/.xdt-worktrees/old',
      baseRepo: '/repo', branch: 'xdt/old', sourceBranch: 'main',
      createdAt: '2026-05-26T00:00:00.000Z', ephemeral: true,
    };
    const next: WorktreeMeta = {
      ...previous, sessionId: 'next', name: 'new', path: '/repo/.xdt-worktrees/new',
      branch: 'xdt/new', createdAt: '2026-05-26T00:01:00.000Z',
    };

    await store.set(previous.sessionId, previous);
    setWorktreePathInDbMock.mockClear();
    await store.replace(previous.sessionId, next.sessionId, next);

    expect(store.get(previous.sessionId)).toBeNull();
    expect(store.get(next.sessionId)).toEqual(next);
    expect(setWorktreePathInDbMock).toHaveBeenCalledWith(next.sessionId, next.path);
  });
});
