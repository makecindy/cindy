/**
 * Shadow file-restore executor tests with real temporary repositories.
 *
 * shadow 链用 createShadowSavepoint 手工构造(turn-start / after-edit),
 * 校验 restore 只改工作区受影响文件,HEAD / 分支 / 用户 index 永不变,
 * dirty 工作区不再被拒绝,失败时自动补偿回执行前状态。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TestDirectoryTemplate } from '../../test/vitest/testDirectoryTemplate';
import {
  executeCodexFileRestorePlan,
  executeCodexFileRestorePlanWithThreadRollback,
} from '../git-snapshot/codexFileRestoreExecutor';
import type { CodexFileRestorePlan } from '../git-snapshot/codexFileRewindPlanner';
import { enqueueGitRepoWrite } from '../git-snapshot/gitRepoWriteQueue';
import { createShadowSavepoint, listShadowSavepoints } from '../git-snapshot/gitSnapshotService';
import { readSavepointTip, savepointRefForSession } from '../git-snapshot/savepointRefs';
import { parseSnapshotCommit } from '../git-snapshot/snapshotTrailers';
import { gitExec } from '../worktree/gitExec';

const REAL_GIT_TEST_TIMEOUT_MS = process.platform === 'win32' ? 60_000 : 20_000;
const SESSION = 'sess-1';

let repoPath: string;

const repoTemplate = new TestDirectoryTemplate('xdt-codex-restore-', async (dir) => {
  await gitExec(['init'], dir);
  await gitExec(['config', 'user.email', 'test@xdt.local'], dir);
  await gitExec(['config', 'user.name', 'XDT Test'], dir);
  await gitExec(['config', 'commit.gpgsign', 'false'], dir);
  await gitExec(['config', 'core.autocrlf', 'false'], dir);
});

async function initRepo(): Promise<string> {
  const dir = await repoTemplate.createCopy();
  // 仓库级覆写 core.excludesFile:宿主机全局 gitignore(常见如 *.tmp)会吞掉
  // 未跟踪文件,让 status 断言在部分开发机上失真。
  const excludesOverride = path.join(dir, '.git', 'xdt-test-empty-excludes');
  await fs.writeFile(excludesOverride, '', 'utf8');
  await gitExec(['config', 'core.excludesFile', excludesOverride], dir);
  return dir;
}

async function writeFile(gitPath: string, content: string): Promise<void> {
  const file = path.join(repoPath, ...gitPath.split('/'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
}

async function readFile(gitPath: string): Promise<string> {
  return fs.readFile(path.join(repoPath, ...gitPath.split('/')), 'utf8');
}

async function gitStdout(args: string[]): Promise<string> {
  return (await gitExec(args, repoPath)).stdout;
}

async function head(): Promise<string> {
  return (await gitStdout(['rev-parse', 'HEAD'])).trim();
}

async function gitInternalPath(gitPath: string): Promise<string> {
  const resolved = (await gitStdout(['rev-parse', '--git-path', gitPath])).trim();
  return path.isAbsolute(resolved) ? resolved : path.resolve(repoPath, resolved);
}

async function commitAll(message: string): Promise<string> {
  await gitExec(['add', '-A'], repoPath);
  await gitExec(['commit', '--no-gpg-sign', '-m', message], repoPath);
  return head();
}

async function shadowSavepoint(
  kind: 'turn-start' | 'after-edit',
  extraMeta: { baselineCommit?: string } = {},
): Promise<string> {
  const result = await createShadowSavepoint(repoPath, {
    sessionId: SESSION,
    label: kind === 'turn-start' ? '本轮开始时的工作区基线' : 'after m1',
    meta: { kind, anchor: 'm1', ...extraMeta },
  });
  if (!result.commit) throw new Error(`expected ${kind} savepoint commit`);
  return result.commit;
}

function buildPlan(
  turns: Array<{ commit: string; baselineCommit: string }>,
  currentHead: string,
): CodexFileRestorePlan {
  return {
    mode: 'file-restore',
    sessionId: SESSION,
    targetMessageClientId: 'm1',
    targetMessageCreatedAt: 100,
    tailTurnsToDrop: turns.length,
    conversationWillRewind: true,
    repoRoot: repoPath,
    currentHead,
    baselineCommit: turns[turns.length - 1].baselineCommit,
    restoreCommitsNewestFirst: turns.map((turn) => ({ ...turn, anchor: 'm1' })),
  };
}

/**
 * 标准转场:seed 三个文件 → 无关 dirty 改动(keep.txt,staged)→ turn-start
 * → 本轮改 app.txt、新建 nested/new.txt、删 gone.txt → after-edit。
 */
async function seedTurnFixture(): Promise<{
  turnStart: string;
  afterEdit: string;
  plan: CodexFileRestorePlan;
}> {
  await writeFile('app.txt', 'base\n');
  await writeFile('keep.txt', 'keep base\n');
  await writeFile('gone.txt', 'gone base\n');
  await commitAll('seed');

  await writeFile('keep.txt', 'keep dirty\n');
  await gitExec(['add', 'keep.txt'], repoPath);

  const turnStart = await shadowSavepoint('turn-start');
  await writeFile('app.txt', 'edited\n');
  await writeFile('nested/new.txt', 'created\n');
  await fs.rm(path.join(repoPath, 'gone.txt'));
  const afterEdit = await shadowSavepoint('after-edit', { baselineCommit: turnStart });

  return {
    turnStart,
    afterEdit,
    plan: buildPlan([{ commit: afterEdit, baselineCommit: turnStart }], await head()),
  };
}

async function chainTip(): Promise<string | null> {
  return readSavepointTip(repoPath, SESSION);
}

async function commitMessageOf(commitish: string): Promise<string> {
  return gitStdout(['log', '-1', '--format=%B', commitish]);
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition was not met');
}

beforeEach(async () => {
  repoPath = await initRepo();
});

afterEach(async () => {
  await fs.rm(repoPath, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

afterAll(async () => {
  await repoTemplate.dispose();
});

describe('executeCodexFileRestorePlan', () => {
  it('restores edits, deletes turn-created files, recreates missing baseline files and keeps unrelated dirty state', async () => {
    const { turnStart, afterEdit, plan } = await seedTurnFixture();
    const headBefore = await head();
    const branchBefore = await gitStdout(['branch', '--show-current']);
    const cachedDiffBefore = await gitStdout(['diff', '--cached']);
    expect(cachedDiffBefore).toContain('keep dirty');

    const result = await executeCodexFileRestorePlan(plan, {
      createRollbackId: () => 'rb-restore',
    });

    // 受影响文件回到 turn-start 基线。
    expect(await readFile('app.txt')).toBe('base\n');
    expect(await readFile('gone.txt')).toBe('gone base\n');
    // 本轮新建的 untracked 文件被删,空目录被清。
    await expect(readFile('nested/new.txt')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(path.join(repoPath, 'nested'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    // dirty worktree 不再被拒绝,非受影响的 dirty 改动原样保留。
    expect(await readFile('keep.txt')).toBe('keep dirty\n');

    // HEAD / 分支 / 用户 index 全程不变。
    expect(await head()).toBe(headBefore);
    expect(await gitStdout(['branch', '--show-current'])).toBe(branchBefore);
    expect(await gitStdout(['diff', '--cached'])).toBe(cachedDiffBefore);

    expect(result).toBeTruthy();
    expect(result?.rollbackId).toBe('rb-restore');
    expect([...(result?.restoredFiles ?? [])].sort()).toEqual(['app.txt', 'gone.txt']);
    expect(result?.deletedFiles).toEqual(['nested/new.txt']);
    expect([...(result?.affectedPaths ?? [])].sort()).toEqual([
      'app.txt',
      'gone.txt',
      'nested/new.txt',
    ]);
    expect(result?.preRollbackCommit).toBeTruthy();
    expect(result?.rollbackCommit).toBeTruthy();
    expect(result?.preRollbackCommit).not.toBe(turnStart);
    expect(result?.preRollbackCommit).not.toBe(afterEdit);
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('puts a pre-rollback savepoint on the chain whose tree equals the pre-restore worktree', async () => {
    const { plan } = await seedTurnFixture();
    // 参照 tree:执行前用另一条 session 链把当前工作区独立快照一次。
    const probe = await createShadowSavepoint(repoPath, {
      sessionId: 'ref-probe',
      label: 'pre-exec reference',
      meta: { kind: 'turn-start' },
    });
    const expectedTree = probe.tree;

    const result = await executeCodexFileRestorePlan(plan, {
      createRollbackId: () => 'rb-pre',
    });

    const preRollbackCommit = result?.preRollbackCommit as string;
    expect((await gitStdout(['rev-parse', `${preRollbackCommit}^{tree}`])).trim()).toBe(
      expectedTree,
    );
    const entries = await listShadowSavepoints(repoPath, SESSION);
    expect(entries.map((entry) => entry.kind)).toContain('pre-rollback');
    expect(entries.find((entry) => entry.kind === 'pre-rollback')?.commit).toBe(
      preRollbackCommit,
    );
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('records a rollback marker with preRollbackCommit and reverts trailers as the chain tip', async () => {
    const { afterEdit, plan } = await seedTurnFixture();

    const result = await executeCodexFileRestorePlan(plan, {
      createRollbackId: () => 'rb-marker',
    });

    expect(result?.rollbackCommit).toBeTruthy();
    expect(await chainTip()).toBe(result?.rollbackCommit);
    const parsed = parseSnapshotCommit(await commitMessageOf(result?.rollbackCommit as string));
    expect(parsed).toMatchObject({
      source: 'cindy',
      sessionId: SESSION,
      kind: 'rollback',
      rollbackId: 'rb-marker',
      preRollbackCommit: result?.preRollbackCommit,
      reverts: [afterEdit],
    });
    // rollback marker 是链上纯记账,不进 listShadowSavepoints 可回退列表。
    const entries = await listShadowSavepoints(repoPath, SESSION);
    expect(entries.map((entry) => entry.commit)).not.toContain(result?.rollbackCommit);
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('compensates files back to the pre-restore state when thread rollback fails', async () => {
    const { plan } = await seedTurnFixture();
    const headBefore = await head();

    await expect(
      executeCodexFileRestorePlanWithThreadRollback(
        plan,
        SESSION,
        {
          commitThreadRollback: async () => {
            // 文件已被恢复到基线后,thread rollback 失败。
            expect(await readFile('app.txt')).toBe('base\n');
            throw new Error('thread rollback failed');
          },
        },
        { createRollbackId: () => 'rb-comp' },
      ),
    ).rejects.toThrow('thread rollback failed');

    // 补偿把受影响文件恢复回执行前状态:编辑内容回来、被删的新文件补回来、
    // 本就删除的基线文件重新删掉。
    expect(await readFile('app.txt')).toBe('edited\n');
    expect(await readFile('nested/new.txt')).toBe('created\n');
    await expect(readFile('gone.txt')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile('keep.txt')).toBe('keep dirty\n');
    expect(await head()).toBe(headBefore);

    // 链 tip 是 rollback-undo marker,记录补偿锚点。
    const tip = await chainTip();
    const parsedTip = parseSnapshotCommit(await commitMessageOf(tip as string));
    expect(parsedTip).toMatchObject({
      source: 'cindy',
      sessionId: SESSION,
      kind: 'rollback-undo',
    });
    expect(parsedTip?.preRollbackCommit).toBeTruthy();
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('rejects while a merge is in progress and leaves the worktree and chain untouched', async () => {
    const { plan } = await seedTurnFixture();
    const tipBefore = await chainTip();
    const mergeHeadPath = await gitInternalPath('MERGE_HEAD');
    await fs.writeFile(mergeHeadPath, `${await head()}\n`, 'utf8');

    await expect(
      executeCodexFileRestorePlan(plan, { createRollbackId: () => 'rb-merge' }),
    ).rejects.toMatchObject({ code: 'REWIND_GIT_FAILED' });

    expect(await readFile('app.txt')).toBe('edited\n');
    expect(await readFile('nested/new.txt')).toBe('created\n');
    await expect(readFile('gone.txt')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await chainTip()).toBe(tipBefore);
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('waits for the shared repo write queue before mutating any state', async () => {
    const { plan } = await seedTurnFixture();
    const tipBefore = await chainTip();
    let release: (() => void) | undefined;
    const blocker = enqueueGitRepoWrite(repoPath, () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await waitFor(() => Boolean(release));

    const resultPromise = executeCodexFileRestorePlan(plan, {
      createRollbackId: () => 'rb-queued',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 队列被占用期间:链不动,文件不动。
    expect(await chainTip()).toBe(tipBefore);
    expect(await readFile('app.txt')).toBe('edited\n');

    release?.();
    await blocker;
    const result = await resultPromise;
    expect(result?.rollbackCommit).toBeTruthy();
    expect(await chainTip()).toBe(result?.rollbackCommit);
    expect(await readFile('app.txt')).toBe('base\n');
    // ref 名健全性:链一直挂在本 session 的隐藏引用上。
    await expect(
      gitExec(['show-ref', '--verify', '--quiet', savepointRefForSession(SESSION)], repoPath),
    ).resolves.toBeTruthy();
  }, REAL_GIT_TEST_TIMEOUT_MS);
});
