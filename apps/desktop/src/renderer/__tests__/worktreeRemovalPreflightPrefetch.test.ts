// @vitest-environment jsdom

/**
 * 归档/删除前 worktree 预检的三态语义 + 预取缓存。
 *
 * 两条不变量：
 *   1. **三态**：查询失败必须是 `'unknown'`，不能塌成 `'clean'`。归档改成「干净就免
 *      确认」之后，把失败当干净就等于静默回收可能带着未提交改动的 worktree。
 *   2. **只复用 dirty**：`'clean'` / `'unknown'` 一律在执行前重新查。复用 clean 会让
 *      预取之后被写脏的工作区跳过确认；复用 unknown 只会把保守分支多留 8 秒。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  worktreeRemovalPreview: vi.fn(),
  deviceLinkInvoke: vi.fn(),
}));

import {
  fetchDirtyWorktreeForRemoval,
  prefetchDirtyWorktreeForRemoval,
  resetDirtyWorktreePreflightCache,
  resolveWorktreeRemovalPreflight,
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

describe('worktree removal preflight — three states', () => {
  it('reports unknown (not clean) when the query fails', async () => {
    // 这是关键的安全语义:失败塌成 clean 就会让归档静默放行。
    mocks.worktreeRemovalPreview.mockRejectedValue(new Error('ipc exploded'));

    await expect(resolveWorktreeRemovalPreflight('session-1')).resolves.toBe('unknown');
  });

  it('maps a session without a worktree to clean', async () => {
    mocks.worktreeRemovalPreview.mockResolvedValue({ hasWorktree: false, dirty: false });

    await expect(resolveWorktreeRemovalPreflight('session-1')).resolves.toBe('clean');
  });

  it('maps a dirty worktree to dirty', async () => {
    mocks.worktreeRemovalPreview.mockResolvedValue({ hasWorktree: true, dirty: true });

    await expect(resolveWorktreeRemovalPreflight('session-1')).resolves.toBe('dirty');
  });

  it('keeps the boolean helper false on failure for always-confirm callers', async () => {
    // 批量计数 / doc 模式关闭标签页 / 删除都必然弹确认框,那里 false 只影响
    // 文案是否追加警告,不会变成静默放行。
    mocks.worktreeRemovalPreview.mockRejectedValue(new Error('ipc exploded'));

    await expect(fetchDirtyWorktreeForRemoval('session-1')).resolves.toBe(false);
  });

  it('routes device-link sessions through the tunnel and reports unknown on tunnel failure', async () => {
    mocks.deviceLinkInvoke.mockRejectedValue(new Error('tunnel down'));

    await expect(resolveWorktreeRemovalPreflight('remote-1', 'device-a')).resolves.toBe('unknown');

    expect(mocks.deviceLinkInvoke).toHaveBeenCalledWith(
      'device-a',
      'worktree:removal-preview',
      ['remote-1'],
    );
    expect(mocks.worktreeRemovalPreview).not.toHaveBeenCalled();
  });
});

describe('worktree removal preflight — prefetch cache', () => {
  // prefetch 是 fire-and-forget，测试里用同一入口 await 一次代表「预取已落地」
  // （结论回填发生在内部 then 里，先于测试的 await 执行）。
  const settledPrefetch = (sessionId: string) => resolveWorktreeRemovalPreflight(sessionId);

  it('serves a prefetched dirty result without querying main again', async () => {
    // dirty 复用是安全侧的:最坏只是确认弹窗多出现一次。
    mocks.worktreeRemovalPreview.mockResolvedValue({ hasWorktree: true, dirty: true });

    await settledPrefetch('session-1');
    expect(mocks.worktreeRemovalPreview).toHaveBeenCalledTimes(1);

    await expect(resolveWorktreeRemovalPreflight('session-1')).resolves.toBe('dirty');
    expect(mocks.worktreeRemovalPreview).toHaveBeenCalledTimes(1);
  });

  it('never reuses a clean prefetch — revalidates at execution time', async () => {
    // 归档会顺带回收 worktree。预取到 clean 之后工作区被写脏时,复用旧结论会整个
    // 跳过 dirty 确认,用户拿不到「先提交或取消」的机会(greptile / codex 的 P1)。
    mocks.worktreeRemovalPreview.mockResolvedValue({ hasWorktree: true, dirty: false });
    await settledPrefetch('session-1');
    expect(mocks.worktreeRemovalPreview).toHaveBeenCalledTimes(1);

    mocks.worktreeRemovalPreview.mockResolvedValue({ hasWorktree: true, dirty: true });
    await expect(resolveWorktreeRemovalPreflight('session-1')).resolves.toBe('dirty');

    expect(mocks.worktreeRemovalPreview).toHaveBeenCalledTimes(2);
  });

  it('does not cache unknown — retries instead of pinning the conservative branch', async () => {
    mocks.worktreeRemovalPreview.mockRejectedValueOnce(new Error('transient'));
    await settledPrefetch('session-1');

    mocks.worktreeRemovalPreview.mockResolvedValue({ hasWorktree: false, dirty: false });
    await expect(resolveWorktreeRemovalPreflight('session-1')).resolves.toBe('clean');

    expect(mocks.worktreeRemovalPreview).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a non-dirty result even while the prefetch is still in flight', async () => {
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
    const resolved = resolveWorktreeRemovalPreflight('session-1');
    resolveFirst?.({ hasWorktree: true, dirty: false });

    await expect(resolved).resolves.toBe('dirty');
    expect(mocks.worktreeRemovalPreview).toHaveBeenCalledTimes(2);
  });

  it('keeps buckets per session rather than sharing one result', async () => {
    mocks.worktreeRemovalPreview.mockImplementation((sessionId: string) =>
      Promise.resolve({ hasWorktree: true, dirty: sessionId === 'dirty-one' }),
    );

    await settledPrefetch('dirty-one');
    await settledPrefetch('clean-one');

    await expect(resolveWorktreeRemovalPreflight('dirty-one')).resolves.toBe('dirty');
    await expect(resolveWorktreeRemovalPreflight('clean-one')).resolves.toBe('clean');
  });

  it('re-queries once the prefetched dirty result has gone stale', async () => {
    mocks.worktreeRemovalPreview.mockResolvedValue({ hasWorktree: true, dirty: true });

    await settledPrefetch('session-1');
    await resolveWorktreeRemovalPreflight('session-1');
    expect(mocks.worktreeRemovalPreview).toHaveBeenCalledTimes(1);

    // TTL 是 8s：略长于行内 Confirm 胶囊 4s 的自动撤回窗口。只对 dirty 结论生效 ——
    // clean / unknown 从不复用，所以不存在「过期结论被用来放行归档」。
    vi.advanceTimersByTime(8_001);
    mocks.worktreeRemovalPreview.mockResolvedValue({ hasWorktree: true, dirty: false });
    await expect(resolveWorktreeRemovalPreflight('session-1')).resolves.toBe('clean');

    expect(mocks.worktreeRemovalPreview).toHaveBeenCalledTimes(2);
  });

  it('resolves without a prefetch by querying directly', async () => {
    mocks.worktreeRemovalPreview.mockResolvedValue({ hasWorktree: true, dirty: true });

    await expect(resolveWorktreeRemovalPreflight('never-prefetched')).resolves.toBe('dirty');

    expect(mocks.worktreeRemovalPreview).toHaveBeenCalledTimes(1);
  });
});
