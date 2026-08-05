/**
 * removeWorktreeForSession 删除守卫回归(P0 重构):
 *   - live-ref 守卫:其它未删除会话仍引用路径 → 保留
 *   - 排除自身:owning session(可能已归档,status 仍非 deleted)不算引用
 *   - dirty → stash 失败保留 / 成功后继续删
 *   - clean 无引用 → git remove + store.del
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fsSync from 'node:fs';
import os from 'node:os';

import type { WorktreeMeta } from '../worktree/types';
import { withWorktreeRestoreMutation } from '../worktree/restoreLock';

const gitExecMock = vi.fn();
const isWorktreeDirtyMock = vi.fn();
const autoStashMock = vi.fn();
const restoreAutoStashMock = vi.fn();
const clearSnapshotRefMock = vi.fn();
const changedIncludeFilesMock = vi.fn();
const storeSetMock = vi.fn();
const storeMap = new Map<string, WorktreeMeta>();
const liveSessionRows: Array<{
  id: string;
  workingDir: string | null;
  worktreePath: string | null;
}> = [];
let liveSessionLookupError: Error | null = null;

vi.mock('../worktree/gitExec', () => ({
  gitExec: (...args: unknown[]) => gitExecMock(...args),
  GitExecError: class GitExecError extends Error {},
}));

vi.mock('../worktree/dirty', () => ({
  isWorktreeDirty: (...args: unknown[]) => isWorktreeDirtyMock(...args),
  autoStashDirtyWorktree: (...args: unknown[]) => autoStashMock(...args),
  restoreAutoStashToPreservedWorktree: (...args: unknown[]) => restoreAutoStashMock(...args),
  clearSnapshotRef: (...args: unknown[]) => clearSnapshotRefMock(...args),
}));

vi.mock('../worktree/includePatternsEngine', () => ({
  applyWorktreeIncludeFile: vi.fn(),
  listChangedWorktreeIncludeFiles: (...args: unknown[]) => changedIncludeFilesMock(...args),
}));

vi.mock('../worktree/worktreeStore', () => ({
  get: (sessionId: string) => storeMap.get(sessionId) ?? null,
  getAll: () => [...storeMap.values()],
  getAllPaths: () => [...storeMap.values()].map((m) => m.path),
  set: (...args: unknown[]) => storeSetMock(...args),
  del: vi.fn((sessionId: string) => storeMap.delete(sessionId)),
}));

vi.mock('../localDb/client/current', () => ({
  getDbClient: () => ({
    drizzle: {
      select: () => ({
        from: () => ({
          where: () => {
            if (liveSessionLookupError) throw liveSessionLookupError;
            return liveSessionRows;
          },
        }),
      }),
    },
  }),
}));

const BASE_REPO = path.resolve('/repo');

function makeMeta(sessionId: string, name = sessionId): WorktreeMeta {
  return {
    sessionId,
    name,
    path: path.join(BASE_REPO, '.xdt-worktrees', name),
    baseRepo: BASE_REPO,
    branch: `xdt/${name}`,
    sourceBranch: 'main',
    createdAt: '2026-07-01T00:00:00.000Z',
  };
}

describe('removeWorktreeForSession', () => {
  let manager: typeof import('../worktree/WorktreeManager');

  beforeEach(async () => {
    storeMap.clear();
    liveSessionRows.length = 0;
    liveSessionLookupError = null;
    gitExecMock.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
    isWorktreeDirtyMock.mockReset().mockResolvedValue(false);
    autoStashMock.mockReset().mockResolvedValue(true);
    restoreAutoStashMock.mockReset().mockResolvedValue(true);
    clearSnapshotRefMock.mockReset().mockResolvedValue(undefined);
    changedIncludeFilesMock.mockReset().mockResolvedValue([]);
    storeSetMock.mockReset().mockImplementation(async (sessionId: string, meta: WorktreeMeta) => {
      storeMap.set(sessionId, meta);
    });
    manager = await import('../worktree/WorktreeManager');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('no store entry → no-op', async () => {
    await manager.removeWorktreeForSession('nope');
    expect(gitExecMock).not.toHaveBeenCalled();
  });

  it('preserves worktree still referenced by another live session', async () => {
    const meta = makeMeta('s1');
    storeMap.set('s1', meta);
    liveSessionRows.push({ id: 'other', workingDir: meta.path, worktreePath: null });

    await manager.removeWorktreeForSession('s1');

    expect(gitExecMock).not.toHaveBeenCalled();
    expect(storeMap.has('s1')).toBe(true);
  });

  it('owning session row does not block its own recycle (archived owner)', async () => {
    const meta = makeMeta('s1');
    storeMap.set('s1', meta);
    // 归档会话 status 仍非 deleted,自己的行必须被排除,否则永远删不掉
    liveSessionRows.push({ id: 's1', workingDir: null, worktreePath: meta.path });

    await manager.removeWorktreeForSession('s1');

    expect(gitExecMock).toHaveBeenCalledWith(
      ['worktree', 'remove', '--force', meta.path],
      BASE_REPO,
    );
    expect(storeMap.has('s1')).toBe(false);
  });

  it('live-ref lookup failure → conservative preserve', async () => {
    const meta = makeMeta('s1');
    storeMap.set('s1', meta);
    liveSessionLookupError = new Error('db closed');

    await manager.removeWorktreeForSession('s1');

    expect(gitExecMock).not.toHaveBeenCalled();
    expect(storeMap.has('s1')).toBe(true);
  });

  it('dirty + stash failure → preserve', async () => {
    const meta = makeMeta('s1');
    storeMap.set('s1', meta);
    isWorktreeDirtyMock.mockResolvedValue(true);
    autoStashMock.mockResolvedValue(false);

    await manager.removeWorktreeForSession('s1');

    expect(gitExecMock).not.toHaveBeenCalled();
    expect(storeMap.has('s1')).toBe(true);
  });

  it('changed local include files → preserve before dirty/stash/remove', async () => {
    const meta = makeMeta('s1');
    storeMap.set('s1', meta);
    changedIncludeFilesMock.mockResolvedValue([{ relpath: '.env', reason: 'content-differs' }]);
    isWorktreeDirtyMock.mockResolvedValue(true);

    await manager.removeWorktreeForSession('s1');

    expect(changedIncludeFilesMock).toHaveBeenCalledWith(BASE_REPO, meta.path);
    expect(isWorktreeDirtyMock).not.toHaveBeenCalled();
    expect(autoStashMock).not.toHaveBeenCalled();
    expect(gitExecMock).not.toHaveBeenCalled();
    expect(storeMap.has('s1')).toBe(true);
  });

  it('dirty + stash success → removed', async () => {
    const meta = makeMeta('s1');
    storeMap.set('s1', meta);
    isWorktreeDirtyMock.mockResolvedValue(true);
    autoStashMock.mockResolvedValue(true);

    await manager.removeWorktreeForSession('s1');

    expect(autoStashMock).toHaveBeenCalledWith(meta.path, 's1');
    expect(gitExecMock).toHaveBeenCalledWith(
      ['worktree', 'remove', '--force', meta.path],
      BASE_REPO,
    );
    expect(storeMap.has('s1')).toBe(false);
  });

  it('rechecks removal guard after snapshot and restores content if session became active', async () => {
    const meta = makeMeta('s1');
    storeMap.set('s1', meta);
    isWorktreeDirtyMock.mockResolvedValue(true);
    autoStashMock.mockResolvedValue(true);
    const canRemove = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await manager.removeWorktreeForSession('s1', { canRemove });

    expect(canRemove).toHaveBeenCalledTimes(2);
    expect(autoStashMock).toHaveBeenCalledWith(meta.path, 's1');
    expect(restoreAutoStashMock).toHaveBeenCalledWith(meta.path, 's1');
    expect(gitExecMock).not.toHaveBeenCalled();
    expect(storeMap.has('s1')).toBe(true);
    expect(storeSetMock).toHaveBeenCalledWith('s1', meta);
  });

  it('keeps a preserved worktree unregistered when cancelled snapshot reapply fails', async () => {
    const meta = makeMeta('s1');
    storeMap.set('s1', meta);
    isWorktreeDirtyMock.mockResolvedValue(true);
    autoStashMock.mockResolvedValue(true);
    restoreAutoStashMock.mockResolvedValue(false);
    const canRemove = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await manager.removeWorktreeForSession('s1', { canRemove });

    expect(restoreAutoStashMock).toHaveBeenCalledWith(meta.path, 's1');
    expect(storeSetMock).not.toHaveBeenCalled();
    expect(storeMap.has('s1')).toBe(false);
  });

  it('serializes cancelled-recycle reapply before a SEND restore mutation', async () => {
    const meta = makeMeta('s1');
    storeMap.set('s1', meta);
    isWorktreeDirtyMock.mockResolvedValue(true);
    autoStashMock.mockResolvedValue(true);
    const canRemove = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    let releaseReapply!: () => void;
    restoreAutoStashMock.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => {
        releaseReapply = () => resolve(true);
      }),
    );

    const removal = manager.removeWorktreeForSession('s1', { canRemove });
    await vi.waitFor(() => {
      expect(restoreAutoStashMock).toHaveBeenCalledWith(meta.path, 's1');
    });

    let sendRestoreStarted = false;
    const sendRestore = withWorktreeRestoreMutation('s1', async () => {
      sendRestoreStarted = true;
    });
    await Promise.resolve();
    expect(sendRestoreStarted).toBe(false);

    releaseReapply();
    await Promise.all([removal, sendRestore]);
    expect(sendRestoreStarted).toBe(true);
    expect(storeMap.has('s1')).toBe(true);
  });

  it('reapplies and re-registers a snapshot when worktree removal fails', async () => {
    const meta = makeMeta('s1');
    storeMap.set('s1', meta);
    isWorktreeDirtyMock.mockResolvedValue(true);
    autoStashMock.mockResolvedValue(true);
    gitExecMock.mockRejectedValueOnce(new Error('worktree locked'));

    await manager.removeWorktreeForSession('s1');

    expect(restoreAutoStashMock).toHaveBeenCalledWith(meta.path, 's1');
    expect(storeSetMock).toHaveBeenCalledWith('s1', meta);
    expect(storeMap.has('s1')).toBe(true);
  });

  it('preserves worktree containing another live session cwd', async () => {
    const meta = makeMeta('s1');
    storeMap.set('s1', meta);
    liveSessionRows.push({
      id: 'other',
      workingDir: path.join(meta.path, 'packages', 'app'),
      worktreePath: null,
    });

    await manager.removeWorktreeForSession('s1');

    expect(gitExecMock).not.toHaveBeenCalled();
    expect(storeMap.has('s1')).toBe(true);
  });

  it('.worktree-keep sentinel → preserved unconditionally (before dirty/stash)', async () => {
    // 哨兵检查走真实 fs,用 tmp 目录构造
    const tmpRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), 'xdt-wt-sentinel-'));
    try {
      const base = path.join(tmpRoot, 'repo');
      const wt = path.join(base, '.xdt-worktrees', 's1');
      fsSync.mkdirSync(wt, { recursive: true });
      fsSync.writeFileSync(path.join(wt, '.worktree-keep'), '');
      const meta: WorktreeMeta = {
        sessionId: 's1',
        name: 's1',
        path: wt,
        baseRepo: base,
        branch: 'xdt/s1',
        sourceBranch: 'main',
        createdAt: '2026-07-01T00:00:00.000Z',
      };
      storeMap.set('s1', meta);
      isWorktreeDirtyMock.mockResolvedValue(true); // dirty 也不该走到 stash

      await manager.removeWorktreeForSession('s1');

      expect(autoStashMock).not.toHaveBeenCalled();
      expect(gitExecMock).not.toHaveBeenCalled();
      expect(storeMap.has('s1')).toBe(true);
    } finally {
      fsSync.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('clean + unreferenced → removed and store entry dropped', async () => {
    const meta = makeMeta('s1');
    storeMap.set('s1', meta);
    liveSessionRows.push({ id: 'other', workingDir: '/somewhere/else', worktreePath: null });

    await manager.removeWorktreeForSession('s1');

    expect(gitExecMock).toHaveBeenCalledWith(
      ['worktree', 'remove', '--force', meta.path],
      BASE_REPO,
    );
    expect(storeMap.has('s1')).toBe(false);
  });

  it('clean and dirty removal do not clear snapshot refs directly', async () => {
    // snapshot ref 的清理由 restore 成功 apply 后负责；删除重试不能清掉尚未恢复的脏内容。
    const meta = makeMeta('s1');
    storeMap.set('s1', meta);

    await manager.removeWorktreeForSession('s1');
    expect(clearSnapshotRefMock).not.toHaveBeenCalled();

    clearSnapshotRefMock.mockClear();
    const meta2 = makeMeta('s2');
    storeMap.set('s2', meta2);
    isWorktreeDirtyMock.mockResolvedValue(true);
    autoStashMock.mockResolvedValue(true);

    await manager.removeWorktreeForSession('s2');
    expect(clearSnapshotRefMock).not.toHaveBeenCalled();
  });

  it('does not clear a snapshot during failed-then-retried removal', async () => {
    const meta = makeMeta('s1');
    storeMap.set('s1', meta);
    isWorktreeDirtyMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    autoStashMock.mockResolvedValue(true);

    let removeAttempts = 0;
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        removeAttempts += 1;
        if (removeAttempts < 3) throw new Error('locked');
      }
      return { stdout: '', stderr: '' };
    });

    await manager.removeWorktreeForSession('s1');
    expect(clearSnapshotRefMock).not.toHaveBeenCalled();
    expect(storeMap.has('s1')).toBe(true);

    await manager.removeWorktreeForSession('s1');
    expect(clearSnapshotRefMock).not.toHaveBeenCalled();
    expect(storeMap.has('s1')).toBe(true);

    await manager.removeWorktreeForSession('s1');
    expect(clearSnapshotRefMock).not.toHaveBeenCalled();
    expect(storeMap.has('s1')).toBe(false);
  });

  it('serializes duplicate recycle for the same session so a clean follow-up cannot clear the new snapshot', async () => {
    const meta = makeMeta('s1');
    storeMap.set('s1', meta);
    isWorktreeDirtyMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    let releaseStash!: () => void;
    autoStashMock.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => {
        releaseStash = () => resolve(true);
      }),
    );

    const first = manager.removeWorktreeForSession('s1');
    const second = manager.removeWorktreeForSession('s1');
    await vi.waitFor(() => {
      expect(autoStashMock).toHaveBeenCalledWith(meta.path, 's1');
    });

    releaseStash();
    await Promise.all([first, second]);

    expect(gitExecMock).toHaveBeenCalledTimes(1);
    expect(gitExecMock).toHaveBeenCalledWith(
      ['worktree', 'remove', '--force', meta.path],
      BASE_REPO,
    );
    expect(clearSnapshotRefMock).not.toHaveBeenCalled();
    expect(storeMap.has('s1')).toBe(false);
  });
});
