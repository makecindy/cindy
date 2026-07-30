// @vitest-environment jsdom

/**
 * useCCSessions 的 `deferred` 桶：让出首屏，不改语义。
 * ---------------------------------------------------------------------------
 * 回归的是启动首屏被非可见数据挤慢：侧栏挂载时同时有两个 'all' 桶消费者
 * （CCAgentSidebarUpper 的 attention 标记、ConversationSearchProvider 的搜索项目清单），
 * 它们和用户真正在等的 active 列表抢同一个**单线程** DB worker。真实 4.7GB 库上一条
 * sessions:list 冷缓存要秒级，排在前面就等于首屏白等一整条查询。
 *
 * 这里钉三件事：
 *   1. deferred 桶挂载时**不发** IPC，非 deferred 桶照常同步发 —— 顺序必须是对的。
 *   2. deferred 只推迟发起，不改结果：数据到达后照常进 store、照常广播给订阅者。
 *   3. pending 的延迟发起在 unmount 后不再触发。
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/ccAgent.types';

const mocks = vi.hoisted(() => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {},
  });
  return { list: vi.fn() };
});

vi.mock('@/lib/sessionService', () => ({
  list: mocks.list,
  create: vi.fn(),
}));

import { useCCSessions } from '@/hooks/useCCSessions';
import { sessionsStore } from '@/lib/sessionsStore';
import type { ListStatusFilter } from '@/lib/sessionService';

function session(id: string, status: Session['status'] = 'active'): Session {
  return { id, status } as Session;
}

/** 本次 list mock 收到的 filter 参数（sessionService.list(limit, filter)）。 */
function requestedFilters(): ListStatusFilter[] {
  return mocks.list.mock.calls.map((call) => call[1] as ListStatusFilter);
}

describe('useCCSessions deferred bucket', () => {
  beforeEach(() => {
    mocks.list.mockReset();
    mocks.list.mockResolvedValue([session('s1')]);
    sessionsStore.reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    sessionsStore.reset();
  });

  it('does not fire IPC on mount, and fires after idle', async () => {
    renderHook(() => useCCSessions({ includeArchived: 'all', deferred: true }));

    // 挂载这一刻必须干净 —— 这正是首屏要抢回来的时间。
    expect(requestedFilters()).toEqual([]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(requestedFilters()).toEqual(['all']);
  });

  it('keeps the non-deferred bucket synchronous so it wins the worker', async () => {
    renderHook(() => {
      useCCSessions({ includeArchived: 'active' });
      useCCSessions({ includeArchived: 'all', deferred: true });
    });

    // 同一次挂载里：用户在等的 active 已发出，看不见的 all 还没排进去。
    expect(requestedFilters()).toEqual(['active']);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(requestedFilters()).toEqual(['active', 'all']);
  });

  it('still delivers data to subscribers once the deferred fetch lands', async () => {
    mocks.list.mockResolvedValue([session('a'), session('b')]);
    const { result } = renderHook(() =>
      useCCSessions({ includeArchived: 'all', deferred: true }),
    );

    // 延迟期间是「还没加载」，不是「加载完且为空」。
    expect(result.current.sessions).toEqual([]);
    expect(result.current.isLoading).toBe(true);

    // advanceTimersByTimeAsync 会连带 flush microtask，list 的 resolve、store 落桶、
    // 订阅者 setState 都在这次 act 里跑完。不能用 waitFor —— 它按真实时间轮询，在
    // fake timers 下永远等不到，只会把测试挂到超时。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(result.current.sessions.map((s) => s.id)).toEqual(['a', 'b']);
    expect(result.current.isLoading).toBe(false);
  });

  it('cancels the pending deferred fetch on unmount', async () => {
    const { unmount } = renderHook(() =>
      useCCSessions({ includeArchived: 'all', deferred: true }),
    );
    expect(requestedFilters()).toEqual([]);

    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(requestedFilters()).toEqual([]);
  });
});

/**
 * 上面那组跑的是 setTimeout 回退分支（jsdom 不实现 requestIdleCallback），而**生产的
 * Electron renderer 有** requestIdleCallback —— 也就是说线上走的恰好是上面没覆盖的那条。
 * 这组补上它：确认真的用了 idle 调度、带兜底 timeout、且 unmount 会 cancel。
 */
describe('useCCSessions deferred bucket (requestIdleCallback path)', () => {
  let idleCallbacks: Map<number, IdleRequestCallback>;
  let nextHandle: number;

  beforeEach(() => {
    mocks.list.mockReset();
    mocks.list.mockResolvedValue([session('s1')]);
    sessionsStore.reset();
    idleCallbacks = new Map();
    nextHandle = 1;
    Object.defineProperty(window, 'requestIdleCallback', {
      configurable: true,
      writable: true,
      value: vi.fn((cb: IdleRequestCallback) => {
        const handle = nextHandle++;
        idleCallbacks.set(handle, cb);
        return handle;
      }),
    });
    Object.defineProperty(window, 'cancelIdleCallback', {
      configurable: true,
      writable: true,
      value: vi.fn((handle: number) => {
        idleCallbacks.delete(handle);
      }),
    });
  });

  afterEach(() => {
    cleanup();
    sessionsStore.reset();
    delete (window as { requestIdleCallback?: unknown }).requestIdleCallback;
    delete (window as { cancelIdleCallback?: unknown }).cancelIdleCallback;
  });

  function runIdle(): Promise<void> {
    const pending = [...idleCallbacks.values()];
    idleCallbacks.clear();
    return act(async () => {
      for (const cb of pending) {
        cb({ didTimeout: false, timeRemaining: () => 0 });
      }
    });
  }

  it('schedules through requestIdleCallback with a starvation timeout', async () => {
    renderHook(() => useCCSessions({ includeArchived: 'all', deferred: true }));

    expect(requestedFilters()).toEqual([]);
    expect(window.requestIdleCallback).toHaveBeenCalledTimes(1);
    // 必须带 timeout，否则一直繁忙的窗口会把这桶饿死，attention 标记永远不出现。
    expect(window.requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 2000,
    });

    await runIdle();

    expect(requestedFilters()).toEqual(['all']);
  });

  it('cancels the idle handle on unmount', async () => {
    const { unmount } = renderHook(() =>
      useCCSessions({ includeArchived: 'all', deferred: true }),
    );
    unmount();

    expect(window.cancelIdleCallback).toHaveBeenCalledTimes(1);
    await runIdle();
    expect(requestedFilters()).toEqual([]);
  });
});
