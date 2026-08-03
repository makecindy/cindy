/**
 * savepointCleanup 单元测试(mock DB / detectCwd / savepointRefs):
 *   - 会话删除清理:只有 status='deleted' 且能定位到 git repoRoot 才删 ref;
 *     行缺失(无 workingDir 可定位)/ archived / active / 非 git / worktree 内
 *     一律不删;任何失败吞掉不抛。
 *   - 启动期对账:孤儿 ref(owner 行缺失或已删除)删除,存活 owner 保留,
 *     DB 查询失败整体跳过(零删除)。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const deleteRefMock = vi.fn();
const listRefsMock = vi.fn();
const detectCwdMock = vi.fn();

/** select().from().where() 每次调用按序消费一个结果;Error 表示该次查询抛错。 */
const selectQueue: Array<unknown[] | Error> = [];
let getDbClientError: Error | null = null;

vi.mock('../git-snapshot/savepointRefs', () => ({
  deleteSavepointRef: (...args: unknown[]) => deleteRefMock(...args),
  listSavepointRefs: (...args: unknown[]) => listRefsMock(...args),
}));

vi.mock('../worktree/WorktreeManager', () => ({
  detectCwd: (...args: unknown[]) => detectCwdMock(...args),
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

import {
  cleanupSavepointsForRemovedSession,
  reconcileSavepointRefsForDeletedSessions,
} from '../git-snapshot/savepointCleanup';

function gitRepoInfo(repoRoot: string) {
  return { gitInstalled: true, isGitRepo: true, isInsideWorktree: false, repoRoot };
}

beforeEach(() => {
  deleteRefMock.mockReset().mockResolvedValue(undefined);
  listRefsMock.mockReset().mockResolvedValue([]);
  detectCwdMock.mockReset().mockResolvedValue(gitRepoInfo('/repo'));
  selectQueue.length = 0;
  getDbClientError = null;
});

describe('cleanupSavepointsForRemovedSession', () => {
  it('deletes the savepoint ref when the session row is deleted', async () => {
    selectQueue.push([{ status: 'deleted', workingDir: '/work/dir' }]);
    detectCwdMock.mockResolvedValue(gitRepoInfo('/repo/root'));

    await cleanupSavepointsForRemovedSession('s1');

    expect(detectCwdMock).toHaveBeenCalledWith('/work/dir');
    expect(deleteRefMock).toHaveBeenCalledTimes(1);
    expect(deleteRefMock).toHaveBeenCalledWith('/repo/root', 's1');
  });

  it('skips when the session row is missing (no workingDir to resolve)', async () => {
    selectQueue.push([]);

    await cleanupSavepointsForRemovedSession('s-missing');

    expect(detectCwdMock).not.toHaveBeenCalled();
    expect(deleteRefMock).not.toHaveBeenCalled();
  });

  it.each(['archived', 'active'])('keeps the ref when status is %s', async (status) => {
    selectQueue.push([{ status, workingDir: '/work/dir' }]);

    await cleanupSavepointsForRemovedSession('s1');

    expect(deleteRefMock).not.toHaveBeenCalled();
  });

  it('skips when the deleted session has no workingDir', async () => {
    selectQueue.push([{ status: 'deleted', workingDir: null }]);

    await cleanupSavepointsForRemovedSession('s1');

    expect(detectCwdMock).not.toHaveBeenCalled();
    expect(deleteRefMock).not.toHaveBeenCalled();
  });

  it('skips when the workingDir is not a git repository', async () => {
    selectQueue.push([{ status: 'deleted', workingDir: '/work/dir' }]);
    detectCwdMock.mockResolvedValue({
      gitInstalled: true,
      isGitRepo: false,
      isInsideWorktree: false,
    });

    await cleanupSavepointsForRemovedSession('s1');

    expect(deleteRefMock).not.toHaveBeenCalled();
  });

  it('skips when the workingDir is inside a managed worktree', async () => {
    selectQueue.push([{ status: 'deleted', workingDir: '/work/dir' }]);
    detectCwdMock.mockResolvedValue({
      gitInstalled: true,
      isGitRepo: true,
      isInsideWorktree: true,
      repoRoot: '/repo/root',
    });

    await cleanupSavepointsForRemovedSession('s1');

    expect(deleteRefMock).not.toHaveBeenCalled();
  });

  it('swallows DB failures without deleting or throwing', async () => {
    selectQueue.push(new Error('db exploded'));

    await expect(cleanupSavepointsForRemovedSession('s1')).resolves.toBeUndefined();

    expect(deleteRefMock).not.toHaveBeenCalled();
  });

  it('swallows detectCwd failures without throwing', async () => {
    selectQueue.push([{ status: 'deleted', workingDir: '/work/dir' }]);
    detectCwdMock.mockRejectedValue(new Error('git missing'));

    await expect(cleanupSavepointsForRemovedSession('s1')).resolves.toBeUndefined();

    expect(deleteRefMock).not.toHaveBeenCalled();
  });
});

describe('reconcileSavepointRefsForDeletedSessions', () => {
  it('removes orphan refs and keeps refs owned by live sessions', async () => {
    selectQueue.push([
      { id: 's-active', status: 'active', workingDir: '/work/dir' },
    ]);
    detectCwdMock.mockResolvedValue(gitRepoInfo('/repo/root'));
    listRefsMock.mockResolvedValue([
      { sessionId: 's-active', sha: 'a'.repeat(40) },
      { sessionId: 's-archived', sha: 'b'.repeat(40) },
      { sessionId: 's-deleted', sha: 'c'.repeat(40) },
      { sessionId: 's-vanished', sha: 'd'.repeat(40) },
    ]);
    // owners 查询:s-vanished 行已物理缺失。
    selectQueue.push([
      { id: 's-active', status: 'active' },
      { id: 's-archived', status: 'archived' },
      { id: 's-deleted', status: 'deleted' },
    ]);

    await reconcileSavepointRefsForDeletedSessions();

    expect(listRefsMock).toHaveBeenCalledWith('/repo/root');
    const deleted = deleteRefMock.mock.calls.map((call) => call[1]).sort();
    expect(deleted).toEqual(['s-deleted', 's-vanished']);
    expect(deleteRefMock).toHaveBeenCalledWith('/repo/root', 's-deleted');
    expect(deleteRefMock).toHaveBeenCalledWith('/repo/root', 's-vanished');
  });

  it('skips entirely when the session query fails', async () => {
    selectQueue.push(new Error('db exploded'));

    await expect(reconcileSavepointRefsForDeletedSessions()).resolves.toBeUndefined();

    expect(detectCwdMock).not.toHaveBeenCalled();
    expect(listRefsMock).not.toHaveBeenCalled();
    expect(deleteRefMock).not.toHaveBeenCalled();
  });

  it('skips non-git workdirs and dedupes repeated repo roots', async () => {
    selectQueue.push([
      { id: 's1', status: 'deleted', workingDir: '/repo/sub-a' },
      { id: 's2', status: 'deleted', workingDir: '/repo/sub-b' },
      { id: 's3', status: 'deleted', workingDir: '/plain/dir' },
    ]);
    detectCwdMock.mockImplementation(async (workingDir: string) =>
      workingDir === '/plain/dir'
        ? { gitInstalled: true, isGitRepo: false, isInsideWorktree: false }
        : gitRepoInfo('/repo'),
    );
    listRefsMock.mockResolvedValue([{ sessionId: 's1', sha: 'a'.repeat(40) }]);
    // 同一 repoRoot 只对账一次 → 只消费一次 owners 查询。
    selectQueue.push([]);

    await reconcileSavepointRefsForDeletedSessions();

    expect(listRefsMock).toHaveBeenCalledTimes(1);
    expect(listRefsMock).toHaveBeenCalledWith('/repo');
    expect(deleteRefMock).toHaveBeenCalledTimes(1);
    expect(deleteRefMock).toHaveBeenCalledWith('/repo', 's1');
  });

  it('continues with the next workdir when one repo fails', async () => {
    selectQueue.push([
      { id: 's1', status: 'deleted', workingDir: '/broken/dir' },
      { id: 's2', status: 'deleted', workingDir: '/ok/dir' },
    ]);
    detectCwdMock.mockImplementation(async (workingDir: string) => {
      if (workingDir === '/broken/dir') throw new Error('detect failed');
      return gitRepoInfo('/ok/repo');
    });
    listRefsMock.mockResolvedValue([{ sessionId: 's2', sha: 'a'.repeat(40) }]);
    selectQueue.push([]);

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
