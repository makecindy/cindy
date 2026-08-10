/**
 * removeWorktreeForSession / discardPrecreatedWorktree 删除守卫回归:
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
const ignoredFilesMock = vi.fn();
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
  listNonReproducibleIgnoredFiles: (...args: unknown[]) => ignoredFilesMock(...args),
}));

vi.mock('../worktree/includePatternsEngine', () => ({
  applyWorktreeIncludeFile: vi.fn(),
  listChangedWorktreeIncludeFiles: (...args: unknown[]) => changedIncludeFilesMock(...args),
}));

vi.mock('../worktree/worktreeStore', () => ({
  get: (sessionId: string) => storeMap.get(sessionId) ?? null,
  getAll: () => [...storeMap.values()],
  getAllPaths: () =>
    [...storeMap.values()].flatMap((m) =>
      m.quarantinePath ? [m.path, m.quarantinePath] : [m.path],
    ),
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
    gitExecMock.mockReset().mockImplementation(async (args: string[], cwd?: string) => {
      if (args[0] === 'symbolic-ref') {
        const meta = [...storeMap.values()].find(
          (candidate) => candidate.path === cwd || candidate.quarantinePath === cwd,
        );
        return { stdout: `refs/heads/${meta?.branch ?? 'xdt/unknown'}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    isWorktreeDirtyMock.mockReset().mockResolvedValue(false);
    autoStashMock.mockReset().mockResolvedValue(true);
    restoreAutoStashMock.mockReset().mockResolvedValue(true);
    clearSnapshotRefMock.mockReset().mockResolvedValue(undefined);
    ignoredFilesMock.mockReset().mockResolvedValue([]);
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

  it('reads and recycles a historical auto-* worktree without renaming it', async () => {
    const meta = makeMeta('legacy-auto', 'auto-abc123');
    storeMap.set(meta.sessionId, meta);

    expect(manager.getForSession(meta.sessionId)).toEqual(meta);
    await manager.removeWorktreeForSession(meta.sessionId);

    expect(gitExecMock).toHaveBeenCalledWith(
      ['worktree', 'remove', '--force', meta.path],
      BASE_REPO,
    );
    expect(storeMap.has(meta.sessionId)).toBe(false);
  });

  it('suggestName reserves current and legacy names from local and origin branches', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      gitExecMock.mockImplementation(async (args: string[]) => ({
        stdout:
          args[0] === 'branch'
            ? 'refs/heads/cindy/pensive-lederberg\nrefs/remotes/origin/xdt/pensive-lederberg-2\n'
            : '',
        stderr: '',
      }));

      await expect(manager.suggestName(BASE_REPO)).resolves.toBe('pensive-lederberg-3');
      expect(gitExecMock).toHaveBeenCalledWith(
        ['branch', '--all', '--format=%(refname)'],
        BASE_REPO,
      );
    } finally {
      random.mockRestore();
    }
  });

  it('suggestName reserves the first name segment of a current-prefix descendant ref', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      gitExecMock.mockImplementation(async (args: string[]) => ({
        stdout: args[0] === 'branch' ? 'refs/heads/cindy/pensive-lederberg/child\n' : '',
        stderr: '',
      }));

      await expect(manager.suggestName(BASE_REPO)).resolves.toBe('pensive-lederberg-2');
    } finally {
      random.mockRestore();
    }
  });

  it('suggestName ignores remote descendant refs because they do not block local heads', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      gitExecMock.mockImplementation(async (args: string[]) => ({
        stdout: args[0] === 'branch' ? 'refs/remotes/origin/cindy/pensive-lederberg/child\n' : '',
        stderr: '',
      }));

      await expect(manager.suggestName(BASE_REPO)).resolves.toBe('pensive-lederberg');
    } finally {
      random.mockRestore();
    }
  });

  it('suggestName distinguishes local origin/* branches from origin tracking refs', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      gitExecMock.mockImplementation(async (args: string[]) => ({
        stdout:
          args[0] === 'branch'
            ? [
                'refs/heads/origin/cindy',
                'refs/remotes/origin/cindy',
                'refs/heads/origin/cindy/pensive-lederberg',
              ].join('\n')
            : '',
        stderr: '',
      }));

      await expect(manager.suggestName(BASE_REPO)).resolves.toBe('pensive-lederberg');
    } finally {
      random.mockRestore();
    }
  });

  it('suggestName reserves exact origin tracking worktree branches', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      gitExecMock.mockImplementation(async (args: string[]) => ({
        stdout: args[0] === 'branch' ? 'refs/remotes/origin/cindy/pensive-lederberg\n' : '',
        stderr: '',
      }));

      await expect(manager.suggestName(BASE_REPO)).resolves.toBe('pensive-lederberg-2');
    } finally {
      random.mockRestore();
    }
  });

  it('suggestName reports a current-prefix namespace root before Git ref creation fails', async () => {
    gitExecMock.mockImplementation(async (args: string[]) => ({
      stdout: args[0] === 'branch' ? 'refs/heads/cindy\n' : '',
      stderr: '',
    }));

    await expect(manager.suggestName(BASE_REPO)).rejects.toThrow(
      '分支 "cindy" 占用了 "cindy/*" 命名空间',
    );
  });

  it('preserves worktree still referenced by another live session', async () => {
    const meta = makeMeta('s1');
    storeMap.set('s1', meta);
    liveSessionRows.push({ id: 'other', workingDir: meta.path, worktreePath: null });

    await manager.removeWorktreeForSession('s1');

    expect(gitExecMock).not.toHaveBeenCalled();
    expect(storeMap.has('s1')).toBe(true);
  });

  it('preserves a clean worktree whose attached branch differs from Store metadata', async () => {
    const meta = makeMeta('s1');
    storeMap.set('s1', meta);
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'refs/heads/feature/manual-switch\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await manager.removeWorktreeForSession('s1');

    expect(isWorktreeDirtyMock).not.toHaveBeenCalled();
    expect(autoStashMock).not.toHaveBeenCalled();
    expect(gitExecMock).not.toHaveBeenCalledWith(
      ['worktree', 'remove', '--force', meta.path],
      BASE_REPO,
    );
    expect(storeMap.has('s1')).toBe(true);
  });

  it('preserves a dirty worktree before snapshotting when its branch changed', async () => {
    const meta = makeMeta('s1');
    storeMap.set('s1', meta);
    isWorktreeDirtyMock.mockResolvedValue(true);
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'refs/heads/feature/manual-switch\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await manager.removeWorktreeForSession('s1');

    expect(isWorktreeDirtyMock).not.toHaveBeenCalled();
    expect(autoStashMock).not.toHaveBeenCalled();
    expect(storeMap.has('s1')).toBe(true);
  });

  it('preserves detached or unreadable HEAD state', async () => {
    const meta = makeMeta('s1');
    storeMap.set('s1', meta);
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') throw new Error('detached HEAD');
      return { stdout: '', stderr: '' };
    });

    await manager.removeWorktreeForSession('s1');

    expect(isWorktreeDirtyMock).not.toHaveBeenCalled();
    expect(autoStashMock).not.toHaveBeenCalled();
    expect(storeMap.has('s1')).toBe(true);
  });

  it('preserves a worktree whose registered branch is outside its managed candidates', async () => {
    const meta = { ...makeMeta('s1'), branch: 'feature/manual-switch' };
    storeMap.set('s1', meta);

    await manager.removeWorktreeForSession('s1');

    expect(gitExecMock).not.toHaveBeenCalled();
    expect(isWorktreeDirtyMock).not.toHaveBeenCalled();
    expect(autoStashMock).not.toHaveBeenCalled();
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

    expect(gitExecMock).not.toHaveBeenCalledWith(
      ['worktree', 'remove', '--force', meta.path],
      BASE_REPO,
    );
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
    expect(gitExecMock).not.toHaveBeenCalledWith(
      ['worktree', 'remove', '--force', meta.path],
      BASE_REPO,
    );
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
    expect(gitExecMock).not.toHaveBeenCalledWith(
      ['worktree', 'remove', '--force', meta.path],
      BASE_REPO,
    );
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
      () =>
        new Promise<boolean>((resolve) => {
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
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: `refs/heads/${meta.branch}\n`, stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        throw new Error('worktree locked');
      }
      return { stdout: '', stderr: '' };
    });

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
      if (args[0] === 'symbolic-ref') {
        return { stdout: `refs/heads/${meta.branch}\n`, stderr: '' };
      }
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
      () =>
        new Promise<boolean>((resolve) => {
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

    expect(
      gitExecMock.mock.calls.filter(
        ([args]) => Array.isArray(args) && args[0] === 'worktree' && args[1] === 'remove',
      ),
    ).toHaveLength(1);
    expect(gitExecMock).toHaveBeenCalledWith(
      ['worktree', 'remove', '--force', meta.path],
      BASE_REPO,
    );
    expect(clearSnapshotRefMock).not.toHaveBeenCalled();
    expect(storeMap.has('s1')).toBe(false);
  });

  it('discard pre-created: absent and path mismatch are non-destructive', async () => {
    await expect(
      manager.discardPrecreatedWorktree('missing', '/repo/.xdt-worktrees/missing'),
    ).resolves.toEqual({ status: 'absent' });

    const meta = makeMeta('s1');
    storeMap.set('s1', meta);
    await expect(
      manager.discardPrecreatedWorktree('s1', path.join(BASE_REPO, 'elsewhere')),
    ).resolves.toEqual({ status: 'path-mismatch' });

    expect(gitExecMock).not.toHaveBeenCalled();
    expect(storeMap.get('s1')).toBe(meta);
  });

  it('discard pre-created: recovery waits for an in-flight create before deciding the record is absent', async () => {
    let releaseGitVersion!: () => void;
    gitExecMock.mockImplementationOnce(
      () =>
        new Promise<{ stdout: string; stderr: string }>((resolve) => {
          releaseGitVersion = () =>
            resolve({
              stdout: 'git version 2.50.0\n',
              stderr: '',
            });
        }),
    );
    const recoveryKey = 'recovery-key-123456';
    const create = manager.createWorktree({
      sessionId: 's1',
      baseRepo: BASE_REPO,
      name: 'recovery-race',
      sourceBranch: 'main',
      recoveryKey,
    });
    await vi.waitFor(() => {
      expect(gitExecMock).toHaveBeenCalledWith(['--version']);
    });

    let discardSettled = false;
    const discard = manager
      .discardPrecreatedWorktreeByRecoveryKey('s1', recoveryKey)
      .finally(() => {
        discardSettled = true;
      });
    await Promise.resolve();
    expect(discardSettled).toBe(false);

    releaseGitVersion();
    await expect(create).resolves.toMatchObject({ ok: false });
    await expect(discard).resolves.toEqual({ status: 'absent' });
  });

  it('discard pre-created: a matching recovery key resolves the registered path and reuses cleanup guards', async () => {
    const meta = {
      ...makeMeta('s1'),
      recoveryKey: 'recovery-key-123456',
    };
    storeMap.set('s1', meta);
    const canRemove = vi.fn(async () => false);

    await expect(
      manager.discardPrecreatedWorktreeByRecoveryKey('s1', meta.recoveryKey, { canRemove }),
    ).resolves.toEqual({ status: 'preserved' });

    expect(canRemove).toHaveBeenCalledTimes(1);
    expect(gitExecMock).not.toHaveBeenCalledWith(['worktree', 'remove', meta.path], BASE_REPO);
    expect(storeMap.get('s1')).toBe(meta);
  });

  it('discard pre-created: a mismatched recovery key is non-destructive', async () => {
    const meta = {
      ...makeMeta('s1'),
      recoveryKey: 'recovery-key-123456',
    };
    storeMap.set('s1', meta);

    await expect(
      manager.discardPrecreatedWorktreeByRecoveryKey('s1', 'different-key-123456'),
    ).resolves.toEqual({ status: 'path-mismatch' });

    expect(gitExecMock).not.toHaveBeenCalled();
    expect(storeMap.get('s1')).toBe(meta);
  });

  it('discard pre-created: dirty worktrees are preserved without auto-stashing', async () => {
    const meta = makeMeta('s1');
    storeMap.set('s1', meta);
    isWorktreeDirtyMock.mockResolvedValue(true);

    await expect(manager.discardPrecreatedWorktree('s1', meta.path)).resolves.toEqual({
      status: 'preserved',
    });

    expect(autoStashMock).not.toHaveBeenCalled();
    expect(gitExecMock).not.toHaveBeenCalledWith(['worktree', 'remove', meta.path], BASE_REPO);
    expect(storeMap.get('s1')).toBe(meta);
  });

  it('discard pre-created: a claimed session guard preserves the worktree', async () => {
    const meta = makeMeta('s1');
    storeMap.set('s1', meta);
    const canRemove = vi.fn(async () => false);

    await expect(
      manager.discardPrecreatedWorktree('s1', meta.path, { canRemove }),
    ).resolves.toEqual({ status: 'preserved' });

    expect(canRemove).toHaveBeenCalledTimes(1);
    expect(gitExecMock).not.toHaveBeenCalledWith(['worktree', 'remove', meta.path], BASE_REPO);
    expect(storeMap.get('s1')).toBe(meta);
  });

  it('discard pre-created: preserves files written after the dirty probe', async () => {
    const meta = makeMeta('s1');
    storeMap.set('s1', meta);
    isWorktreeDirtyMock.mockResolvedValue(false);
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: `refs/heads/${meta.branch}\n`, stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        throw new Error('worktree contains modified or untracked files');
      }
      return { stdout: '', stderr: '' };
    });

    await expect(manager.discardPrecreatedWorktree('s1', meta.path)).resolves.toEqual({
      status: 'preserved',
    });

    expect(gitExecMock).toHaveBeenCalledWith(['worktree', 'remove', meta.path], BASE_REPO);
    expect(gitExecMock).not.toHaveBeenCalledWith(
      ['worktree', 'remove', '--force', meta.path],
      BASE_REPO,
    );
    expect(gitExecMock).not.toHaveBeenCalledWith(expect.arrayContaining(['rev-list']), BASE_REPO);
    expect(storeMap.get('s1')).toBe(meta);
  });

  it('discard pre-created: preserves non-reproducible ignored files before removal', async () => {
    const meta = makeMeta('s1');
    storeMap.set('s1', meta);
    isWorktreeDirtyMock.mockResolvedValue(false);
    ignoredFilesMock.mockResolvedValue(['.env']);

    await expect(manager.discardPrecreatedWorktree('s1', meta.path)).resolves.toEqual({
      status: 'preserved',
    });

    expect(ignoredFilesMock).toHaveBeenCalledWith(BASE_REPO, meta.path);
    expect(gitExecMock).not.toHaveBeenCalledWith(['worktree', 'remove', meta.path], BASE_REPO);
    expect(storeMap.get('s1')).toBe(meta);
  });

  it('discard pre-created: ignored files mirrored exactly in base do not block removal', async () => {
    const meta = makeMeta('s1');
    storeMap.set('s1', meta);
    isWorktreeDirtyMock.mockResolvedValue(false);
    ignoredFilesMock.mockResolvedValue([]);

    await expect(manager.discardPrecreatedWorktree('s1', meta.path)).resolves.toMatchObject({
      status: 'discarded',
    });

    expect(ignoredFilesMock).toHaveBeenCalledWith(BASE_REPO, meta.path);
    expect(gitExecMock).toHaveBeenCalledWith(['worktree', 'remove', meta.path], BASE_REPO);
  });

  it('quarantines the worktree before the final ignored-file scan', async () => {
    const tmpRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), 'xdt-wt-quarantine-'));
    try {
      const base = path.join(tmpRoot, 'repo');
      const worktreePath = path.join(base, '.xdt-worktrees', 's1');
      fsSync.mkdirSync(worktreePath, { recursive: true });
      const meta: WorktreeMeta = {
        ...makeMeta('s1'),
        baseRepo: base,
        path: worktreePath,
      };
      storeMap.set('s1', meta);
      ignoredFilesMock.mockResolvedValueOnce([]).mockResolvedValueOnce(['.env']);

      await expect(manager.discardPrecreatedWorktree('s1', meta.path)).resolves.toEqual({
        status: 'preserved',
      });

      const moves = gitExecMock.mock.calls.filter(
        ([args]) => Array.isArray(args) && args[0] === 'worktree' && args[1] === 'move',
      );
      expect(moves).toHaveLength(2);
      const quarantinePath = moves[0][0][3] as string;
      expect(moves[0][0]).toEqual(['worktree', 'move', meta.path, quarantinePath]);
      expect(moves[1][0]).toEqual(['worktree', 'move', quarantinePath, meta.path]);
      expect(ignoredFilesMock).toHaveBeenNthCalledWith(1, base, meta.path);
      expect(ignoredFilesMock).toHaveBeenNthCalledWith(2, base, quarantinePath);
      expect(gitExecMock).not.toHaveBeenCalledWith(['worktree', 'remove', quarantinePath], base);
      expect(storeMap.get('s1')).toEqual(meta);
      expect(storeSetMock).toHaveBeenCalledWith('s1', expect.objectContaining({ quarantinePath }));
    } finally {
      fsSync.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('resumes a persisted quarantine path after restart while accepting the original ledger path', async () => {
    const tmpRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), 'xdt-wt-quarantine-restart-'));
    try {
      const base = path.join(tmpRoot, 'repo');
      const worktreePath = path.join(base, '.xdt-worktrees', 's1');
      const quarantinePath = `${worktreePath}.xdt-removing-crashed`;
      fsSync.mkdirSync(quarantinePath, { recursive: true });
      const meta: WorktreeMeta = {
        ...makeMeta('s1'),
        baseRepo: base,
        path: worktreePath,
        quarantinePath,
      };
      storeMap.set('s1', meta);

      await expect(manager.discardPrecreatedWorktree('s1', worktreePath)).resolves.toEqual({
        status: 'discarded',
        branchDeleted: false,
      });

      expect(ignoredFilesMock).toHaveBeenCalledWith(base, quarantinePath);
      expect(gitExecMock).toHaveBeenCalledWith(['worktree', 'remove', quarantinePath], base);
      expect(gitExecMock).not.toHaveBeenCalledWith(
        ['worktree', 'move', worktreePath, quarantinePath],
        base,
      );
      expect(storeMap.has('s1')).toBe(false);
    } finally {
      fsSync.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('does not move a worktree when quarantine state cannot be persisted', async () => {
    const tmpRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), 'xdt-wt-quarantine-persist-'));
    try {
      const base = path.join(tmpRoot, 'repo');
      const worktreePath = path.join(base, '.xdt-worktrees', 's1');
      fsSync.mkdirSync(worktreePath, { recursive: true });
      const meta: WorktreeMeta = {
        ...makeMeta('s1'),
        baseRepo: base,
        path: worktreePath,
      };
      storeMap.set('s1', meta);
      storeSetMock.mockRejectedValueOnce(new Error('disk full'));

      await expect(manager.discardPrecreatedWorktree('s1', worktreePath)).resolves.toEqual({
        status: 'preserved',
      });

      expect(gitExecMock).not.toHaveBeenCalledWith(
        ['worktree', 'move', worktreePath, expect.any(String)],
        base,
      );
      expect(storeMap.get('s1')).toBe(meta);
    } finally {
      fsSync.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('discard pre-created: removes a clean worktree and its commit-equivalent generated branch', async () => {
    const meta = makeMeta('s1');
    storeMap.set('s1', meta);
    const gitOperations: string[] = [];
    gitExecMock.mockImplementation(async (args: string[]) => {
      gitOperations.push(args[0] ?? '');
      return {
        stdout:
          args[0] === 'symbolic-ref'
            ? `refs/heads/${meta.branch}\n`
            : args[0] === 'rev-parse'
              ? 'abc123\n'
              : args[0] === 'rev-list'
                ? '0\n'
                : '',
        stderr: '',
      };
    });

    await expect(manager.discardPrecreatedWorktree('s1', meta.path)).resolves.toEqual({
      status: 'discarded',
      branchDeleted: true,
    });

    expect(gitExecMock).toHaveBeenCalledWith(
      ['rev-list', '--count', `${meta.sourceBranch}..${meta.branch}`],
      BASE_REPO,
    );
    expect(gitExecMock).toHaveBeenCalledWith(['worktree', 'remove', meta.path], BASE_REPO);
    expect(gitExecMock).toHaveBeenCalledWith(
      ['update-ref', '-d', `refs/heads/${meta.branch}`, 'abc123'],
      BASE_REPO,
    );
    expect(gitOperations).toEqual([
      'symbolic-ref',
      'worktree',
      'rev-parse',
      'rev-list',
      'update-ref',
    ]);
    expect(storeMap.has('s1')).toBe(false);
  });

  it('discard pre-created: preserves a generated branch with a unique commit', async () => {
    const meta = makeMeta('s1');
    storeMap.set('s1', meta);
    gitExecMock.mockImplementation(async (args: string[]) => ({
      stdout:
        args[0] === 'symbolic-ref'
          ? `refs/heads/${meta.branch}\n`
          : args[0] === 'rev-parse'
            ? 'abc123\n'
            : args[0] === 'rev-list'
              ? '1\n'
              : '',
      stderr: '',
    }));

    await expect(manager.discardPrecreatedWorktree('s1', meta.path)).resolves.toEqual({
      status: 'discarded',
      branchDeleted: false,
    });

    expect(gitExecMock).toHaveBeenCalledWith(['worktree', 'remove', meta.path], BASE_REPO);
    expect(gitExecMock).not.toHaveBeenCalledWith(
      expect.arrayContaining(['update-ref', '-d']),
      BASE_REPO,
    );
    expect(storeMap.has('s1')).toBe(false);
  });

  it('discard pre-created: preserves a branch whose tip changes before deletion', async () => {
    const meta = makeMeta('s1');
    storeMap.set('s1', meta);
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: `refs/heads/${meta.branch}\n`, stderr: '' };
      }
      if (args[0] === 'rev-parse') return { stdout: 'abc123\n', stderr: '' };
      if (args[0] === 'rev-list') return { stdout: '0\n', stderr: '' };
      if (args[0] === 'update-ref') throw new Error('cannot lock ref: expected abc123');
      return { stdout: '', stderr: '' };
    });

    await expect(manager.discardPrecreatedWorktree('s1', meta.path)).resolves.toEqual({
      status: 'discarded',
      branchDeleted: false,
    });

    expect(gitExecMock).toHaveBeenCalledWith(
      ['update-ref', '-d', `refs/heads/${meta.branch}`, 'abc123'],
      BASE_REPO,
    );
  });

  it('discard pre-created: preserves a worktree registered to a non-managed branch', async () => {
    const meta = {
      ...makeMeta('s1'),
      branch: 'main',
    };
    storeMap.set('s1', meta);

    await expect(manager.discardPrecreatedWorktree('s1', meta.path)).resolves.toEqual({
      status: 'preserved',
    });

    expect(gitExecMock).not.toHaveBeenCalled();
    expect(gitExecMock).not.toHaveBeenCalledWith(
      expect.arrayContaining(['update-ref', '-d']),
      BASE_REPO,
    );
    expect(gitExecMock).not.toHaveBeenCalledWith(expect.arrayContaining(['rev-list']), BASE_REPO);
  });
});
