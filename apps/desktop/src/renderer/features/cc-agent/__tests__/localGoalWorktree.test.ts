import { describe, expect, it, vi } from 'vitest';
import {
  isLocalGoalWorktreeCleanupPendingError,
  prepareLocalGoalWorktree,
  type LocalGoalWorktreeCreateResponse,
  type LocalGoalWorktreeProgress,
} from '../localGoalWorktree';

function makeHarness(options?: {
  create?: () => Promise<LocalGoalWorktreeCreateResponse>;
  update?: (path: string) => Promise<void>;
  rollback?: () => Promise<void>;
}) {
  const order: string[] = [];
  const progress: LocalGoalWorktreeProgress[] = [];
  const createWorktree = vi.fn(async (request: { sourceBranch: string }) => {
    order.push(`create:${request.sourceBranch}`);
    return options?.create
      ? options.create()
      : { ok: true as const, meta: { path: '/repo/.worktrees/goal', branch: 'goal' } };
  });
  const updateWorkingDir = vi.fn(async (path: string) => {
    order.push(`update:${path}`);
    await options?.update?.(path);
  });
  const patchWorkingDir = vi.fn((path: string) => order.push(`patch:${path}`));
  const rollbackSession = vi.fn(async () => {
    order.push('rollback');
    await options?.rollback?.();
  });
  const patchDeleted = vi.fn(() => order.push('deleted'));
  const clearProgress = vi.fn(() => order.push('clear'));
  const setProgress = vi.fn((value: LocalGoalWorktreeProgress) => progress.push(value));

  const run = () => prepareLocalGoalWorktree({
    sessionId: 'session-1',
    baseRepo: '/repo',
    name: 'goal',
    initialBranchName: 'goal',
    sourceBranch: 'feature/source',
    createWorktree,
    updateWorkingDir,
    patchWorkingDir,
    rollbackSession,
    patchDeleted,
    setProgress,
    clearProgress,
  });

  return {
    run,
    order,
    progress,
    createWorktree,
    updateWorkingDir,
    patchWorkingDir,
    rollbackSession,
    patchDeleted,
    clearProgress,
  };
}

describe('prepareLocalGoalWorktree', () => {
  it('updates the session to the managed path before clearing progress', async () => {
    const h = makeHarness();

    await expect(h.run()).resolves.toEqual({
      path: '/repo/.worktrees/goal',
      branch: 'goal',
    });
    expect(h.order).toEqual([
      'create:feature/source',
      'update:/repo/.worktrees/goal',
      'patch:/repo/.worktrees/goal',
      'clear',
    ]);
    expect(h.rollbackSession).not.toHaveBeenCalled();
  });

  it.each([
    ['confirmed failure', async () => ({ ok: false as const, error: { kind: 'CONFLICT' } })],
    ['invoke rejection', async () => { throw new Error('offline'); }],
  ])('rolls back the empty session after worktree create %s', async (_name, create) => {
    const h = makeHarness({ create });

    await expect(h.run()).rejects.toThrow();
    expect(h.order).toEqual(['create:feature/source', 'rollback', 'deleted', 'clear']);
    expect(h.updateWorkingDir).not.toHaveBeenCalled();
    expect(h.progress.at(-1)).toMatchObject({ status: 'failed', name: 'goal' });
  });

  it('rolls back when the managed workingDir update fails', async () => {
    const h = makeHarness({
      update: async () => { throw new Error('db unavailable'); },
    });

    await expect(h.run()).rejects.toThrow('db unavailable');
    expect(h.order).toEqual([
      'create:feature/source',
      'update:/repo/.worktrees/goal',
      'rollback',
      'deleted',
      'clear',
    ]);
    expect(h.patchWorkingDir).not.toHaveBeenCalled();
  });

  it('keeps failed progress and surfaces cleanup-pending when rollback itself fails', async () => {
    const h = makeHarness({
      create: async () => { throw new Error('create uncertain'); },
      rollback: async () => { throw new Error('delete unavailable'); },
    });

    const failure = await h.run().catch((error: unknown) => error);
    expect(isLocalGoalWorktreeCleanupPendingError(failure)).toBe(true);
    expect(h.patchDeleted).not.toHaveBeenCalled();
    expect(h.clearProgress).not.toHaveBeenCalled();
    expect(h.progress.at(-1)).toEqual({
      status: 'failed',
      name: 'goal',
      error: 'create uncertain',
    });
  });
});
