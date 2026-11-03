import { mkdtemp, mkdir, writeFile, readFile, access, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';
import { runSourceGit } from '../sourceGit.js';
import { manageCindyMakeWorkspace } from '../taskCleanup.js';
import { makeSourceCheckoutPath, makeTaskWorktreePath, makeTaskBranch } from '../sourcePaths.js';

it('preserves archives and finished unintegrated changes, and completely removes discarded work with real Git', async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'cindy-make-cleanup-'));
  const source = makeSourceCheckoutPath(profile);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    GIT_CONFIG_GLOBAL: path.join(profile, 'empty.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  const signal = AbortSignal.timeout(90_000);
  const git = async (args: string[], cwd = source) => {
    try {
      return await runSourceGit(env, args, cwd, signal);
    } catch (error) {
      const detail = error as { operation?: string; stderr?: string; spawnCode?: string };
      throw new Error(
        [detail.operation, detail.spawnCode, detail.stderr].filter(Boolean).join(': '),
        { cause: error },
      );
    }
  };
  try {
    await writeFile(env.GIT_CONFIG_GLOBAL!, '');
    await mkdir(source, { recursive: true });
    await git(['init', '--initial-branch=cindy-personal']);
    await writeFile(path.join(source, '.gitignore'), 'node_modules/\n');
    await git(['add', '.']);
    await git(['commit', '-s', '-m', 'base']);
    const baseCommit = await git(['rev-parse', 'HEAD']);
    const target = makeTaskWorktreePath(profile, 'first');
    await git(['worktree', 'add', '-b', makeTaskBranch('first'), target]);
    await expect(
      manageCindyMakeWorkspace(profile, 'first', 'archive', env, signal, { baseCommit }),
    ).resolves.toBe(false);
    await writeFile(path.join(target, 'feature.txt'), 'personal change');
    await expect(
      manageCindyMakeWorkspace(profile, 'first', 'finish', env, signal),
    ).resolves.toBe(false);
    await git(['add', '.'], target);
    await git(['commit', '-s', '-m', 'feature'], target);
    await mkdir(path.join(target, 'node_modules'), { recursive: true });
    await writeFile(path.join(target, 'node_modules', 'dependency'), 'ignored dependency');
    await expect(
      manageCindyMakeWorkspace(profile, 'first', 'archive', env, signal, { baseCommit }),
    ).resolves.toBe(false);
    await expect(manageCindyMakeWorkspace(profile, 'first', 'finish', env, signal)).resolves.toBe(
      false,
    );
    expect(await readFile(path.join(target, 'feature.txt'), 'utf8')).toBe('personal change');
    await expect(access(path.join(source, 'feature.txt'))).rejects.toThrow();
    await manageCindyMakeWorkspace(profile, 'first', 'delete', env, signal);
    await expect(access(target)).rejects.toThrow();
    expect(await git(['branch', '--list', makeTaskBranch('first')])).toBe('');
    const conflict = makeTaskWorktreePath(profile, 'conflict');
    await git(['worktree', 'add', '-b', makeTaskBranch('conflict'), conflict]);
    await writeFile(path.join(conflict, 'feature.txt'), 'task change');
    await git(['add', '.'], conflict);
    await git(['commit', '-s', '-m', 'task change'], conflict);
    await writeFile(path.join(source, 'feature.txt'), 'personal change advanced');
    await git(['add', '.']);
    await git(['commit', '-s', '-m', 'personal change advanced']);
    await expect(
      manageCindyMakeWorkspace(profile, 'conflict', 'finish', env, signal),
    ).resolves.toBe(false);
    expect(await readFile(path.join(conflict, 'feature.txt'), 'utf8')).toBe('task change');
    expect(await readFile(path.join(source, 'feature.txt'), 'utf8')).toBe(
      'personal change advanced',
    );
    expect(await git(['status', '--porcelain'])).toBe('');
    await expect(access(path.join(source, '.git', 'MERGE_HEAD'))).rejects.toThrow();
    await expect(
      manageCindyMakeWorkspace(profile, 'conflict', 'delete', env, signal),
    ).resolves.toBe(true);
    const discarded = makeTaskWorktreePath(profile, 'discarded');
    await git(['worktree', 'add', '-b', makeTaskBranch('discarded'), discarded]);
    await writeFile(path.join(discarded, 'not-merged.txt'), 'discard only this');
    const longDependency = path.join(
      discarded,
      'node_modules',
      ...Array(6).fill('long-dependency-name-1234567890'),
    );
    await mkdir(longDependency, { recursive: true });
    await writeFile(path.join(longDependency, 'index.js'), 'long path dependency');
    await expect(
      manageCindyMakeWorkspace(profile, 'discarded', 'end', env, signal),
    ).resolves.toBe(true);
    await expect(access(discarded)).rejects.toThrow();
    // Match Windows' failed removal: no registration/.git, but dependencies and
    // the task branch survive. Preparation metadata is the recovery authority.
    const partial = makeTaskWorktreePath(profile, 'partial');
    const partialBranch = makeTaskBranch('partial');
    await git(['worktree', 'add', '-b', partialBranch, partial]);
    await git(['worktree', 'remove', '--force', partial]);
    const deep = path.join(
      partial,
      'node_modules',
      ...Array(6).fill('dependency-with-long-package-name-123456789'),
    );
    await mkdir(deep, { recursive: true });
    await writeFile(path.join(deep, 'leftover.js'), 'locked during previous cleanup');
    const outside = path.join(profile, 'unrelated-work');
    await mkdir(outside);
    await writeFile(path.join(outside, 'keep.txt'), 'keep');
    await symlink(
      outside,
      path.join(partial, 'linked-folder'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(
      manageCindyMakeWorkspace(profile, 'partial', 'delete', env, signal),
    ).rejects.toMatchObject({ code: 'unavailable' });
    await expect(
      manageCindyMakeWorkspace(profile, 'partial', 'end', env, signal, {
        preparedWorkspace: { path: partial, branch: partialBranch },
      }),
    ).resolves.toBe(true);
    await expect(access(partial)).rejects.toThrow();
    expect(await readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep');
    expect(await git(['branch', '--list', 'cindy-make/*'])).toBe('');
    expect(await git(['worktree', 'list', '--porcelain'])).not.toContain('worktrees');
    expect(await readFile(path.join(source, 'feature.txt'), 'utf8')).toBe(
      'personal change advanced',
    );
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}, 90_000);
