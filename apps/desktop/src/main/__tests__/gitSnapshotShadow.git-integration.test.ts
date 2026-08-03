/**
 * Shadow savepoint kernel tests with real temporary repositories.
 *
 * 核心不变量:createShadowSavepoint / createShadowMarker 只写
 * refs/cindy/savepoints/<sessionId> 隐藏链,HEAD、当前分支、用户 index、
 * 工作区在保存点前后必须逐字节不变。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TestDirectoryTemplate } from '../../test/vitest/testDirectoryTemplate';
import {
  createShadowMarker,
  createShadowSavepoint,
  createSnapshotMarker,
  listShadowSavepoints,
  writeWorktreeTreeForPaths,
} from '../git-snapshot/gitSnapshotService';
import {
  deleteSavepointRef,
  InvalidSavepointSessionIdError,
  listSavepointRefs,
  readSavepointTip,
  savepointRefForSession,
  SAVEPOINT_REF_NAMESPACE,
} from '../git-snapshot/savepointRefs';
import { parseSnapshotCommit } from '../git-snapshot/snapshotTrailers';
import { gitExec } from '../worktree/gitExec';

const REAL_GIT_TEST_TIMEOUT_MS = process.platform === 'win32' ? 60_000 : 20_000;
const SESSION = 'shadow-sess-1';

let repoPath: string;
const originalGitLocaleEnv = {
  LC_ALL: process.env.LC_ALL,
  LANG: process.env.LANG,
  LANGUAGE: process.env.LANGUAGE,
};

const repoTemplate = new TestDirectoryTemplate('xdt-shadow-savepoint-', async (dir) => {
  await gitExec(['init'], dir);
  await gitExec(['config', 'user.email', 'test@xdt.local'], dir);
  await gitExec(['config', 'user.name', 'XDT Test'], dir);
  await gitExec(['config', 'commit.gpgsign', 'false'], dir);
  await gitExec(['config', 'core.autocrlf', 'false'], dir);
});

async function initRepo(): Promise<string> {
  const dir = await repoTemplate.createCopy();
  // 仓库级覆写 core.excludesFile:宿主机全局 gitignore 会吞掉未跟踪文件,
  // 让 status 逐字节断言在部分开发机上失真。复制后再写绝对路径。
  const excludesOverride = path.join(dir, '.git', 'xdt-test-empty-excludes');
  await fs.writeFile(excludesOverride, '', 'utf8');
  await gitExec(['config', 'core.excludesFile', excludesOverride], dir);
  return dir;
}

async function writeRepoFile(gitPath: string, content: string | Buffer): Promise<void> {
  const filePath = path.join(repoPath, ...gitPath.split('/'));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

async function gitStdout(args: string[]): Promise<string> {
  return (await gitExec(args, repoPath)).stdout;
}

async function head(): Promise<string> {
  return (await gitStdout(['rev-parse', 'HEAD'])).trim();
}

async function commitSeed(): Promise<string> {
  await writeRepoFile('seed.txt', 'seed\n');
  await gitExec(['add', '-A'], repoPath);
  await gitExec(['commit', '--no-gpg-sign', '-m', 'seed'], repoPath);
  return head();
}

async function treeOf(commitish: string): Promise<string> {
  return (await gitStdout(['rev-parse', `${commitish}^{tree}`])).trim();
}

async function commitMessage(commitish: string): Promise<string> {
  return (await gitStdout(['log', '-1', '--format=%B', commitish])).replace(/\n+$/, '\n');
}

/** Raw byte-level view of everything a shadow savepoint must never change. */
async function captureUserVisibleState(): Promise<{
  head: string;
  branch: string;
  status: string;
  cachedDiff: string;
}> {
  const [headOut, branchOut, statusOut, cachedOut] = [
    await gitStdout(['rev-parse', 'HEAD']),
    await gitStdout(['branch', '--show-current']),
    await gitStdout(['status', '--porcelain=v1']),
    await gitStdout(['diff', '--cached']),
  ];
  return { head: headOut, branch: branchOut, status: statusOut, cachedDiff: cachedOut };
}

beforeEach(async () => {
  process.env.LC_ALL = 'C';
  process.env.LANG = 'C';
  delete process.env.LANGUAGE;
  repoPath = await initRepo();
});

afterEach(async () => {
  await fs.rm(repoPath, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  if (originalGitLocaleEnv.LC_ALL === undefined) delete process.env.LC_ALL;
  else process.env.LC_ALL = originalGitLocaleEnv.LC_ALL;
  if (originalGitLocaleEnv.LANG === undefined) delete process.env.LANG;
  else process.env.LANG = originalGitLocaleEnv.LANG;
  if (originalGitLocaleEnv.LANGUAGE === undefined) delete process.env.LANGUAGE;
  else process.env.LANGUAGE = originalGitLocaleEnv.LANGUAGE;
});

afterAll(async () => {
  await repoTemplate.dispose();
});

describe('createShadowSavepoint', () => {
  it('never changes HEAD, branch, status or the cached diff', async () => {
    await commitSeed();
    await writeRepoFile('staged.txt', 'staged change\n');
    await gitExec(['add', 'staged.txt'], repoPath);
    await writeRepoFile('seed.txt', 'unstaged change\n');
    await writeRepoFile('untracked.txt', 'untracked\n');
    const before = await captureUserVisibleState();
    expect(before.status).not.toBe('');
    expect(before.cachedDiff).not.toBe('');

    const result = await createShadowSavepoint(repoPath, {
      sessionId: SESSION,
      label: '本轮开始时的工作区基线',
      meta: { kind: 'turn-start', anchor: 'm1' },
    });

    expect(result.commit).toBeTruthy();
    expect(await captureUserVisibleState()).toEqual(before);

    // 工作区内容全部进了 tree,且 trailer 是 X-Cindy 代际。
    const commit = result.commit as string;
    expect(await gitStdout(['show', `${commit}:staged.txt`])).toBe('staged change\n');
    expect(await gitStdout(['show', `${commit}:seed.txt`])).toBe('unstaged change\n');
    expect(await gitStdout(['show', `${commit}:untracked.txt`])).toBe('untracked\n');
    const parsed = parseSnapshotCommit(await commitMessage(commit));
    expect(parsed).toMatchObject({
      source: 'cindy',
      sessionId: SESSION,
      kind: 'turn-start',
      anchor: 'm1',
      label: '本轮开始时的工作区基线',
      baseHead: before.head.trim(),
      branch: before.branch.trim(),
    });
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('chains savepoints: the second commit parents the first, ref tracks the tip', async () => {
    await commitSeed();
    await writeRepoFile('a.txt', 'v1\n');
    const first = await createShadowSavepoint(repoPath, {
      sessionId: SESSION,
      label: 'first',
      meta: { kind: 'turn-start' },
    });
    await writeRepoFile('a.txt', 'v2\n');
    const second = await createShadowSavepoint(repoPath, {
      sessionId: SESSION,
      label: 'second',
      meta: { kind: 'after-edit', baselineCommit: first.commit as string },
    });

    expect(first.commit).toBeTruthy();
    expect(second.commit).toBeTruthy();
    expect((await gitStdout(['rev-parse', `${second.commit}^`])).trim()).toBe(first.commit);
    expect(await readSavepointTip(repoPath, SESSION)).toBe(second.commit);
    expect(
      (await gitStdout(['rev-parse', savepointRefForSession(SESSION)])).trim(),
    ).toBe(second.commit);
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('skipIfTreeEquals returns null and keeps the ref untouched', async () => {
    await commitSeed();
    await writeRepoFile('a.txt', 'v1\n');
    const baseline = await createShadowSavepoint(repoPath, {
      sessionId: SESSION,
      label: 'baseline',
      meta: { kind: 'turn-start' },
    });

    const result = await createShadowSavepoint(repoPath, {
      sessionId: SESSION,
      label: 'unchanged turn',
      meta: { kind: 'after-edit', baselineCommit: baseline.commit as string },
      skipIfTreeEquals: baseline.commit as string,
    });

    expect(result.commit).toBeNull();
    expect(result.tree).toBe(await treeOf(baseline.commit as string));
    expect(await readSavepointTip(repoPath, SESSION)).toBe(baseline.commit);
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('creates a parentless savepoint with no baseHead in an unborn repository', async () => {
    await writeRepoFile('first.txt', 'first\n');

    const result = await createShadowSavepoint(repoPath, {
      sessionId: SESSION,
      label: 'unborn baseline',
      meta: { kind: 'turn-start' },
    });

    expect(result.commit).toBeTruthy();
    // HEAD 仍然 unborn:保存点没有替用户创建首个分支提交。
    await expect(gitExec(['rev-parse', '--verify', 'HEAD'], repoPath)).rejects.toThrow();
    expect((await gitStdout(['rev-list', '--count', result.commit as string])).trim()).toBe('1');

    const { entries } = await listShadowSavepoints(repoPath, SESSION);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ commit: result.commit, parentCount: 0 });
    expect(entries[0]?.baseHead).toBeUndefined();
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('treats tracked files behind an out-of-repo symlinked parent as deleted', async () => {
    if (process.platform === 'win32') return; // 符号链接在 Windows CI 上需要特权
    await commitSeed();
    await writeRepoFile('evil/target.txt', 'tracked base\n');
    await gitExec(['add', '-A'], repoPath);
    await gitExec(['commit', '--no-gpg-sign', '-m', 'seed evil dir'], repoPath);
    // 用户把 evil 换成指向仓库外的符号链接,外部目录里有同名文件:
    // status 会报 `D evil/target.txt` + 未跟踪的 evil(符号链接)。
    const outside = await fs.mkdtemp(path.join(path.dirname(repoPath), 'outside-'));
    try {
      await fs.writeFile(path.join(outside, 'target.txt'), 'external secret\n', 'utf8');
      await fs.rm(path.join(repoPath, 'evil'), { recursive: true });
      await fs.symlink(outside, path.join(repoPath, 'evil'));

      const result = await createShadowSavepoint(repoPath, {
        sessionId: SESSION,
        label: 'symlinked parent',
        meta: { kind: 'turn-start' },
      });

      expect(result.commit).toBeTruthy();
      const commit = result.commit as string;
      // 真实父目录在仓库外 → 按删除记录,绝不把外部内容写进保存点树;
      // 符号链接本身以 link 对象入树。
      await expect(gitExec(['show', `${commit}:evil/target.txt`], repoPath)).rejects.toThrow();
      const evilEntry = await gitStdout(['ls-tree', commit, 'evil']);
      expect(evilEntry).toContain('120000');
      expect(await gitStdout(['show', `${commit}:seed.txt`])).toBe('seed\n');
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('tolerates a path staged in the user index but deleted from the worktree (status AD)', async () => {
    await commitSeed();
    // 用户自己 git add 了新文件,然后又从工作区删掉:status 为 `AD`,
    // 该路径既不在 HEAD 也不在工作区,git add 会 fatal,必须走 force-remove。
    await writeRepoFile('staged-then-deleted.txt', 'gone\n');
    await gitExec(['add', 'staged-then-deleted.txt'], repoPath);
    await fs.rm(path.join(repoPath, 'staged-then-deleted.txt'));
    await writeRepoFile('normal.txt', 'normal\n');
    const before = await captureUserVisibleState();
    expect(before.status).toContain('AD staged-then-deleted.txt');

    const result = await createShadowSavepoint(repoPath, {
      sessionId: SESSION,
      label: 'AD baseline',
      meta: { kind: 'turn-start' },
    });

    expect(result.commit).toBeTruthy();
    expect(await captureUserVisibleState()).toEqual(before);
    const listed = (await gitStdout(['ls-tree', '-r', '--name-only', result.tree]))
      .split('\n')
      .filter(Boolean);
    expect(listed).not.toContain('staged-then-deleted.txt');
    expect(listed).toContain('normal.txt');
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('keeps sensitive and oversized file contents out of the savepoint tree', async () => {
    await writeRepoFile('big.txt', 'small\n');
    await gitExec(['add', '-A'], repoPath);
    await gitExec(['commit', '--no-gpg-sign', '-m', 'seed big'], repoPath);
    await writeRepoFile('big.txt', Buffer.alloc(64, 'x'));
    await writeRepoFile('.env', 'SECRET=abc123\n');
    await writeRepoFile('safe.txt', 'safe\n');

    const result = await createShadowSavepoint(repoPath, {
      sessionId: SESSION,
      label: 'filtered',
      meta: { kind: 'turn-start' },
      fileFilter: { maxFileBytes: 32 },
    });

    expect(result.commit).toBeTruthy();
    expect(result.includedFiles).toEqual(['safe.txt']);
    expect(result.skippedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '.env', reason: 'sensitive-path' }),
        expect.objectContaining({ path: 'big.txt', reason: 'large-file' }),
      ]),
    );
    const commit = result.commit as string;
    // 被 skip 的 tracked 文件保留 HEAD 版本,未跟踪的敏感文件完全缺失。
    expect(await gitStdout(['show', `${commit}:big.txt`])).toBe('small\n');
    await expect(gitExec(['show', `${commit}:.env`], repoPath)).rejects.toThrow();
    expect(await gitStdout(['show', `${commit}:safe.txt`])).toBe('safe\n');
  }, REAL_GIT_TEST_TIMEOUT_MS);
});

describe('createShadowMarker', () => {
  it('creates a root marker with the empty tree on an empty chain', async () => {
    // 首轮 turn-start 失败时链还是空的:缺口必须作为根提交持久化,否则
    // 后续轮次正常建链后 planner 永远看不到首轮缺口。
    await commitSeed();

    const marker = await createShadowMarker(repoPath, {
      sessionId: SESSION,
      label: 'gap marker',
      meta: { kind: 'rewind-blocked', anchor: 'm1' },
    });

    expect(marker).toBeTruthy();
    expect(await readSavepointTip(repoPath, SESSION)).toBe(marker);
    // 空树根提交:无父、树为 canonical empty tree。
    expect((await gitStdout(['rev-list', '--count', marker as string])).trim()).toBe('1');
    expect(await treeOf(marker as string)).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
    const { entries } = await listShadowSavepoints(repoPath, SESSION);
    expect(entries.map((entry) => entry.kind)).toContain('rewind-blocked');
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('reuses the chain tip tree and parents the tip on a non-empty chain', async () => {
    await commitSeed();
    await writeRepoFile('a.txt', 'v1\n');
    const savepoint = await createShadowSavepoint(repoPath, {
      sessionId: SESSION,
      label: 'baseline',
      meta: { kind: 'turn-start' },
    });

    const marker = await createShadowMarker(repoPath, {
      sessionId: SESSION,
      label: 'rollback marker',
      meta: { kind: 'rollback', rollbackId: 'rb-1' },
    });

    expect(marker).toBeTruthy();
    expect(await treeOf(marker as string)).toBe(await treeOf(savepoint.commit as string));
    expect((await gitStdout(['rev-parse', `${marker}^`])).trim()).toBe(savepoint.commit);
    expect(await readSavepointTip(repoPath, SESSION)).toBe(marker);
  }, REAL_GIT_TEST_TIMEOUT_MS);
});

describe('listShadowSavepoints', () => {
  it('returns [] when the session ref does not exist or the session id is invalid', async () => {
    await commitSeed();
    expect(await listShadowSavepoints(repoPath, 'no-such-session')).toEqual({
      entries: [],
      truncated: false,
    });
    expect(await listShadowSavepoints(repoPath, 'bad session id!')).toEqual({
      entries: [],
      truncated: false,
    });
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('reports truncation when the chain exceeds the traversal window', async () => {
    await commitSeed();
    const commits: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      await writeRepoFile('a.txt', `v${i}\n`);
      const result = await createShadowSavepoint(repoPath, {
        sessionId: SESSION,
        label: `turn ${i}`,
        meta: { kind: 'turn-start' },
      });
      commits.push(result.commit as string);
    }

    const truncatedView = await listShadowSavepoints(repoPath, SESSION, { maxCount: 2 });
    expect(truncatedView.truncated).toBe(true);
    expect(truncatedView.entries.map((entry) => entry.commit)).toEqual([
      commits[2],
      commits[1],
    ]);

    const fullView = await listShadowSavepoints(repoPath, SESSION, { maxCount: 10 });
    expect(fullView.truncated).toBe(false);
    expect(fullView.entries).toHaveLength(3);
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('lists chain savepoints newest-first without X-XDT commits from the HEAD branch', async () => {
    await commitSeed();
    // HEAD 分支上的 legacy X-XDT commit(同 session)绝不能混进 shadow 链。
    const legacyMarker = await createSnapshotMarker(repoPath, {
      label: 'legacy on branch',
      meta: { sessionId: SESSION, kind: 'after-edit', anchor: 'm0' },
    });

    await writeRepoFile('a.txt', 'v1\n');
    const first = await createShadowSavepoint(repoPath, {
      sessionId: SESSION,
      label: 'turn start',
      meta: { kind: 'turn-start', anchor: 'm1' },
    });
    await writeRepoFile('a.txt', 'v2\n');
    const second = await createShadowSavepoint(repoPath, {
      sessionId: SESSION,
      label: 'after edit',
      meta: { kind: 'after-edit', anchor: 'm1', baselineCommit: first.commit as string },
    });

    const { entries } = await listShadowSavepoints(repoPath, SESSION);

    expect(entries.map((entry) => entry.commit)).toEqual([second.commit, first.commit]);
    expect(entries.map((entry) => entry.commit)).not.toContain(legacyMarker);
    expect(entries[0]).toMatchObject({
      kind: 'after-edit',
      source: 'cindy',
      sessionId: SESSION,
      anchor: 'm1',
      baselineCommit: first.commit,
      parentCount: 1,
    });
    expect(entries[0]?.baseHead).toBeTruthy();
    expect(entries[1]).toMatchObject({ kind: 'turn-start', source: 'cindy', parentCount: 0 });
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('filters non-listable kinds such as rollback markers', async () => {
    await commitSeed();
    await writeRepoFile('a.txt', 'v1\n');
    const savepoint = await createShadowSavepoint(repoPath, {
      sessionId: SESSION,
      label: 'baseline',
      meta: { kind: 'turn-start' },
    });
    const rollbackMarker = await createShadowMarker(repoPath, {
      sessionId: SESSION,
      label: 'rollback',
      meta: { kind: 'rollback', rollbackId: 'rb-1' },
    });
    expect(rollbackMarker).toBeTruthy();

    const { entries } = await listShadowSavepoints(repoPath, SESSION);

    expect(entries.map((entry) => entry.commit)).toEqual([savepoint.commit]);
    expect(entries[0]?.kind).toBe('turn-start');
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('does not leak savepoints across sessions', async () => {
    await commitSeed();
    await writeRepoFile('a.txt', 'v1\n');
    const mine = await createShadowSavepoint(repoPath, {
      sessionId: SESSION,
      label: 'mine',
      meta: { kind: 'turn-start' },
    });
    await writeRepoFile('a.txt', 'v2\n');
    await createShadowSavepoint(repoPath, {
      sessionId: 'other-session',
      label: 'theirs',
      meta: { kind: 'turn-start' },
    });

    const { entries } = await listShadowSavepoints(repoPath, SESSION);
    expect(entries.map((entry) => entry.commit)).toEqual([mine.commit]);
  }, REAL_GIT_TEST_TIMEOUT_MS);
});

describe('savepointRefs', () => {
  it('rejects session ids that cannot be embedded into a refname', () => {
    for (const sessionId of ['has space', 'a/../b', 'dot.dot', '', 'x'.repeat(129)]) {
      expect(() => savepointRefForSession(sessionId)).toThrow(InvalidSavepointSessionIdError);
    }
    expect(savepointRefForSession('Ok_id-123')).toBe(`${SAVEPOINT_REF_NAMESPACE}Ok_id-123`);
  });

  it('lists refs for multiple sessions and deletes them idempotently', async () => {
    await commitSeed();
    await writeRepoFile('a.txt', 'v1\n');
    const a = await createShadowSavepoint(repoPath, {
      sessionId: 'sess-a',
      label: 'a',
      meta: { kind: 'turn-start' },
    });
    await writeRepoFile('a.txt', 'v2\n');
    const b = await createShadowSavepoint(repoPath, {
      sessionId: 'sess-b',
      label: 'b',
      meta: { kind: 'turn-start' },
    });

    const refs = await listSavepointRefs(repoPath);
    expect(refs).toEqual(
      expect.arrayContaining([
        { sessionId: 'sess-a', sha: a.commit },
        { sessionId: 'sess-b', sha: b.commit },
      ]),
    );
    expect(refs).toHaveLength(2);

    await deleteSavepointRef(repoPath, 'sess-a');
    // 幂等:重复删除与删除非法 id 都静默成功。
    await deleteSavepointRef(repoPath, 'sess-a');
    await deleteSavepointRef(repoPath, 'bad id!');

    expect(await readSavepointTip(repoPath, 'sess-a')).toBeNull();
    expect(await listSavepointRefs(repoPath)).toEqual([{ sessionId: 'sess-b', sha: b.commit }]);
  }, REAL_GIT_TEST_TIMEOUT_MS);
});

describe('writeWorktreeTreeForPaths', () => {
  it('writes current worktree state and tolerates paths deleted and absent from HEAD', async () => {
    await writeRepoFile('a.txt', 'base\n');
    await writeRepoFile('del.txt', 'delete me\n');
    await writeRepoFile('other.txt', 'other base\n');
    await gitExec(['add', '-A'], repoPath);
    await gitExec(['commit', '--no-gpg-sign', '-m', 'seed tree fixture'], repoPath);
    await writeRepoFile('a.txt', 'work\n');
    await fs.rm(path.join(repoPath, 'del.txt'));

    // ghost.txt 从未存在(等价于"某轮创建、后续轮删除"后的终态):
    // 不报错,也不出现在结果树里。
    const tree = await writeWorktreeTreeForPaths(repoPath, ['a.txt', 'del.txt', 'ghost.txt']);

    expect(tree).toMatch(/^[0-9a-f]{40}$/);
    expect(await gitStdout(['show', `${tree}:a.txt`])).toBe('work\n');
    const listed = (await gitStdout(['ls-tree', '-r', '--name-only', tree]))
      .split('\n')
      .filter(Boolean);
    expect(listed).not.toContain('ghost.txt');
    expect(listed).not.toContain('del.txt');
    // 未列入 paths 的 HEAD 文件保持 HEAD 版本(临时 index 以 HEAD 播种)。
    expect(await gitStdout(['show', `${tree}:other.txt`])).toBe('other base\n');
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('treats a file replaced by a directory as absent instead of failing', async () => {
    await writeRepoFile('swap', 'was a file\n');
    await gitExec(['add', '-A'], repoPath);
    await gitExec(['commit', '--no-gpg-sign', '-m', 'seed swap fixture'], repoPath);
    // 某轮把文件 swap 换成了同名目录及其子文件:路径集合里旧文件路径仍在。
    await fs.rm(path.join(repoPath, 'swap'));
    await writeRepoFile('swap/child.txt', 'child\n');

    const tree = await writeWorktreeTreeForPaths(repoPath, ['swap', 'swap/child.txt']);

    const listed = (await gitStdout(['ls-tree', '-r', '--name-only', tree]))
      .split('\n')
      .filter(Boolean);
    expect(listed).toContain('swap/child.txt');
    expect(listed).not.toContain('swap');
    expect(await gitStdout(['show', `${tree}:swap/child.txt`])).toBe('child\n');
  }, REAL_GIT_TEST_TIMEOUT_MS);
});
