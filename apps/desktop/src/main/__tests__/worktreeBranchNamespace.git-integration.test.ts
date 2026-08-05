import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  blocksManagedWorktreeBranchNamespace,
  getManagedWorktreeReservedName,
} from '../../shared/managedWorktreeBranches';
import { readAttachedWorktreeBranch } from '../worktree/attachedBranch';

const tempDirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: os.devNull,
    },
  }).trim();
}

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-branch-namespace-'));
  tempDirs.push(repo);
  git(repo, 'init', '--initial-branch=main');
  git(repo, 'config', 'user.name', 'Cindy Test');
  git(repo, 'config', 'user.email', 'cindy-test@example.invalid');
  fs.writeFileSync(path.join(repo, 'README.md'), 'test\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'init');
  return repo;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('managed Worktree branch namespace', () => {
  it('turns a real descendant ref collision into a reserved name', () => {
    const repo = makeRepo();
    git(repo, 'branch', 'cindy/foo/bar');

    expect(() => git(repo, 'branch', 'cindy/foo')).toThrow();
    const branches = git(repo, 'branch', '--format=%(refname:short)').split(/\r?\n/);
    expect(branches.map(getManagedWorktreeReservedName).filter(Boolean)).toContain('foo');
    expect(() => git(repo, 'branch', 'cindy/foo-2')).not.toThrow();
  });

  it('detects a real namespace-root ref that blocks every cindy/* branch', () => {
    const repo = makeRepo();
    git(repo, 'branch', 'cindy');

    expect(() => git(repo, 'branch', 'cindy/foo')).toThrow();
    expect(blocksManagedWorktreeBranchNamespace('cindy')).toBe(true);
  });

  it('keeps local origin/* branches distinct from origin tracking refs', () => {
    const repo = makeRepo();
    git(repo, 'branch', 'origin/cindy');
    git(repo, 'update-ref', 'refs/remotes/origin/cindy', 'HEAD');

    const refs = git(repo, 'branch', '--all', '--format=%(refname)').split(/\r?\n/);
    expect(refs).toContain('refs/heads/origin/cindy');
    expect(refs).toContain('refs/remotes/origin/cindy');
  });

  it('reads the canonical branch name when a tag has the same short name', async () => {
    const repo = makeRepo();
    git(repo, 'branch', 'cindy/foo');
    git(repo, 'tag', 'cindy/foo');
    git(repo, 'checkout', 'cindy/foo');

    expect(git(repo, 'symbolic-ref', '--quiet', '--short', 'HEAD')).toBe('heads/cindy/foo');
    await expect(readAttachedWorktreeBranch(repo)).resolves.toBe('cindy/foo');
  });
});
