import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { detectCwd } from '../worktree/WorktreeManager';

const exec = promisify(execFile);
let fixture: string | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  if (fixture) await fs.rm(fixture, { recursive: true, force: true });
});

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GIT_')) vi.stubEnv(key, undefined);
  }
  vi.stubEnv('GIT_CONFIG_GLOBAL', process.platform === 'win32' ? 'NUL' : os.devNull);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});

it('preserves real Git snapshots for attached, detached, unborn, missing and nested directories', async () => {
  fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-detect-cwd-'));
  const repo = path.join(fixture, 'repo');
  await fs.mkdir(repo);
  const git = (...args: string[]) => exec('git', args, { cwd: repo, windowsHide: true });
  await git('init', '--initial-branch=main');
  expect(await detectCwd(repo)).toMatchObject({
    isGitRepo: true,
    isInsideWorktree: false,
    gitInstalled: true,
  });
  await git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'fixture',
  );
  expect(await detectCwd(repo)).toMatchObject({ currentBranch: 'main', isInsideWorktree: false });

  const linked = path.join(fixture, 'linked');
  await git('worktree', 'add', '-b', 'feature', linked);
  const snapshot = await detectCwd(linked);
  expect(snapshot).toMatchObject({
    isGitRepo: true,
    isInsideWorktree: true,
    currentBranch: 'feature',
  });
  const subdir = path.join(linked, 'nested');
  await fs.mkdir(subdir);
  expect(await detectCwd(subdir)).toEqual(snapshot);
  await git('-C', linked, 'checkout', '--detach');
  expect(await detectCwd(linked)).toEqual({ ...snapshot, currentBranch: undefined });
  await git('worktree', 'remove', '--force', linked);
  expect(await detectCwd(linked)).toMatchObject({
    isGitRepo: false,
    isInsideWorktree: false,
    gitInstalled: true,
  });
  expect(await detectCwd(fixture)).toMatchObject({
    isGitRepo: false,
    isInsideWorktree: false,
    gitInstalled: true,
  });

  if (process.platform !== 'win32') {
    const spaced = path.join(fixture, 'repo ');
    await fs.mkdir(spaced);
    await git('-C', spaced, 'init', '--initial-branch=main');
    expect((await detectCwd(spaced)).repoRoot).toBe(await fs.realpath(spaced));
    await git('-C', spaced, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '--allow-empty', '-m', 'fixture');
    expect((await detectCwd(spaced)).repoRoot).toBe(await fs.realpath(spaced));
    const newlinePath = path.join(fixture, 'line\nbreak');
    await git('worktree', 'add', '--detach', newlinePath);
    const newlineSnapshot = await detectCwd(newlinePath);
    expect(newlineSnapshot).toMatchObject({ isGitRepo: true, isInsideWorktree: true });
    expect(newlineSnapshot.repoRoot).toBe(await fs.realpath(newlinePath));
  }
}, 30_000);

// #6409: existing snapshots never crossed a directory symlink. Exercise detectCwd
// with A/link -> B/workspace/project, where Git can mix absolute git-dir and
// physical-cwd-relative common-dir. Real Git belongs in the git-integration tier.
it.for(['unborn', 'committed'] as const)(
  'does not label a symlink into a %s ordinary repository as a linked worktree',
  async (state, context) => {
    fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-detect-cwd-symlink-'));
    const repoA = path.join(fixture, 'A');
    const repoB = path.join(fixture, 'B');
    const nested = path.join(repoB, 'workspace', 'project');
    await fs.mkdir(repoA);
    await fs.mkdir(nested, { recursive: true });
    const git = (...args: string[]) => exec('git', args, { cwd: repoB, windowsHide: true });
    await git('-C', repoA, 'init', '--initial-branch=main');
    await git('init', '--initial-branch=main');
    if (state === 'committed') {
      await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
        'commit', '--allow-empty', '-m', 'fixture');
    }
    const link = path.join(repoA, 'link');
    try {
      await fs.symlink(nested, link, 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        context.skip();
        return;
      }
      throw error;
    }
    expect(await detectCwd(link)).toMatchObject({
      isGitRepo: true,
      isInsideWorktree: false,
      gitInstalled: true,
      repoRoot: await fs.realpath(repoB),
    });
  },
);
