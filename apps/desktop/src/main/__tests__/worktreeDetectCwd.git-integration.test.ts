import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';

import { detectCwd } from '../worktree/WorktreeManager';

const exec = promisify(execFile);
let fixture: string | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  if (fixture) await fs.rm(fixture, { recursive: true, force: true });
});

it('preserves real Git snapshots for attached, detached, unborn, missing and nested directories', async () => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GIT_')) vi.stubEnv(key, undefined);
  }
  vi.stubEnv('GIT_CONFIG_GLOBAL', process.platform === 'win32' ? 'NUL' : os.devNull);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
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
