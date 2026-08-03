/**
 * handoffWorktree 单测 —— send_to_session create + use_worktree 的 worktree 准备逻辑。
 * 依赖全 mock(不碰真 git / Electron),覆盖 base repo 三种解析路径与失败分支。
 */

import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { WorktreeMeta } from '../../worktree/types.js';
import {
  prepareHandoffWorktree,
  resolveHandoffBaseRepo,
  shouldRecycleHandoffWorktreeOnFailure,
  type HandoffWorktreeDeps,
} from '../handoffWorktree.js';

const BASE = path.resolve('/repo');
const WT = path.join(BASE, '.xdt-worktrees', 'auto-x1');

function meta(overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return {
    sessionId: 'disp-1',
    name: 'auto-x1',
    path: WT,
    baseRepo: BASE,
    branch: 'xdt/auto-x1',
    sourceBranch: 'main',
    createdAt: '2026-07-05T00:00:00.000Z',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<HandoffWorktreeDeps> = {}): HandoffWorktreeDeps {
  return {
    getForSession: vi.fn(() => null),
    listAll: vi.fn(() => []),
    detectCwd: vi.fn(async () => ({
      isGitRepo: true,
      isInsideWorktree: false,
      gitInstalled: true,
      repoRoot: BASE,
      currentBranch: 'main',
    })),
    suggestName: vi.fn(async () => 'fresh-name'),
    listBranches: vi.fn(async () => ({ branches: ['main'], current: 'main' })),
    createWorktree: vi.fn(async (req) => ({
      ok: true as const,
      meta: meta({ sessionId: req.sessionId, name: req.name, sourceBranch: req.sourceBranch }),
    })),
    createId: vi.fn(() => 'new-session-uuid'),
    ...overrides,
  };
}

describe('resolveHandoffBaseRepo', () => {
  it('情况 1:dispatcher 是 worktree session 且 workingDir 在其下 → 用绑定的 baseRepo,不走 detectCwd', async () => {
    const deps = makeDeps({ getForSession: vi.fn(() => meta()) });
    const res = await resolveHandoffBaseRepo(deps, 'disp-1', path.join(WT, 'sub'));
    expect(res.baseRepo).toBe(BASE);
    expect(deps.detectCwd).not.toHaveBeenCalled();
  });

  it('情况 1 防御:有绑定但 workingDir 已不在该 worktree 下 → 忽略旧绑定,走 detectCwd', async () => {
    const other = path.resolve('/elsewhere');
    const deps = makeDeps({
      getForSession: vi.fn(() => meta()),
      detectCwd: vi.fn(async () => ({
        isGitRepo: true,
        isInsideWorktree: false,
        gitInstalled: true,
        repoRoot: other,
      })),
    });
    const res = await resolveHandoffBaseRepo(deps, 'disp-1', other);
    expect(res.baseRepo).toBe(other);
    expect(deps.detectCwd).toHaveBeenCalledWith(other);
  });

  it('情况 2:普通 git 仓库 → repoRoot 即 baseRepo', async () => {
    const deps = makeDeps();
    const res = await resolveHandoffBaseRepo(deps, undefined, BASE);
    expect(res.baseRepo).toBe(BASE);
  });

  it('情况 3:在未绑定的 worktree 内 → 按路径在登记表反查 baseRepo', async () => {
    const deps = makeDeps({
      detectCwd: vi.fn(async () => ({
        isGitRepo: true,
        isInsideWorktree: true,
        gitInstalled: true,
        repoRoot: WT, // show-toplevel 在 linked worktree 里返回 worktree 根
      })),
      listAll: vi.fn(() => [meta({ sessionId: 'other-session' })]),
    });
    const res = await resolveHandoffBaseRepo(deps, 'disp-none', WT);
    expect(res.baseRepo).toBe(BASE);
  });

  it('在 worktree 内且登记表反查不到 → baseRepo=null + 原因', async () => {
    const deps = makeDeps({
      detectCwd: vi.fn(async () => ({
        isGitRepo: true,
        isInsideWorktree: true,
        gitInstalled: true,
        repoRoot: WT,
      })),
    });
    const res = await resolveHandoffBaseRepo(deps, undefined, WT);
    expect(res.baseRepo).toBeNull();
    if (res.baseRepo === null) expect(res.message).toContain('未登记');
  });

  it('git 未装 / 非 git 仓库 → baseRepo=null', async () => {
    for (const det of [
      { isGitRepo: false, isInsideWorktree: false, gitInstalled: false },
      { isGitRepo: false, isInsideWorktree: false, gitInstalled: true },
    ]) {
      const deps = makeDeps({ detectCwd: vi.fn(async () => det) });
      const res = await resolveHandoffBaseRepo(deps, undefined, '/not-a-repo');
      expect(res.baseRepo).toBeNull();
    }
  });
});

describe('prepareHandoffWorktree', () => {
  it('成功:预生成 sessionId → createWorktree 以当前分支为源,返回 meta', async () => {
    const deps = makeDeps();
    const res = await prepareHandoffWorktree(deps, undefined, BASE);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.sessionId).toBe('new-session-uuid');
      expect(res.meta.baseRepo).toBe(BASE);
    }
    expect(deps.createWorktree).toHaveBeenCalledWith({
      sessionId: 'new-session-uuid',
      baseRepo: BASE,
      name: 'fresh-name',
      sourceBranch: 'main',
    });
  });

  it('detached HEAD(current 为空)→ sourceBranch 回退 HEAD', async () => {
    const deps = makeDeps({
      listBranches: vi.fn(async () => ({ branches: [], current: '' })),
    });
    await prepareHandoffWorktree(deps, undefined, BASE);
    expect(deps.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ sourceBranch: 'HEAD' }),
    );
  });

  it('注入 resolveFreshSource 且非 dispatcher worktree 派发 → 以 fetch 后的远端默认分支为源', async () => {
    const resolveFreshSource = vi.fn(async () => ({ sourceBranch: 'upstream/main' }));
    const deps = makeDeps({ resolveFreshSource });
    await prepareHandoffWorktree(deps, undefined, BASE);
    expect(resolveFreshSource).toHaveBeenCalledWith(BASE, 'main');
    expect(deps.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ sourceBranch: 'upstream/main' }),
    );
  });

  it('dispatcher 是 worktree session(派生子任务)→ 不走 resolveFreshSource,跟随 dispatcher worktree 当前分支', async () => {
    const resolveFreshSource = vi.fn(async () => ({ sourceBranch: 'upstream/main' }));
    // baseRepo 主 checkout 停在 main,dispatcher worktree 检出的是 xdt/auto-x1:
    // 派生子任务必须拿到后者,否则丢 dispatcher 分支上的在途提交。
    const listBranches = vi.fn(async (repoDir: string) =>
      repoDir === WT
        ? { branches: ['main', 'xdt/auto-x1'], current: 'xdt/auto-x1' }
        : { branches: ['main', 'xdt/auto-x1'], current: 'main' },
    );
    const deps = makeDeps({
      getForSession: vi.fn(() => meta()),
      listBranches,
      resolveFreshSource,
    });
    await prepareHandoffWorktree(deps, 'disp-1', path.join(WT, 'sub'));
    expect(resolveFreshSource).not.toHaveBeenCalled();
    expect(listBranches).toHaveBeenCalledWith(WT);
    expect(deps.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ sourceBranch: 'xdt/auto-x1' }),
    );
  });

  it('派生子任务且 dispatcher worktree 处于 detached HEAD → 用 rev-parse HEAD 的 SHA 为源', async () => {
    // rev-parse --abbrev-ref HEAD 在 detached 时返回字面量 "HEAD",不能当分支用;
    // 登记分支可能落后实际检出位置,必须跟随实际 HEAD 提交
    const listBranches = vi.fn(async () => ({ branches: ['main'], current: 'HEAD' }));
    const resolveCommit = vi.fn(async () => 'abc123def456');
    const deps = makeDeps({
      getForSession: vi.fn(() => meta({ branch: 'xdt/auto-x1' })),
      listBranches,
      resolveCommit,
    });
    await prepareHandoffWorktree(deps, 'disp-1', path.join(WT, 'sub'));
    expect(resolveCommit).toHaveBeenCalledWith(WT, 'HEAD');
    expect(deps.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ sourceBranch: 'abc123def456' }),
    );
  });

  it('detached 且 rev-parse HEAD 解析失败 → 才回退创建时登记的分支', async () => {
    const listBranches = vi.fn(async () => ({ branches: ['main'], current: 'HEAD' }));
    const resolveCommit = vi.fn(async () => null);
    const deps = makeDeps({
      getForSession: vi.fn(() => meta({ branch: 'xdt/auto-x1' })),
      listBranches,
      resolveCommit,
    });
    await prepareHandoffWorktree(deps, 'disp-1', path.join(WT, 'sub'));
    expect(deps.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ sourceBranch: 'xdt/auto-x1' }),
    );
  });

  it('baseRepo 解析失败 → ok=false 带原因,不调 createWorktree', async () => {
    const deps = makeDeps({
      detectCwd: vi.fn(async () => ({ isGitRepo: false, isInsideWorktree: false, gitInstalled: true })),
    });
    const res = await prepareHandoffWorktree(deps, undefined, '/not-a-repo');
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.message).toContain('不是 git 仓库');
    expect(deps.createWorktree).not.toHaveBeenCalled();
  });

  it('createWorktree 失败 → ok=false 透传错误信息', async () => {
    const deps = makeDeps({
      createWorktree: vi.fn(async () => ({
        ok: false as const,
        error: { kind: 'git-crypt-locked' as const, message: 'git-crypt 未解锁' },
      })),
    });
    const res = await prepareHandoffWorktree(deps, undefined, BASE);
    expect(res).toMatchObject({ ok: false, message: 'git-crypt 未解锁' });
  });
});

describe('shouldRecycleHandoffWorktreeOnFailure', () => {
  it('session 未建成 → 回收(无主 worktree 不留残余)', () => {
    expect(shouldRecycleHandoffWorktreeOnFailure(false)).toBe(true);
  });

  it('session 已建成 → 绝不回收(workingDir/DB 都指着它,删了产生孤儿会话;随 session close 生命周期回收)', () => {
    expect(shouldRecycleHandoffWorktreeOnFailure(true)).toBe(false);
  });
});
