import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { createWorkingDirectoryRecovery } from '../workingDirectoryRecovery';

// Execute the production preflight with isolated IO, without booting Electron.
const register = readFileSync(new URL('../register.ts', import.meta.url), 'utf8');
const start = register.indexOf('async function checkWorkDirExists(');
const end = register.indexOf('\n/**', start);
const compiled = transpileModule(register.slice(start, end), {
  compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText;

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
  const readiness = vi.fn(async () => 'ready');
  const managedBase = vi.fn((_dir: string): string | null => null);
  const isCindyMake = vi.fn(() => false);
  const deps = {
    path,
    app: { getPath: () => path.resolve('test-profile') },
    isCindyMakeManagedWorktreePath: isCindyMake,
    assertCindyMakeWorkspace: vi.fn(async () => {}),
    workingDirectoryRecovery: recovery,
    statWorkingDirectory: stat,
    getManagedWorktreeBasePath: managedBase,
    getManagedWorktreeReadinessForSession: readiness,
    workdirDiagnosticContext: () => ({}),
    workdirDiagnosticId: () => 'redacted',
    workdirDiagnosticErrorCode: (error: NodeJS.ErrnoException) => error.code,
    workdirLog: { warn: vi.fn(), info: vi.fn() },
    log: { warn: vi.fn(), info: vi.fn() },
    emitWorkDirMissingError: emit,
    isUnavailableFilesystemError: () => false,
    findSimilarDirOnDisk: vi.fn(async () => null),
    getMaker: () => ({ listActiveSessions: () => [] }),
  };
  const check = new Function(...Object.keys(deps), compiled + '\nreturn checkWorkDirExists;')(
    ...Object.values(deps),
  ) as (id: string, dir: string, kind: string, remote?: string, opts?: { suppressMissingBroadcast: boolean }) => Promise<boolean>;
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

  it.each(['EACCES', 'file'] as const)('still blocks %s without a saved workspace', async (state) => {
    const h = harness(state, false);
    h.readiness.mockResolvedValue('not-managed');
    expect(await h.check('task', h.original, 'codex')).toBe(false);
    expect(h.recovery.isFallback('task', h.original)).toBe(false);
    expect(h.allocate).not.toHaveBeenCalled();
    expect(h.mkdir).not.toHaveBeenCalled();
    expect(h.emit).toHaveBeenCalledOnce();
  });

  it('leaves a missing-path first probe to the caller with a DB repair candidate', async () => {
    const h = harness('ENOENT', false);
    h.readiness.mockResolvedValue('not-managed');
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
