/**
 * dirty.ts 快照 ref 回归(P1):auto-stash 后把 stash 条目转存 refs/xdt/snapshots/<sid>。
 * stash 栈条目保留为冗余备份,避免按 stash index drop 时被进程外 stash 操作干扰。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const gitExecMock = vi.fn();

vi.mock('../worktree/gitExec', () => ({
  gitExec: (...args: unknown[]) => gitExecMock(...args),
}));

import {
  autoStashDirtyWorktree,
  clearSnapshotRef,
  getAutoStashSha,
  getRestorableAutoStashSha,
  getSnapshotSha,
  restoreAutoStashToPreservedWorktree,
  snapshotRefForSession,
} from '../worktree/dirty';

const WT = '/repo/.xdt-worktrees/wt1';
const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const REF = 'refs/xdt/snapshots/s1';
const CONSUMED_REF = 'refs/xdt/snapshots-consumed/s1';
const OURS = `${SHA}\tOn xdt/wt1: xdt-auto-stash: session s1 worktree=wt1`;
const THEIRS = `${SHA2}\tOn other: someone else`;

function argsOf(call: unknown[]): string[] {
  return call[0] as string[];
}

function pushedStashMessage(cwd = WT): string {
  const call = gitExecMock.mock.calls.find((entry) => {
    const args = argsOf(entry);
    return entry[1] === cwd && args[0] === 'stash' && args[1] === 'push';
  });
  const args = call ? argsOf(call) : [];
  return args[args.indexOf('-m') + 1] ?? '';
}

function pushedStashEntry(sha = SHA, cwd = WT): string {
  return `${sha}\tOn xdt/wt1: ${pushedStashMessage(cwd)}`;
}

/** update-ref 写入(3 参无 -d) / 删除(-d)分开断言。 */
function refWrites(calls: string[][]): string[][] {
  return calls.filter((a) => a[0] === 'update-ref' && a[1] !== '-d');
}
function refDeletes(calls: string[][]): string[][] {
  return calls.filter((a) => a[0] === 'update-ref' && a[1] === '-d' && a[2] === REF);
}
function consumedRefDeletes(calls: string[][]): string[][] {
  return calls.filter((a) => a[0] === 'update-ref' && a[1] === '-d' && a[2] === CONSUMED_REF);
}

describe('autoStashDirtyWorktree snapshot transfer', () => {
  beforeEach(() => {
    gitExecMock.mockReset();
  });

  it('happy path: transfers stash commit to snapshot ref without dropping stash index', async () => {
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'stash' && args[1] === 'list') {
        return { stdout: `${THEIRS}\n${pushedStashEntry()}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await expect(autoStashDirtyWorktree(WT, 's1')).resolves.toBe(true);

    const calls = gitExecMock.mock.calls.map(argsOf);
    expect(refWrites(calls)).toEqual([['update-ref', REF, SHA]]);
    expect(calls.some((a) => a[0] === 'stash' && a[1] === 'drop')).toBe(false);
    expect(refDeletes(calls)).toEqual([]);
    expect(consumedRefDeletes(calls)).toEqual([['update-ref', '-d', CONSUMED_REF]]);
  });

  it('locates own entry by exact suffix match, not includes (wt1 vs wt1-extra)', async () => {
    // 栈里有更新的 `worktree=wt1-extra` 条目:includes 匹配会先命中它,把别的
    // worktree 的 sha 写进本会话快照 ref(review 反馈:快照串号)
    const EXTRA = `${SHA2}\tOn xdt/wt1-extra: xdt-auto-stash: session s1 worktree=wt1-extra`;
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'stash' && args[1] === 'list') {
        return { stdout: `${EXTRA}\n${pushedStashEntry()}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await expect(autoStashDirtyWorktree(WT, 's1')).resolves.toBe(true);
    expect(refWrites(gitExecMock.mock.calls.map(argsOf))).toEqual([['update-ref', REF, SHA]]);
  });

  it('does not issue a second stash list after writing the snapshot ref', async () => {
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'stash' && args[1] === 'list') {
        return { stdout: `${pushedStashEntry()}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await expect(autoStashDirtyWorktree(WT, 's1')).resolves.toBe(true);
    const calls = gitExecMock.mock.calls.map(argsOf);
    expect(refWrites(calls)).toEqual([['update-ref', REF, SHA]]);
    expect(calls.filter((a) => a[0] === 'stash' && a[1] === 'list')).toHaveLength(1);
    expect(calls.some((a) => a[0] === 'stash' && a[1] === 'drop')).toBe(false);
    expect(refDeletes(calls)).toEqual([]);
    expect(consumedRefDeletes(calls)).toEqual([['update-ref', '-d', CONSUMED_REF]]);
  });

  it('push failure (no local changes) → false, no transfer attempted', async () => {
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'stash' && args[1] === 'push') {
        throw new Error('No local changes to save');
      }
      return { stdout: '', stderr: '' };
    });

    await expect(autoStashDirtyWorktree(WT, 's1')).resolves.toBe(false);
    expect(gitExecMock.mock.calls.map(argsOf).some((a) => a[0] === 'update-ref')).toBe(false);
  });

  it('still dirty after stash → reapplies partial auto-stash and returns false', async () => {
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'status') return { stdout: ' M sub\n', stderr: '' };
      if (args[0] === 'stash' && args[1] === 'list') {
        return { stdout: `${pushedStashEntry()}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await expect(autoStashDirtyWorktree(WT, 's1')).resolves.toBe(false);
    expect(gitExecMock.mock.calls.map(argsOf)).toContainEqual(['stash', 'apply', SHA]);
  });

  it('does not reapply a retained stash when this push creates no new entry', async () => {
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'stash' && args[1] === 'push') {
        return { stdout: 'No local changes to save\n', stderr: '' };
      }
      if (args[0] === 'status') return { stdout: ' M submodule\n', stderr: '' };
      if (args[0] === 'stash' && args[1] === 'list') {
        return { stdout: `${OURS}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await expect(autoStashDirtyWorktree(WT, 's1')).resolves.toBe(false);
    expect(gitExecMock.mock.calls.map(argsOf).some((a) => a[0] === 'stash' && a[1] === 'apply')).toBe(false);
  });

  it('stash list transfer failure → reapplies the new auto-stash before preserving', async () => {
    let listCalls = 0;
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'stash' && args[1] === 'list') {
        listCalls += 1;
        if (listCalls === 1) throw new Error('boom');
        return { stdout: `${pushedStashEntry()}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await expect(autoStashDirtyWorktree(WT, 's1')).resolves.toBe(false);
    const calls = gitExecMock.mock.calls.map(argsOf);
    expect(calls).toContainEqual(['stash', 'apply', SHA]);
    expect(refWrites(calls)).toContainEqual(['update-ref', CONSUMED_REF, SHA]);
    // 本轮内容只在 stash 栈,上一轮旧 ref 已过期 → 清,防止恢复 apply 过期内容
    expect(refDeletes(calls)).toEqual([['update-ref', '-d', REF]]);
  });

  it('entry not found in stash list → false, stale ref cleared, no drop', async () => {
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'stash' && args[1] === 'list') {
        return { stdout: `${THEIRS}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await expect(autoStashDirtyWorktree(WT, 's1')).resolves.toBe(false);
    const calls = gitExecMock.mock.calls.map(argsOf);
    expect(refWrites(calls)).toEqual([]);
    expect(refDeletes(calls)).toEqual([['update-ref', '-d', REF]]);
    expect(calls.some((a) => a[0] === 'stash' && a[1] === 'drop')).toBe(false);
  });

  it('update-ref write failure → false, stale ref cleared, no drop', async () => {
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'stash' && args[1] === 'list') {
        return { stdout: `${pushedStashEntry()}\n`, stderr: '' };
      }
      if (args[0] === 'update-ref' && args[1] !== '-d') throw new Error('ref locked');
      return { stdout: '', stderr: '' };
    });

    await expect(autoStashDirtyWorktree(WT, 's1')).resolves.toBe(false);
    const calls = gitExecMock.mock.calls.map(argsOf);
    expect(refDeletes(calls)).toEqual([['update-ref', '-d', REF]]);
    expect(calls.some((a) => a[0] === 'stash' && a[1] === 'drop')).toBe(false);
  });

  it('concurrent invocations are serialized (no interleaved stash ops)', async () => {
    // 两路并发回收:全程互斥锁下,第二路的 stash push 必须在第一路转存完成后才开始
    const order: string[] = [];
    let release1!: () => void;
    const gate1 = new Promise<void>((r) => {
      release1 = r;
    });
    gitExecMock.mockImplementation(async (args: string[], cwd: string) => {
      const tag = cwd === WT ? 'A' : 'B';
      if (args[0] === 'stash' && args[1] === 'push') order.push(`${tag}:push`);
      if (args[0] === 'update-ref' && args[1] !== '-d') order.push(`${tag}:ref`);
      if (tag === 'A' && args[0] === 'stash' && args[1] === 'list') await gate1;
      if (args[0] === 'stash' && args[1] === 'list') {
        const sha = tag === 'A' ? SHA : SHA2;
        const msg = `${sha}\tOn x: ${pushedStashMessage(cwd)}`;
        return { stdout: `${msg}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const p1 = autoStashDirtyWorktree(WT, 's1');
    const p2 = autoStashDirtyWorktree('/repo/.xdt-worktrees/wt2', 's2');
    release1();
    await expect(Promise.all([p1, p2])).resolves.toEqual([true, true]);
    expect(order).toEqual(['A:push', 'A:ref', 'B:push', 'B:ref']);
  });

  it('reapplies a completed snapshot when session removal is cancelled', async () => {
    gitExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args.includes(REF)) {
        return { stdout: `${SHA}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await expect(restoreAutoStashToPreservedWorktree(WT, 's1')).resolves.toBe(true);

    const calls = gitExecMock.mock.calls.map(argsOf);
    expect(calls).toContainEqual(['stash', 'apply', SHA]);
    expect(calls).toContainEqual(['update-ref', '-d', REF]);
    expect(calls).toContainEqual(['update-ref', CONSUMED_REF, SHA]);
  });
});

describe('clearSnapshotRef', () => {
  beforeEach(() => {
    gitExecMock.mockReset();
  });

  it('issues update-ref -d; git failure is swallowed', async () => {
    gitExecMock.mockResolvedValueOnce({ stdout: '', stderr: '' });
    await clearSnapshotRef('/repo', 's1');
    expect(gitExecMock).toHaveBeenCalledWith(['update-ref', '-d', REF], '/repo');

    gitExecMock.mockRejectedValueOnce(new Error('no such ref'));
    await expect(clearSnapshotRef('/repo', 's1')).resolves.toBeUndefined();
  });
});

describe('getSnapshotSha / snapshotRefForSession', () => {
  beforeEach(() => {
    gitExecMock.mockReset();
  });

  it('ref naming is per-session', () => {
    expect(snapshotRefForSession('abc')).toBe('refs/xdt/snapshots/abc');
  });

  it('returns sha when ref exists, null when missing', async () => {
    gitExecMock.mockResolvedValueOnce({ stdout: `${SHA}\n`, stderr: '' });
    await expect(getSnapshotSha('/repo', 's1')).resolves.toBe(SHA);

    gitExecMock.mockRejectedValueOnce(new Error('not found'));
    await expect(getSnapshotSha('/repo', 's1')).resolves.toBeNull();
  });

  it('finds an auto-stash entry for restore fallback', async () => {
    gitExecMock.mockResolvedValueOnce({ stdout: `${THEIRS}\n${OURS}\n`, stderr: '' });

    await expect(getAutoStashSha('/repo', 's1', 'wt1')).resolves.toBe(SHA);
  });

  it('does not match auto-stash entries whose worktree name only shares a prefix', async () => {
    const prefixCollision = `${SHA2}\tOn xdt/wt1-extra: xdt-auto-stash: session s1 worktree=wt1-extra`;
    gitExecMock.mockResolvedValueOnce({ stdout: `${prefixCollision}\n${OURS}\n`, stderr: '' });

    await expect(getAutoStashSha('/repo', 's1', 'wt1')).resolves.toBe(SHA);
  });

  it('ignores an auto-stash entry that was already consumed by restore', async () => {
    gitExecMock
      .mockResolvedValueOnce({ stdout: `${OURS}\n`, stderr: '' })
      .mockResolvedValueOnce({ stdout: `${SHA}\n`, stderr: '' });

    await expect(getRestorableAutoStashSha('/repo', 's1', 'wt1')).resolves.toBeNull();
  });
});
