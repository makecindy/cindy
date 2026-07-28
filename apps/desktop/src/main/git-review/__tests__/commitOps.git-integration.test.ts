import { promises as fs } from 'node:fs';
import path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Windows 上 git 子进程明显更慢(每次 spawn 数百毫秒),多步 git 编排用例会超默认 5s。
vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 });

import { TestDirectoryTemplate } from '../../../test/vitest/testDirectoryTemplate';
import { commitStagedChanges, GitReviewCommitError } from '../commitOps';
import { runGit } from '../gitRunner';
import { readStatus } from '../statusReader';
import type { ReviewScope } from '../types';

let repoPath: string;

const repoTemplate = new TestDirectoryTemplate('xdt-git-review-commit-op-', async (dir) => {
  await runGit(['init'], { cwd: dir });
  await runGit(['config', 'user.email', 'test@xdt.local'], { cwd: dir });
  await runGit(['config', 'user.name', 'XDT Test'], { cwd: dir });
  await runGit(['config', 'commit.gpgsign', 'false'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'file.txt'), 'one\n');
  await runGit(['add', 'file.txt'], { cwd: dir });
  await runGit(['commit', '--no-gpg-sign', '-m', 'seed'], { cwd: dir });
});

function scope(): ReviewScope {
  return {
    sessionId: 's1',
    workdir: repoPath,
    worktreePath: repoPath,
    workingDir: repoPath,
    repoRoot: repoPath,
    branch: 'main',
    headOid: null,
    isDetached: false,
    isUnborn: false,
    source: 'worktree',
    aheadBehind: { ahead: 0, behind: 0, upstream: null, stale: true },
    disabledReason: null,
    disabledMessage: null,
    resolutionChain: [],
  };
}

beforeEach(async () => {
  repoPath = await repoTemplate.createCopy();
});

afterEach(async () => {
  await fs.rm(repoPath, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

afterAll(async () => {
  await repoTemplate.dispose();
});

describe('git-review commitOps', () => {
  it('commits staged changes with stdin message', async () => {
    await fs.writeFile(path.join(repoPath, 'file.txt'), 'two\n');
    await runGit(['add', 'file.txt'], { cwd: repoPath });
    const result = await commitStagedChanges(scope(), await readStatus(scope()), 'update file\n\nbody');

    expect(result.commitOid).toMatch(/[0-9a-f]{40}/);
    expect((await runGit(['log', '-1', '--format=%s%n%b'], { cwd: repoPath })).stdout).toContain('update file');
  });

  it('rejects empty staged changes and empty messages', async () => {
    await expect(commitStagedChanges(scope(), await readStatus(scope()), 'message')).rejects.toThrow(GitReviewCommitError);
    await expect(commitStagedChanges(scope(), await readStatus(scope()), 'message', { includeUnstaged: true }))
      .rejects.toThrow(GitReviewCommitError);
    await fs.writeFile(path.join(repoPath, 'file.txt'), 'two\n');
    await runGit(['add', 'file.txt'], { cwd: repoPath });
    await expect(commitStagedChanges(scope(), await readStatus(scope()), '   ')).rejects.toThrow(GitReviewCommitError);
  });

  it('commits untracked files when includeUnstaged is enabled', async () => {
    await fs.writeFile(path.join(repoPath, 'new file.txt'), 'new\n');

    const result = await commitStagedChanges(scope(), await readStatus(scope()), 'add untracked', {
      includeUnstaged: true,
    });

    expect(result.commitOid).toMatch(/[0-9a-f]{40}/);
    const { stdout } = await runGit(['show', '--name-status', '--format=', 'HEAD'], { cwd: repoPath });
    expect(stdout).toContain('A\tnew file.txt');
  });

  it('commits unstaged deletions when includeUnstaged is enabled', async () => {
    await fs.rm(path.join(repoPath, 'file.txt'));

    await commitStagedChanges(scope(), await readStatus(scope()), 'delete file', {
      includeUnstaged: true,
    });

    const { stdout } = await runGit(['show', '--name-status', '--format=', 'HEAD'], { cwd: repoPath });
    expect(stdout).toContain('D\tfile.txt');
  });

  it('commits staged and unstaged changes together when includeUnstaged is enabled', async () => {
    await fs.writeFile(path.join(repoPath, 'file.txt'), 'two\n');
    await runGit(['add', 'file.txt'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'extra.txt'), 'extra\n');

    await commitStagedChanges(scope(), await readStatus(scope()), 'mixed changes', {
      includeUnstaged: true,
    });

    const { stdout } = await runGit(['show', '--name-status', '--format=', 'HEAD'], { cwd: repoPath });
    expect(stdout).toContain('M\tfile.txt');
    expect(stdout).toContain('A\textra.txt');
  });

  it('keeps staged-only semantics when includeUnstaged is disabled', async () => {
    await fs.writeFile(path.join(repoPath, 'file.txt'), 'two\n');

    await expect(commitStagedChanges(scope(), await readStatus(scope()), 'unstaged only', {
      includeUnstaged: false,
    })).rejects.toThrow(GitReviewCommitError);
  });

  it('rejects unmerged or in-progress states', async () => {
    await fs.writeFile(path.join(repoPath, 'file.txt'), 'two\n');
    await runGit(['add', 'file.txt'], { cwd: repoPath });
    const unmergedStatus = await readStatus(scope());
    unmergedStatus.writeDisabledReasons.push('unmerged');
    await expect(commitStagedChanges(scope(), unmergedStatus, 'message')).rejects.toThrow(GitReviewCommitError);

    const inProgressStatus = await readStatus(scope());
    inProgressStatus.writeDisabledReasons.push('in-progress');
    await expect(commitStagedChanges(scope(), inProgressStatus, 'message')).rejects.toThrow(GitReviewCommitError);
  });

  it('runs repository hooks for explicit commits', async () => {
    const hookPath = path.join(repoPath, '.git', 'hooks', 'pre-commit');
    const marker = path.join(repoPath, 'hook-ran');
    await fs.writeFile(hookPath, `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`);
    await fs.chmod(hookPath, 0o755);
    await fs.writeFile(path.join(repoPath, 'file.txt'), 'hook\n');
    await runGit(['add', 'file.txt'], { cwd: repoPath });

    await commitStagedChanges(scope(), await readStatus(scope()), 'hook commit');

    await expect(fs.readFile(marker, 'utf8')).resolves.toContain('ran');
  });
});
