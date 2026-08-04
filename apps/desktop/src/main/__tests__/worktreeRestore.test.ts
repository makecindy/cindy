/**
 * restore.ts 回归(P1):worktree 回收后的状态查询与一键恢复。
 * 路径存在性走真实 fs(tmp 目录),git/db/store 全 mock。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fsSync from 'node:fs';
import os from 'node:os';

import { withWorktreeRestoreMutation } from '../worktree/restoreLock';

const gitExecMock = vi.fn();
const { MockGitExecError } = vi.hoisted(() => ({
  MockGitExecError: class extends Error {
    constructor(public readonly stderr: string) {
      super(stderr);
    }
  },
}));
const storeSetMock = vi.fn();
const storeGetMock = vi.fn();
const storeGetAllMock = vi.fn();
const storeDelMock = vi.fn();
const applyIncludeMock = vi.fn();
const copyClaudeSiviDirsMock = vi.fn();
let dbWorktreePath: string | null = null;
let dbWorkingDir: string | null = null;
let dbBindingRows: Array<{
  workingDir: string | null;
  worktreePath: string | null;
}> = [];
let dbOwnerRows: Array<{
  id: string;
  worktreePath: string | null;
  status: 'active' | 'archived' | 'deleted';
}> = [];

vi.mock('../worktree/gitExec', () => ({
  gitExec: (...args: unknown[]) => gitExecMock(...args),
  GitExecError: MockGitExecError,
}));

vi.mock('../worktree/worktreeStore', () => ({
  set: (...args: unknown[]) => storeSetMock(...args),
  get: (...args: unknown[]) => storeGetMock(...args),
  del: (...args: unknown[]) => storeDelMock(...args),
  getAll: (...args: unknown[]) => storeGetAllMock(...args),
}));

vi.mock('../worktree/includePatternsEngine', () => ({
  applyWorktreeIncludeFile: (...args: unknown[]) => applyIncludeMock(...args),
}));

vi.mock('../worktree/WorktreeManager', () => ({
  copyClaudeSiviDirs: (...args: unknown[]) => copyClaudeSiviDirsMock(...args),
}));

vi.mock('../localDb/client/current', () => ({
  getDbClient: () => ({
    drizzle: {
      select: (selection: Record<string, unknown>) => ({
        from: () => ({
          where: () => {
            if ('id' in selection) return dbOwnerRows;
            if (dbBindingRows.length > 0) return [dbBindingRows.shift()!];
            return dbWorktreePath === undefined
              ? []
              : [
                  {
                    workingDir: dbWorkingDir,
                    worktreePath: dbWorktreePath,
                  },
                ];
          },
        }),
      }),
    },
  }),
}));

const SHA = 'c'.repeat(40);
const AUTO_STASH = `${SHA}\tOn xdt/wt1: xdt-auto-stash: session s1 worktree=wt1`;

function argsOf(call: unknown[]): string[] {
  return call[0] as string[];
}

describe('worktree restore', () => {
  let tmpRoot: string;
  let baseRepo: string;
  let wtPath: string;
  let mod: typeof import('../worktree/restore');

  beforeEach(async () => {
    tmpRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), 'xdt-wt-restore-'));
    baseRepo = path.join(tmpRoot, 'repo');
    fsSync.mkdirSync(path.join(baseRepo, '.cindy-worktrees'), { recursive: true });
    wtPath = path.join(baseRepo, '.cindy-worktrees', 'wt1');
    dbWorktreePath = wtPath;
    dbWorkingDir = wtPath;
    dbBindingRows = [];
    dbOwnerRows = [];
    gitExecMock.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
    storeSetMock.mockReset().mockResolvedValue(undefined);
    storeGetMock.mockReset().mockReturnValue(null);
    storeGetAllMock.mockReset().mockReturnValue([]);
    storeDelMock.mockReset();
    applyIncludeMock.mockReset().mockResolvedValue([]);
    copyClaudeSiviDirsMock.mockReset().mockResolvedValue(undefined);
    mod = await import('../worktree/restore');
  });

  afterEach(() => {
    fsSync.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('no worktree_path in DB → no-worktree', async () => {
    dbWorktreePath = null;
    await expect(mod.getWorktreeRestoreStatus('s1')).resolves.toEqual({ state: 'no-worktree' });
  });

  it('send-time owner restore uses the store path when its best-effort DB sync is missing', async () => {
    dbWorktreePath = null;
    fsSync.mkdirSync(wtPath, { recursive: true });
    const meta = { sessionId: 'owner', path: wtPath };
    storeGetMock.mockImplementation((sessionId: string) => (sessionId === 'owner' ? meta : null));
    storeGetAllMock.mockReturnValue([meta]);
    dbOwnerRows = [{ id: 'owner', worktreePath: null, status: 'active' }];
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'refs/heads/xdt/wt1\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args.includes('refs/xdt/snapshots/owner')) {
        return { stdout: `${SHA}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await expect(mod.restoreMissingManagedWorktreeForSession('borrower', wtPath)).resolves.toBe(
      true,
    );

    const calls = gitExecMock.mock.calls.map(argsOf);
    expect(calls).toContainEqual(['stash', 'apply', SHA]);
    expect(calls).toContainEqual(['update-ref', '-d', 'refs/xdt/snapshots/owner']);
  });

  it('non-managed path shape → no-worktree (never touches git)', async () => {
    dbWorktreePath = path.join(tmpRoot, 'elsewhere', 'dir');
    await expect(mod.getWorktreeRestoreStatus('s1')).resolves.toEqual({ state: 'no-worktree' });
    expect(gitExecMock).not.toHaveBeenCalled();
  });

  it('directory still on disk → present', async () => {
    fsSync.mkdirSync(wtPath, { recursive: true });
    await expect(mod.getWorktreeRestoreStatus('s1')).resolves.toEqual({
      state: 'present',
      worktreePath: wtPath,
      hasSnapshot: false,
    });
  });

  it('present directory without Store metadata re-registers its actual HEAD branch', async () => {
    fsSync.mkdirSync(wtPath, { recursive: true });
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'refs/heads/cindy/wt1\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await expect(mod.restoreWorktreeForSession('s1')).resolves.toEqual({
      ok: true,
      snapshotApplied: true,
    });
    expect(storeSetMock).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ branch: 'cindy/wt1', sourceBranch: 'cindy/wt1' }),
    );
  });

  it.each(['feature/foo', 'cindy/other'])(
    'present directory without Store metadata does not register non-candidate branch %s',
    async (branch) => {
      fsSync.mkdirSync(wtPath, { recursive: true });
      gitExecMock.mockImplementation(async (args: string[]) => {
        if (args[0] === 'symbolic-ref') {
          return { stdout: `refs/heads/${branch}\n`, stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      await expect(mod.restoreWorktreeForSession('s1')).resolves.toEqual({
        ok: true,
        snapshotApplied: true,
      });
      expect(storeSetMock).not.toHaveBeenCalled();
    },
  );

  it('preserves a pending snapshot when the existing directory is on a custom branch', async () => {
    fsSync.mkdirSync(wtPath, { recursive: true });
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'refs/heads/feature/manual-switch\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args.includes('refs/xdt/snapshots/s1')) {
        return { stdout: `${SHA}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await expect(mod.restoreWorktreeForSession('s1')).resolves.toEqual({
      ok: true,
      snapshotApplied: false,
    });
    expect(gitExecMock.mock.calls.map(argsOf)).not.toContainEqual(['stash', 'apply', SHA]);
    expect(storeSetMock).not.toHaveBeenCalled();
  });

  it('present directory prefers actual HEAD when Store metadata is stale', async () => {
    fsSync.mkdirSync(wtPath, { recursive: true });
    storeGetMock
      .mockReturnValueOnce({
        sessionId: 's1',
        name: 'wt1',
        path: wtPath,
        baseRepo,
        branch: 'xdt/wt1',
        sourceBranch: 'main',
        createdAt: '2026-08-04T00:00:00.000Z',
      })
      .mockReturnValueOnce(null);
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'refs/heads/cindy/wt1\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await expect(mod.restoreWorktreeForSession('s1')).resolves.toEqual({
      ok: true,
      snapshotApplied: true,
    });
    expect(storeSetMock).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ branch: 'cindy/wt1', sourceBranch: 'cindy/wt1' }),
    );
  });

  it('legacy .xdt-worktrees directory still on disk → present', async () => {
    const legacyPath = path.join(baseRepo, '.xdt-worktrees', 'wt1');
    fsSync.mkdirSync(legacyPath, { recursive: true });
    dbWorktreePath = legacyPath;

    await expect(mod.getWorktreeRestoreStatus('s1')).resolves.toEqual({
      state: 'present',
      worktreePath: legacyPath,
      hasSnapshot: false,
    });
  });

  it('present directory with pending snapshot stays restorable and retries apply', async () => {
    fsSync.mkdirSync(wtPath, { recursive: true });
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'refs/heads/xdt/wt1\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args.includes('refs/xdt/snapshots/s1')) {
        return { stdout: `${SHA}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await expect(mod.getWorktreeRestoreStatus('s1')).resolves.toEqual({
      state: 'present',
      worktreePath: wtPath,
      hasSnapshot: true,
    });

    const result = await mod.restoreWorktreeForSession('s1');
    expect(result).toEqual({ ok: true, snapshotApplied: true });

    const calls = gitExecMock.mock.calls.map(argsOf);
    expect(calls.some((a) => a[0] === 'stash' && a[1] === 'apply' && a[2] === SHA)).toBe(true);
    expect(storeSetMock).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ sessionId: 's1', path: wtPath, branch: 'xdt/wt1' }),
    );
  });

  it('present directory ignores a consumed snapshot ref left behind after apply', async () => {
    fsSync.mkdirSync(wtPath, { recursive: true });
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (
        args[0] === 'rev-parse' &&
        (args.includes('refs/xdt/snapshots/s1') || args.includes('refs/xdt/snapshots-consumed/s1'))
      ) {
        return { stdout: `${SHA}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await expect(mod.getWorktreeRestoreStatus('s1')).resolves.toEqual({
      state: 'present',
      worktreePath: wtPath,
      hasSnapshot: false,
    });
    await expect(mod.restoreWorktreeForSession('s1')).resolves.toEqual({
      ok: true,
      snapshotApplied: true,
    });

    const calls = gitExecMock.mock.calls.map(argsOf);
    expect(calls.some((args) => args[0] === 'stash' && args[1] === 'apply')).toBe(false);
  });

  it('local and origin tracking branches missing → gone', async () => {
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (
        args[0] === 'rev-parse' &&
        (args.includes('refs/heads/xdt/wt1') || args.includes('refs/remotes/origin/xdt/wt1'))
      ) {
        throw new Error('unknown revision');
      }
      return { stdout: '', stderr: '' };
    });
    await expect(mod.getWorktreeRestoreStatus('s1')).resolves.toEqual({
      state: 'gone',
      worktreePath: wtPath,
    });
  });

  it('local branch missing + origin tracking branch present → restorable', async () => {
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/xdt/wt1')) {
        throw new Error('unknown revision');
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/xdt/wt1')) {
        return { stdout: 'deadbeef\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await expect(mod.getWorktreeRestoreStatus('s1')).resolves.toEqual({
      state: 'restorable',
      worktreePath: wtPath,
      hasSnapshot: false,
    });
  });

  it('new cindy branch missing locally + origin tracking branch present → restorable', async () => {
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/cindy/wt1')) {
        throw new Error('unknown revision');
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/cindy/wt1')) {
        return { stdout: 'deadbeef\n', stderr: '' };
      }
      if (
        args[0] === 'rev-parse' &&
        (args.includes('refs/heads/xdt/wt1') || args.includes('refs/remotes/origin/xdt/wt1'))
      ) {
        throw new Error('unknown revision');
      }
      return { stdout: '', stderr: '' };
    });

    await expect(mod.getWorktreeRestoreStatus('s1')).resolves.toEqual({
      state: 'restorable',
      worktreePath: wtPath,
      hasSnapshot: false,
    });
  });

  it('new and legacy branches both exist → fail closed without restoring either', async () => {
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (
        args[0] === 'rev-parse' &&
        (args.includes('refs/heads/cindy/wt1') || args.includes('refs/heads/xdt/wt1'))
      ) {
        return { stdout: 'deadbeef\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await expect(mod.getWorktreeRestoreStatus('s1')).resolves.toEqual({
      state: 'gone',
      worktreePath: wtPath,
    });
    await expect(mod.restoreWorktreeForSession('s1')).resolves.toEqual({
      ok: false,
      reason: 'gone',
    });
    const calls = gitExecMock.mock.calls.map(argsOf);
    expect(calls.some((args) => args[0] === 'branch')).toBe(false);
    expect(calls.some((args) => args[0] === '-c' && args[3] === 'add')).toBe(false);
  });

  it('branch present + snapshot present → restorable with hasSnapshot', async () => {
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/xdt/wt1')) {
        return { stdout: 'deadbeef\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args.includes('refs/xdt/snapshots/s1')) {
        return { stdout: `${SHA}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    await expect(mod.getWorktreeRestoreStatus('s1')).resolves.toEqual({
      state: 'restorable',
      worktreePath: wtPath,
      hasSnapshot: true,
    });
  });

  it('Store branch wins even when the pooled path basename differs from meta.name', async () => {
    const pooledMeta = {
      sessionId: 's1',
      name: 'scheduled-task',
      path: wtPath,
      baseRepo,
      branch: 'xdt/scheduled-task',
      sourceBranch: 'main',
      createdAt: '2026-08-04T00:00:00.000Z',
    };
    storeGetMock.mockReturnValue(pooledMeta);
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/xdt/scheduled-task')) {
        return { stdout: 'deadbeef\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await expect(mod.restoreWorktreeForSession('s1')).resolves.toEqual({
      ok: true,
      snapshotApplied: true,
    });
    expect(gitExecMock.mock.calls.map(argsOf)).toContainEqual([
      '-c',
      'core.longpaths=true',
      'worktree',
      'add',
      wtPath,
      'xdt/scheduled-task',
    ]);
    expect(storeSetMock).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ name: 'scheduled-task', branch: 'xdt/scheduled-task' }),
    );
  });

  it('ignores a custom Store branch and restores only the matching managed candidate', async () => {
    storeGetMock.mockReturnValue({
      sessionId: 's1',
      name: 'wt1',
      path: wtPath,
      baseRepo,
      branch: 'feature/manual-switch',
      sourceBranch: 'main',
      createdAt: '2026-08-04T00:00:00.000Z',
    });
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/xdt/wt1')) {
        return { stdout: 'deadbeef\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await expect(mod.restoreWorktreeForSession('s1')).resolves.toEqual({
      ok: true,
      snapshotApplied: true,
    });

    const calls = gitExecMock.mock.calls.map(argsOf);
    expect(calls).not.toContainEqual([
      'rev-parse',
      '--verify',
      '--quiet',
      'refs/heads/feature/manual-switch',
    ]);
    expect(calls).toContainEqual([
      '-c',
      'core.longpaths=true',
      'worktree',
      'add',
      wtPath,
      'xdt/wt1',
    ]);
  });

  it('restore: worktree add + snapshot apply + store re-register', async () => {
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/xdt/wt1')) {
        return { stdout: 'deadbeef\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args.includes('refs/xdt/snapshots/s1')) {
        return { stdout: `${SHA}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const result = await mod.restoreWorktreeForSession('s1');
    expect(result).toEqual({ ok: true, snapshotApplied: true });

    const calls = gitExecMock.mock.calls.map(argsOf);
    expect(calls).toContainEqual([
      '-c',
      'core.longpaths=true',
      'worktree',
      'add',
      wtPath,
      'xdt/wt1',
    ]);
    expect(copyClaudeSiviDirsMock).toHaveBeenCalledWith(baseRepo, wtPath, {
      overwriteExisting: false,
    });
    expect(applyIncludeMock).toHaveBeenCalledWith(baseRepo, wtPath, {
      overwriteExisting: false,
    });
    expect(calls.some((a) => a[0] === 'stash' && a[1] === 'apply' && a[2] === SHA)).toBe(true);
    const snapshotApplyOrder =
      gitExecMock.mock.invocationCallOrder[
        calls.findIndex((a) => a[0] === 'stash' && a[1] === 'apply' && a[2] === SHA)
      ];
    expect(snapshotApplyOrder).toBeLessThan(copyClaudeSiviDirsMock.mock.invocationCallOrder[0]!);
    expect(snapshotApplyOrder).toBeLessThan(applyIncludeMock.mock.invocationCallOrder[0]!);
    expect(
      calls.some((a) => a[0] === 'update-ref' && a[1] === '-d' && a[2] === 'refs/xdt/snapshots/s1'),
    ).toBe(true);
    expect(storeSetMock).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ sessionId: 's1', path: wtPath, branch: 'xdt/wt1' }),
    );
  });

  it('restore: recreates a deleted local branch from origin before worktree add', async () => {
    let localBranchCreated = false;
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/xdt/wt1')) {
        if (!localBranchCreated) throw new Error('unknown revision');
        return { stdout: 'deadbeef\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/xdt/wt1')) {
        return { stdout: 'deadbeef\n', stderr: '' };
      }
      if (args[0] === 'branch' && args[1] === 'xdt/wt1') {
        localBranchCreated = true;
      }
      return { stdout: '', stderr: '' };
    });

    await expect(mod.restoreWorktreeForSession('s1')).resolves.toEqual({
      ok: true,
      snapshotApplied: true,
    });

    const calls = gitExecMock.mock.calls.map(argsOf);
    const createBranchIndex = calls.findIndex((args) => args[0] === 'branch');
    const addWorktreeIndex = calls.findIndex((args) => args[0] === '-c' && args[3] === 'add');
    expect(calls[createBranchIndex]).toEqual(['branch', 'xdt/wt1', 'refs/remotes/origin/xdt/wt1']);
    expect(createBranchIndex).toBeLessThan(addWorktreeIndex);
  });

  it('send-time restore only accepts the DB-authoritative managed path', async () => {
    const stalePath = path.join(baseRepo, '.cindy-worktrees', 'stale');

    await expect(mod.restoreMissingManagedWorktreeForSession('s1', stalePath)).resolves.toBe(false);

    expect(gitExecMock).not.toHaveBeenCalled();
  });

  it('send-time restore rejects a historical worktree after DB working_dir moved', async () => {
    dbWorkingDir = baseRepo;

    await expect(mod.restoreMissingManagedWorktreeForSession('s1', wtPath)).resolves.toBe(false);

    expect(gitExecMock).not.toHaveBeenCalled();
  });

  it('send-time check allows a non-owner session to use an existing managed worktree', async () => {
    dbWorktreePath = null;
    fsSync.mkdirSync(wtPath, { recursive: true });

    await expect(mod.restoreMissingManagedWorktreeForSession('s1', wtPath)).resolves.toBe(true);

    expect(gitExecMock).not.toHaveBeenCalled();
    expect(storeSetMock).not.toHaveBeenCalled();
  });

  it('send-time check applies the owning session snapshot before allowing a non-owner', async () => {
    fsSync.mkdirSync(wtPath, { recursive: true });
    const equivalentOwnerPath = path.join(
      path.dirname(wtPath),
      'nested',
      '..',
      path.basename(wtPath),
    );
    dbBindingRows = [
      { workingDir: wtPath, worktreePath: null },
      { workingDir: wtPath, worktreePath: equivalentOwnerPath },
    ];
    dbOwnerRows = [{ id: 'owner', worktreePath: equivalentOwnerPath, status: 'active' }];
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'refs/heads/xdt/wt1\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args.includes('refs/xdt/snapshots/owner')) {
        return { stdout: `${SHA}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await expect(mod.restoreMissingManagedWorktreeForSession('s1', wtPath)).resolves.toBe(true);

    const calls = gitExecMock.mock.calls.map(argsOf);
    expect(calls).toContainEqual(['stash', 'apply', SHA]);
    expect(calls).toContainEqual(['update-ref', '-d', 'refs/xdt/snapshots/owner']);
    expect(storeSetMock).toHaveBeenCalledWith(
      'owner',
      expect.objectContaining({ sessionId: 'owner', path: wtPath }),
    );
  });

  it('send-time check does not rebuild a missing managed worktree for a non-owner', async () => {
    dbWorktreePath = null;

    await expect(mod.restoreMissingManagedWorktreeForSession('s1', wtPath)).resolves.toBe(false);

    expect(gitExecMock).not.toHaveBeenCalled();
    expect(storeSetMock).not.toHaveBeenCalled();
  });

  it('send-time check ignores deleted historical owners for a reused managed path', async () => {
    fsSync.mkdirSync(wtPath, { recursive: true });
    dbWorktreePath = null;
    const deletedMeta = { sessionId: 'deleted-owner', path: wtPath };
    storeGetMock.mockImplementation((sessionId: string) =>
      sessionId === 'deleted-owner' ? deletedMeta : null,
    );
    storeGetAllMock.mockReturnValue([deletedMeta]);
    dbOwnerRows = [{ id: 'deleted-owner', worktreePath: wtPath, status: 'deleted' }];
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args.includes('refs/xdt/snapshots/deleted-owner')) {
        return { stdout: `${SHA}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await expect(mod.restoreMissingManagedWorktreeForSession('s1', wtPath)).resolves.toBe(true);

    expect(gitExecMock).not.toHaveBeenCalled();
    expect(storeSetMock).not.toHaveBeenCalled();
  });

  it('send-time check applies a pending snapshot even when the existing worktree is registered', async () => {
    fsSync.mkdirSync(wtPath, { recursive: true });
    storeGetMock.mockReturnValue({ sessionId: 's1', path: wtPath });
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'refs/heads/xdt/wt1\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args.includes('refs/xdt/snapshots/s1')) {
        return { stdout: `${SHA}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await expect(mod.restoreMissingManagedWorktreeForSession('s1', wtPath)).resolves.toBe(true);

    const calls = gitExecMock.mock.calls.map(argsOf);
    expect(calls).toContainEqual(['stash', 'apply', SHA]);
    expect(calls).toContainEqual(['update-ref', '-d', 'refs/xdt/snapshots/s1']);
  });

  it('send-time check waits for an external snapshot mutation before probing readiness', async () => {
    fsSync.mkdirSync(wtPath, { recursive: true });
    storeGetMock.mockReturnValue({ sessionId: 's1', path: wtPath });
    let releaseMutation!: () => void;
    const mutation = withWorktreeRestoreMutation(
      's1',
      () =>
        new Promise<void>((resolve) => {
          releaseMutation = resolve;
        }),
    );

    const readiness = mod.restoreMissingManagedWorktreeForSession('s1', wtPath);
    let settled = false;
    void readiness.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(gitExecMock).not.toHaveBeenCalled();

    releaseMutation();
    await expect(Promise.all([mutation, readiness])).resolves.toEqual([undefined, true]);
  });

  it('send-time check re-probes snapshots after a later restore mutation', async () => {
    fsSync.mkdirSync(wtPath, { recursive: true });
    storeGetMock.mockReturnValue({ sessionId: 's1', path: wtPath });
    let fallbackStashPresent = false;
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'refs/heads/xdt/wt1\n', stderr: '' };
      }
      if (args[0] === 'stash' && args[1] === 'list') {
        return { stdout: fallbackStashPresent ? `${AUTO_STASH}\n` : '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await expect(mod.restoreMissingManagedWorktreeForSession('s1', wtPath)).resolves.toBe(true);

    await withWorktreeRestoreMutation('s1', async () => {
      fallbackStashPresent = true;
    });

    await expect(mod.restoreMissingManagedWorktreeForSession('s1', wtPath)).resolves.toBe(true);
    expect(gitExecMock.mock.calls.map(argsOf)).toContainEqual(['stash', 'apply', SHA]);
  });

  it('send-time check only probes snapshot state once for a registered ready worktree', async () => {
    fsSync.mkdirSync(wtPath, { recursive: true });
    storeGetMock.mockReturnValue({ sessionId: 's1', path: wtPath });

    await expect(mod.restoreMissingManagedWorktreeForSession('s1', wtPath)).resolves.toBe(true);
    const callsAfterFirstSend = gitExecMock.mock.calls.length;
    await expect(mod.restoreMissingManagedWorktreeForSession('s1', wtPath)).resolves.toBe(true);

    expect(gitExecMock.mock.calls).toHaveLength(callsAfterFirstSend);
  });

  it('send-time restore rebuilds the exact missing worktree from origin', async () => {
    let localBranchCreated = false;
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/xdt/wt1')) {
        if (!localBranchCreated) throw new Error('unknown revision');
        return { stdout: 'deadbeef\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/xdt/wt1')) {
        return { stdout: 'deadbeef\n', stderr: '' };
      }
      if (args[0] === 'branch') localBranchCreated = true;
      if (args[0] === '-c' && args[2] === 'worktree' && args[3] === 'add') {
        fsSync.mkdirSync(wtPath, { recursive: true });
      }
      return { stdout: '', stderr: '' };
    });

    await expect(mod.restoreMissingManagedWorktreeForSession('s1', wtPath)).resolves.toBe(true);

    expect(storeSetMock).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ sessionId: 's1', path: wtPath, branch: 'xdt/wt1' }),
    );
  });

  it('send-time restore rebuilds the managed root for a subdirectory working_dir', async () => {
    const childPath = path.join(wtPath, 'packages', 'app');
    dbWorkingDir = childPath;
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/xdt/wt1')) {
        return { stdout: 'deadbeef\n', stderr: '' };
      }
      if (args[0] === '-c' && args[2] === 'worktree' && args[3] === 'add') {
        fsSync.mkdirSync(childPath, { recursive: true });
      }
      return { stdout: '', stderr: '' };
    });

    await expect(mod.restoreMissingManagedWorktreeForSession('s1', childPath)).resolves.toBe(true);

    expect(gitExecMock.mock.calls.map(argsOf)).toContainEqual([
      '-c',
      'core.longpaths=true',
      'worktree',
      'add',
      wtPath,
      'xdt/wt1',
    ]);
  });

  it('send-time restore rejects a restored child cwd that is a file', async () => {
    const childPath = path.join(wtPath, 'packages', 'app');
    dbWorkingDir = childPath;
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/xdt/wt1')) {
        return { stdout: 'deadbeef\n', stderr: '' };
      }
      if (args[0] === '-c' && args[2] === 'worktree' && args[3] === 'add') {
        fsSync.mkdirSync(path.dirname(childPath), { recursive: true });
        fsSync.writeFileSync(childPath, 'not a directory');
      }
      return { stdout: '', stderr: '' };
    });

    await expect(mod.restoreMissingManagedWorktreeForSession('s1', childPath)).resolves.toBe(false);
  });

  it('concurrent restore requests share one worktree mutation', async () => {
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/xdt/wt1')) {
        return { stdout: 'deadbeef\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const first = mod.restoreWorktreeForSession('s1');
    const second = mod.restoreWorktreeForSession('s1');

    expect(second).toBe(first);
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, snapshotApplied: true },
      { ok: true, snapshotApplied: true },
    ]);

    const calls = gitExecMock.mock.calls.map(argsOf);
    expect(calls.filter((args) => args[0] === '-c' && args[3] === 'add')).toHaveLength(1);
    expect(storeSetMock).toHaveBeenCalledTimes(1);
  });

  it('concurrent send-time restores wait for snapshot apply before allowing either send', async () => {
    let releaseApply!: () => void;
    let signalApplyStarted!: () => void;
    const applyStarted = new Promise<void>((resolve) => {
      signalApplyStarted = resolve;
    });
    const applyRelease = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/xdt/wt1')) {
        return { stdout: 'deadbeef\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args.includes('refs/xdt/snapshots/s1')) {
        return { stdout: `${SHA}\n`, stderr: '' };
      }
      if (args[0] === '-c' && args[2] === 'worktree' && args[3] === 'add') {
        fsSync.mkdirSync(wtPath, { recursive: true });
      }
      if (args[0] === 'stash' && args[1] === 'apply') {
        signalApplyStarted();
        await applyRelease;
        throw new Error('conflict');
      }
      return { stdout: '', stderr: '' };
    });

    const first = mod.restoreMissingManagedWorktreeForSession('s1', wtPath);
    await applyStarted;
    const second = mod.restoreMissingManagedWorktreeForSession('s1', wtPath);
    let secondSettled = false;
    void second.finally(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    releaseApply();
    await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
    const calls = gitExecMock.mock.calls.map(argsOf);
    expect(calls.filter((args) => args[0] === '-c' && args[3] === 'add')).toHaveLength(1);
    expect(calls.filter((args) => args[0] === 'stash' && args[1] === 'apply')).toHaveLength(1);
  });

  it('send-time restore remains blocked and retries a pending snapshot after apply conflict', async () => {
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'refs/heads/xdt/wt1\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args.includes('refs/heads/xdt/wt1')) {
        return { stdout: 'deadbeef\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args.includes('refs/xdt/snapshots/s1')) {
        return { stdout: `${SHA}\n`, stderr: '' };
      }
      if (args[0] === '-c' && args[2] === 'worktree' && args[3] === 'add') {
        fsSync.mkdirSync(wtPath, { recursive: true });
      }
      if (args[0] === 'stash' && args[1] === 'apply') throw new Error('conflict');
      return { stdout: '', stderr: '' };
    });

    await expect(mod.restoreMissingManagedWorktreeForSession('s1', wtPath)).resolves.toBe(false);
    await expect(mod.restoreMissingManagedWorktreeForSession('s1', wtPath)).resolves.toBe(false);

    const calls = gitExecMock.mock.calls.map(argsOf);
    expect(calls.filter((args) => args[0] === '-c' && args[3] === 'add')).toHaveLength(1);
    expect(calls.filter((args) => args[0] === 'stash' && args[1] === 'apply')).toHaveLength(2);
    expect(storeSetMock).not.toHaveBeenCalled();
  });

  it('restore: falls back to the session auto-stash when snapshot ref is missing', async () => {
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/xdt/wt1')) {
        return { stdout: 'deadbeef\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args.includes('refs/xdt/snapshots/s1')) {
        throw new Error('unknown revision');
      }
      if (args[0] === 'stash' && args[1] === 'list') {
        return { stdout: `${AUTO_STASH}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const status = await mod.getWorktreeRestoreStatus('s1');
    expect(status).toEqual({
      state: 'restorable',
      worktreePath: wtPath,
      hasSnapshot: true,
    });

    const result = await mod.restoreWorktreeForSession('s1');
    expect(result).toEqual({ ok: true, snapshotApplied: true });

    const calls = gitExecMock.mock.calls.map(argsOf);
    expect(calls.some((a) => a[0] === 'stash' && a[1] === 'apply' && a[2] === SHA)).toBe(true);
    expect(calls.some((a) => a[0] === 'update-ref' && a[1] === '-d')).toBe(false);
    expect(storeSetMock).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ sessionId: 's1', path: wtPath, branch: 'xdt/wt1' }),
    );
  });

  it('restore: include copy failure does not block worktree recovery', async () => {
    applyIncludeMock.mockRejectedValueOnce(new Error('env copy failed'));
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/xdt/wt1')) {
        return { stdout: 'deadbeef\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args.includes('refs/xdt/snapshots/s1')) {
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const result = await mod.restoreWorktreeForSession('s1');

    expect(result).toEqual({ ok: true, snapshotApplied: true });
    expect(applyIncludeMock).toHaveBeenCalledWith(baseRepo, wtPath, {
      overwriteExisting: false,
    });
    expect(storeSetMock).toHaveBeenCalled();
  });

  it('restore: agent config copy failure does not block worktree recovery', async () => {
    copyClaudeSiviDirsMock.mockRejectedValueOnce(new Error('config copy failed'));
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/xdt/wt1')) {
        return { stdout: 'deadbeef\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args.includes('refs/xdt/snapshots/s1')) {
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const result = await mod.restoreWorktreeForSession('s1');

    expect(result).toEqual({ ok: true, snapshotApplied: true });
    expect(copyClaudeSiviDirsMock).toHaveBeenCalledWith(baseRepo, wtPath, {
      overwriteExisting: false,
    });
    expect(storeSetMock).toHaveBeenCalled();
  });

  it('restore: snapshot apply failure stays unregistered so cleanup cannot overwrite it', async () => {
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/xdt/wt1')) {
        return { stdout: 'deadbeef\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args.includes('refs/xdt/snapshots/s1')) {
        return { stdout: `${SHA}\n`, stderr: '' };
      }
      if (args[0] === 'stash' && args[1] === 'apply') throw new Error('conflict');
      return { stdout: '', stderr: '' };
    });

    const result = await mod.restoreWorktreeForSession('s1');
    expect(result).toEqual({ ok: true, snapshotApplied: false });
    expect(storeDelMock).toHaveBeenCalledWith('s1');
    expect(storeSetMock).not.toHaveBeenCalled();
    expect(copyClaudeSiviDirsMock).not.toHaveBeenCalled();
    expect(applyIncludeMock).not.toHaveBeenCalled();
  });

  it('restore: retries worktree add after enabling Windows long paths', async () => {
    let addAttempts = 0;
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/xdt/wt1')) {
        return { stdout: 'deadbeef\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args.includes('refs/xdt/snapshots/s1')) {
        return { stdout: '', stderr: '' };
      }
      if (args[0] === '-c' && args[2] === 'worktree' && args[3] === 'add') {
        addAttempts += 1;
        if (addAttempts === 1) throw new MockGitExecError('Filename too long');
      }
      return { stdout: '', stderr: '' };
    });

    await expect(mod.restoreWorktreeForSession('s1')).resolves.toEqual({
      ok: true,
      snapshotApplied: true,
    });

    const calls = gitExecMock.mock.calls.map(argsOf);
    expect(calls.filter((args) => args[0] === '-c' && args[3] === 'add')).toHaveLength(2);
    expect(calls).toContainEqual(['config', '--global', 'core.longpaths', 'true']);
  });

  it('restore: worktree add failure → ok=false, no store write', async () => {
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/xdt/wt1')) {
        return { stdout: 'deadbeef\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args.includes('refs/xdt/snapshots/s1')) {
        return { stdout: '', stderr: '' };
      }
      if (args[0] === '-c' && args[2] === 'worktree' && args[3] === 'add') {
        throw new Error('branch checked out elsewhere');
      }
      return { stdout: '', stderr: '' };
    });

    const result = await mod.restoreWorktreeForSession('s1');
    expect(result).toMatchObject({
      ok: false,
      reason: 'git-error',
      detail: expect.stringContaining('branch checked out elsewhere'),
    });
    expect(storeSetMock).not.toHaveBeenCalled();
  });

  it('restore: non-restorable state returns stable reason instead of user-facing text', async () => {
    dbWorktreePath = null;

    const result = await mod.restoreWorktreeForSession('s1');

    expect(result).toEqual({ ok: false, reason: 'no-worktree' });
  });
});
