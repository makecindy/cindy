import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
// Windows 上 git 子进程明显更慢(每次 spawn 数百毫秒),多步 git 编排用例会超默认 5s。
vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 });

import { TestDirectoryTemplate } from '../../../test/vitest/testDirectoryTemplate';
import { runGit } from '../gitRunner';
import { GitReviewPushError, pushBranch } from '../pushOps';
import { readStatus } from '../statusReader';
import type { ReviewScope, ReviewStatus } from '../types';

const roots: string[] = [];

const repoTemplate = new TestDirectoryTemplate('xdt-git-review-push-', async (dir) => {
  await runGit(['init', '-b', 'main'], { cwd: dir });
  await runGit(['config', 'user.email', 'test@xdt.local'], { cwd: dir });
  await runGit(['config', 'user.name', 'XDT Test'], { cwd: dir });
  await runGit(['config', 'commit.gpgsign', 'false'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'file.txt'), 'one\n');
  await runGit(['add', 'file.txt'], { cwd: dir });
  await runGit(['commit', '--no-gpg-sign', '-m', 'seed'], { cwd: dir });
});

async function mkTemp(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

async function initBareRemote(): Promise<string> {
  const dir = await mkTemp('xdt-git-review-remote-');
  await runGit(['init', '--bare'], { cwd: dir });
  return dir;
}

async function initRepo(): Promise<string> {
  const dir = await repoTemplate.createCopy();
  roots.push(dir);
  return dir;
}

async function cloneRemote(remotePath: string): Promise<string> {
  const dir = await mkTemp('xdt-git-review-clone-');
  await runGit(['clone', remotePath, dir], { cwd: os.tmpdir() });
  await runGit(['config', 'user.email', 'test@xdt.local'], { cwd: dir });
  await runGit(['config', 'user.name', 'XDT Test'], { cwd: dir });
  await runGit(['config', 'commit.gpgsign', 'false'], { cwd: dir });
  return dir;
}

async function initRepoWithUpstream(): Promise<{ repoPath: string; remotePath: string }> {
  const remotePath = await initBareRemote();
  const repoPath = await initRepo();
  await runGit(['remote', 'add', 'origin', remotePath], { cwd: repoPath });
  await runGit(['push', '--set-upstream', 'origin', 'main'], { cwd: repoPath });
  await runGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: remotePath });
  return { repoPath, remotePath };
}

async function commitFile(repoPath: string, content: string, message: string): Promise<string> {
  await fs.writeFile(path.join(repoPath, 'file.txt'), content);
  await runGit(['add', 'file.txt'], { cwd: repoPath });
  await runGit(['commit', '--no-gpg-sign', '-m', message], { cwd: repoPath });
  return revParse(repoPath, 'HEAD');
}

async function revParse(repoPath: string, ref: string): Promise<string> {
  const { stdout } = await runGit(['rev-parse', ref], { cwd: repoPath });
  return stdout.trim();
}

function scope(repoPath: string): ReviewScope {
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

async function status(repoPath: string): Promise<ReviewStatus> {
  return readStatus(scope(repoPath));
}

async function push(repoPath: string) {
  const current = await status(repoPath);
  return pushBranch(current.scope, current);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
  ));
});

afterAll(async () => {
  await repoTemplate.dispose();
});

describe('git-review pushOps', () => {
  it('sets upstream on first push', async () => {
    const remotePath = await initBareRemote();
    const repoPath = await initRepo();
    await runGit(['remote', 'add', 'origin', remotePath], { cwd: repoPath });

    const result = await push(repoPath);

    expect(result.kind).toBe('pushed');
    expect((await status(repoPath)).scope.aheadBehind.upstream).toBe('origin/main');
    await expect(revParse(remotePath, 'refs/heads/main')).resolves.toBe(await revParse(repoPath, 'HEAD'));
  });

  it('pushes fast-forward updates when a tag shares the current branch name', async () => {
    const { repoPath, remotePath } = await initRepoWithUpstream();
    const localHead = await commitFile(repoPath, 'two\n', 'local change');
    await runGit(['tag', 'main', 'HEAD'], { cwd: repoPath });
    const before = await status(repoPath);
    expect(before.scope.aheadBehind).toMatchObject({ ahead: 1, behind: 0 });

    const result = await pushBranch(before.scope, before);

    expect(result.kind).toBe('pushed');
    await expect(revParse(remotePath, 'refs/heads/main')).resolves.toBe(localHead);
  });

  it('resolves upstream remotes whose names contain slashes', async () => {
    const remotePath = await initBareRemote();
    const repoPath = await initRepo();
    await runGit(['remote', 'add', 'foo/bar', remotePath], { cwd: repoPath });
    await runGit(['push', '--set-upstream', 'foo/bar', 'main'], { cwd: repoPath });
    await runGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: remotePath });
    const localHead = await commitFile(repoPath, 'slash remote\n', 'slash remote update');
    const before = await status(repoPath);

    const result = await pushBranch(before.scope, before);

    expect(before.scope.aheadBehind.upstream).toBe('foo/bar/main');
    expect(result).toMatchObject({
      kind: 'pushed',
      remote: 'foo/bar',
      remoteRef: 'refs/heads/main',
    });
    await expect(revParse(remotePath, 'refs/heads/main')).resolves.toBe(localHead);
  });

  it('uses an explicit refspec so push.default=matching does not push other branches', async () => {
    const { repoPath, remotePath } = await initRepoWithUpstream();
    await runGit(['checkout', '-b', 'side'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'side.txt'), 'side remote\n');
    await runGit(['add', 'side.txt'], { cwd: repoPath });
    await runGit(['commit', '--no-gpg-sign', '-m', 'side remote'], { cwd: repoPath });
    await runGit(['push', '--set-upstream', 'origin', 'side'], { cwd: repoPath });
    const remoteSideBefore = await revParse(remotePath, 'refs/heads/side');
    await fs.writeFile(path.join(repoPath, 'side.txt'), 'side local\n');
    await runGit(['add', 'side.txt'], { cwd: repoPath });
    await runGit(['commit', '--no-gpg-sign', '-m', 'side local'], { cwd: repoPath });
    const localSideHead = await revParse(repoPath, 'HEAD');
    await runGit(['checkout', 'main'], { cwd: repoPath });
    const localMainHead = await commitFile(repoPath, 'main local\n', 'main local');
    await runGit(['config', 'push.default', 'matching'], { cwd: repoPath });
    const before = await status(repoPath);

    const result = await pushBranch(before.scope, before);

    expect(result.kind).toBe('pushed');
    await expect(revParse(remotePath, 'refs/heads/main')).resolves.toBe(localMainHead);
    await expect(revParse(remotePath, 'refs/heads/side')).resolves.toBe(remoteSideBefore);
    await expect(revParse(remotePath, 'refs/heads/side')).resolves.not.toBe(localSideHead);
  });

  it('returns a force confirmation result when the branches diverged', async () => {
    const { repoPath, remotePath } = await initRepoWithUpstream();
    const clonePath = await cloneRemote(remotePath);
    const remoteHead = await commitFile(clonePath, 'remote\n', 'remote change');
    await runGit(['push'], { cwd: clonePath });
    await commitFile(repoPath, 'local\n', 'local diverging change');
    await runGit(['fetch', 'origin'], { cwd: repoPath });
    const before = await status(repoPath);

    const result = await pushBranch(before.scope, before);

    expect(before.scope.aheadBehind.behind).toBe(1);
    expect(result).toMatchObject({
      kind: 'needs-force',
      remote: 'origin',
      remoteRef: 'refs/heads/main',
      remoteOid: remoteHead,
      behind: 1,
    });
    await expect(revParse(remotePath, 'refs/heads/main')).resolves.toBe(remoteHead);
  });

  it('force pushes with a lease after confirmation when a tag shares the current branch name', async () => {
    const { repoPath, remotePath } = await initRepoWithUpstream();
    const clonePath = await cloneRemote(remotePath);
    await commitFile(clonePath, 'remote\n', 'remote change');
    await runGit(['push'], { cwd: clonePath });
    const localHead = await commitFile(repoPath, 'local\n', 'local diverging change');
    await runGit(['tag', 'main', 'HEAD'], { cwd: repoPath });
    await runGit(['fetch', 'origin'], { cwd: repoPath });
    const first = await push(repoPath);
    expect(first.kind).toBe('needs-force');
    if (first.kind !== 'needs-force') return;

    const result = await pushBranch((await status(repoPath)).scope, await status(repoPath), {
      remoteRef: first.remoteRef,
      expectedOid: first.remoteOid,
    });

    expect(result.kind).toBe('pushed');
    await expect(revParse(remotePath, 'refs/heads/main')).resolves.toBe(localHead);
  });

  it('rejects an expired force-with-lease without overwriting the remote', async () => {
    const { repoPath, remotePath } = await initRepoWithUpstream();
    const clonePath = await cloneRemote(remotePath);
    await commitFile(clonePath, 'remote\n', 'remote change');
    await runGit(['push'], { cwd: clonePath });
    await commitFile(repoPath, 'local\n', 'local diverging change');
    await runGit(['fetch', 'origin'], { cwd: repoPath });
    const first = await push(repoPath);
    expect(first.kind).toBe('needs-force');
    if (first.kind !== 'needs-force') return;
    const latestRemoteHead = await commitFile(clonePath, 'remote again\n', 'remote change again');
    await runGit(['push'], { cwd: clonePath });

    await expect(pushBranch((await status(repoPath)).scope, await status(repoPath), {
      remoteRef: first.remoteRef,
      expectedOid: first.remoteOid,
    })).rejects.toMatchObject({ kind: 'lease-expired' });
    await expect(revParse(remotePath, 'refs/heads/main')).resolves.toBe(latestRemoteHead);
  });

  it('refuses to offer force push when local has no new commits', async () => {
    const { repoPath, remotePath } = await initRepoWithUpstream();
    const clonePath = await cloneRemote(remotePath);
    const remoteHead = await commitFile(clonePath, 'remote\n', 'remote change');
    await runGit(['push'], { cwd: clonePath });
    await runGit(['fetch', 'origin'], { cwd: repoPath });

    await expect(push(repoPath)).rejects.toThrow(GitReviewPushError);
    await expect(revParse(remotePath, 'refs/heads/main')).resolves.toBe(remoteHead);
  });

  it('rejects stale force confirmation when the local branch has no commits to push', async () => {
    const { repoPath, remotePath } = await initRepoWithUpstream();
    const clonePath = await cloneRemote(remotePath);
    const remoteHead = await commitFile(clonePath, 'remote\n', 'remote change');
    await runGit(['push'], { cwd: clonePath });
    await runGit(['fetch', 'origin'], { cwd: repoPath });
    const behindOnly = await status(repoPath);
    expect(behindOnly.scope.aheadBehind).toMatchObject({ ahead: 0, behind: 1 });

    await expect(pushBranch(behindOnly.scope, behindOnly, {
      remoteRef: 'refs/heads/main',
      expectedOid: remoteHead,
    })).rejects.toMatchObject({
      message: 'local branch has no new commits to push; pushing would rewind the remote',
    });
    await expect(revParse(remotePath, 'refs/heads/main')).resolves.toBe(remoteHead);
  });

  it('rejects detached and unmerged states', async () => {
    const { repoPath } = await initRepoWithUpstream();
    await runGit(['checkout', '--detach', 'HEAD'], { cwd: repoPath });
    const detached = await status(repoPath);
    await expect(pushBranch(detached.scope, detached)).rejects.toThrow(GitReviewPushError);

    await runGit(['checkout', 'main'], { cwd: repoPath });
    const unmerged = await status(repoPath);
    unmerged.writeDisabledReasons.push('unmerged');
    await expect(pushBranch(unmerged.scope, unmerged)).rejects.toThrow(GitReviewPushError);
  });

  it('reports a readable error when no remote exists', async () => {
    const repoPath = await initRepo();
    await expect(push(repoPath)).rejects.toMatchObject({
      kind: 'no-remote',
      message: 'no git remote is configured',
    });
  });

  it('rejects local upstream branches without updating the local upstream target', async () => {
    const repoPath = await initRepo();
    const mainBefore = await revParse(repoPath, 'refs/heads/main');
    await runGit(['checkout', '-b', 'feature'], { cwd: repoPath });
    const featureHead = await commitFile(repoPath, 'feature\n', 'feature change');
    await runGit(['branch', '--set-upstream-to=main', 'feature'], { cwd: repoPath });
    const before = await status(repoPath);

    await expect(pushBranch(before.scope, before)).rejects.toMatchObject({
      kind: 'no-remote',
      message: 'local upstream branches are not supported for review push; configure a remote upstream',
    });

    await expect(revParse(repoPath, 'refs/heads/main')).resolves.toBe(mainBefore);
    await expect(revParse(repoPath, 'refs/heads/feature')).resolves.toBe(featureHead);
  });

  it('runs pre-push hooks and stops when a hook fails', async () => {
    const { repoPath, remotePath } = await initRepoWithUpstream();
    const hookPath = path.join(repoPath, '.git', 'hooks', 'pre-push');
    await fs.writeFile(hookPath, '#!/bin/sh\nprintf ran > hook-ran\n');
    await fs.chmod(hookPath, 0o755);
    await commitFile(repoPath, 'hook\n', 'hook commit');

    await push(repoPath);

    await expect(fs.readFile(path.join(repoPath, 'hook-ran'), 'utf8')).resolves.toBe('ran');

    await fs.writeFile(hookPath, '#!/bin/sh\nprintf failed > hook-failed\nexit 7\n');
    await fs.chmod(hookPath, 0o755);
    const localHead = await commitFile(repoPath, 'hook fail\n', 'hook failure');
    await expect(push(repoPath)).rejects.toThrow(GitReviewPushError);
    await expect(fs.readFile(path.join(repoPath, 'hook-failed'), 'utf8')).resolves.toBe('failed');
    await expect(revParse(remotePath, 'refs/heads/main')).resolves.not.toBe(localHead);
  });
});
