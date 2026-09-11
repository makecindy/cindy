import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isCindyMakeWorktreePath, prepareCindyMakeWorkspace } from '../taskWorkspace';

describe('prepareCindyMakeWorkspace', () => {
  let userData: string;
  beforeEach(async () => {
    userData = await mkdtemp(path.join(os.tmpdir(), 'cindy-make-workspace-'));
    await mkdir(path.join(userData, 'cindy-make', 'source', '.git'), { recursive: true });
  });
  afterEach(async () => {
    await rm(userData, { recursive: true, force: true });
  });

  it('branches a new worktree off the personal baseline and installs dependencies', async () => {
    const git = vi.fn(async (_env: NodeJS.ProcessEnv, args: string[]) => {
      if (args[0] === 'branch' && args[2] === 'cindy-personal') return '  cindy-personal\n';
      if (args[0] === 'branch') return '';
      if (args[0] === 'rev-parse') return 'abcdef1234567\n';
      if (args[0] === 'worktree') return '';
      throw new Error(`unexpected ${args.join(' ')}`);
    });
    const pnpm = vi.fn(async () => undefined);
    const phases: string[] = [];
    const workspace = await prepareCindyMakeWorkspace(
      userData,
      'run-1',
      new AbortController().signal,
      { processEnvironment: { PATH: '' }, git, pnpm },
      (phase) => phases.push(phase),
    );
    const worktreePath = path.join(userData, 'cindy-make', 'worktrees', 'run-1');
    expect(workspace).toEqual({
      path: worktreePath,
      branch: 'cindy-make/run-1',
      baseCommit: 'abcdef1234567',
    });
    expect(git).toHaveBeenCalledWith(
      expect.anything(),
      ['worktree', 'add', '-b', 'cindy-make/run-1', worktreePath, 'cindy-personal'],
      path.join(userData, 'cindy-make', 'source'),
      expect.anything(),
    );
    expect(pnpm).toHaveBeenCalledWith(
      expect.anything(),
      ['install', '--prefer-offline'],
      worktreePath,
      expect.anything(),
    );
    expect(phases).toEqual(['checking', 'creating', 'installing']);
  });

  it('reuses an existing worktree on the task branch and refuses a foreign directory', async () => {
    const worktreePath = path.join(userData, 'cindy-make', 'worktrees', 'run-2');
    await mkdir(worktreePath, { recursive: true });
    await writeFile(path.join(worktreePath, '.git'), 'gitdir: ../../source/.git/worktrees/run-2\n');
    const git = vi.fn(async (_env: NodeJS.ProcessEnv, args: string[], cwd: string) => {
      if (args[0] === 'branch')
        return args[2] === 'cindy-personal' ? 'cindy-personal' : 'cindy-make/run-2';
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
        expect(cwd).toBe(worktreePath);
        return 'cindy-make/run-2';
      }
      if (args[0] === 'rev-parse') return 'abcdef1234567';
      throw new Error(`unexpected ${args.join(' ')}`);
    });
    const pnpm = vi.fn(async () => undefined);
    await expect(
      prepareCindyMakeWorkspace(userData, 'run-2', new AbortController().signal, {
        processEnvironment: {},
        git,
        pnpm,
      }),
    ).resolves.toMatchObject({ path: worktreePath, branch: 'cindy-make/run-2' });
    expect(git.mock.calls.some(([, args]) => args[0] === 'worktree')).toBe(false);

    await rm(path.join(worktreePath, '.git'));
    await expect(
      prepareCindyMakeWorkspace(userData, 'run-2', new AbortController().signal, {
        processEnvironment: {},
        git,
        pnpm,
      }),
    ).rejects.toMatchObject({ code: 'gitFailed' });
  });

  it('fails before touching Git when the source or personal branch is missing', async () => {
    const git = vi.fn<(env: NodeJS.ProcessEnv, args: string[]) => Promise<string>>(async () => '');
    await expect(
      prepareCindyMakeWorkspace(userData, 'run-3', new AbortController().signal, {
        processEnvironment: {},
        git,
        pnpm: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: 'environmentNotReady' });
    expect(git.mock.calls.some(([, args]) => args[0] === 'worktree')).toBe(false);

    await rm(path.join(userData, 'cindy-make', 'source', '.git'), { recursive: true });
    await expect(
      prepareCindyMakeWorkspace(userData, 'run-3', new AbortController().signal, {
        processEnvironment: {},
        git,
        pnpm: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: 'environmentNotReady' });
    await expect(
      prepareCindyMakeWorkspace(userData, '../escape', new AbortController().signal, {
        processEnvironment: {},
        git,
        pnpm: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: 'gitFailed' });
  });
});

describe('isCindyMakeWorktreePath', () => {
  const userData = path.resolve(os.tmpdir(), 'cindy-userdata');
  const worktrees = path.join(userData, 'cindy-make', 'worktrees');
  it('accepts only a direct child of the worktrees root named like a run id', () => {
    expect(isCindyMakeWorktreePath(userData, path.join(worktrees, 'run-1'))).toBe(true);
    expect(isCindyMakeWorktreePath(userData, worktrees)).toBe(false);
    expect(isCindyMakeWorktreePath(userData, path.join(worktrees, 'run-1', 'apps'))).toBe(false);
    expect(isCindyMakeWorktreePath(userData, path.join(worktrees, '..', 'source'))).toBe(false);
    expect(isCindyMakeWorktreePath(userData, path.join(userData, 'cindy-make', 'source'))).toBe(
      false,
    );
  });
});
