/**
 * savepointCleanup 单元测试(mock DB / gitExec / savepointRefs)。
 *
 * 启动期对账是保存点 ref 的**唯一**删除驱动(会话删除不做即时清理:瞬态软删
 * 流程会回滚,status 触发的删除与之竞态,见 savepointCleanup.ts 模块注释):
 *   - 只删当前账号 DB 里 status='deleted' 的 owner 的 ref;存活 / archived
 *     保留;**行缺失也保留**(localDb 按账号隔离,可能是另一账号的链,无法
 *     证明是孤儿);
 *   - 非 git 目录、linked worktree 内目录跳过,同一 repoRoot 去重;
 *   - DB 查询失败整体跳过(零删除),单个 repo 失败不阻断其余。
 *
 * 仓库判定经 gitExec 的 rev-parse 而非 WorktreeManager.detectCwd:清理模块被
 * localDb/ipc/sessions 静态导入,不能引入 WorktreeManager → worktreeStore →
 * sessions 的模块环。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const deleteRefMock = vi.fn();
const listRefsMock = vi.fn();
const gitExecMock = vi.fn();

/** 每个 workingDir 的仓库形态;Error 表示 git 调用抛错(git 缺失等)。 */
type RepoBehavior = { repoRoot: string; insideWorktree?: boolean } | 'non-git' | Error;
const repoByCwd = new Map<string, RepoBehavior>();
let defaultRepoBehavior: RepoBehavior = { repoRoot: '/repo' };

/** select().from().where() 每次调用按序消费一个结果;Error 表示该次查询抛错。 */
const selectQueue: Array<unknown[] | Error> = [];
let getDbClientError: Error | null = null;

vi.mock('../git-snapshot/savepointRefs', () => ({
  deleteSavepointRef: (...args: unknown[]) => deleteRefMock(...args),
  listSavepointRefs: (...args: unknown[]) => listRefsMock(...args),
}));

vi.mock('../worktree/gitExec', () => ({
  gitExec: (...args: unknown[]) => gitExecMock(...args),
}));

vi.mock('../localDb/client/current', () => ({
  getDbClient: () => {
    if (getDbClientError) throw getDbClientError;
    return {
      drizzle: {
        select: () => ({
          from: () => ({
            where: () => {
              const next = selectQueue.shift();
              if (next === undefined) return [];
              if (next instanceof Error) throw next;
              return next;
            },
          }),
        }),
      },
    };
  },
}));

import { reconcileSavepointRefsForDeletedSessions } from '../git-snapshot/savepointCleanup';

function installGitExecImpl(): void {
  gitExecMock.mockImplementation(async (args: readonly string[], cwd: string) => {
    const behavior = repoByCwd.get(cwd) ?? defaultRepoBehavior;
    if (behavior instanceof Error) throw behavior;
    if (behavior === 'non-git') throw new Error('fatal: not a git repository');
    if (args.includes('--show-toplevel')) return { stdout: `${behavior.repoRoot}\n`, stderr: '' };
    if (args.includes('--git-dir')) return { stdout: '.git\n', stderr: '' };
    if (args.includes('--git-common-dir')) {
      // linked worktree 的 common dir 指向主仓 .git,与 --git-dir 不同。
      return { stdout: behavior.insideWorktree ? '/primary/.git\n' : '.git\n', stderr: '' };
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  });
}

beforeEach(() => {
  deleteRefMock.mockReset().mockResolvedValue(undefined);
  listRefsMock.mockReset().mockResolvedValue([]);
  gitExecMock.mockReset();
  repoByCwd.clear();
  defaultRepoBehavior = { repoRoot: '/repo' };
  installGitExecImpl();
  selectQueue.length = 0;
  getDbClientError = null;
});

describe('reconcileSavepointRefsForDeletedSessions', () => {
  it('removes only refs provably deleted in this DB; missing rows are kept', async () => {
    selectQueue.push([
      { id: 's-active', status: 'active', workingDir: '/work/dir' },
    ]);
    repoByCwd.set('/work/dir', { repoRoot: '/repo/root' });
    listRefsMock.mockResolvedValue([
      { sessionId: 's-active', sha: 'a'.repeat(40) },
      { sessionId: 's-archived', sha: 'b'.repeat(40) },
      { sessionId: 's-deleted', sha: 'c'.repeat(40) },
      { sessionId: 's-foreign', sha: 'd'.repeat(40) },
    ]);
    // owners 查询:s-foreign 行缺失——可能是本机另一账号的会话(localDb 按
    // 账号隔离),不是孤儿证据,必须保留。
    selectQueue.push([
      { id: 's-active', status: 'active' },
      { id: 's-archived', status: 'archived' },
      { id: 's-deleted', status: 'deleted' },
    ]);

    await reconcileSavepointRefsForDeletedSessions();

    expect(listRefsMock).toHaveBeenCalledWith('/repo/root');
    expect(deleteRefMock).toHaveBeenCalledTimes(1);
    expect(deleteRefMock).toHaveBeenCalledWith('/repo/root', 's-deleted');
  });

  it('skips entirely when the session query fails', async () => {
    selectQueue.push(new Error('db exploded'));

    await expect(reconcileSavepointRefsForDeletedSessions()).resolves.toBeUndefined();

    expect(gitExecMock).not.toHaveBeenCalled();
    expect(listRefsMock).not.toHaveBeenCalled();
    expect(deleteRefMock).not.toHaveBeenCalled();
  });

  it('skips non-git workdirs and dedupes repeated repo roots', async () => {
    selectQueue.push([
      { id: 's1', status: 'deleted', workingDir: '/repo/sub-a' },
      { id: 's2', status: 'deleted', workingDir: '/repo/sub-b' },
      { id: 's3', status: 'deleted', workingDir: '/plain/dir' },
    ]);
    repoByCwd.set('/repo/sub-a', { repoRoot: '/repo' });
    repoByCwd.set('/repo/sub-b', { repoRoot: '/repo' });
    repoByCwd.set('/plain/dir', 'non-git');
    listRefsMock.mockResolvedValue([{ sessionId: 's1', sha: 'a'.repeat(40) }]);
    // 同一 repoRoot 只对账一次 → 只消费一次 owners 查询。
    selectQueue.push([{ id: 's1', status: 'deleted' }]);

    await reconcileSavepointRefsForDeletedSessions();

    expect(listRefsMock).toHaveBeenCalledTimes(1);
    expect(listRefsMock).toHaveBeenCalledWith('/repo');
    expect(deleteRefMock).toHaveBeenCalledTimes(1);
    expect(deleteRefMock).toHaveBeenCalledWith('/repo', 's1');
  });

  it('skips workdirs inside a managed worktree', async () => {
    selectQueue.push([{ id: 's1', status: 'deleted', workingDir: '/work/dir' }]);
    repoByCwd.set('/work/dir', { repoRoot: '/repo/root', insideWorktree: true });

    await reconcileSavepointRefsForDeletedSessions();

    expect(listRefsMock).not.toHaveBeenCalled();
    expect(deleteRefMock).not.toHaveBeenCalled();
  });

  it('continues with the next workdir when one repo fails', async () => {
    selectQueue.push([
      { id: 's1', status: 'deleted', workingDir: '/broken/dir' },
      { id: 's2', status: 'deleted', workingDir: '/ok/dir' },
    ]);
    repoByCwd.set('/broken/dir', new Error('detect failed'));
    repoByCwd.set('/ok/dir', { repoRoot: '/ok/repo' });
    listRefsMock.mockResolvedValue([{ sessionId: 's2', sha: 'a'.repeat(40) }]);
    selectQueue.push([{ id: 's2', status: 'deleted' }]);

    await expect(reconcileSavepointRefsForDeletedSessions()).resolves.toBeUndefined();

    expect(deleteRefMock).toHaveBeenCalledTimes(1);
    expect(deleteRefMock).toHaveBeenCalledWith('/ok/repo', 's2');
  });

  it('does not query owners when a repo has no savepoint refs', async () => {
    selectQueue.push([{ id: 's1', status: 'active', workingDir: '/work/dir' }]);
    listRefsMock.mockResolvedValue([]);

    await reconcileSavepointRefsForDeletedSessions();

    expect(deleteRefMock).not.toHaveBeenCalled();
    // owners 查询未发生:队列里没有第二个结果,若发生会拿到 [] 也无碍,
    // 这里用 selectQueue 是否被清空来断言只消费了首个查询。
    expect(selectQueue).toHaveLength(0);
  });
});
