import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { WorktreeMeta } from '../worktree/types';

const gitExecMock = vi.fn();
const storeMap = new Map<string, WorktreeMeta>();
const storeSetMock = vi.fn();
const profile = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({ app: { getPath: () => profile.root } }));
vi.mock('../localDb/client/current', () => ({ getDbClient: () => ({ readLocalWorktreeReferences: async () => [] }) }));
vi.mock('../worktree/piSubagentReferences', () => ({ readPiSubagentWorktreeReferences: async () => new Map() }));
vi.mock('../worktree/runtimeLeases', () => ({
  readWorktreeRuntimePaths: async () => new Set(),
  acquireWorktreeRuntimeLease: async () => ({}),
  releaseWorktreeRuntimeLease: async () => {},
}));
const includeMock = vi.hoisted(() => vi.fn(async () => []));

vi.mock('../worktree/gitExec', () => ({
  gitExec: (...args: unknown[]) => gitExecMock(...args),
  GitExecError: class GitExecError extends Error {},
  globalSafeDirectoryLockPath: () => path.join(profile.root, 'git-config.lock'),
  safeDirectorySpellings: (value: string) => [value],
}));

vi.mock('../worktree/includePatternsEngine', () => ({
  applyWorktreeIncludeFile: includeMock,
  listChangedWorktreeIncludeFiles: vi.fn(async () => []),
}));

vi.mock('../worktree/worktreeStore', () => ({
  get: (sessionId: string) => storeMap.get(sessionId) ?? null,
  getAll: () => [...storeMap.values()],
  getAllPaths: () => [...storeMap.values()].map((meta) => meta.path),
  set: (...args: unknown[]) => storeSetMock(...args),
  del: (sessionId: string) => storeMap.delete(sessionId),
  addPendingSafeDirectoryCleanups: async () => {},
  removePendingSafeDirectoryCleanups: async () => {},
}));

describe('createWorktree naming authority', () => {
  let manager: typeof import('../worktree/WorktreeManager');
  let tmpRoot: string;
  let baseRepo: string;
  let randomSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-worktree-create-'));
    profile.root = path.join(tmpRoot, 'profile');
    fs.mkdirSync(profile.root);
    baseRepo = path.join(tmpRoot, 'repo');
    fs.mkdirSync(baseRepo, { recursive: true });
    storeMap.clear();
    includeMock.mockReset().mockResolvedValue([]);
    storeSetMock.mockReset().mockImplementation(async (sessionId: string, meta: WorktreeMeta) => {
      storeMap.set(sessionId, meta);
    });
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    gitExecMock.mockReset().mockImplementation(async (args: string[], cwd?: string) => {
      if (args[0] === 'symbolic-ref') {
        const meta = [...storeMap.values()].find((value) => value.path === cwd);
        return { stdout: `refs/heads/${meta?.branch ?? 'main'}\n`, stderr: '' };
      }
      if (args[0] === '--version') {
        return { stdout: 'git version 2.50.0\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        return { stdout: `${baseRepo}\n`, stderr: '' };
      }
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
        return { stdout: 'main\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && (args[1] === '--git-dir' || args[1] === '--git-common-dir')) {
        return { stdout: '.git\n', stderr: '' };
      }
      if (args[0] === 'branch' && args[1] === '--format=%(refname:short)') {
        return { stdout: 'main\n', stderr: '' };
      }
      if (args[0] === 'branch' && args[1] === '--all') {
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    manager = await import('../worktree/WorktreeManager');
  });

  afterEach(() => {
    randomSpy.mockRestore();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function create(name: string, sessionId = 'session-1') {
    return manager.createWorktree({
      sessionId,
      baseRepo,
      name,
      sourceBranch: 'main',
    });
  }

  it.each(['', '   \t'])('generates a meaningful final name for blank input %j', async (name) => {
    const result = await create(name);

    expect(result).toMatchObject({
      ok: true,
      meta: {
        name: 'pensive-lederberg',
        path: path.join(baseRepo, '.cindy-worktrees', 'pensive-lederberg'),
        branch: 'cindy/pensive-lederberg',
      },
    });
  });

  it('preserves an explicit legal auto-* name', async () => {
    const result = await create('auto-abc123');

    expect(result).toMatchObject({
      ok: true,
      meta: {
        name: 'auto-abc123',
        path: path.join(baseRepo, '.cindy-worktrees', 'auto-abc123'),
        branch: 'cindy/auto-abc123',
      },
    });
    expect(storeMap.get('session-1')).toEqual(result.ok ? result.meta : undefined);
  });

  it('preserves an explicit legal name and still rejects an explicit illegal name', async () => {
    await expect(create('fix-login')).resolves.toMatchObject({
      ok: true,
      meta: {
        name: 'fix-login',
        path: path.join(baseRepo, '.cindy-worktrees', 'fix-login'),
        branch: 'cindy/fix-login',
      },
    });

    gitExecMock.mockClear();
    await expect(create('Bad Name', 'session-2')).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('worktree 名称非法') },
    });
    expect(gitExecMock).not.toHaveBeenCalled();
  });

  it('generates against getTakenNames and avoids a meaningful-name collision', async () => {
    const takenName = 'pensive-lederberg';
    storeMap.set('existing-session', {
      sessionId: 'existing-session',
      name: takenName,
      path: path.join(baseRepo, '.cindy-worktrees', takenName),
      baseRepo,
      branch: `cindy/${takenName}`,
      sourceBranch: 'main',
      createdAt: '2026-08-09T00:00:00.000Z',
    });

    const result = await create('');

    expect(result).toMatchObject({
      ok: true,
      meta: {
        name: 'pensive-lederberg-2',
        path: path.join(baseRepo, '.cindy-worktrees', 'pensive-lederberg-2'),
        branch: 'cindy/pensive-lederberg-2',
      },
    });
  });

  it.each(['setup', 'metadata'])('serializes cancellation from a separate manager while creation awaits %s', async (stage) => {
    // Independent module instances model separate process-local queues. The
    // profile lock and cancellation marker are real shared filesystem state.
    const creator = manager;
    vi.resetModules();
    const canceller = await import('../worktree/WorktreeManager');
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const pause = new Promise<void>((resolve) => { release = resolve; });
    if (stage === 'setup') {
      includeMock.mockImplementationOnce(async () => { entered(); await pause; return []; });
    } else {
      storeSetMock.mockImplementationOnce(async (id: string, meta: WorktreeMeta) => {
        entered(); await pause; storeMap.set(id, meta);
      });
    }
    const request = { sessionId: 'cross-process', baseRepo, name: 'race', sourceBranch: 'main', recoveryKey: 'cross-process-recovery' };
    const creating = creator.createWorktree(request);
    await ready;
    let cancellation: ReturnType<typeof manager.cancelPrecreatedWorktree> | undefined;
    try {
      cancellation = canceller.cancelPrecreatedWorktree(request.sessionId,
        { recoveryKey: request.recoveryKey }, { canRemove: async () => true });
      expect(await Promise.race([
        cancellation.then(() => 'cancelled'),
        new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 100)),
      ])).toBe('waiting');
      await expect(canceller.createWorktree({ ...request, sessionId: 'other-task', name: 'other' }))
        .resolves.toMatchObject({ ok: true });
    } finally {
      release();
      await creating;
      await cancellation;
    }
    expect(await creating).toMatchObject({ ok: true });
    expect(await cancellation).toMatchObject({ status: 'discarded' });
    expect(storeMap.has(request.sessionId)).toBe(false);
    expect(storeMap.has('other-task')).toBe(true);
    await expect(creator.createWorktree(request)).rejects.toThrow('PRECONDITION_FAILED');
  });

  it('rechecks a cancellation published during setup before registering metadata', async () => {
    const { sealPrecreatedSessionCancellation } = await import('../worktree/precreatedCancellation');
    const previousGit = gitExecMock.getMockImplementation()!;
    let finishCheckout!: () => void;
    const checkout = new Promise<{ stdout: string; stderr: string }>((resolve) => {
      finishCheckout = () => resolve({ stdout: '', stderr: '' });
    });
    gitExecMock.mockImplementation((args: string[], ...rest: unknown[]) =>
      args[0] === 'checkout' && args.includes(':(exclude).sivi') ? checkout : previousGit(args, ...rest));
    let marked!: () => void;
    const markReady = new Promise<void>((resolve) => { marked = resolve; });
    includeMock.mockImplementationOnce(async () => {
      // A peer on an older version may not participate in the new lock yet.
      sealPrecreatedSessionCancellation('cancel-during-setup');
      marked();
      return [];
    });
    const creating = create('cancelled', 'cancel-during-setup');
    await markReady;
    try {
      expect(await Promise.race([
        creating.then(() => 'completed'),
        new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 100)),
      ])).toBe('waiting');
      expect(gitExecMock).not.toHaveBeenCalledWith(['worktree', 'remove', path.join(baseRepo, '.cindy-worktrees', 'cancelled')], baseRepo);
    } finally {
      finishCheckout();
      await creating;
    }
    expect(await creating).toMatchObject({ ok: false });
    expect(storeSetMock).not.toHaveBeenCalled();
    expect(storeMap.has('cancel-during-setup')).toBe(false);
    expect(gitExecMock).toHaveBeenCalledWith(['worktree', 'remove', path.join(baseRepo, '.cindy-worktrees', 'cancelled')], baseRepo);
  });
});
