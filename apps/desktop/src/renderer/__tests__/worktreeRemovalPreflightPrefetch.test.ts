// @vitest-environment jsdom

/**
 * 归档/删除 dirty 预检的预取缓存
 * ---------------------------------------------------------------------------
 * 这次查询要在 main 侧跑 git status，是「点了归档、行还没消失」里剩下的最大一块
 * 等待。归档入口在执行前都有一段人类操作空窗（行内两步确认 / 先开菜单再点条目），
 * 预取就是把查询挪进那段空窗，执行时命中缓存。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  worktreeRemovalPreview: vi.fn(),
  deviceLinkInvoke: vi.fn(),
}));

import {
  prefetchDirtyWorktreeForRemoval,
  resetDirtyWorktreePreflightCache,
  resolveDirtyWorktreeForRemoval,
} from '@/lib/worktreeRemovalWarning';

beforeEach(() => {
  vi.useFakeTimers();
  mocks.worktreeRemovalPreview.mockReset();
  mocks.deviceLinkInvoke.mockReset();
  resetDirtyWorktreePreflightCache();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      worktreeRemovalPreview: mocks.worktreeRemovalPreview,
      deviceLink: { invoke: mocks.deviceLinkInvoke },
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  resetDirtyWorktreePreflightCache();
});

describe('dirty worktree preflight prefetch', () => {
  // prefetch 是 fire-and-forget，测试里用同一入口 await 一次代表「预取已落地」
  // （结论回填发生在内部 then 里，先于测试的 await 执行）。
  const settledPrefetch = (sessionId: string) => resolveDirtyWorktreeForRemoval(sessionId);

  it('serves a prefetched dirty result without querying main again', async () => {
    // dirty 复用是安全侧的:最坏只是确认弹窗多出现一次。
    mocks.worktreeRemovalPreview.mockResolvedValue({ hasWorktree: true, dirty: true });

    await settledPrefetch('session-1');
    expect(mocks.worktreeRemovalPreview).toHaveBeenCalledTimes(1);

    await expect(resolveDirtyWorktreeForRemoval('session-1')).resolves.toBe(true);
    expect(mocks.worktreeRemovalPreview).toHaveBeenCalledTimes(1);
  });

  it('never reuses a clean prefetch — revalidates at execution time', async () => {
    // 归档会顺带回收 worktree。预取到 clean 之后工作区被写脏时,复用旧结论会整个
    // 跳过 dirty 确认,用户拿不到「先提交或取消」的机会(greptile / codex 的 P1)。
    mocks.worktreeRemovalPreview.mockResolvedValue({ hasWorktree: true, dirty: false });
    await settledPrefetch('session-1');
    expect(mocks.worktreeRemovalPreview).toHaveBeenCalledTimes(1);

    // 预取之后工作区变脏 —— 执行时必须重新查到这个新结论。
    mocks.worktreeRemovalPreview.mockResolvedValue({ hasWorktree: true, dirty: true });
    await expect(resolveDirtyWorktreeForRemoval('session-1')).resolves.toBe(true);

    expect(mocks.worktreeRemovalPreview).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a clean result even while the prefetch is still in flight', async () => {
    let resolveFirst: ((value: { hasWorktree: boolean; dirty: boolean }) => void) | undefined;
    mocks.worktreeRemovalPreview.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    mocks.worktreeRemovalPreview.mockResolvedValue({ hasWorktree: true, dirty: true });

    prefetchDirtyWorktreeForRemoval('session-1');
    // 预取还没回来就点了归档:in-flight 的结论同样可能是 clean，不能拿来放行。
    const resolved = resolveDirtyWorktreeForRemoval('session-1');
    resolveFirst?.({ hasWorktree: true, dirty: false });

    await expect(resolved).resolves.toBe(true);
    expect(mocks.worktreeRemovalPreview).toHaveBeenCalledTimes(2);
  });

  it('keeps buckets per session rather than sharing one result', async () => {
    mocks.worktreeRemovalPreview.mockImplementation((sessionId: string) =>
      Promise.resolve({ hasWorktree: true, dirty: sessionId === 'dirty-one' }),
    );

    await settledPrefetch('dirty-one');
    await settledPrefetch('clean-one');

    await expect(resolveDirtyWorktreeForRemoval('dirty-one')).resolves.toBe(true);
    await expect(resolveDirtyWorktreeForRemoval('clean-one')).resolves.toBe(false);
  });

  it('re-queries once the prefetched dirty result has gone stale', async () => {
    mocks.worktreeRemovalPreview.mockResolvedValue({ hasWorktree: true, dirty: true });

    await settledPrefetch('session-1');
    await resolveDirtyWorktreeForRemoval('session-1');
    expect(mocks.worktreeRemovalPreview).toHaveBeenCalledTimes(1);

    // TTL 是 8s：略长于行内 Confirm 胶囊 4s 的自动撤回窗口。只对 dirty 结论生效 ——
    // clean 从不复用，所以不存在「过期的 clean 被用来放行归档」。
    vi.advanceTimersByTime(8_001);
    mocks.worktreeRemovalPreview.mockResolvedValue({ hasWorktree: true, dirty: false });
    await expect(resolveDirtyWorktreeForRemoval('session-1')).resolves.toBe(false);

    expect(mocks.worktreeRemovalPreview).toHaveBeenCalledTimes(2);
  });

  it('resolves without a prefetch by querying directly', async () => {
    mocks.worktreeRemovalPreview.mockResolvedValue({ hasWorktree: true, dirty: true });

    await expect(resolveDirtyWorktreeForRemoval('never-prefetched')).resolves.toBe(true);

    expect(mocks.worktreeRemovalPreview).toHaveBeenCalledTimes(1);
  });

  it('routes device-link sessions through the tunnel and degrades to no warning on failure', async () => {
    mocks.deviceLinkInvoke.mockRejectedValue(new Error('tunnel down'));

    await expect(resolveDirtyWorktreeForRemoval('remote-1', 'device-a')).resolves.toBe(false);

    expect(mocks.deviceLinkInvoke).toHaveBeenCalledWith(
      'device-a',
      'worktree:removal-preview',
      ['remote-1'],
    );
    expect(mocks.worktreeRemovalPreview).not.toHaveBeenCalled();
  });
});
