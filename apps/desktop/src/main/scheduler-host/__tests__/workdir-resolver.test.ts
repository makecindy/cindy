/**
 * workdir-resolver 单测 —— schedule ephemeral worktree 的源分支解析与池化接线。
 * worktree 模块全 mock:验证 freshBase 解析结果(sourceBranch + fetched)如实传入
 * WorktreePool.acquireWorktree——fetched 状态用于池复用路径跳过二次 fetch。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Schedule } from '@cindy/maker-scheduler';

const mocks = vi.hoisted(() => ({
  detectCwd: vi.fn(),
  acquireWorktree: vi.fn(),
  resolveFreshSourceBranch: vi.fn(),
}));

vi.mock('../../worktree', () => ({
  WorktreeManager: { detectCwd: mocks.detectCwd },
  WorktreePool: { acquireWorktree: mocks.acquireWorktree },
  resolveFreshSourceBranch: mocks.resolveFreshSourceBranch,
}));

import { resolveWorkingDir } from '../workdir-resolver';

const schedule = { useWorktree: true, workingDir: '/repo' } as unknown as Schedule;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.detectCwd.mockResolvedValue({
    gitInstalled: true,
    isGitRepo: true,
    isInsideWorktree: false,
    currentBranch: 'work',
  });
  mocks.acquireWorktree.mockResolvedValue({
    ok: true,
    meta: { path: '/repo/.xdt-worktrees/sched-x', branch: 'xdt/sched-x' },
  });
});

describe('resolveWorkingDir(useWorktree=true)', () => {
  it('freshBase fetch 成功 → sourceBranch 用远端默认分支,并声明网络尝试已完成(池跳过二次 fetch)', async () => {
    mocks.resolveFreshSourceBranch.mockResolvedValue({ sourceBranch: 'origin/main', fetched: true });
    const res = await resolveWorkingDir(schedule, 'session-12345678');
    expect(res.ok).toBe(true);
    expect(mocks.resolveFreshSourceBranch).toHaveBeenCalledWith('/repo', 'work');
    expect(mocks.acquireWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ sourceBranch: 'origin/main', ephemeral: true }),
      { sourceFetchAlreadyAttempted: true },
    );
  });

  it('freshBase 离线回退(fetch 失败/预算耗尽)→ 同样声明已尝试,池不得再开一份新预算重试', async () => {
    mocks.resolveFreshSourceBranch.mockResolvedValue({
      sourceBranch: 'origin/main',
      fetched: false,
      reason: 'stale-remote-ref',
    });
    const res = await resolveWorkingDir(schedule, 'session-12345678');
    expect(res.ok).toBe(true);
    expect(mocks.acquireWorktree).toHaveBeenCalledWith(expect.anything(), {
      sourceFetchAlreadyAttempted: true,
    });
  });
});
