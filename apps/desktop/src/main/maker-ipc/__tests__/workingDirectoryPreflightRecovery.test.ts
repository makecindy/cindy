import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createWorkingDirectoryRecovery } from '../workingDirectoryRecovery';
import { createWorkingDirectoryPreflight } from '../workingDirectoryPreflight';

function harness(originalState: 'EACCES' | 'file' | 'ENOENT' | 'ready', saved = true) {
  const original = path.resolve('original-project');
  const fallback = path.resolve('owned-dialogues', 'dialogue-recovery', 'saved');
  const stat = vi.fn(async (dir: string) => {
    if (dir === fallback) return { isDirectory: () => true };
    if (dir !== original) throw new Error('unexpected filesystem probe');
    if (originalState === 'EACCES' || originalState === 'ENOENT') {
      throw Object.assign(new Error(originalState), { code: originalState });
    }
    return { isDirectory: () => originalState === 'ready' };
  });
  const mkdir = vi.fn();
  const findFallback = vi.fn(async (): Promise<string | undefined> => saved ? fallback : undefined);
  const allocate = vi.fn(async () => fallback);
  const recovery = createWorkingDirectoryRecovery({ stat, mkdir, findFallback }, allocate);
  const emit = vi.fn();
  const readiness = vi.fn(async (): Promise<'ready' | 'gone' | 'retry'> => 'ready');
  const managedBase = vi.fn((_dir: string): string | null => null);
  const isCindyMake = vi.fn(() => false);
  const deps = {
    workingDirectoryRecovery: recovery,
    statWorkingDirectory: stat,
    readBoundWorkingDir: vi.fn(async () => original),
    getUserDataPath: () => path.resolve('test-profile'),
    isCindyMakeWorktreePath: isCindyMake,
    assertCindyMakeWorkspace: vi.fn(async () => {}),
    getManagedWorktreeBasePath: managedBase,
    getManagedWorktreeReadinessForSession: readiness,
    findSimilarDirOnDisk: vi.fn(async () => null),
    listActiveSessions: () => [],
    workdirLog: { debug: vi.fn(), warn: vi.fn() },
    log: { debug: vi.fn(), warn: vi.fn() },
    emitWorkDirMissingError: emit,
  };
  const check = createWorkingDirectoryPreflight(deps);
  return { original, fallback, stat, mkdir, findFallback, allocate, recovery, emit, readiness, managedBase, isCindyMake, check };
}

describe('persistent ordinary recovery in workdir preflight', () => {
  it.each(['EACCES', 'file', 'ENOENT', 'ready'] as const)(
    'resumes the saved workspace before probing an original path in state %s',
    async (state) => {
      for (const suppressMissingBroadcast of [false, true]) {
        const h = harness(state);
        expect(await h.check('task', h.original, 'codex', undefined, { suppressMissingBroadcast })).toBe(true);
        expect(h.recovery.resolve('task', h.original)).toBe(h.fallback);
        expect(h.recovery.peek('task', h.original)).toContain('previously selected');
        expect(h.stat.mock.calls.every(([dir]) => dir === h.fallback)).toBe(true);
        expect(h.stat).toHaveBeenCalled();
        expect(h.mkdir).not.toHaveBeenCalled();
        expect(h.allocate).not.toHaveBeenCalled();
        expect(h.emit).not.toHaveBeenCalled();
      }
    },
  );

  it('preserves EACCES without a saved workspace instead of reporting missing', async () => {
    const h = harness('EACCES', false);
    h.readiness.mockResolvedValue('retry');
    await expect(h.check('task', h.original, 'codex')).rejects.toMatchObject({ code: 'EACCES' });
    expect(h.recovery.isFallback('task', h.original)).toBe(false);
    expect(h.allocate).not.toHaveBeenCalled();
    expect(h.mkdir).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
  });

  it('blocks a non-directory result without entering missing recovery', async () => {
    const h = harness('file', false);
    expect(await h.check('task', h.original, 'codex')).toBe(false);
    expect(h.recovery.isFallback('task', h.original)).toBe(false);
    expect(h.allocate).not.toHaveBeenCalled();
    expect(h.mkdir).not.toHaveBeenCalled();
    expect(h.emit).toHaveBeenCalledWith('task', h.original, 'codex', 'not-dir');
  });

  it('leaves a missing-path first probe to the caller with a DB repair candidate', async () => {
    const h = harness('ENOENT', false);
    h.readiness.mockResolvedValue('retry');
    expect(await h.check('task', h.original, 'codex', undefined, { suppressMissingBroadcast: true })).toBe(false);
    expect(h.mkdir).not.toHaveBeenCalled();
    expect(h.allocate).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
  });

  it.each(['EACCES', 'EIO'])('blocks a failed saved-selection lookup (%s) without touching the original', async (code) => {
    const h = harness('ready');
    h.findFallback.mockRejectedValue(Object.assign(new Error(code), { code }));
    expect(await h.check('task', h.original, 'codex')).toBe(false);
    expect(h.stat).not.toHaveBeenCalled();
    expect(h.allocate).not.toHaveBeenCalled();
    expect(h.mkdir).not.toHaveBeenCalled();
  });

  it.each(['ssh', 'worktree', 'cindy-make'])('preserves the %s readiness path', async (kind) => {
    const h = harness('ready');
    if (kind === 'worktree') h.managedBase.mockReturnValue(path.resolve('repo'));
    if (kind === 'cindy-make') h.isCindyMake.mockReturnValue(true);
    expect(await h.check('task', h.original, 'codex', kind === 'ssh' ? 'remote-host' : undefined)).toBe(true);
    expect(h.findFallback).not.toHaveBeenCalled();
    expect(h.recovery.isFallback('task', h.original)).toBe(false);
    if (kind === 'ssh') expect(h.stat).not.toHaveBeenCalled();
    if (kind === 'worktree') expect(h.readiness).toHaveBeenCalledOnce();
  });

  it('does not revive a selection cleared during its lookup', async () => {
    const h = harness('EACCES');
    let finish!: (dir: string) => void;
    h.findFallback.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = h.check('task', h.original, 'codex');
    await vi.waitFor(() => expect(h.findFallback).toHaveBeenCalledOnce());
    h.recovery.clear();
    finish(h.fallback);
    expect(await pending).toBe(false);
    expect(h.recovery.isFallback('task', h.original)).toBe(false);
    expect(h.stat).not.toHaveBeenCalled();
  });
});
