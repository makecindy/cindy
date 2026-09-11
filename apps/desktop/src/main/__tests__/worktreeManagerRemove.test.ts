// Normal archive/deletion coverage moved to managedWorktreeRecycle.test.ts:
// non-mutating content snapshots replace the former stash/reapply contract.
vi.mock('../worktree/runtimeLeases', () => ({
  readWorktreeRuntimePaths: async () => new Set(),
  acquireWorktreeRuntimeLease: async () => {}, releaseWorktreeRuntimeLease: async () => {},
}));
/**
 * removeWorktreeForSession / discardPrecreatedWorktree 删除守卫回归:
 *   - live-ref 守卫:其它 live 会话仍引用路径 → 保留;终态引用需确认 runtime 已关闭
 *   - 排除自身:owning session 自己的路径不算引用
 *   - dirty → stash 失败保留 / 成功后继续删
 *   - clean 无引用 → git remove + store.del
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fsSync from 'node:fs';
import os from 'node:os';

import type { WorktreeMeta } from '../worktree/types';
import { withWorktreeRestoreMutation } from '../worktree/restoreLock';

const gitExecMock = vi.fn();
const crossProcessLockMock = vi.fn();
const isWorktreeDirtyMock = vi.fn();
const autoStashMock = vi.fn();
const restoreAutoStashMock = vi.fn();
const clearSnapshotRefMock = vi.fn();
const ignoredFilesMock = vi.fn();
const changedIncludeFilesMock = vi.fn();
const storeSetMock = vi.fn();
const storeMap = new Map<string, WorktreeMeta>();
const pendingSafeDirectoryCleanups: string[] = [];
const liveSessionRows: Array<{
  id: string;
  status: string | null;
  workingDir: string | null;
  worktreePath: string | null;
}> = [];
let liveSessionLookupError: Error | null = null;

vi.mock('../worktree/gitExec', () => ({
  gitExec: (...args: unknown[]) => gitExecMock(...args),
  GitExecError: class GitExecError extends Error {},
  globalSafeDirectoryLockPath: () => '/tmp/cindy-git-safe-directory.lock',
  safeDirectorySpellings: (p: string) => {
    const normalized = process.platform === 'win32' ? p.replace(/\\/g, '/') : p;
    return normalized === p ? [p] : [normalized, p];
  },
}));

vi.mock('../device-link/crossProcessLock', () => ({
  withCrossProcessLock: (...args: unknown[]) => crossProcessLockMock(...args),
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
  replace: async (previousId: string, nextId: string, meta: WorktreeMeta) => {
    storeMap.delete(previousId);
    storeMap.set(nextId, meta);
  },
  del: vi.fn((sessionId: string) => storeMap.delete(sessionId)),
  getPendingSafeDirectoryCleanups: () => [...pendingSafeDirectoryCleanups],
  addPendingSafeDirectoryCleanups: (paths: readonly string[]) => {
    for (const p of paths) {
      if (p && !pendingSafeDirectoryCleanups.includes(p)) pendingSafeDirectoryCleanups.push(p);
    }
  },
  removePendingSafeDirectoryCleanups: (paths: readonly string[]) => {
    const toRemove = new Set(paths);
    for (let i = pendingSafeDirectoryCleanups.length - 1; i >= 0; i -= 1) {
      if (toRemove.has(pendingSafeDirectoryCleanups[i])) pendingSafeDirectoryCleanups.splice(i, 1);
    }
  },
}));

vi.mock('../localDb/client/current', () => ({
  getDbClient: () => ({
    readLocalWorktreeReferences: async () => {
      if (liveSessionLookupError) throw liveSessionLookupError;
      return liveSessionRows.map((row) => ({ ...row, source: 'desktop', currentDatabase: true }));
    },
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
    vi.clearAllMocks();
    storeMap.clear();
    pendingSafeDirectoryCleanups.length = 0;
    liveSessionRows.length = 0;
    liveSessionRows.push({
      id: '__unrelated_active_session__',
      status: 'active',
      workingDir: path.join(BASE_REPO, 'unrelated'),
      worktreePath: null,
    });
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
    crossProcessLockMock
      .mockReset()
      .mockImplementation(
        (_lockPath: string, _opts: unknown, task: (status: unknown) => Promise<unknown>) =>
          task({ held: true }),
      );
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

  it('transfers the same branch/path through repeated continuations without recycling the old owner', async () => {
    const meta = makeMeta('original');
    storeMap.set('original', meta);
    await manager.withTransferredSession('original', 'continued', meta.path, async () => {
      expect(manager.getForSession('original')).toBeNull();
      expect(manager.getForSession('continued')).toEqual({ ...meta, sessionId: 'continued' });
      return { reopened: true };
    });
    await manager.removeWorktreeForSession('original');
    await manager.withTransferredSession('continued', 'continued-again', meta.path, async () => ({ reopened: true }));
    expect(manager.getForSession('continued')).toBeNull();
    expect(manager.getForSession('continued-again')).toEqual({ ...meta, sessionId: 'continued-again' });
    expect(gitExecMock).not.toHaveBeenCalled();
  });

  it.each(['throw', 'cas'] as const)('restores the original worktree owner after a %s transaction failure', async failure => {
    const meta = makeMeta('original');
    storeMap.set('original', meta);
    const operation = manager.withTransferredSession('original', 'continued', meta.path, async () => {
      if (failure === 'throw') throw new Error('fixture DB failure');
      return { reopened: false };
    });
    if (failure === 'throw') await expect(operation).rejects.toThrow('fixture DB failure');
    else expect(await operation).toEqual({ reopened: false });
    expect(manager.getForSession('original')).toEqual(meta);
    expect(manager.getForSession('continued')).toBeNull();
    expect(gitExecMock).not.toHaveBeenCalled();
  });

  it('refuses a stale or conflicting transfer without calling the child transaction', async () => {
    const meta = makeMeta('original');
    storeMap.set('original', meta);
    storeMap.set('continued', makeMeta('continued'));
    const commit = vi.fn();
    await expect(manager.withTransferredSession('original', 'continued', meta.path, commit)).rejects.toThrow('ownership changed');
    await expect(manager.withTransferredSession('missing', 'other', meta.path, commit)).rejects.toThrow('ownership changed');
    expect(commit).not.toHaveBeenCalled();
    expect(manager.getForSession('original')).toEqual(meta);
  });

  it('no store entry → no-op', async () => {
    await manager.removeWorktreeForSession('nope');
    expect(gitExecMock).not.toHaveBeenCalled();
  });

  it('a no-options compensation call cannot remove a registered active task', async () => {
    const meta = makeMeta('active');
    storeMap.set(meta.sessionId, meta);
    liveSessionRows.push({ id: meta.sessionId, status: 'active', workingDir: meta.path, worktreePath: meta.path });
    await manager.removeWorktreeForSession(meta.sessionId);
    expect(gitExecMock.mock.calls.some(([args]) => args.includes('remove'))).toBe(false);
    expect(storeMap.get(meta.sessionId)).toEqual(meta);
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
    let releaseGitProbe!: () => void;
    gitExecMock.mockImplementationOnce(
      () =>
        new Promise<{ stdout: string; stderr: string }>((resolve) => {
          releaseGitProbe = () =>
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
      expect(gitExecMock).toHaveBeenCalledWith(
        ['rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD', '--git-dir', '--git-common-dir'],
        BASE_REPO,
        { timeoutMs: 10_000 },
      );
    });

    let discardSettled = false;
    const discard = manager
      .discardPrecreatedWorktreeByRecoveryKey('s1', recoveryKey)
      .finally(() => {
        discardSettled = true;
      });
    await Promise.resolve();
    expect(discardSettled).toBe(false);

    releaseGitProbe();
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
      const originalGit = gitExecMock.getMockImplementation()!;
      gitExecMock.mockImplementation(async (args, cwd) => {
        if (args[0] === 'worktree' && args[1] === 'remove' && args[2] === quarantinePath) {
          fsSync.rmSync(quarantinePath, { recursive: true });
        }
        return originalGit(args, cwd);
      });
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

  it('discard pre-created: cleans the generated quarantine path from global safe.directory', async () => {
    const tmpRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), 'xdt-wt-safedir-'));
    try {
      const base = path.join(tmpRoot, 'repo');
      const worktreePath = path.join(base, '.xdt-worktrees', 's1');
      fsSync.mkdirSync(worktreePath, { recursive: true });
      const meta: WorktreeMeta = { ...makeMeta('s1'), baseRepo: base, path: worktreePath };
      storeMap.set('s1', meta);

      await expect(manager.discardPrecreatedWorktree('s1', worktreePath)).resolves.toEqual({
        status: 'discarded',
        branchDeleted: false,
      });

      // 本轮 preserveDirty 现场生成的 .xdt-removing-* 路径
      const moveCalls = gitExecMock.mock.calls.filter(
        ([args]) => Array.isArray(args) && args[0] === 'worktree' && args[1] === 'move',
      );
      expect(moveCalls).toHaveLength(1);
      const quarantinePath = moveCalls[0][0][3] as string;

      // 原路径与本轮生成路径都要从全局 safe.directory 精确清理(#2627)
      expect(gitExecMock).toHaveBeenCalledWith([
        'config',
        '--global',
        '--unset-all',
        '--fixed-value',
        'safe.directory',
        worktreePath,
      ]);
      expect(gitExecMock).toHaveBeenCalledWith([
        'config',
        '--global',
        '--unset-all',
        '--fixed-value',
        'safe.directory',
        quarantinePath,
      ]);
    } finally {
      fsSync.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('defers safe.directory cleanup to the store when the global lock is not acquired', async () => {
    crossProcessLockMock.mockImplementation(
      (_lockPath: string, opts: { label: string }, task: (status: unknown) => Promise<unknown>) =>
        task(opts.label === 'worktree-resource' ? { held: true } : { held: false, reason: 'busy' }),
    );
    const meta = makeMeta('s1');
    storeMap.set('s1', meta);

    await manager.removeWorktreeForSession('s1', { preserveDirty: true });

    // 目录已删、store.del 已执行; 拿不到锁时不得做无锁 --unset-all, 而是落盘待下次启动补清
    expect(
      gitExecMock.mock.calls.some(([args]) => Array.isArray(args) && args.includes('--unset-all')),
    ).toBe(false);
    expect(pendingSafeDirectoryCleanups).toContain(meta.path);
  });

  it('reconcilePendingSafeDirectoryCleanups drains pending entries under the lock', async () => {
    const gonePath = path.join(BASE_REPO, '.xdt-worktrees', 'gone');
    pendingSafeDirectoryCleanups.push(gonePath);
    crossProcessLockMock.mockImplementation(
      (_lockPath: string, _opts: unknown, task: (status: unknown) => Promise<unknown>) =>
        task({ held: true }),
    );

    await manager.reconcilePendingSafeDirectoryCleanups();

    expect(gitExecMock).toHaveBeenCalledWith([
      'config',
      '--global',
      '--unset-all',
      '--fixed-value',
      'safe.directory',
      gonePath,
    ]);
    expect(pendingSafeDirectoryCleanups).toEqual([]);
  });

  it('reconcile skips and drops pending paths re-created by a live worktree', async () => {
    // 旧删除留下的待办 + 同名新 worktree 已在 store 里占用该路径
    const reusedPath = path.join(BASE_REPO, '.xdt-worktrees', 'reused');
    const orphanPath = path.join(BASE_REPO, '.xdt-worktrees', 'orphan');
    pendingSafeDirectoryCleanups.push(reusedPath, orphanPath);
    storeMap.set('s-new', { ...makeMeta('reused'), path: reusedPath });
    crossProcessLockMock.mockImplementation(
      (_lockPath: string, _opts: unknown, task: (status: unknown) => Promise<unknown>) =>
        task({ held: true }),
    );

    await manager.reconcilePendingSafeDirectoryCleanups();

    // 复用路径: 不 --unset-all(条目归新 worktree), 只从待办移除
    expect(
      gitExecMock.mock.calls.some(([args]) => Array.isArray(args) && args.includes(reusedPath)),
    ).toBe(false);
    // 孤儿路径: 正常清理并出队
    expect(gitExecMock).toHaveBeenCalledWith([
      'config',
      '--global',
      '--unset-all',
      '--fixed-value',
      'safe.directory',
      orphanPath,
    ]);
    expect(pendingSafeDirectoryCleanups).toEqual([]);
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
    // config 是 safe.directory 清理的副作用, 其次数随平台拼写数(POSIX 1 次 / Windows
    // 正反斜杠 2 次)变化, 不参与这里的顺序断言。
    expect(gitOperations.filter((op) => op !== 'config')).toEqual([
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
