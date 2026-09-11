// @vitest-environment jsdom

/**
 * useRemoteClaudeSubscriptionUsage 单测。
 *
 * reduce 纯函数与本机版同一语义;行为用例覆盖两条 review 修复:
 *   - owner 栅栏:owner A 发起的隧道读在切到 owner B 后才 resolve → 整帧丢弃,
 *     module 缓存不得把 A 的余量顶给 B(缓存跨路由重挂载存活,组件卸载挡不住);
 *   - CHANNEL_NOT_ALLOWED 负缓存带 TTL:TTL 内不重复探测,到期后重新探测
 *     (被控端升级后同 deviceId 重连);收到该设备订阅 push 立即解除负缓存。
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setDataOwnerGeneration } from '../contexts/dataOwnerGeneration';
import {
  reduceRemoteClaudeSubscriptionPush,
  resetRemoteClaudeSubscriptionUsageCacheForTest,
  useRemoteClaudeSubscriptionUsage,
} from '../hooks/useRemoteClaudeSubscriptionUsage';

type PushListener = (
  push: { deviceId: string; channel: string; payload: unknown },
  localOwnerStamp?: unknown,
) => void;

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(deviceId: string, channel: string, args: unknown[]) => Promise<unknown>>(),
  pushListeners: [] as PushListener[],
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_788_300_000_000);
  setDataOwnerGeneration('owner-a');
  resetRemoteClaudeSubscriptionUsageCacheForTest();
  mocks.invoke.mockReset();
  mocks.pushListeners.length = 0;
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      deviceLink: {
        invoke: mocks.invoke,
        onRemotePush: (cb: PushListener) => {
          mocks.pushListeners.push(cb);
          return () => {
            const i = mocks.pushListeners.indexOf(cb);
            if (i >= 0) mocks.pushListeners.splice(i, 1);
          };
        },
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('reduceRemoteClaudeSubscriptionPush', () => {
  const current = { fiveHour: { utilization: 10 } };

  it('clears on null broadcasts (controlled device logged out / switched account)', () => {
    expect(reduceRemoteClaudeSubscriptionPush(current, null)).toBeNull();
  });

  it('replaces with pushed snapshots', () => {
    const next = { fiveHour: { utilization: 20 } };
    expect(reduceRemoteClaudeSubscriptionPush(current, next)).toBe(next);
  });

  it('keeps current value on malformed tunnel payloads', () => {
    expect(reduceRemoteClaudeSubscriptionPush(current, undefined)).toBe(current);
    expect(reduceRemoteClaudeSubscriptionPush(current, 'nope')).toBe(current);
    expect(reduceRemoteClaudeSubscriptionPush(current, [1, 2])).toBe(current);
  });
});

describe('owner fence on async backfill', () => {
  it('discards an in-flight invoke result that resolves after an owner switch', async () => {
    const read = deferred<unknown>();
    mocks.invoke.mockReturnValue(read.promise);

    const { result, unmount } = renderHook(() => useRemoteClaudeSubscriptionUsage('device-1'));
    expect(mocks.invoke).toHaveBeenCalledTimes(1);

    // owner A → owner B(路由树重挂载在真实应用里会发生,module 缓存不受影响)。
    setDataOwnerGeneration('owner-b');
    read.resolve({ fiveHour: { utilization: 34 } });
    await flushMicrotasks();

    // 迟到的 A 账号快照必须整帧丢弃:hook 状态与缓存都不得出现该值。
    expect(result.current).toBeNull();
    unmount();
    const { result: remounted } = renderHook(() => useRemoteClaudeSubscriptionUsage('device-1'));
    expect(remounted.current).toBeNull();
  });

  it('drops cached snapshots from a previous owner before seeding a new mount', async () => {
    mocks.invoke.mockResolvedValue({ fiveHour: { utilization: 12 } });
    const { result, unmount } = renderHook(() => useRemoteClaudeSubscriptionUsage('device-1'));
    await flushMicrotasks();
    expect(result.current).toMatchObject({ fiveHour: { utilization: 12 } });
    unmount();

    // 换号后重挂载:上一个账号读到的余量不得作为 seed 顶给新账号。
    setDataOwnerGeneration('owner-b');
    mocks.invoke.mockReturnValue(deferred<unknown>().promise);
    const { result: next } = renderHook(() => useRemoteClaudeSubscriptionUsage('device-1'));
    expect(next.current).toBeNull();
  });
});

describe('CHANNEL_NOT_ALLOWED negative cache', () => {
  const notAllowed = () =>
    Promise.reject(new Error("[DEVICE_LINK_CHANNEL_NOT_ALLOWED] channel not allowed remotely"));

  it('skips re-probing within the TTL and re-probes after it expires', async () => {
    mocks.invoke.mockImplementation(notAllowed);

    const first = renderHook(() => useRemoteClaudeSubscriptionUsage('device-old'));
    await flushMicrotasks();
    first.unmount();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);

    // TTL 内重挂载:不再探测(老被控端保持降级占位,不打无谓隧道请求)。
    const second = renderHook(() => useRemoteClaudeSubscriptionUsage('device-old'));
    await flushMicrotasks();
    second.unmount();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);

    // TTL 过期(被控端可能已升级):重新探测。
    vi.setSystemTime(1_788_300_000_000 + 16 * 60_000);
    const third = renderHook(() => useRemoteClaudeSubscriptionUsage('device-old'));
    await flushMicrotasks();
    third.unmount();
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it('clears the negative cache when a subscription push arrives from that device', async () => {
    mocks.invoke.mockImplementation(notAllowed);
    const { result, unmount } = renderHook(() => useRemoteClaudeSubscriptionUsage('device-old'));
    await flushMicrotasks();

    // 被控端升级后推来订阅快照 = 能力已具备:应用快照并解除负缓存。
    act(() => {
      for (const cb of [...mocks.pushListeners]) {
        cb({
          deviceId: 'device-old',
          channel: 'usage:claude-subscription-changed',
          payload: { fiveHour: { utilization: 8 } },
        });
      }
    });
    expect(result.current).toMatchObject({ fiveHour: { utilization: 8 } });
    unmount();

    mocks.invoke.mockResolvedValue({ fiveHour: { utilization: 9 } });
    const { result: remounted } = renderHook(() => useRemoteClaudeSubscriptionUsage('device-old'));
    await flushMicrotasks();
    // 负缓存已清 → 重新走隧道读。
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(remounted.current).toMatchObject({ fiveHour: { utilization: 9 } });
  });
});
