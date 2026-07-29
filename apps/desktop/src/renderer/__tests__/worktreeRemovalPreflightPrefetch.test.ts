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
  it('serves the prefetched result without querying main again', async () => {
    mocks.worktreeRemovalPreview.mockResolvedValue({ hasWorktree: true, dirty: true });

    prefetchDirtyWorktreeForRemoval('session-1');
    await expect(resolveDirtyWorktreeForRemoval('session-1')).resolves.toBe(true);

    expect(mocks.worktreeRemovalPreview).toHaveBeenCalledTimes(1);
  });

  it('dedupes repeated prefetches for the same session', async () => {
    mocks.worktreeRemovalPreview.mockResolvedValue({ hasWorktree: false, dirty: false });

    prefetchDirtyWorktreeForRemoval('session-1');
    prefetchDirtyWorktreeForRemoval('session-1');
    prefetchDirtyWorktreeForRemoval('session-1');
    await resolveDirtyWorktreeForRemoval('session-1');

    expect(mocks.worktreeRemovalPreview).toHaveBeenCalledTimes(1);
  });

  it('keeps buckets per session rather than sharing one result', async () => {
    mocks.worktreeRemovalPreview.mockImplementation((sessionId: string) =>
      Promise.resolve({ hasWorktree: true, dirty: sessionId === 'dirty-one' }),
    );

    prefetchDirtyWorktreeForRemoval('dirty-one');
    prefetchDirtyWorktreeForRemoval('clean-one');

    await expect(resolveDirtyWorktreeForRemoval('dirty-one')).resolves.toBe(true);
    await expect(resolveDirtyWorktreeForRemoval('clean-one')).resolves.toBe(false);
  });

  it('re-queries once the prefetch has gone stale', async () => {
    mocks.worktreeRemovalPreview.mockResolvedValue({ hasWorktree: true, dirty: true });

    prefetchDirtyWorktreeForRemoval('session-1');
    await resolveDirtyWorktreeForRemoval('session-1');
    expect(mocks.worktreeRemovalPreview).toHaveBeenCalledTimes(1);

    // TTL 是 8s：略长于行内 Confirm 胶囊 4s 的自动撤回窗口，又不会把
    // 「用户刚提交完改动」的旧结论留太久。
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
