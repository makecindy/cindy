/**
 * freshBase 单测 —— 自动 worktree 新鲜基底解析(resolveFreshSourceBranch)。
 * gitExec 全 mock(不碰真 git),覆盖 upstream/origin 选择、默认分支解析、
 * fetch 失败回退与 fail-open 各分支。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  impl: undefined as undefined | ((args: readonly string[]) => string | undefined),
  calls: [] as string[][],
}));

vi.mock('../gitExec', () => ({
  gitExec: async (args: readonly string[]) => {
    mocks.calls.push([...args]);
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

describe('resolveFreshSourceBranch', () => {
  it('有 upstream → fetch 其默认分支并返回 upstream/<db>', async () => {
    mocks.impl = (args) => {
      const key = args.join(' ');
      if (key === 'remote get-url upstream') return 'git@github.com:up/repo.git';
      if (key === 'symbolic-ref --short refs/remotes/upstream/HEAD') return 'upstream/main';
      if (key === 'fetch --quiet upstream main') return '';
      if (key === 'rev-parse --verify refs/remotes/upstream/main') return 'abc123';
      return undefined;
    };
    const res = await resolveFreshSourceBranch(REPO, 'feature-x');
    expect(res).toEqual({ sourceBranch: 'upstream/main', fetched: true, reason: undefined });
    expect(mocks.calls).toContainEqual(['fetch', '--quiet', 'upstream', 'main']);
  });

  it('无 upstream 有 origin,symbolic-ref 缺失 → 探测 refs/remotes/origin/main', async () => {
    mocks.impl = (args) => {
      const key = args.join(' ');
      if (key === 'remote get-url origin') return 'git@github.com:me/repo.git';
      if (key === 'rev-parse --verify refs/remotes/origin/main') return 'abc123';
      if (key === 'fetch --quiet origin main') return '';
      return undefined;
    };
    const res = await resolveFreshSourceBranch(REPO, 'feature-x');
    expect(res.sourceBranch).toBe('origin/main');
    expect(res.fetched).toBe(true);
  });

  it('fetch 失败但本地已有远端 ref → 退用 stale ref,不回退 fallback', async () => {
    mocks.impl = (args) => {
      const key = args.join(' ');
      if (key === 'remote get-url origin') return 'git@github.com:me/repo.git';
      if (key === 'symbolic-ref --short refs/remotes/origin/HEAD') return 'origin/main';
      if (key === 'rev-parse --verify refs/remotes/origin/main') return 'abc123';
      // fetch → undefined → 抛错
      return undefined;
    };
    const res = await resolveFreshSourceBranch(REPO, 'feature-x');
    expect(res).toEqual({ sourceBranch: 'origin/main', fetched: false, reason: 'stale-remote-ref' });
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
    expect(mocks.calls.some((c) => c[0] === 'fetch')).toBe(false);
  });
});
