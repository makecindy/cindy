/**
 * freshBase 单测 —— 自动 worktree 新鲜基底解析(resolveFreshSourceBranch)。
 * gitExec 全 mock(不碰真 git),覆盖 upstream/origin 选择、远端默认分支真值查询
 * (ls-remote --symref)、离线回退本地元数据、fetch 失败回退与 fail-open 各分支。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitExecOpts } from '../gitExec';

const mocks = vi.hoisted(() => ({
  impl: undefined as undefined | ((args: readonly string[]) => string | undefined),
  calls: [] as { args: string[]; opts?: { timeoutMs?: number } }[],
}));

vi.mock('../gitExec', () => ({
  // 与真实实现保持一致:freshBase 用它从每步网络预算里预留超时清理时间
  KILL_CLEANUP_BUDGET_MS: 3_000,
  gitExec: async (args: readonly string[], _cwd?: string, opts?: GitExecOpts) => {
    mocks.calls.push({ args: [...args], opts });
    const out = mocks.impl?.(args);
    if (out === undefined) throw new Error(`git ${args.join(' ')} failed`);
    return { stdout: out, stderr: '' };
  },
}));

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { resolveFreshSourceBranch } from '../freshBase';

const REPO = '/repo';

beforeEach(() => {
  mocks.impl = undefined;
  mocks.calls = [];
});

function call(prefix: string) {
  return mocks.calls.find((c) => c.args.join(' ').startsWith(prefix));
}

describe('resolveFreshSourceBranch', () => {
  it('有 upstream → ls-remote 查远端默认分支真值,fetch 后返回 upstream/<db>', async () => {
    mocks.impl = (args) => {
      const key = args.join(' ');
      if (key === 'remote get-url upstream') return 'git@github.com:up/repo.git';
      if (key === 'ls-remote --symref upstream HEAD')
        return 'ref: refs/heads/main\tHEAD\nabc123\tHEAD';
      if (key === 'fetch --quiet upstream +refs/heads/main:refs/remotes/upstream/main') return '';
      if (key === 'rev-parse --verify refs/remotes/upstream/main') return 'abc123';
      return undefined;
    };
    const res = await resolveFreshSourceBranch(REPO, 'feature-x');
    expect(res).toEqual({ sourceBranch: 'refs/remotes/upstream/main', fetched: true, reason: undefined });
    // 网络类命令必须带真超时(到点杀子进程,防与后续 createWorktree 抢仓库锁)
    expect(call('ls-remote')?.opts?.timeoutMs).toBeGreaterThan(0);
    expect(call('fetch')?.opts?.timeoutMs).toBeGreaterThan(0);
    // 远端真值命中时不再读本地 symbolic-ref
    expect(call('symbolic-ref')).toBeUndefined();
  });

  it('远端默认分支已改名 → 以 ls-remote 真值为准,不用本地过期的 remote HEAD', async () => {
    mocks.impl = (args) => {
      const key = args.join(' ');
      if (key === 'remote get-url upstream') return 'git@github.com:up/repo.git';
      // 本地 refs/remotes/upstream/HEAD 仍指旧的 main(不应被读到)
      if (key === 'symbolic-ref --short refs/remotes/upstream/HEAD') return 'upstream/main';
      if (key === 'ls-remote --symref upstream HEAD')
        return 'ref: refs/heads/trunk\tHEAD\ndef456\tHEAD';
      if (key === 'fetch --quiet upstream +refs/heads/trunk:refs/remotes/upstream/trunk') return '';
      if (key === 'rev-parse --verify refs/remotes/upstream/trunk') return 'def456';
      return undefined;
    };
    const res = await resolveFreshSourceBranch(REPO, 'feature-x');
    expect(res.sourceBranch).toBe('refs/remotes/upstream/trunk');
    expect(res.fetched).toBe(true);
    // 回归:必须用显式目标 refspec——--single-branch/窄 refspec clone 里裸
    // `fetch <remote> trunk` 只更新 FETCH_HEAD 不建 refs/remotes/<remote>/trunk,
    // 后续 rev-parse 查不到就会退回陈旧基底
    expect(call('fetch')?.args).toEqual([
      'fetch',
      '--quiet',
      'upstream',
      '+refs/heads/trunk:refs/remotes/upstream/trunk',
    ]);
  });

  it('ls-remote 失败(离线)→ 退本地 symbolic-ref,fetch 成功', async () => {
    mocks.impl = (args) => {
      const key = args.join(' ');
      if (key === 'remote get-url origin') return 'git@github.com:me/repo.git';
      if (key === 'symbolic-ref --short refs/remotes/origin/HEAD') return 'origin/main';
      if (key === 'fetch --quiet origin +refs/heads/main:refs/remotes/origin/main') return '';
      if (key === 'rev-parse --verify refs/remotes/origin/main') return 'abc123';
      return undefined;
    };
    const res = await resolveFreshSourceBranch(REPO, 'feature-x');
    expect(res.sourceBranch).toBe('refs/remotes/origin/main');
    expect(res.fetched).toBe(true);
  });

  it('ls-remote 与 symbolic-ref 都缺 → 探测 refs/remotes/origin/main', async () => {
    mocks.impl = (args) => {
      const key = args.join(' ');
      if (key === 'remote get-url origin') return 'git@github.com:me/repo.git';
      if (key === 'rev-parse --verify refs/remotes/origin/main') return 'abc123';
      if (key === 'fetch --quiet origin +refs/heads/main:refs/remotes/origin/main') return '';
      return undefined;
    };
    const res = await resolveFreshSourceBranch(REPO, 'feature-x');
    expect(res.sourceBranch).toBe('refs/remotes/origin/main');
    expect(res.fetched).toBe(true);
  });

  it('fetch 失败但本地已有远端 ref 且 fallback 未领先 → 退用 stale ref', async () => {
    mocks.impl = (args) => {
      const key = args.join(' ');
      if (key === 'remote get-url origin') return 'git@github.com:me/repo.git';
      if (key === 'symbolic-ref --short refs/remotes/origin/HEAD') return 'origin/main';
      if (key === 'rev-parse --verify refs/remotes/origin/main') return 'abc123';
      // ls-remote / fetch → undefined → 抛错(离线);
      // merge-base --is-ancestor → 抛错 = 非祖先(fallback 未包含 stale ref,分叉/落后)
      return undefined;
    };
    const res = await resolveFreshSourceBranch(REPO, 'feature-x');
    expect(res).toEqual({ sourceBranch: 'refs/remotes/origin/main', fetched: false, reason: 'stale-remote-ref' });
  });

  it('fetch 失败且 fallback 已领先 stale ref → 保留 fallback,不丢本地提交', async () => {
    mocks.impl = (args) => {
      const key = args.join(' ');
      if (key === 'remote get-url origin') return 'git@github.com:me/repo.git';
      if (key === 'symbolic-ref --short refs/remotes/origin/HEAD') return 'origin/main';
      if (key === 'rev-parse --verify refs/remotes/origin/main') return 'abc123';
      // stale origin/main 是 fallback 的祖先(本地 main 有未推送提交)
      if (key === 'merge-base --is-ancestor refs/remotes/origin/main feature-x') return '';
      return undefined;
    };
    const res = await resolveFreshSourceBranch(REPO, 'feature-x');
    expect(res).toEqual({
      sourceBranch: 'feature-x',
      fetched: false,
      reason: 'stale-remote-ref-behind-fallback',
    });
  });

  it('预算耗尽跳过 fetch 且 fallback 领先 → 同样保留 fallback', async () => {
    vi.useFakeTimers();
    try {
      mocks.impl = (args) => {
        const key = args.join(' ');
        if (key === 'remote get-url origin') return 'git@github.com:me/repo.git';
        if (key.startsWith('ls-remote')) {
          vi.setSystemTime(Date.now() + 15_000);
          return undefined;
        }
        if (key === 'symbolic-ref --short refs/remotes/origin/HEAD') return 'origin/main';
        if (key === 'rev-parse --verify refs/remotes/origin/main') return 'abc123';
        if (key === 'merge-base --is-ancestor refs/remotes/origin/main feature-x') return '';
        return undefined;
      };
      const res = await resolveFreshSourceBranch(REPO, 'feature-x');
      expect(res).toEqual({
        sourceBranch: 'feature-x',
        fetched: false,
        reason: 'stale-remote-ref-behind-fallback',
      });
      expect(call('fetch')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ls-remote 挂满耗尽总预算 → 不再发起 fetch,退用本地已有远端 ref', async () => {
    vi.useFakeTimers();
    try {
      mocks.impl = (args) => {
        const key = args.join(' ');
        if (key === 'remote get-url origin') return 'git@github.com:me/repo.git';
        if (key.startsWith('ls-remote')) {
          // 模拟离线挂满:整个总预算被 ls-remote 耗光
          vi.setSystemTime(Date.now() + 15_000);
          return undefined;
        }
        if (key === 'symbolic-ref --short refs/remotes/origin/HEAD') return 'origin/main';
        if (key === 'rev-parse --verify refs/remotes/origin/main') return 'abc123';
        return undefined;
      };
      const res = await resolveFreshSourceBranch(REPO, 'feature-x');
      expect(res).toEqual({ sourceBranch: 'refs/remotes/origin/main', fetched: false, reason: 'stale-remote-ref' });
      // 预算耗尽后不得以全新预算发起第二次网络操作
      expect(call('fetch')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ls-remote 耗掉部分预算 → fetch 只拿剩余预算,不是全新 15s', async () => {
    vi.useFakeTimers();
    try {
      mocks.impl = (args) => {
        const key = args.join(' ');
        if (key === 'remote get-url origin') return 'git@github.com:me/repo.git';
        if (key.startsWith('ls-remote')) {
          vi.setSystemTime(Date.now() + 10_000);
          return undefined;
        }
        if (key === 'symbolic-ref --short refs/remotes/origin/HEAD') return 'origin/main';
        if (key === 'fetch --quiet origin +refs/heads/main:refs/remotes/origin/main') return '';
        if (key === 'rev-parse --verify refs/remotes/origin/main') return 'abc123';
        return undefined;
      };
      const res = await resolveFreshSourceBranch(REPO, 'feature-x');
      expect(res.fetched).toBe(true);
      const fetchOpts = call('fetch')?.opts;
      expect(fetchOpts?.timeoutMs).toBeGreaterThan(0);
      // 剩余 5s 还要预留 3s 超时清理预算(KILL_CLEANUP_BUDGET_MS)——超时路径的
      // 清理墙钟也必须落在共享 deadline 内,fetch 实际只拿 ≤2s
      expect(fetchOpts?.timeoutMs).toBeLessThanOrEqual(2_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fetch 超时且清理未确认(cleanup unconfirmed)→ 仍按契约 fail-open 回退,不阻断创建', async () => {
    mocks.impl = (args) => {
      const key = args.join(' ');
      if (key === 'remote get-url origin') return 'git@github.com:me/repo.git';
      if (key === 'symbolic-ref --short refs/remotes/origin/HEAD') return 'origin/main';
      if (key === 'rev-parse --verify refs/remotes/origin/main') return 'abc123';
      if (key.startsWith('fetch'))
        throw new Error('git fetch failed: timed out after 2000ms; process tree cleanup unconfirmed');
      return undefined;
    };
    const res = await resolveFreshSourceBranch(REPO, 'feature-x');
    // 刻意的 fail-open(行为契约):残留进程若真持锁,后续 git 写操作会以锁错误
    // 显式失败,解析层不把降级环境变成必失败
    expect(res).toEqual({ sourceBranch: 'refs/remotes/origin/main', fetched: false, reason: 'stale-remote-ref' });
  });

  it('总预算 ≤0 → 不发起任何网络操作(0/负数不传给 gitExec),纯本地元数据回退', async () => {
    mocks.impl = (args) => {
      const key = args.join(' ');
      if (key === 'remote get-url origin') return 'git@github.com:me/repo.git';
      if (key === 'symbolic-ref --short refs/remotes/origin/HEAD') return 'origin/main';
      if (key === 'rev-parse --verify refs/remotes/origin/main') return 'abc123';
      return undefined;
    };
    const res = await resolveFreshSourceBranch(REPO, 'feature-x', 0);
    expect(res).toEqual({ sourceBranch: 'refs/remotes/origin/main', fetched: false, reason: 'stale-remote-ref' });
    expect(call('ls-remote')).toBeUndefined();
    expect(call('fetch')).toBeUndefined();
  });

  it('无任何 remote → 回退 fallback', async () => {
    mocks.impl = () => undefined;
    const res = await resolveFreshSourceBranch(REPO, 'feature-x');
    expect(res).toEqual({ sourceBranch: 'feature-x', fetched: false, reason: 'no-remote' });
  });

  it('有 remote 但解析不出默认分支 → 回退 fallback,不 fetch', async () => {
    mocks.impl = (args) => {
      const key = args.join(' ');
      if (key === 'remote get-url origin') return 'git@github.com:me/repo.git';
      return undefined;
    };
    const res = await resolveFreshSourceBranch(REPO, 'feature-x');
    expect(res).toEqual({ sourceBranch: 'feature-x', fetched: false, reason: 'no-default-branch' });
    expect(call('fetch')).toBeUndefined();
  });
});
