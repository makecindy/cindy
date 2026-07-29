import { promises as fs } from 'node:fs';
import path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TestDirectoryTemplate } from '../../test/vitest/testDirectoryTemplate';
import {
  compensateCodexFileRewindExecution,
  executeCodexFileRewindPlan,
  executeCodexFileRewindPlanWithThreadRollback,
} from '../git-snapshot/codexFileRewindExecutor';
import type { CodexFileRewindPlan } from '../git-snapshot/codexFileRewindPlanner';
import { createSnapshot } from '../git-snapshot/gitSnapshotService';
import { enqueueGitRepoWrite } from '../git-snapshot/gitRepoWriteQueue';
import { gitExec, GitExecError } from '../worktree/gitExec';

const REAL_GIT_TEST_TIMEOUT_MS = process.platform === 'win32' ? 60_000 : 20_000;

let repoPath: string;

const repoTemplate = new TestDirectoryTemplate('xdt-codex-rewind-', async (dir) => {
  await gitExec(['init'], dir);
  for (const args of [['config', 'user.email', 'test@xdt.local'], ['config', 'user.name', 'XDT Test'], ['config', 'commit.gpgsign', 'false'], ['config', 'core.autocrlf', 'false']]) await gitExec(args, dir);
});

async function initRepo() {
  const dir = await repoTemplate.createCopy();
  // 仓库级覆写 core.excludesFile:宿主机全局 gitignore(常见如 *.tmp)会吞掉
  // 未跟踪文件,让 status 断言在部分开发机上失真。复制后再写绝对路径，
  // 避免模板仓库路径泄漏进副本配置。
  const excludesOverride = path.join(dir, '.git', 'xdt-test-empty-excludes');
  await fs.writeFile(excludesOverride, '', 'utf8');
  await gitExec(['config', 'core.excludesFile', excludesOverride], dir);
  return dir;
}

async function writeFile(gitPath: string, content: string) {
  const file = path.join(repoPath, ...gitPath.split('/'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
}

async function commitFile(gitPath: string, content: string, message: string) {
  await writeFile(gitPath, content); await gitExec(['add', '-A'], repoPath);
  await gitExec(['commit', '--no-gpg-sign', '-m', message], repoPath);
  return head();
}

async function head() {
  return (await gitExec(['rev-parse', 'HEAD'], repoPath)).stdout.trim();
}

async function gitStdout(args: string[]) {
  return (await gitExec(args, repoPath)).stdout;
}

async function gitInternalPath(gitPath: string) {
  const result = await gitExec(['rev-parse', '--git-path', gitPath], repoPath);
  const resolved = result.stdout.trim();
  return path.isAbsolute(resolved) ? resolved : path.resolve(repoPath, resolved);
}

async function refExists(ref: string) {
  return gitExec(['show-ref', '--verify', '--quiet', ref], repoPath).then(() => true, () => false);
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition was not met');
}

async function snapshot() {
  const commit = await createSnapshot(repoPath, { label: 'after m1', meta: { sessionId: 'sess-1', kind: 'after-edit', anchor: 'm1' } });
  if (!commit) throw new Error('expected snapshot commit');
  return commit;
}

async function plan(commit: string): Promise<CodexFileRewindPlan> {
  return planFor([commit]);
}

async function planFor(commitsNewestFirst: string[]): Promise<CodexFileRewindPlan> {
  const branch = (await gitStdout(['branch', '--show-current'])).trim();
  return {
    mode: 'file-rewind', sessionId: 'sess-1', targetMessageClientId: 'm1', targetMessageCreatedAt: 100,
    tailTurnsToDrop: 1, conversationWillRewind: true, repoRoot: repoPath, currentHead: await head(),
    currentBranch: branch, revertCommitsNewestFirst: commitsNewestFirst,
    commits: commitsNewestFirst.map((commit) => ({ commit, sessionId: 'sess-1', kind: 'after-edit', branch, anchor: 'm1', action: 'revert' })),
  };
}

async function editedSavepoint(content = 'edited\n') { await commitFile('app.txt', 'base\n', 'seed'); await writeFile('app.txt', content); return snapshot(); }

beforeEach(async () => { repoPath = await initRepo(); });
afterEach(async () => { await fs.rm(repoPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
afterAll(async () => { await repoTemplate.dispose(); });

describe('executeCodexFileRewindPlan', () => {
  it('restores files, records rollback, and can compensate it', async () => {
    const savepoint = await editedSavepoint();
    const hookPath = await gitInternalPath('hooks/prepare-commit-msg');
    await fs.mkdir(path.dirname(hookPath), { recursive: true });
    await fs.writeFile(hookPath, '#!/bin/sh\necho prepare-commit-msg should not run >&2\nexit 1\n', 'utf8');
    await fs.chmod(hookPath, 0o755);
    await writeFile('scratch.tmp', 'untracked\n');
    const result = await executeCodexFileRewindPlan(await plan(savepoint), { createRollbackId: () => 'rb-success' });
    expect(result?.revertedCommits).toEqual([savepoint]);
    expect(await gitStdout(['show', 'HEAD:app.txt'])).toBe('base\n');
    expect((await gitStdout(['status', '--porcelain=v1'])).trim()).toBe('?? scratch.tmp');
    await compensateCodexFileRewindExecution(result, 'sess-1', { createRollbackId: () => 'rb-comp' });
    expect(await gitStdout(['show', 'HEAD:app.txt'])).toBe('edited\n');
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('reverts a root savepoint by deleting files introduced by the root commit', async () => {
    await writeFile('app.txt', 'created by first turn\n');
    const savepoint = await snapshot();

    const result = await executeCodexFileRewindPlan(await plan(savepoint), { createRollbackId: () => 'rb-root' });

    expect(result?.revertedCommits).toEqual([savepoint]);
    expect(result?.rollbackCommit).toBeTruthy();
    expect((await gitStdout(['ls-tree', '-r', '--name-only', 'HEAD'])).trim()).toBe('');
    await expect(fs.readFile(path.join(repoPath, 'app.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await gitStdout(['status', '--porcelain=v1'])).trim()).toBe('');
    expect(await refExists('refs/xdt/pre-rollback/rb-root')).toBe(true);
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('rejects a dirty worktree before creating a rollback commit', async () => {
    const savepoint = await editedSavepoint();
    await writeFile('other.txt', 'staged\n');
    await gitExec(['add', 'other.txt'], repoPath);
    await expect(executeCodexFileRewindPlan(await plan(savepoint), { createRollbackId: () => 'rb-dirty' }))
      .rejects.toMatchObject({ code: 'REWIND_GIT_FAILED' });
    expect((await gitStdout(['status', '--porcelain=v1'])).trim()).toBe('A  other.txt');
    expect(await refExists('refs/xdt/pre-rollback/rb-dirty')).toBe(false);
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('rejects an active Git operation before touching rewind refs', async () => {
    const savepoint = await editedSavepoint();
    const rewindPlan = await plan(savepoint);
    const revertHeadPath = await gitInternalPath('REVERT_HEAD');
    await fs.writeFile(revertHeadPath, `${await head()}\n`, 'utf8');

    await expect(executeCodexFileRewindPlan(rewindPlan, { createRollbackId: () => 'rb-active-op' }))
      .rejects.toMatchObject({ code: 'REWIND_GIT_FAILED' });
    await expect(fs.lstat(revertHeadPath)).resolves.toBeTruthy();
    expect((await gitStdout(['status', '--porcelain=v1', '--untracked-files=no'])).trim()).toBe('');
    expect(await refExists('refs/xdt/pre-rollback/rb-active-op')).toBe(false);
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('waits for the shared repo write queue before mutating Git state', async () => {
    const savepoint = await editedSavepoint();
    const rewindPlan = await plan(savepoint);
    let release: (() => void) | undefined;
    const blocker = enqueueGitRepoWrite(repoPath, () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await waitFor(() => Boolean(release));

    const resultPromise = executeCodexFileRewindPlan(rewindPlan, { createRollbackId: () => 'rb-queued' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await refExists('refs/xdt/pre-rollback/rb-queued')).toBe(false);

    release?.();
    await blocker;
    const result = await resultPromise;
    expect(result?.rollbackCommit).toBeTruthy();
    expect(await refExists('refs/xdt/pre-rollback/rb-queued')).toBe(true);
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('keeps the repo write queue locked until thread rollback succeeds', async () => {
    const savepoint = await editedSavepoint();
    const rewindPlan = await plan(savepoint);
    let queuedRan = false;
    let queuedTask: Promise<void> | undefined;

    const result = await executeCodexFileRewindPlanWithThreadRollback(
      rewindPlan,
      'sess-1',
      {
        commitThreadRollback: async () => {
          queuedTask = enqueueGitRepoWrite(repoPath, async () => {
            queuedRan = true;
          });
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(queuedRan).toBe(false);
          return { sdkSessionId: 'thread-ok' };
        },
      },
      { createRollbackId: () => 'rb-thread-ok' },
    );

    expect(result.threadRollback).toEqual({ sdkSessionId: 'thread-ok' });
    expect(queuedRan).toBe(false);
    await queuedTask;
    expect(queuedRan).toBe(true);
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('keeps the repo write queue locked until thread rollback compensation settles', async () => {
    const savepoint = await editedSavepoint();
    const rewindPlan = await plan(savepoint);
    const ids = ['rb-thread-fail', 'rb-thread-comp'];
    let queuedHeadFile = '';
    let queuedTask: Promise<void> | undefined;

    await expect(
      executeCodexFileRewindPlanWithThreadRollback(
        rewindPlan,
        'sess-1',
        {
          commitThreadRollback: async () => {
            queuedTask = enqueueGitRepoWrite(repoPath, async () => {
              queuedHeadFile = await gitStdout(['show', 'HEAD:app.txt']);
            });
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(queuedHeadFile).toBe('');
            throw new Error('thread rollback failed');
          },
        },
        { createRollbackId: () => ids.shift() ?? 'unexpected-id' },
      ),
    ).rejects.toThrow('thread rollback failed');

    await queuedTask;
    expect(queuedHeadFile).toBe('edited\n');
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('aborts and leaves the repo unchanged on conflict', async () => {
    const savepoint = await editedSavepoint('snapshot\n');
    const userHead = await commitFile('app.txt', 'user change\n', 'user change');
    await expect(executeCodexFileRewindPlan(await plan(savepoint), { createRollbackId: () => 'rb-conflict' }))
      .rejects.toMatchObject({ code: 'REWIND_GIT_CONFLICT' });
    expect(await head()).toBe(userHead);
    expect(await fs.readFile(path.join(repoPath, 'app.txt'), 'utf8')).toBe('user change\n');
    expect((await gitStdout(['status', '--porcelain=v1'])).trim()).toBe('');
    expect(await refExists('refs/xdt/pre-rollback/rb-conflict')).toBe(false);
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('restores prior no-commit reverts when a later savepoint conflicts', async () => {
    await commitFile('app.txt', 'base\n', 'seed app');
    await commitFile('other.txt', 'other base\n', 'seed other');
    await writeFile('app.txt', 'snapshot\n');
    const olderSavepoint = await snapshot();
    await writeFile('other.txt', 'other snapshot\n');
    const newerSavepoint = await snapshot();
    const userHead = await commitFile('app.txt', 'user change\n', 'user change');

    await expect(executeCodexFileRewindPlan(await planFor([newerSavepoint, olderSavepoint]), { createRollbackId: () => 'rb-multi-conflict' }))
      .rejects.toMatchObject({ code: 'REWIND_GIT_CONFLICT' });
    expect(await head()).toBe(userHead);
    expect(await gitStdout(['show', 'HEAD:app.txt'])).toBe('user change\n');
    expect(await gitStdout(['show', 'HEAD:other.txt'])).toBe('other snapshot\n');
    expect((await gitStdout(['status', '--porcelain=v1'])).trim()).toBe('');
    expect(await refExists('refs/xdt/pre-rollback/rb-multi-conflict')).toBe(false);
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('skips empty reverts without creating a rollback commit', async () => {
    const savepoint = await editedSavepoint('snapshot\n');
    const userHead = await commitFile('app.txt', 'base\n', 'manual undo');
    const result = await executeCodexFileRewindPlan(await plan(savepoint), { createRollbackId: () => 'rb-empty' });
    expect(result).toMatchObject({ rollbackCommit: null, revertedCommits: [], skippedCommits: [savepoint] });
    expect(await head()).toBe(userHead);
    expect(await refExists('refs/xdt/pre-rollback/rb-empty')).toBe(false);
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('preserves prior no-commit reverts when a later savepoint is empty', async () => {
    let staged = false;
    const calls: string[][] = [];
    const fakeGitExec = vi.fn(async (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === 'rev-parse' && args[1] === '--git-path') return { stdout: `.git/${args[2]}\n`, stderr: '' };
      if (args[0] === 'status') return { stdout: '', stderr: '' };
      if (args[0] === 'update-ref') return { stdout: '', stderr: '' };
      if (args[0] === 'revert' && args[1] === '--no-commit' && args[2] === 'newer') {
        staged = true; return { stdout: '', stderr: '' };
      }
      if (args[0] === 'revert' && args[1] === '--no-commit' && args[2] === 'older') {
        throw new GitExecError({ args, exitCode: 1, stdout: '', stderr: 'nothing to commit, working tree clean' });
      }
      if (args[0] === 'revert' && args[1] === '--quit') return { stdout: '', stderr: '' };
      if (args[0] === 'diff' && args[1] === '--cached' && args[2] === '--quiet') {
        if (staged) throw new GitExecError({ args, exitCode: 1, stdout: '', stderr: '' });
        return { stdout: '', stderr: '' };
      }
      if (args.includes('commit')) {
        staged = false; return { stdout: '', stderr: '' };
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`);
    });
    let getHeadCalls = 0;
    const result = await executeCodexFileRewindPlan({
      mode: 'file-rewind', sessionId: 'sess-1', targetMessageClientId: 'm1', targetMessageCreatedAt: 100,
      tailTurnsToDrop: 1, conversationWillRewind: true, repoRoot: repoPath, currentHead: 'head',
      currentBranch: 'main', revertCommitsNewestFirst: ['newer', 'older'],
      commits: [],
    }, { createRollbackId: () => 'rb-empty-after-applied', getHead: async () => (++getHeadCalls === 1 ? 'head' : 'rollback-head'), gitExec: fakeGitExec });

    expect(result).toMatchObject({ rollbackCommit: 'rollback-head', revertedCommits: ['newer'], skippedCommits: ['older'] });
    expect(calls).toContainEqual(['revert', '--quit']);
    expect(calls).not.toContainEqual(['revert', '--skip']);
  });

  it('aborts compensation and cleans its protect ref when the commit fails', async () => {
    const savepoint = await editedSavepoint();
    const result = await executeCodexFileRewindPlan(await plan(savepoint));
    const failingGitExec = (args: readonly string[], cwd?: string) =>
      args.includes('commit')
        ? Promise.reject(new GitExecError({ args, exitCode: 1, stderr: 'commit failed', stdout: '' }))
        : gitExec(args, cwd);

    await expect(compensateCodexFileRewindExecution(result, 'sess-1', { createRollbackId: () => 'rb-comp-fail', gitExec: failingGitExec })).rejects.toMatchObject({ code: 'REWIND_GIT_FAILED' });

    expect((await gitStdout(['status', '--porcelain=v1'])).trim()).toBe('');
    expect(await gitStdout(['show', 'HEAD:app.txt'])).toBe('base\n');
    expect(await refExists('refs/xdt/pre-undo-rollback/rb-comp-fail')).toBe(false);
  }, REAL_GIT_TEST_TIMEOUT_MS);
});
