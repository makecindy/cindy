import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import path from 'node:path';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';

import type { WorktreeMeta } from '../worktree/types';

const gitExecMock = vi.fn();
const isWorktreeDirtyMock = vi.fn();
const storeMap = new Map<string, WorktreeMeta>();
const liveSessionRows: Array<{
  id: string;
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
  set: vi.fn(),
  del: (sessionId: string) => storeMap.delete(sessionId),
}));

vi.mock('../worktree/WorktreeManager', () => ({
  copyClaudeSiviDirs: vi.fn(),
  createWorktree: vi.fn(),
}));

vi.mock('../localDb/client/current', () => ({
  getDbClient: () => ({
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
    liveSessionLookupError = null;
    liveSessionQueryCount = 0;
    gitExecMock.mockReset();
    isWorktreeDirtyMock.mockReset().mockResolvedValue(false);
    rmSpy = vi.spyOn(fs, 'rm');

    pool = await import('../worktree/WorktreePool');
    pool.parkAll();
  });

  afterEach(() => {
    pool?.parkAll();
    rmSpy.mockRestore();
    fsSync.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('does not evict a worktree still referenced by a non-deleted session', async () => {
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
    expect(liveSessionQueryCount).toBe(1);
  });

  it('does not return a live session worktree to the reusable pool', async () => {
    const meta = makeMeta(baseRepo, 'session-1', '2026-05-26T00:00:00.000Z');
    fsSync.mkdirSync(meta.path, { recursive: true });
    storeMap.set(meta.sessionId, meta);
    liveSessionRows.push({
      id: meta.sessionId,
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
    await expect(pool.drainOne(baseRepo)).rejects.toThrow('git remove failed');

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
      | { timeoutMs?: number; extraEnv?: Record<string, string> }
      | undefined;
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

  it('preserves dirty worktrees instead of auto-stashing them into the pool', async () => {
    const meta = makeMeta(baseRepo, 'session-1', '2026-05-26T00:00:00.000Z');
    fsSync.mkdirSync(meta.path, { recursive: true });
    storeMap.set(meta.sessionId, meta);
    isWorktreeDirtyMock.mockResolvedValue(true);

    await expect(pool.releaseWorktree(meta.sessionId)).resolves.toBe('preserved');

    expect(gitExecMock).not.toHaveBeenCalled();
    expect(storeMap.has(meta.sessionId)).toBe(true);
  });
});
