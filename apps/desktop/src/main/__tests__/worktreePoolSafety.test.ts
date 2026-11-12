const checkpointMock = vi.hoisted(() => vi.fn());
const recyclePoolMock = vi.hoisted(() => vi.fn());
const restoreRecordedWorktreeMock = vi.hoisted(() => vi.fn());
const readRecycleRecordMock = vi.hoisted(() => vi.fn());
vi.mock('../worktree/managedRecycle', () => ({
  checkpointWorktreeForReuse: checkpointMock,
  recycleManagedWorktree: recyclePoolMock,
}));
vi.mock('../worktree/legacyRuntimeGuard', () => ({
  withLegacyWorktreeRuntimeGuard: (task: (isHeld: () => boolean) => Promise<unknown>) => task(() => true),
}));
vi.mock('../worktree/runtimeLeases', () => ({
  readWorktreeRuntimePaths: async () => new Set(liveSessionRows.filter((row) => row.status === 'archived').flatMap((row) => [row.workingDir, row.worktreePath].filter(Boolean))),
}));
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import path from 'node:path';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';

import type { WorktreeMeta } from '../worktree/types';

const gitExecMock = vi.fn();
const isWorktreeDirtyMock = vi.fn();
const resolveAvailableWorktreeNameMock = vi.fn();
const createWorktreeMock = vi.fn();
const storeMap = new Map<string, WorktreeMeta>();
const liveSessionRows: Array<{
  id: string;
  status: string | null;
  workingDir: string | null;
  worktreePath: string | null;
}> = [];
let liveSessionLookupError: Error | null = null;
let liveSessionQueryCount = 0;

vi.mock('../worktree/gitExec', () => ({
  gitExec: (...args: unknown[]) => gitExecMock(...args),
}));

vi.mock('../worktree/dirty', () => ({
  isWorktreeDirty: (...args: unknown[]) => isWorktreeDirtyMock(...args),
}));

vi.mock('../worktree/worktreeStore', () => ({
  get: (sessionId: string) => storeMap.get(sessionId) ?? null,
  getAll: () => [...storeMap.values()],
  getAllPaths: () => [...storeMap.values()].map((m) => m.path),
  set: async (id: string, meta: WorktreeMeta) => { storeMap.set(id, meta); },
  replace: async (previousId: string, id: string, meta: WorktreeMeta) => {
    if (previousId !== id) storeMap.delete(previousId);
    storeMap.set(id, meta);
  },
  del: (sessionId: string) => storeMap.delete(sessionId),
}));
vi.mock('../worktree/restoreRecovery', () => ({
  restoreRecordedWorktree: restoreRecordedWorktreeMock,
}));
vi.mock('../worktree/recycleJournal', () => ({
  readRecycleRecord: (...args: unknown[]) => readRecycleRecordMock(...args),
}));

vi.mock('../worktree/WorktreeManager', () => ({
  copyClaudeSiviDirs: vi.fn(),
  createWorktree: (...args: unknown[]) => createWorktreeMock(...args),
  resolveAvailableWorktreeName: (...args: unknown[]) => resolveAvailableWorktreeNameMock(...args),
}));

vi.mock('../localDb/client/current', () => ({
  getDbClient: () => ({
    readLocalWorktreeReferences: async () => {
      liveSessionQueryCount += 1;
      if (liveSessionLookupError) throw liveSessionLookupError;
      return [
        ...liveSessionRows.map((row) => ({ ...row, source: 'desktop', currentDatabase: true })),
        ...[...storeMap.values()].filter((meta) => !liveSessionRows.some((row) => row.id === meta.sessionId))
          .map((meta) => ({ id: meta.sessionId, status: 'deleted', source: 'desktop', currentDatabase: true, workingDir: meta.path, worktreePath: meta.path })),
      ];
    },
    drizzle: {
      select: () => ({
        from: () => ({
          where: () => {
            liveSessionQueryCount += 1;
            if (liveSessionLookupError) throw liveSessionLookupError;
            return liveSessionRows;
          },
        }),
      }),
    },
  }),
}));

function makeMeta(
  baseRepo: string,
  sessionId: string,
  createdAt: string,
  name = sessionId,
): WorktreeMeta {
  return {
    sessionId,
    name,
    path: path.join(baseRepo, '.xdt-worktrees', name),
    baseRepo,
    branch: `xdt/${name}`,
    sourceBranch: 'main',
    createdAt,
    ephemeral: true,
  };
}

describe('WorktreePool safety', () => {
  let tmpRoot: string;
  let baseRepo: string;
  let rmSpy: MockInstance<typeof fs.rm>;
  let pool: typeof import('../worktree/WorktreePool');

  beforeEach(async () => {
    tmpRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), 'xdt-wt-pool-safety-'));
    baseRepo = path.join(tmpRoot, 'repo');
    fsSync.mkdirSync(path.join(baseRepo, '.xdt-worktrees'), { recursive: true });

    storeMap.clear();
    liveSessionRows.length = 0;
    liveSessionRows.push({
      id: '__unrelated_active_session__',
      status: 'active',
      workingDir: path.join(baseRepo, 'unrelated'),
      worktreePath: null,
    });
    liveSessionLookupError = null;
    liveSessionQueryCount = 0;
    gitExecMock.mockReset();
    isWorktreeDirtyMock.mockReset().mockResolvedValue(false);
    resolveAvailableWorktreeNameMock
      .mockReset()
      .mockImplementation(async (_baseRepo: string, requestedName: string) => requestedName);
    createWorktreeMock.mockReset();
    checkpointMock.mockReset().mockResolvedValue(undefined);
    recyclePoolMock.mockReset().mockImplementation(async (meta: WorktreeMeta, options: { canRemove: () => Promise<boolean> }) => {
      if (!(await options.canRemove())) return false;
      if (path.dirname(meta.path) !== path.join(meta.baseRepo, '.xdt-worktrees')) return false;
      await gitExecMock(['worktree', 'remove', '--force', meta.path], meta.baseRepo);
      storeMap.delete(meta.sessionId);
      return true;
    });
    restoreRecordedWorktreeMock.mockReset().mockResolvedValue(true);
    readRecycleRecordMock.mockReset().mockResolvedValue(null);
    rmSpy = vi.spyOn(fs, 'rm');

    pool = await import('../worktree/WorktreePool');
    pool.parkAll();
  });

  afterEach(() => {
    pool?.parkAll();
    rmSpy.mockRestore();
    fsSync.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('does not evict a worktree still referenced by an active session', async () => {
    const protectedMeta = makeMeta(baseRepo, 'session-1', '2026-05-26T00:00:00.000Z');
    const evictableMeta = makeMeta(baseRepo, 'session-2', '2026-05-26T00:01:00.000Z');
    const releaseMeta = makeMeta(baseRepo, 'session-6', '2026-05-26T00:05:00.000Z');

    const metas = [
      protectedMeta,
      evictableMeta,
      makeMeta(baseRepo, 'session-3', '2026-05-26T00:02:00.000Z'),
      makeMeta(baseRepo, 'session-4', '2026-05-26T00:03:00.000Z'),
      makeMeta(baseRepo, 'session-5', '2026-05-26T00:04:00.000Z'),
      releaseMeta,
    ];
    for (const meta of metas) {
      fsSync.mkdirSync(meta.path, { recursive: true });
      storeMap.set(meta.sessionId, meta);
    }
    liveSessionRows.push({
      id: protectedMeta.sessionId,
      status: 'active',
      workingDir: protectedMeta.path,
      worktreePath: null,
    });

    await expect(pool.releaseWorktree(releaseMeta.sessionId)).resolves.toBe('pooled');

    expect(storeMap.has(protectedMeta.sessionId)).toBe(true);
    expect(storeMap.has(evictableMeta.sessionId)).toBe(false);
    expect(gitExecMock).toHaveBeenCalledWith(
      ['worktree', 'remove', '--force', evictableMeta.path],
      baseRepo,
    );
    expect(liveSessionQueryCount).toBeGreaterThanOrEqual(2);
  });

  it('does not return a live session worktree to the reusable pool', async () => {
    const meta = makeMeta(baseRepo, 'session-1', '2026-05-26T00:00:00.000Z');
    fsSync.mkdirSync(meta.path, { recursive: true });
    storeMap.set(meta.sessionId, meta);
    liveSessionRows.push({
      id: meta.sessionId,
      status: 'active',
      workingDir: meta.path,
      worktreePath: meta.path,
    });

    await expect(pool.releaseWorktree(meta.sessionId)).resolves.toBe('preserved');

    expect(gitExecMock).not.toHaveBeenCalled();
    expect(storeMap.has(meta.sessionId)).toBe(true);
  });

  it('does not return an archived session worktree to the pool without runtime truth', async () => {
    const meta = makeMeta(baseRepo, 'session-1', '2026-05-26T00:00:00.000Z');
    fsSync.mkdirSync(meta.path, { recursive: true });
    storeMap.set(meta.sessionId, meta);
    liveSessionRows.push({
      id: meta.sessionId,
      status: 'archived',
      workingDir: meta.path,
      worktreePath: meta.path,
    });

    await expect(pool.releaseWorktree(meta.sessionId)).resolves.toBe('preserved');

    expect(gitExecMock).not.toHaveBeenCalled();
    expect(storeMap.has(meta.sessionId)).toBe(true);
  });

  it('does not recover a live session worktree into the reusable pool', async () => {
    const meta = makeMeta(baseRepo, 'session-1', '2026-05-26T00:00:00.000Z');
    fsSync.mkdirSync(meta.path, { recursive: true });
    storeMap.set(meta.sessionId, meta);
    liveSessionRows.push({
      id: meta.sessionId,
      status: 'active',
      workingDir: null,
      worktreePath: meta.path,
    });

    await pool.recoverPool();
    await pool.drainOne(baseRepo);

    expect(gitExecMock).not.toHaveBeenCalled();
    expect(storeMap.has(meta.sessionId)).toBe(true);
  });

  it('does not recover an archived session worktree without runtime truth', async () => {
    const meta = makeMeta(baseRepo, 'session-1', '2026-05-26T00:00:00.000Z');
    fsSync.mkdirSync(meta.path, { recursive: true });
    storeMap.set(meta.sessionId, meta);
    liveSessionRows.push({
      id: meta.sessionId,
      status: 'archived',
      workingDir: null,
      worktreePath: meta.path,
    });

    await pool.recoverPool();
    await pool.drainOne(baseRepo);

    expect(gitExecMock).not.toHaveBeenCalled();
    expect(storeMap.has(meta.sessionId)).toBe(true);
  });

  it('preserves worktrees when live session lookup fails', async () => {
    const meta = makeMeta(baseRepo, 'session-1', '2026-05-26T00:00:00.000Z');
    fsSync.mkdirSync(meta.path, { recursive: true });
    storeMap.set(meta.sessionId, meta);
    liveSessionLookupError = new Error('db unavailable');

    await expect(pool.releaseWorktree(meta.sessionId)).resolves.toBe('preserved');

    expect(gitExecMock).not.toHaveBeenCalled();
    expect(storeMap.has(meta.sessionId)).toBe(true);
  });

  it('does not fs.rm a pooled path outside baseRepo/.xdt-worktrees', async () => {
    const outsidePath = path.join(tmpRoot, 'outside-worktree');
    fsSync.mkdirSync(outsidePath, { recursive: true });
    const meta: WorktreeMeta = {
      ...makeMeta(baseRepo, 'session-1', '2026-05-26T00:00:00.000Z'),
      path: outsidePath,
    };
    storeMap.set(meta.sessionId, meta);
    gitExecMock.mockRejectedValueOnce(new Error('git remove failed'));

    await expect(pool.releaseWorktree(meta.sessionId)).resolves.toBe('pooled');
    await expect(pool.drainOne(baseRepo)).rejects.toThrow('pooled worktree was preserved');

    expect(rmSpy).not.toHaveBeenCalled();
    expect(storeMap.has(meta.sessionId)).toBe(true);
  });

  it('bounds the pool-reuse fetch for origin/* sources (real timeout + no terminal prompt)', async () => {
    const meta = {
      ...makeMeta(baseRepo, 'session-1', '2026-05-26T00:00:00.000Z'),
      sourceBranch: 'origin/main',
    };
    fsSync.mkdirSync(meta.path, { recursive: true });
    storeMap.set(meta.sessionId, meta);
    await expect(pool.releaseWorktree(meta.sessionId)).resolves.toBe('pooled');
    gitExecMock.mockClear();

    const res = await pool.acquireWorktree({
      sessionId: 'session-2',
      name: 'reuse-1',
      baseRepo,
      sourceBranch: 'origin/main',
      ephemeral: true,
    });
    expect(res.ok).toBe(true);
    const fetchCall = gitExecMock.mock.calls.find((c) => (c[0] as string[])[0] === 'fetch');
    expect(fetchCall).toBeTruthy();
    const opts = fetchCall?.[2] as
      { timeoutMs?: number; extraEnv?: Record<string, string> } | undefined;
    expect(opts?.timeoutMs).toBeGreaterThan(0);
    expect(opts?.extraEnv?.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('skips the pool-reuse fetch when caller already attempted the source fetch (even a failed one)', async () => {
    const meta = {
      ...makeMeta(baseRepo, 'session-1', '2026-05-26T00:00:00.000Z'),
      sourceBranch: 'origin/main',
    };
    fsSync.mkdirSync(meta.path, { recursive: true });
    storeMap.set(meta.sessionId, meta);
    await expect(pool.releaseWorktree(meta.sessionId)).resolves.toBe('pooled');
    gitExecMock.mockClear();

    const res = await pool.acquireWorktree(
      {
        sessionId: 'session-2',
        name: 'reuse-1',
        baseRepo,
        sourceBranch: 'origin/main',
        ephemeral: true,
      },
      { sourceFetchAlreadyAttempted: true },
    );
    expect(res.ok).toBe(true);
    expect(gitExecMock.mock.calls.some((c) => (c[0] as string[])[0] === 'fetch')).toBe(false);
  });

  it('reuses a legacy pooled worktree on a new cindy/* branch', async () => {
    const meta = makeMeta(baseRepo, 'session-1', '2026-05-26T00:00:00.000Z');
    fsSync.mkdirSync(meta.path, { recursive: true });
    storeMap.set(meta.sessionId, meta);
    await expect(pool.releaseWorktree(meta.sessionId)).resolves.toBe('pooled');
    gitExecMock.mockClear();

    const res = await pool.acquireWorktree({
      sessionId: 'session-2',
      name: 'reuse-1',
      baseRepo,
      sourceBranch: 'main',
      ephemeral: true,
    });

    expect(res).toMatchObject({
      ok: true,
      meta: { name: 'reuse-1', branch: 'cindy/reuse-1' },
    });
    expect(gitExecMock).toHaveBeenCalledWith(
      ['checkout', '--no-track', '-b', 'cindy/reuse-1', 'main'],
      meta.path,
    );
    expect(gitExecMock.mock.calls.some((call) => (call[0] as string[]).includes('-B'))).toBe(false);
  });

  it('uses the Manager-reserved name when reusing a pooled worktree', async () => {
    const meta = makeMeta(baseRepo, 'session-1', '2026-05-26T00:00:00.000Z');
    fsSync.mkdirSync(meta.path, { recursive: true });
    storeMap.set(meta.sessionId, meta);
    await expect(pool.releaseWorktree(meta.sessionId)).resolves.toBe('pooled');
    gitExecMock.mockClear();
    resolveAvailableWorktreeNameMock.mockResolvedValue('reuse-1-2');

    const res = await pool.acquireWorktree({
      sessionId: 'session-2',
      name: 'reuse-1',
      baseRepo,
      sourceBranch: 'main',
      ephemeral: true,
    });

    expect(res).toMatchObject({
      ok: true,
      meta: { name: 'reuse-1-2', branch: 'cindy/reuse-1-2' },
    });
    expect(gitExecMock).toHaveBeenCalledWith(
      ['checkout', '--no-track', '-b', 'cindy/reuse-1-2', 'main'],
      meta.path,
    );
  });

  it('falls back without reset or clean when branch creation loses a collision race', async () => {
    const meta = makeMeta(baseRepo, 'session-1', '2026-05-26T00:00:00.000Z');
    fsSync.mkdirSync(meta.path, { recursive: true });
    storeMap.set(meta.sessionId, meta);
    await expect(pool.releaseWorktree(meta.sessionId)).resolves.toBe('pooled');
    gitExecMock.mockClear();
    const fallback = {
      ok: false as const,
      error: { kind: 'unknown' as const, message: 'fresh create failed' },
    };
    createWorktreeMock.mockResolvedValue(fallback);
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'checkout') throw new Error('branch already exists');
      return { stdout: '', stderr: '' };
    });

    const req = {
      sessionId: 'session-2',
      name: 'reuse-1',
      baseRepo,
      sourceBranch: 'main',
      ephemeral: true,
    };
    await expect(pool.acquireWorktree(req)).resolves.toBe(fallback);

    const commands = gitExecMock.mock.calls.map((call) => call[0] as string[]);
    expect(commands.some((args) => args[0] === 'reset')).toBe(false);
    expect(commands.some((args) => args[0] === 'clean')).toBe(false);
    expect(commands.some((args) => args.includes('-B'))).toBe(false);
    expect(createWorktreeMock).toHaveBeenCalledWith(req);
  });

  it('restores the old generation before falling back when reset fails after checkpoint', async () => {
    const meta = makeMeta(baseRepo, 'previous', '2026-05-26T00:00:00.000Z');
    fsSync.mkdirSync(meta.path, { recursive: true });
    storeMap.set(meta.sessionId, meta);
    await expect(pool.releaseWorktree(meta.sessionId)).resolves.toBe('pooled');
    createWorktreeMock.mockResolvedValue({ ok: false as const, error: { kind: 'unknown' as const, message: 'fresh create failed' } });
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'checkout') throw new Error('checkout failed after checkpoint');
      return { stdout: '', stderr: '' };
    });

    await pool.acquireWorktree({ sessionId: 'next', name: 'next', baseRepo, sourceBranch: 'main', ephemeral: true });

    expect(restoreRecordedWorktreeMock).toHaveBeenCalledWith(meta.sessionId, meta.path);
    expect(storeMap.get(meta.sessionId)).toEqual(meta);
    expect(storeMap.has('next')).toBe(false);
  });

  it('checks out the checkpointed branch before restoring after a post-checkout reset failure', async () => {
    const meta = makeMeta(baseRepo, 'previous', '2026-05-26T00:00:00.000Z');
    fsSync.mkdirSync(meta.path, { recursive: true });
    storeMap.set(meta.sessionId, meta);
    await expect(pool.releaseWorktree(meta.sessionId)).resolves.toBe('pooled');
    readRecycleRecordMock.mockResolvedValue({
      sessionId: meta.sessionId,
      snapshot: { head: 'a'.repeat(40), headRef: 'refs/heads/xdt/previous' },
    });
    createWorktreeMock.mockResolvedValue({ ok: false as const, error: { kind: 'unknown' as const, message: 'fresh create failed' } });
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'reset') throw new Error('reset failed after checkout');
      return { stdout: '', stderr: '' };
    });

    await pool.acquireWorktree({ sessionId: 'next', name: 'next', baseRepo, sourceBranch: 'main', ephemeral: true });

    expect(gitExecMock).toHaveBeenCalledWith(['checkout', 'xdt/previous'], meta.path);
    expect(gitExecMock).toHaveBeenCalledWith(['branch', '-D', 'cindy/next'], meta.path);
    expect(restoreRecordedWorktreeMock).toHaveBeenCalledWith(meta.sessionId, meta.path);
  });

  it('preserves dirty worktrees instead of auto-stashing them into the pool', async () => {
    const meta = makeMeta(baseRepo, 'session-1', '2026-05-26T00:00:00.000Z');
    fsSync.mkdirSync(meta.path, { recursive: true });
    storeMap.set(meta.sessionId, meta);
    isWorktreeDirtyMock.mockResolvedValue(true);

    await expect(pool.releaseWorktree(meta.sessionId)).resolves.toBe('preserved');

    expect(gitExecMock).not.toHaveBeenCalled();
    expect(storeMap.has(meta.sessionId)).toBe(true);
  });

  it('checkpoints before reset and replaces the old registration with one new generation', async () => {
    const meta = makeMeta(baseRepo, 'previous', '2026-05-26T00:00:00.000Z');
    fsSync.mkdirSync(meta.path, { recursive: true });
    storeMap.set(meta.sessionId, meta);
    expect(await pool.releaseWorktree(meta.sessionId)).toBe('pooled');
    const order: string[] = [];
    checkpointMock.mockImplementation(async () => { order.push('checkpoint'); });
    gitExecMock.mockImplementation(async (args: string[]) => { order.push(args[0]); return { stdout: '', stderr: '' }; });
    const result = await pool.acquireWorktree({ sessionId: 'next', name: 'next', baseRepo, sourceBranch: 'main', ephemeral: true });
    expect(result.ok).toBe(true);
    expect(order.slice(0, 4)).toEqual(['checkpoint', 'checkout', 'reset', 'clean']);
    expect(storeMap.has(meta.sessionId)).toBe(false);
    expect(storeMap.get('next')).toMatchObject({ path: meta.path, generation: expect.any(String) });
    expect(storeMap.size).toBe(1);
  });

  it('leaves a pooled directory intact when a task references it before reuse', async () => {
    const meta = makeMeta(baseRepo, 'previous', '2026-05-26T00:00:00.000Z');
    fsSync.mkdirSync(meta.path, { recursive: true });
    storeMap.set(meta.sessionId, meta);
    expect(await pool.releaseWorktree(meta.sessionId)).toBe('pooled');
    liveSessionRows.push({ id: 'late-borrower', status: 'active', workingDir: meta.path, worktreePath: null });
    const req = { sessionId: 'next', name: 'next', baseRepo, sourceBranch: 'main', ephemeral: true };
    await pool.acquireWorktree(req);
    expect(checkpointMock).not.toHaveBeenCalled();
    expect(gitExecMock).not.toHaveBeenCalled();
    expect(storeMap.get(meta.sessionId)).toEqual(meta);
    expect(createWorktreeMock).toHaveBeenCalledWith(req);
  });
});
