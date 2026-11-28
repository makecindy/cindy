/**
 * handoffWorktree 单测 —— send_to_session create + use_worktree 的 worktree 准备逻辑。
 * 依赖全 mock(不碰真 git / Electron),覆盖 base repo 三种解析路径与失败分支。
 */

import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { WorktreeMeta } from '../../worktree/types.js';
import {
  prepareHandoffWorktree,
  prepareTaskWorktree,
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

  // 显式基线(send_to_session / create_task_worktree 的 base_ref)。依据:多机协作复盘——
  // 工作分支不是默认分支的项目,新任务从默认分支起步后还要再整树切一次分支;另一台电脑
  // 刚 push 的远端分支在本机可能还没 fetch。既有用例只覆盖「原样透传」,不含远端刷新、
  // 没能刷新时的回报,以及它压过「跟随来源任务在途分支」。最小输入:一个显式引用 + 解析结果。
  it.each([
    ['远端分支已刷新', { sourceBranch: 'refs/remotes/origin/release/2.x', fetched: true }, undefined],
    ['远端分支没连上,沿用本地副本', { sourceBranch: 'refs/remotes/origin/release/2.x', fetched: false }, 'fetch-failed'],
    ['远端已没有这条分支,沿用本地副本', { sourceBranch: 'refs/remotes/origin/release/2.x', fetched: false, reason: 'not-on-remote' }, 'not-on-remote'],
    ['本地分支,没有可刷新的东西', { sourceBranch: 'release/2.x' }, undefined],
  ] as const)('显式基线:%s → 以解析结果为源,并如实回报是否陈旧', async (_label, explicit, stale) => {
    const resolveFreshSource = vi.fn(async () => ({ sourceBranch: 'refs/remotes/origin/main' }));
    const resolveExplicitSource = vi.fn(async () => explicit);
    // 来源任务自己在 worktree 里:没有显式基线时会跟随它的在途分支。
    const deps = makeDeps({
      getForSession: vi.fn(() => meta()),
      listBranches: vi.fn(async () => ({ branches: ['main'], current: 'xdt/auto-x1' })),
      resolveFreshSource,
      resolveExplicitSource,
    });
    const res = await prepareHandoffWorktree(deps, 'disp-1', WT, { sourceRef: 'origin/release/2.x' });
    expect(resolveExplicitSource).toHaveBeenCalledWith(BASE, 'origin/release/2.x');
    expect(deps.createWorktree).toHaveBeenCalledWith(expect.objectContaining({ sourceBranch: explicit.sourceBranch }));
    expect(res).toMatchObject({ ok: true, meta: { sourceBranch: explicit.sourceBranch } });
    expect(res.ok && res.staleBaseReason).toBe(stale);
    expect(resolveFreshSource).not.toHaveBeenCalled();
  });

  it.each([
    ['远端没有这条分支', { sourceBranch: 'refs/remotes/origin/gone', fetched: false, reason: 'not-on-remote' }, null, 'The remote has no such branch'],
    ['没连上且本地没有副本', { sourceBranch: 'refs/remotes/origin/gone', fetched: false, reason: 'fetch-failed' }, null, 'could not be fetched'],
    ['裸分支名只在远端存在', { sourceBranch: 'gone' }, null, 'pass it as "origin/<branch>"'],
    // 基线本身解析得了(本地副本可用),worktree 因别的原因建不出:不能把原因说成基线拉不到。
    ['基线可用但 worktree 因别的原因失败', { sourceBranch: 'refs/remotes/origin/gone', fetched: false, reason: 'fetch-failed' }, 'sha', null],
  ] as const)('显式基线建不出 worktree(%s)→ 报错带下一步,不回退默认分支', async (_label, explicit, resolved, hint) => {
    const resolveFreshSource = vi.fn(async () => ({ sourceBranch: 'refs/remotes/origin/main' }));
    const createWorktree = vi.fn(async () => ({
      ok: false as const,
      error: { kind: 'unknown' as const, message: `worktree add 失败: ${explicit.sourceBranch}` },
    }));
    const deps = makeDeps({
      resolveFreshSource,
      resolveExplicitSource: vi.fn(async () => explicit),
      resolveCommit: vi.fn(async () => resolved),
      createWorktree,
    });
    const res = await prepareHandoffWorktree(deps, undefined, BASE, { sourceRef: 'origin/gone' });
    expect(res.ok).toBe(false);
    const message = res.ok === false ? res.message : '';
    expect(message).toContain(explicit.sourceBranch);
    if (hint) expect(message).toContain(hint);
    else expect(message).toBe(`worktree add 失败: ${explicit.sourceBranch}`);
    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(resolveFreshSource).not.toHaveBeenCalled();
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

// create_task_worktree:给已有任务自己绑定托管 worktree(不搬任务、不重启)。
// 生产入口 prepareTaskWorktree;可观察结果是绑定到调用方 session 的 worktree 与错误码。
describe('prepareTaskWorktree', () => {
  const caller = { workingDir: BASE, status: 'active', source: 'desktop' };

  it('binds a new worktree to the calling task, branched from the fresh remote default', async () => {
    const resolveFreshSource = vi.fn(async () => ({ sourceBranch: 'refs/remotes/origin/main', fetched: true }));
    const deps = makeDeps({ resolveFreshSource });
    const res = await prepareTaskWorktree(deps, { sessionId: 'task-1', caller });
    expect(res).toMatchObject({ ok: true, created: true, meta: { sessionId: 'task-1' } });
    expect(res).not.toHaveProperty('staleBaseReason');
    expect(resolveFreshSource).toHaveBeenCalledWith(BASE, 'main');
    expect(deps.createWorktree).toHaveBeenCalledWith({
      sessionId: 'task-1',
      baseRepo: BASE,
      name: 'fresh-name',
      sourceBranch: 'refs/remotes/origin/main',
    });
  });

  // 拉取失败时退用本地引用曾经静默进行,Agent 以为是最新代码就开工;结果必须带上原因。
  // 没有 remote 的纯本地仓库无所谓落后,不能误报。
  it.each([
    ['a failed fetch', 'stale-remote-ref', 'stale-remote-ref'],
    ['a repository without a remote', 'no-remote', undefined],
  ] as const)('reports the stale base for %s only when the base may be behind', async (_label, reason, expected) => {
    const resolveFreshSource = vi.fn(async () => ({ sourceBranch: 'refs/remotes/origin/main', fetched: false, reason }));
    const res = await prepareTaskWorktree(makeDeps({ resolveFreshSource }), { sessionId: 'task-1', caller });
    expect(res).toMatchObject({ ok: true, created: true });
    expect((res as { staleBaseReason?: string }).staleBaseReason).toBe(expected);
  });

  it('returns the existing binding instead of creating a second worktree', async () => {
    const deps = makeDeps({ getForSession: vi.fn(() => meta({ sessionId: 'task-1' })) });
    const res = await prepareTaskWorktree(deps, { sessionId: 'task-1', caller });
    expect(res).toMatchObject({ ok: true, created: false, meta: { path: WT } });
    expect(deps.createWorktree).not.toHaveBeenCalled();
  });

  it.each([
    ['archived task', { caller: { ...caller, status: 'archived' } }, 'PRECONDITION_FAILED'],
    ['read-only review task', { caller: { ...caller, source: 'review' } }, 'PRECONDITION_FAILED'],
    ['relative repo_dir', { caller, repoDir: 'repo' }, 'INVALID_ARGS'],
    ['no directory to branch from', { caller: { ...caller, workingDir: null } }, 'INVALID_ARGS'],
  ] as const)('rejects %s without touching git', async (_label, input, errorCode) => {
    const deps = makeDeps();
    const res = await prepareTaskWorktree(deps, { sessionId: 'task-1', ...input });
    expect(res).toMatchObject({ ok: false, errorCode });
    expect(deps.createWorktree).not.toHaveBeenCalled();
  });

  it('branches from repo_dir when the task directory is not the repository', async () => {
    const repo = path.resolve('/workspace/repo');
    const deps = makeDeps({
      detectCwd: vi.fn(async () => ({ isGitRepo: true, isInsideWorktree: false, gitInstalled: true, repoRoot: repo })),
    });
    const res = await prepareTaskWorktree(deps, {
      sessionId: 'task-1',
      caller: { ...caller, workingDir: path.resolve('/workspace') },
      repoDir: repo,
    });
    expect(res.ok).toBe(true);
    expect(deps.detectCwd).toHaveBeenCalledWith(repo);
  });

  // #9513:显式基线分支。默认路径取远端默认分支,给出 base_ref 时按该引用切出,
  // 且引用解析不了必须报错而不是回退默认分支。
  it('branches from the explicit base ref instead of the remote default branch', async () => {
    const resolveFreshSource = vi.fn(async () => ({ sourceBranch: 'refs/remotes/origin/main' }));
    const deps = makeDeps({ resolveFreshSource });
    const res = await prepareTaskWorktree(deps, {
      sessionId: 'task-1',
      caller,
      baseRef: 'release/2.x',
    });
    expect(res).toMatchObject({ ok: true, created: true, meta: { sourceBranch: 'release/2.x' } });
    expect(deps.createWorktree).toHaveBeenCalledWith({
      sessionId: 'task-1',
      baseRepo: BASE,
      name: 'fresh-name',
      sourceBranch: 'release/2.x',
    });
    expect(resolveFreshSource).not.toHaveBeenCalled();
  });

  it('fails instead of falling back to the default branch when the base ref does not resolve', async () => {
    const resolveFreshSource = vi.fn(async () => ({ sourceBranch: 'refs/remotes/origin/main' }));
    const deps = makeDeps({
      resolveFreshSource,
      createWorktree: vi.fn(async () => ({
        ok: false as const,
        error: { kind: 'unknown' as const, message: '源分支 "release/2.x" 不存在' },
      })),
    });
    const res = await prepareTaskWorktree(deps, {
      sessionId: 'task-1',
      caller,
      baseRef: 'release/2.x',
    });
    expect(res).toMatchObject({ ok: false, errorCode: 'WORKTREE_UNAVAILABLE' });
    expect(res.ok === false && res.message).toContain('release/2.x');
    expect(resolveFreshSource).not.toHaveBeenCalled();
  });

  it.each([
    ['option injection', '-upload-pack=evil'],
    ['empty', '   '],
    ['control character', 'release/2.x\u0000'],
  ] as const)('rejects a malformed base ref (%s) without touching git', async (_label, baseRef) => {
    const deps = makeDeps();
    const res = await prepareTaskWorktree(deps, { sessionId: 'task-1', caller, baseRef });
    expect(res).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(deps.createWorktree).not.toHaveBeenCalled();
  });

  it('reports a directory that is not a git repository as WORKTREE_UNAVAILABLE', async () => {
    const deps = makeDeps({
      detectCwd: vi.fn(async () => ({ isGitRepo: false, isInsideWorktree: false, gitInstalled: true })),
    });
    const res = await prepareTaskWorktree(deps, { sessionId: 'task-1', caller });
    expect(res).toMatchObject({ ok: false, errorCode: 'WORKTREE_UNAVAILABLE' });
  });
});
