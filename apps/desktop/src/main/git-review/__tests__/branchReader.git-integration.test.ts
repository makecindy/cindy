import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// Windows 上 git 子进程明显更慢(每次 spawn 数百毫秒),多步 git 编排用例会超默认 5s。
vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 });

import { TestDirectoryTemplate } from '../../../test/vitest/testDirectoryTemplate';
import { isSafeBranchBaseRef, listBranchBaseCandidates, readBranchDiff } from '../branchReader';
import { runGit } from '../gitRunner';
import type { ReviewScope } from '../types';

const repos: string[] = [];

const repoTemplate = new TestDirectoryTemplate('xdt-git-review-branch-', async (dir) => {
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

async function revParse(repoPath: string, ref: string): Promise<string> {
  const { stdout } = await runGit(['rev-parse', ref], { cwd: repoPath });
  return stdout.trim();
}

function scope(repoPath: string, branch = 'feature'): ReviewScope {
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

async function initStaleLocalMainFixture(): Promise<string> {
  const repoPath = await initRepo();
  await fs.writeFile(path.join(repoPath, 'base.txt'), 'base\n');
  await commitAll(repoPath, 'root');

  const remotePath = await fs.mkdtemp(path.join(os.tmpdir(), 'xdt-git-review-branch-remote-'));
  repos.push(remotePath);
  await runGit(['init', '--bare'], { cwd: remotePath });
  await runGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: remotePath });
  await runGit(['remote', 'add', 'origin', remotePath], { cwd: repoPath });
  await runGit(['push', 'origin', 'main'], { cwd: repoPath });

  const updaterParent = await fs.mkdtemp(path.join(os.tmpdir(), 'xdt-git-review-branch-updater-'));
  repos.push(updaterParent);
  const updaterPath = path.join(updaterParent, 'updater');
  await runGit(['clone', remotePath, updaterPath], { cwd: updaterParent });
  await runGit(['config', 'user.email', 'test@xdt.local'], { cwd: updaterPath });
  await runGit(['config', 'user.name', 'XDT Test'], { cwd: updaterPath });
  await runGit(['config', 'commit.gpgsign', 'false'], { cwd: updaterPath });
  await fs.writeFile(path.join(updaterPath, 'main-current.txt'), 'remote main\n');
  await commitAll(updaterPath, 'remote main advances');
  await runGit(['push', 'origin', 'main'], { cwd: updaterPath });

  await runGit(['fetch', 'origin'], { cwd: repoPath });
  await runGit(['remote', 'set-head', 'origin', '-a'], { cwd: repoPath });
  await runGit(['checkout', '-b', 'feature', 'origin/main'], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, 'feature.txt'), 'feature\n');
  await commitAll(repoPath, 'feature change');
  await runGit(['push', '-u', 'origin', 'feature'], { cwd: repoPath });

  return repoPath;
}

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repoPath) =>
    fs.rm(repoPath, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
  ));
});

afterAll(async () => {
  await repoTemplate.dispose();
});

describe('git-review branchReader', () => {
  it('uses a three-dot merge-base diff so base branch advances are not reversed into the result', async () => {
    const repoPath = await initRepo();
    await fs.writeFile(path.join(repoPath, 'shared.txt'), 'base\n');
    await commitAll(repoPath, 'root');
    await runGit(['checkout', '-b', 'feature'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'feature.txt'), 'feature\n');
    await commitAll(repoPath, 'feature change');
    await runGit(['checkout', 'main'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'main-only.txt'), 'main\n');
    await commitAll(repoPath, 'main advances');
    await runGit(['checkout', 'feature'], { cwd: repoPath });

    const result = await readBranchDiff(scope(repoPath), 'main');

    expect(result.baseRef).toBe('main');
    expect(result.mergeBaseOid).toEqual(expect.any(String));
    expect(result.diffs.map((diff) => diff.path)).toEqual(['feature.txt']);
    expect(result.diffs[0]).toMatchObject({
      source: 'branch',
      id: 'branch:main:feature.txt',
      status: 'added',
      additions: 1,
      deletions: 0,
    });
  });

  it('defaults to the remote default branch when local main is stale', async () => {
    const repoPath = await initStaleLocalMainFixture();

    const candidates = await listBranchBaseCandidates(scope(repoPath));
    const result = await readBranchDiff(scope(repoPath), null);

    expect(candidates[0]).toMatchObject({ refName: 'origin/main', kind: 'remote-default' });
    expect(candidates.map((candidate) => candidate.refName)).toContain('origin/feature');
    expect(candidates.find((candidate) => candidate.refName === 'main')).toMatchObject({ isStaleRisk: true });
    expect(candidates.find((candidate) => candidate.refName === 'origin/main')?.isStaleRisk).toBeUndefined();
    expect(result.baseRef).toBe('origin/main');
    expect(result.diffs.map((diff) => diff.path)).toEqual(['feature.txt']);
  });

  it('resolves the remote default candidate by full ref when a same-name tag exists', async () => {
    const repoPath = await initStaleLocalMainFixture();
    const tagOid = await revParse(repoPath, 'main');
    const remoteMainOid = await revParse(repoPath, 'refs/remotes/origin/main');
    await runGit(['tag', 'origin/main', tagOid], { cwd: repoPath });

    const candidates = await listBranchBaseCandidates(scope(repoPath));
    const remoteDefault = candidates.find((candidate) => candidate.refName === 'origin/main');

    expect(remoteDefault).toMatchObject({
      refName: 'origin/main',
      kind: 'remote-default',
      oid: remoteMainOid,
    });
    expect(remoteDefault?.oid).not.toBe(tagOid);
  });

  it('uses init.defaultBranch as a remote-first default when main and master are absent', async () => {
    const repoPath = await initRepo();
    await runGit(['config', 'init.defaultBranch', 'trunk'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'base.txt'), 'base\n');
    await commitAll(repoPath, 'root');
    await runGit(['checkout', '-b', 'trunk'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'trunk.txt'), 'trunk\n');
    await commitAll(repoPath, 'trunk base');

    const remotePath = await fs.mkdtemp(path.join(os.tmpdir(), 'xdt-git-review-branch-remote-'));
    repos.push(remotePath);
    await runGit(['init', '--bare'], { cwd: remotePath });
    await runGit(['remote', 'add', 'origin', remotePath], { cwd: repoPath });
    await runGit(['push', 'origin', 'trunk'], { cwd: repoPath });
    await runGit(['fetch', 'origin'], { cwd: repoPath });
    await runGit(['branch', '-D', 'main'], { cwd: repoPath });
    await runGit(['checkout', '-b', 'feature', 'trunk'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'feature.txt'), 'feature\n');
    await commitAll(repoPath, 'feature change');

    const candidates = await listBranchBaseCandidates(scope(repoPath));
    const result = await readBranchDiff(scope(repoPath), null);

    expect(candidates.map((candidate) => candidate.refName).slice(0, 2)).toEqual(['origin/trunk', 'trunk']);
    expect(result.baseRef).toBe('origin/trunk');
    expect(result.diffs.map((diff) => diff.path)).toEqual(['feature.txt']);
  });

  it('falls back to origin/main when origin/HEAD is unavailable', async () => {
    const repoPath = await initStaleLocalMainFixture();
    await runGit(['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD'], { cwd: repoPath });

    const result = await readBranchDiff(scope(repoPath), null);

    expect(result.baseRef).toBe('origin/main');
    expect(result.diffs.map((diff) => diff.path)).toEqual(['feature.txt']);
  });

  it('falls back to local main when no remote base exists', async () => {
    const repoPath = await initRepo();
    await fs.writeFile(path.join(repoPath, 'base.txt'), 'base\n');
    await commitAll(repoPath, 'root');
    await runGit(['checkout', '-b', 'feature'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'feature.txt'), 'feature\n');
    await commitAll(repoPath, 'feature change');

    const candidates = await listBranchBaseCandidates(scope(repoPath));
    const result = await readBranchDiff(scope(repoPath), null);

    expect(candidates.map((candidate) => candidate.refName)).toContain('main');
    expect(result.baseRef).toBe('main');
  });

  it('respects an explicitly requested base even when the remote default branch is available', async () => {
    const repoPath = await initStaleLocalMainFixture();

    const result = await readBranchDiff(scope(repoPath), 'main');

    expect(result.baseRef).toBe('main');
    expect(result.warning).toBeNull();
    expect(result.diffs.map((diff) => diff.path).sort()).toEqual(['feature.txt', 'main-current.txt']);
  });

  it('keeps modified rename metadata when reading bulk branch diffs independent of git config', async () => {
    const repoPath = await initRepo();
    await runGit(['config', 'diff.renames', 'false'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'old.txt'), 'one\ntwo\nthree\n');
    await commitAll(repoPath, 'root');
    await runGit(['checkout', '-b', 'feature'], { cwd: repoPath });
    await runGit(['mv', 'old.txt', 'new.txt'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'new.txt'), 'one\nTWO\nthree\n');
    await commitAll(repoPath, 'rename and modify file');

    const result = await readBranchDiff(scope(repoPath), 'main');

    expect(result.diffs[0]).toMatchObject({
      source: 'branch',
      path: 'new.txt',
      oldPath: 'old.txt',
      status: 'renamed',
      additions: 1,
      deletions: 1,
    });
    expect(result.diffs[0].rawPatch).toContain('rename from old.txt');
    expect(result.diffs[0].rawPatch).toContain('+TWO');
  });

  it('falls back to the default base and reports a warning when a persisted base disappears', async () => {
    const repoPath = await initRepo();
    await fs.writeFile(path.join(repoPath, 'base.txt'), 'base\n');
    await commitAll(repoPath, 'root');
    await runGit(['checkout', '-b', 'feature'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'feature.txt'), 'feature\n');
    await commitAll(repoPath, 'feature change');

    const result = await readBranchDiff(scope(repoPath), 'missing-base');

    expect(result.baseRef).toBe('main');
    expect(result.warning).toMatchObject({
      code: 'base-missing',
      requestedBaseRef: 'missing-base',
    });
  });

  it('returns a structured warning instead of falling back to two-dot when merge-base is missing', async () => {
    const repoPath = await initRepo();
    await fs.writeFile(path.join(repoPath, 'base.txt'), 'base\n');
    await commitAll(repoPath, 'root');
    await runGit(['checkout', '--orphan', 'feature'], { cwd: repoPath });
    await runGit(['rm', '-rf', '.'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'orphan.txt'), 'orphan\n');
    await commitAll(repoPath, 'orphan root');

    const result = await readBranchDiff(scope(repoPath), 'main');

    expect(result.diffs).toEqual([]);
    expect(result.warning).toMatchObject({ code: 'merge-base-missing' });
  });

  it('returns a capped file summary instead of reading full branch patches for large diffs', async () => {
    const repoPath = await initRepo();
    await fs.writeFile(path.join(repoPath, 'base.txt'), 'base\n');
    await commitAll(repoPath, 'root');
    await runGit(['checkout', '-b', 'feature'], { cwd: repoPath });
    const bulkDir = path.join(repoPath, 'bulk');
    await fs.mkdir(bulkDir);
    await Promise.all(Array.from({ length: 129 }, (_, index) =>
      fs.writeFile(path.join(bulkDir, `file-${index}.txt`), `${index}\n`),
    ));
    await commitAll(repoPath, 'many files');

    const result = await readBranchDiff(scope(repoPath), 'main');

    expect(result.diffs).toEqual([]);
    expect(result.warning).toBeNull();
    expect(result.capped).toMatchObject({
      reason: 'file-count',
      stats: {
        fileCount: 129,
        totalChangedLines: 129,
      },
    });
    expect(result.capped?.files[0]).toMatchObject({
      source: 'branch',
      id: 'branch:main:bulk/file-0.txt',
      path: 'bulk/file-0.txt',
      additions: 1,
      changedBytes: 2,
    });
  });

  it('rejects branch base refs that could be parsed as git flags or revisions', () => {
    expect(isSafeBranchBaseRef('main')).toBe(true);
    expect(isSafeBranchBaseRef('origin/main')).toBe(true);
    expect(isSafeBranchBaseRef('-bad')).toBe(false);
    expect(isSafeBranchBaseRef('main..feature')).toBe(false);
    expect(isSafeBranchBaseRef('main~1')).toBe(false);
    expect(isSafeBranchBaseRef('feature@{upstream}')).toBe(false);
  });
});
