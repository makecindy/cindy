import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { WorktreeMeta } from '../worktree/types';

// 按 store 文件名隔离的后备数据: worktrees.json 与 worktree-safe-directory-cleanup.json
// 是两个物理文件, 单测同样按 name 隔离, 验证队列写入不会碰 worktrees 键。
const storesByName = new Map<string, Record<string, unknown>>();
const setWorktreePathInDbMock = vi.fn();

vi.mock('electron-store', () => ({
  default: class MockStore {
    constructor(opts: { name?: string } = {}) {
      this.name = opts.name ?? 'default';
      if (!storesByName.has(this.name)) storesByName.set(this.name, {});
    }

    name: string;

    get(key: string, fallback: unknown) {
      const backing = storesByName.get(this.name) ?? {};
      return backing[key] ?? fallback;
    }

    set(key: string, value: unknown) {
      const backing = storesByName.get(this.name) ?? {};
      backing[key] = value;
      storesByName.set(this.name, backing);
    }
  },
}));

vi.mock('../localDb/ipc/sessions', () => ({
  setWorktreePathInDb: (...args: unknown[]) => setWorktreePathInDbMock(...args),
}));

// 队列读改写走跨进程锁; 单测里直通持锁, 聚焦合并/去重语义, 不落真实锁文件。
vi.mock('../device-link/crossProcessLock', () => ({
  withCrossProcessLock: (
    _lockPath: string,
    _opts: unknown,
    task: (status: unknown) => Promise<unknown>,
  ) => task({ held: true }),
}));

describe('worktreeStore', () => {
  beforeEach(async () => {
    storesByName.clear();
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

    // 两类写入落在不同 store 文件: worktrees.json 只含 worktrees 键,
    // 队列文件只含 pending 键 —— 互相整体重写也不会抹掉对方的数据。
    expect(Object.keys(storesByName.get('worktrees') ?? {})).toEqual(['worktrees']);
    expect(storesByName.get('worktrees')?.worktrees).toEqual({ [meta.sessionId]: meta });
    expect(storesByName.get('worktree-safe-directory-cleanup')).toEqual({ pending: ['/deferred'] });
  });
});
