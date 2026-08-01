// @vitest-environment jsdom

/**
 * useModelDiscoveryPending 的并发语义锁。
 *
 * 回归的是「模型发现完全静默」：打开选择器会触发一次发现，而 ChatGPT 订阅那条要起 codex
 * app-server 再 RPC 列模型（秒级到十几秒）。以前没有任何提示，列表在用户看完关掉之后才更新，
 * 于是「只能看到少数模型，进一次设置页再回来就全了」——用户以为是设置页刷新的功劳。
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  useModelDiscoveryPending,
  type ModelDiscoveryPending,
} from '@/components/new-chat/useModelDiscoveryPending';

function deferred(): { promise: Promise<void>; resolve(): void; reject(e: unknown): void } {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** 把 hook 暴露给测试体，避免为它写一个只有 render 的壳组件。 */
function mount(): { current: ModelDiscoveryPending } {
  const ref = { current: null as unknown as ModelDiscoveryPending };
  function Probe(): null {
    ref.current = useModelDiscoveryPending();
    return null;
  }
  render(<Probe />);
  return ref;
}

afterEach(() => {
  cleanup();
});

describe('useModelDiscoveryPending', () => {
  it('begin 进入 pending，完成后收起', async () => {
    const hook = mount();
    expect(hook.current.pending).toBe(false);

    const flight = deferred();
    act(() => {
      hook.current.begin(() => flight.promise);
    });
    expect(hook.current.pending).toBe(true);

    await act(async () => {
      flight.resolve();
      await flight.promise;
    });
    expect(hook.current.pending).toBe(false);
  });

  it('发现失败也收起状态行（失败归因另有通道，不在这行讲）', async () => {
    const hook = mount();
    const flight = deferred();
    act(() => {
      hook.current.begin(() => flight.promise);
    });

    await act(async () => {
      flight.reject(new Error('app-server spawn failed'));
      await flight.promise.catch(() => undefined);
    });
    expect(hook.current.pending).toBe(false);
  });

  it('run 同步抛出时也不会卡在 pending', async () => {
    const hook = mount();
    await act(async () => {
      hook.current.begin(() => {
        throw new Error('ipc bridge missing');
      });
    });
    expect(hook.current.pending).toBe(false);
  });

  it('同步发起 run —— 打开面板那一刻就该发出请求，不推迟到微任务', () => {
    // 回归实测：早先实现走 Promise.resolve().then(run)，于是「打开选择器触发一次刷新」
    // 变成异步，调用方在同一个事件循环里观察不到那次请求。
    const hook = mount();
    const run = vi.fn(async () => undefined);
    act(() => {
      hook.current.begin(run);
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it('先发起的那次回来不会清掉后发起的状态', async () => {
    // 快速开关几次时最容易踩：first 比 second 晚 resolve 或早 resolve 都不能把 second 的
    // 状态行提前收起，否则用户看到「转了一下就没了，但清单还是旧的」。
    const hook = mount();
    const first = deferred();
    const second = deferred();

    act(() => {
      hook.current.begin(() => first.promise);
    });
    act(() => {
      hook.current.begin(() => second.promise);
    });
    expect(hook.current.pending).toBe(true);

    await act(async () => {
      first.resolve();
      await first.promise;
    });
    // second 还在途 —— 必须仍是 pending。
    expect(hook.current.pending).toBe(true);

    await act(async () => {
      second.resolve();
      await second.promise;
    });
    expect(hook.current.pending).toBe(false);
  });

  it('reset 立即收起，但不夺走在途请求的归属', async () => {
    // 关闭面板要立刻收起状态行；随后重新打开发起的新一轮，绝不能被上一轮的迟到回调清掉。
    const hook = mount();
    const stale = deferred();
    act(() => {
      hook.current.begin(() => stale.promise);
    });
    act(() => {
      hook.current.reset();
    });
    expect(hook.current.pending).toBe(false);

    const fresh = deferred();
    act(() => {
      hook.current.begin(() => fresh.promise);
    });
    expect(hook.current.pending).toBe(true);

    // 上一轮迟到落地 —— 它的 requestId 已经不是最新，必须无声无息。
    await act(async () => {
      stale.resolve();
      await stale.promise;
    });
    expect(hook.current.pending).toBe(true);

    await act(async () => {
      fresh.resolve();
      await fresh.promise;
    });
    expect(hook.current.pending).toBe(false);
  });

  it('begin 的身份稳定，可安全进 useCallback 依赖', () => {
    // ModelSelector / ScheduleChips 都把它放进 handleOpenChange 的依赖里；
    // 每次渲染换新函数会让那个 callback 跟着抖，白白重建 Popover 回调。
    const seen: ModelDiscoveryPending[] = [];
    function Probe(): null {
      seen.push(useModelDiscoveryPending());
      return null;
    }
    const { rerender } = render(<Probe />);
    rerender(<Probe />);

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[1].begin).toBe(seen[0].begin);
    expect(seen[1].reset).toBe(seen[0].reset);
  });
});
