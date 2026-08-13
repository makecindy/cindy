import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { WorktreeMeta } from '../worktree/types';

const gitExecMock = vi.fn();
const safeDirectoryWitnessRefreshMock = vi.fn(async (mutation: () => Promise<unknown>) =>
  mutation(),
);
const { MockGitExecError } = vi.hoisted(() => ({
  MockGitExecError: class extends Error {
    constructor(public readonly stderr: string) {
      super(stderr);
    }
  },
}));
const storeMap = new Map<string, WorktreeMeta>();
const storeSetMock = vi.fn();

vi.mock('../worktree/gitExec', () => ({
  gitExec: (...args: unknown[]) => gitExecMock(...args),
  GitExecError: MockGitExecError,
}));

vi.mock('../worktree/safeDirectory', () => ({
  withSafeDirectoryRetention: async (
    _options: unknown,
    task: (retention: {
      addExact: ReturnType<typeof vi.fn>;
      addSubtree: ReturnType<typeof vi.fn>;
    }) => Promise<unknown>,
  ) => task({ addExact: vi.fn(), addSubtree: vi.fn() }),
  reconcileSafeDirectories: vi.fn(async () => undefined),
  withSafeDirectoryWitnessRefresh: (...args: unknown[]) =>
    safeDirectoryWitnessRefreshMock(...(args as [() => Promise<unknown>])),
}));

vi.mock('../worktree/includePatternsEngine', () => ({
  applyWorktreeIncludeFile: vi.fn(async () => []),
  listChangedWorktreeIncludeFiles: vi.fn(async () => []),
}));

vi.mock('../worktree/worktreeStore', () => ({
  get: (sessionId: string) => storeMap.get(sessionId) ?? null,
  getAll: () => [...storeMap.values()],
  getAllPaths: () => [...storeMap.values()].map((meta) => meta.path),
  set: (...args: unknown[]) => storeSetMock(...args),
  del: (sessionId: string) => storeMap.delete(sessionId),
}));

describe('createWorktree naming authority', () => {
  let manager: typeof import('../worktree/WorktreeManager');
  let tmpRoot: string;
  let baseRepo: string;
  let randomSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-worktree-create-'));
    baseRepo = path.join(tmpRoot, 'repo');
    fs.mkdirSync(baseRepo, { recursive: true });
    storeMap.clear();
    safeDirectoryWitnessRefreshMock.mockClear();
    storeSetMock.mockReset().mockImplementation(async (sessionId: string, meta: WorktreeMeta) => {
      storeMap.set(sessionId, meta);
    });
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    gitExecMock.mockReset().mockImplementation(async (args: string[]) => {
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

  it('does not write safe.directory during a normal successful creation', async () => {
    await expect(create('fix-login')).resolves.toMatchObject({ ok: true });

    expect(
      gitExecMock.mock.calls.some(
        ([args]) =>
          Array.isArray(args) &&
          args[0] === 'config' &&
          args.includes('--global') &&
          args.includes('safe.directory'),
      ),
    ).toBe(false);
  });

  it('refreshes safe.directory witnesses around the Windows long-path fallback write', async () => {
    let addAttempts = 0;
    const defaultGitExec = gitExecMock.getMockImplementation()!;
    gitExecMock.mockImplementation(async (...callArgs: unknown[]) => {
      const args = callArgs[0] as string[];
      if (args[0] === '-c' && args[2] === 'worktree' && args[3] === 'add') {
        addAttempts += 1;
        if (addAttempts === 1) throw new MockGitExecError('Filename too long');
      }
      return defaultGitExec(...callArgs);
    });

    await expect(create('long-paths')).resolves.toMatchObject({ ok: true });

    expect(safeDirectoryWitnessRefreshMock).toHaveBeenCalledOnce();
    expect(gitExecMock.mock.calls.map(([args]) => args)).toContainEqual([
      'config',
      '--global',
      'core.longpaths',
      'true',
    ]);
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
});
