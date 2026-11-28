import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 });

import { TestDirectoryTemplate } from '../../../test/vitest/testDirectoryTemplate';
import { runGit } from '../gitRunner';
import { pullBranch } from '../pullOps';
import { readStatus } from '../statusReader';
import type { ReviewScope } from '../types';

/**
 * Tier: git-integration.
 * Basis: pull depends on real refs/fetch semantics; mocks cannot prove ff-only safety.
 * Gap: SSH workspaces are rejected by the IPC write gate, so they are not exercised here.
 * Minimal failing input: a diverged local/remote pair must leave local HEAD untouched.
 */
const roots: string[] = [];

const repoTemplate = new TestDirectoryTemplate('xdt-git-review-pull-', async (dir) => {
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

async function initRepo(): Promise<string> {
  const dir = await repoTemplate.createCopy();
  roots.push(dir);
  return dir;
}

async function cloneRemote(remotePath: string): Promise<string> {
  const dir = await mkTemp('xdt-git-review-pull-clone-');
  await runGit(['clone', remotePath, dir], { cwd: os.tmpdir() });
  await runGit(['config', 'user.email', 'test@xdt.local'], { cwd: dir });
  await runGit(['config', 'user.name', 'XDT Test'], { cwd: dir });
  await runGit(['config', 'commit.gpgsign', 'false'], { cwd: dir });
  return dir;
}

async function initRepoWithUpstream(): Promise<{ repoPath: string; remotePath: string }> {
  const remotePath = await mkTemp('xdt-git-review-pull-remote-');
  await runGit(['init', '--bare'], { cwd: remotePath });
  const repoPath = await initRepo();
  await runGit(['remote', 'add', 'origin', remotePath], { cwd: repoPath });
  await runGit(['push', '--set-upstream', 'origin', 'main'], { cwd: repoPath });
  await runGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: remotePath });
  return { repoPath, remotePath };
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

async function headOid(repoPath: string): Promise<string> {
  const { stdout } = await runGit(['rev-parse', 'HEAD'], { cwd: repoPath });
  return stdout.trim();
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((repoPath) =>
      fs.rm(repoPath, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
    ),
  );
});

afterAll(async () => {
  await repoTemplate.dispose();
});

describe('git-review pullOps', () => {
  it('fast-forwards to the remote tip', async () => {
    const { repoPath, remotePath } = await initRepoWithUpstream();
    const updater = await cloneRemote(remotePath);
    await fs.writeFile(path.join(updater, 'remote.txt'), 'remote\n');
    await runGit(['add', 'remote.txt'], { cwd: updater });
    await runGit(['commit', '--no-gpg-sign', '-m', 'remote advance'], { cwd: updater });
    await runGit(['push'], { cwd: updater });
    const remoteHead = await headOid(updater);

    const status = await readStatus(scope(repoPath));
    await pullBranch(status.scope, status);

    expect(await headOid(repoPath)).toBe(remoteHead);
    await expect(fs.readFile(path.join(repoPath, 'remote.txt'), 'utf8')).resolves.toBe('remote\n');
  });

  it('refuses to pull without an upstream', async () => {
    const repoPath = await initRepo();
    const status = await readStatus(scope(repoPath));

    await expect(pullBranch(status.scope, status)).rejects.toMatchObject({
      name: 'GitReviewPullError',
      message: expect.stringContaining('no upstream'),
    });
  });

  it('refuses to merge diverged branches and keeps the local HEAD', async () => {
    const { repoPath, remotePath } = await initRepoWithUpstream();
    const updater = await cloneRemote(remotePath);
    await fs.writeFile(path.join(updater, 'remote.txt'), 'remote\n');
    await runGit(['add', 'remote.txt'], { cwd: updater });
    await runGit(['commit', '--no-gpg-sign', '-m', 'remote advance'], { cwd: updater });
    await runGit(['push'], { cwd: updater });

    await fs.writeFile(path.join(repoPath, 'local.txt'), 'local\n');
    await runGit(['add', 'local.txt'], { cwd: repoPath });
    await runGit(['commit', '--no-gpg-sign', '-m', 'local advance'], { cwd: repoPath });
    const localHead = await headOid(repoPath);

    const status = await readStatus(scope(repoPath));
    await expect(pullBranch(status.scope, status)).rejects.toMatchObject({
      name: 'GitReviewPullError',
    });

    expect(await headOid(repoPath)).toBe(localHead);
    await expect(fs.readFile(path.join(repoPath, 'local.txt'), 'utf8')).resolves.toBe('local\n');
  });
});
