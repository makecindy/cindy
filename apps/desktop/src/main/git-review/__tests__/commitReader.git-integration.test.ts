import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
// Windows 上 git 子进程明显更慢(每次 spawn 数百毫秒),多步 git 编排用例会超默认 5s。
vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 });

import { TestDirectoryTemplate } from '../../../test/vitest/testDirectoryTemplate';
import { listBranchCommits, readCommitDiff } from '../commitReader';
import { runGit } from '../gitRunner';
import type { ReviewScope } from '../types';

const repos: string[] = [];

const repoTemplate = new TestDirectoryTemplate('xdt-git-review-commit-', async (dir) => {
  await runGit(['init', '-b', 'main'], { cwd: dir });
  await runGit(['config', 'user.email', 'test@xdt.local'], { cwd: dir });
  await runGit(['config', 'user.name', 'XDT Test'], { cwd: dir });
  await runGit(['config', 'commit.gpgsign', 'false'], { cwd: dir });
});

async function initRepo(): Promise<string> {
  const dir = await repoTemplate.createCopy();
  repos.push(dir);
  return dir;
}

async function commitAll(repoPath: string, message: string): Promise<string> {
  await runGit(['add', '-A'], { cwd: repoPath });
  await runGit(['commit', '--no-gpg-sign', '-m', message], { cwd: repoPath });
  const { stdout } = await runGit(['rev-parse', 'HEAD'], { cwd: repoPath });
  return stdout.trim();
}

function scope(repoPath: string, branch = 'main'): ReviewScope {
  return {
    sessionId: 's1',
    workdir: repoPath,
    worktreePath: repoPath,
    workingDir: repoPath,
    repoRoot: repoPath,
    branch,
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

async function initStaleLocalMainFixture(): Promise<{ repoPath: string; featureOid: string; remoteMainOid: string }> {
  const repoPath = await initRepo();
  await fs.writeFile(path.join(repoPath, 'base.txt'), 'base\n');
  await commitAll(repoPath, 'root');

  const remotePath = await fs.mkdtemp(path.join(os.tmpdir(), 'xdt-git-review-commit-remote-'));
  repos.push(remotePath);
  await runGit(['init', '--bare'], { cwd: remotePath });
  await runGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: remotePath });
  await runGit(['remote', 'add', 'origin', remotePath], { cwd: repoPath });
  await runGit(['push', 'origin', 'main'], { cwd: repoPath });

  const updaterParent = await fs.mkdtemp(path.join(os.tmpdir(), 'xdt-git-review-commit-updater-'));
  repos.push(updaterParent);
  const updaterPath = path.join(updaterParent, 'updater');
  await runGit(['clone', remotePath, updaterPath], { cwd: updaterParent });
  await runGit(['config', 'user.email', 'test@xdt.local'], { cwd: updaterPath });
  await runGit(['config', 'user.name', 'XDT Test'], { cwd: updaterPath });
  await runGit(['config', 'commit.gpgsign', 'false'], { cwd: updaterPath });
  await fs.writeFile(path.join(updaterPath, 'main-current.txt'), 'remote main\n');
  const remoteMainOid = await commitAll(updaterPath, 'remote main advances');
  await runGit(['push', 'origin', 'main'], { cwd: updaterPath });

  await runGit(['fetch', 'origin'], { cwd: repoPath });
  await runGit(['remote', 'set-head', 'origin', '-a'], { cwd: repoPath });
  await runGit(['checkout', '-b', 'feature', 'origin/main'], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, 'feature.txt'), 'feature\n');
  const featureOid = await commitAll(repoPath, 'feature change');

  return { repoPath, featureOid, remoteMainOid };
}

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repoPath) =>
    fs.rm(repoPath, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
  ));
});

afterAll(async () => {
  await repoTemplate.dispose();
});

describe('git-review commitReader', () => {
  it('lists branch commits from base..HEAD and reads a normal commit diff against first parent', async () => {
    const repoPath = await initRepo();
    await fs.writeFile(path.join(repoPath, 'note.txt'), 'one\n');
    await commitAll(repoPath, 'root');
    await runGit(['checkout', '-b', 'feature'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'note.txt'), 'two\n');
    const firstFeatureOid = await commitAll(repoPath, 'modify note');
    await fs.writeFile(path.join(repoPath, 'extra.txt'), 'feature\n');
    const oid = await commitAll(repoPath, 'add extra');
    await runGit(['checkout', 'main'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'main-only.txt'), 'main\n');
    await commitAll(repoPath, 'main advances');
    await runGit(['checkout', 'feature'], { cwd: repoPath });

    const result = await listBranchCommits(scope(repoPath, 'feature'), 'main');
    const diff = await readCommitDiff(scope(repoPath), oid);

    expect(result.baseRef).toBe('main');
    expect(result.warning).toBeNull();
    expect(result.commits.map((commit) => commit.oid)).toEqual([oid, firstFeatureOid]);
    expect(result.commits.map((commit) => commit.title)).toEqual(['add extra', 'modify note']);
    expect(result.commits[0].authorTime).toEqual(expect.any(Number));
    expect(diff.diffs[0]).toMatchObject({
      source: 'commit',
      path: 'extra.txt',
      status: 'added',
      additions: 1,
      deletions: 0,
    });
  });

  it('falls back to the default branch base for branch commit history', async () => {
    const repoPath = await initRepo();
    await fs.writeFile(path.join(repoPath, 'base.txt'), 'base\n');
    await commitAll(repoPath, 'root');
    await runGit(['checkout', '-b', 'feature'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'feature.txt'), 'feature\n');
    const oid = await commitAll(repoPath, 'feature change');

    const result = await listBranchCommits(scope(repoPath, 'feature'), 'missing-base');

    expect(result.baseRef).toBe('main');
    expect(result.commits.map((commit) => commit.oid)).toEqual([oid]);
    expect(result.warning).toMatchObject({
      code: 'base-missing',
      requestedBaseRef: 'missing-base',
    });
  });

  it('uses the remote default branch for branch commit history when local main is stale', async () => {
    const { repoPath, featureOid, remoteMainOid } = await initStaleLocalMainFixture();

    const result = await listBranchCommits(scope(repoPath, 'feature'), null);

    expect(result.baseRef).toBe('origin/main');
    expect(result.commits.map((commit) => commit.oid)).toEqual([featureOid]);
    expect(result.commits.map((commit) => commit.oid)).not.toContain(remoteMainOid);
    expect(result.warning).toBeNull();
  });

  it('reads root commit diff via the empty tree', async () => {
    const repoPath = await initRepo();
    await fs.writeFile(path.join(repoPath, 'root.txt'), 'root\n');
    const oid = await commitAll(repoPath, 'root');

    const diff = await readCommitDiff(scope(repoPath), oid);

    expect(diff.commitOid).toBe(oid);
    expect(diff.diffs[0]).toMatchObject({
      path: 'root.txt',
      status: 'added',
      additions: 1,
      deletions: 0,
    });
  });

  it('keeps rename metadata when reading commit diffs', async () => {
    const repoPath = await initRepo();
    await fs.writeFile(path.join(repoPath, 'old.txt'), 'same\n');
    await commitAll(repoPath, 'root');
    await runGit(['mv', 'old.txt', 'new.txt'], { cwd: repoPath });
    const oid = await commitAll(repoPath, 'rename file');

    const diff = await readCommitDiff(scope(repoPath), oid);

    expect(diff.diffs[0]).toMatchObject({
      path: 'new.txt',
      oldPath: 'old.txt',
      status: 'renamed',
    });
  });

  it('keeps modified rename metadata when reading bulk commit diffs independent of git config', async () => {
    const repoPath = await initRepo();
    await runGit(['config', 'diff.renames', 'false'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'old.txt'), 'one\ntwo\nthree\n');
    await commitAll(repoPath, 'root');
    await runGit(['mv', 'old.txt', 'new.txt'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'new.txt'), 'one\nTWO\nthree\n');
    const oid = await commitAll(repoPath, 'rename and modify file');

    const diff = await readCommitDiff(scope(repoPath), oid);

    expect(diff.diffs[0]).toMatchObject({
      path: 'new.txt',
      oldPath: 'old.txt',
      status: 'renamed',
      additions: 1,
      deletions: 1,
    });
    expect(diff.diffs[0].rawPatch).toContain('rename from old.txt');
    expect(diff.diffs[0].rawPatch).toContain('+TWO');
  });

  it('classifies binary commit diffs without rendering text hunks', async () => {
    const repoPath = await initRepo();
    await fs.writeFile(path.join(repoPath, 'seed.txt'), 'seed\n');
    await commitAll(repoPath, 'root');
    await fs.writeFile(path.join(repoPath, 'asset.bin'), Buffer.from([0, 1, 2, 3, 0]));
    const oid = await commitAll(repoPath, 'add binary');

    const diff = await readCommitDiff(scope(repoPath), oid);

    expect(diff.diffs[0]).toMatchObject({
      path: 'asset.bin',
      kind: 'binary',
      isBinary: true,
      hunks: [],
    });
  });

  it('reads commit diffs with whitespace ignored', async () => {
    const repoPath = await initRepo();
    await fs.writeFile(path.join(repoPath, 'mixed.txt'), 'alpha\nbeta\ngamma\n');
    await commitAll(repoPath, 'root');
    await fs.writeFile(path.join(repoPath, 'mixed.txt'), 'alpha   \nBETA\ngamma\n');
    const oid = await commitAll(repoPath, 'mixed changes');

    const diff = await readCommitDiff(scope(repoPath), oid, { ignoreWhitespace: true });

    expect(diff.diffs[0]).toMatchObject({
      path: 'mixed.txt',
      additions: 1,
      deletions: 1,
      kind: 'text',
    });
    expect(diff.diffs[0].rawPatch).toContain('+BETA');
    expect(diff.diffs[0].rawPatch).not.toContain('+alpha   ');
    expect(diff.diffs[0].rawPatch).not.toContain('-alpha');
  });

  it('returns capped summary data for large commit diffs without full patch data', async () => {
    const repoPath = await initRepo();
    await fs.writeFile(path.join(repoPath, 'seed.txt'), 'seed\n');
    await commitAll(repoPath, 'root');
    const bulkDir = path.join(repoPath, 'bulk');
    await fs.mkdir(bulkDir);
    await Promise.all(Array.from({ length: 129 }, (_, index) =>
      fs.writeFile(path.join(bulkDir, `file-${index}.txt`), `${index}\n`),
    ));
    const oid = await commitAll(repoPath, 'many files');

    const diff = await readCommitDiff(scope(repoPath), oid);

    expect(diff.diffs).toEqual([]);
    expect(diff.capped).toMatchObject({
      reason: 'file-count',
      stats: {
        fileCount: 129,
        totalChangedLines: 129,
      },
    });
    expect(diff.capped?.files[0]).toMatchObject({
      source: 'commit',
      id: 'commit:bulk/file-0.txt',
      path: 'bulk/file-0.txt',
      additions: 1,
    });
  });
});
