// @vitest-environment jsdom

/**
 * useRemoteDeviceUsage / remoteDeviceUsageMirror / useRemoteClaudeSessionRoute 单测。
 *
 * 镜像工厂与 useRemoteClaudeSubscriptionUsage 同语义(owner 栅栏 / CHANNEL_NOT_ALLOWED
 * TTL 已在该 hook 的测试覆盖同款路径),这里覆盖:
 *   - 工厂 push 整帧替换 / null 清空 / invokeArgs 透传 / push-only 镜像不发 invoke;
 *   - selectRemoteCodexAccountUsage 的选槽 / 选桶口径(与本机 useAccountUsage 一致:
 *     bridge → web 槽;app-server 按模型匹配桶,匹配不到不显示;空桶表回退顶层);
 *   - 路由镜像的观察值应用与 push 更新(按 deviceId+sessionId 过滤)。
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setDataOwnerGeneration } from '../contexts/dataOwnerGeneration';
import { createRemoteDeviceUsageMirror } from '../hooks/remoteDeviceUsageMirror';
import {
  selectRemoteCodexAccountUsage,
  useRemoteCodexAccountUsage,
  useRemoteCodexRefreshState,
  requestRemoteCodexLiveRefresh,
  useRemoteCodexRateLimits,
  requestRemoteCodexRateLimitsRefresh,
  useRemoteClaudeAccountUsage,
  useRemoteXaiRateLimit,
  resetRemoteDeviceUsageMirrorsForTest,
} from '../hooks/useRemoteDeviceUsage';
import {
  resetRemoteClaudeSessionRouteCacheForTest,
  useRemoteClaudeSessionRoute,
} from '../hooks/useRemoteClaudeSessionRoute';

type PushListener = (
  push: { deviceId: string; channel: string; payload: unknown },
  localOwnerStamp?: unknown,
) => void;

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(deviceId: string, channel: string, args: unknown[]) => Promise<unknown>>(),
  pushListeners: [] as PushListener[],
  reopenedListeners: [] as Array<(value: { deviceId: string }) => void>,
  peerResetListeners: [] as Array<(value: { deviceId: string }) => void>,
  statusListeners: [] as Array<(value: { status: 'online' | 'connecting' | 'stopped' }) => void>,
  presenceListeners: [] as Array<(value: { deviceId: string; online: boolean }) => void>,
}));

function emitPush(push: { deviceId: string; channel: string; payload: unknown }): void {
  for (const cb of [...mocks.pushListeners]) cb(push);
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
  resetRemoteDeviceUsageMirrorsForTest();
  resetRemoteClaudeSessionRouteCacheForTest();
  mocks.invoke.mockReset();
  mocks.pushListeners.length = 0;
  mocks.presenceListeners.length = 0;
  mocks.statusListeners.length = 0;
  mocks.peerResetListeners.length = 0;
  mocks.reopenedListeners.length = 0;
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      deviceLink: {
        invoke: mocks.invoke,
        onPeerLinkReopened: (listener: (value: { deviceId: string }) => void) => {
          mocks.reopenedListeners.push(listener);
          return () => { mocks.reopenedListeners = mocks.reopenedListeners.filter(item => item !== listener); };
        },
        onPeerLinkReset: (listener: (value: { deviceId: string }) => void) => {
          mocks.peerResetListeners.push(listener);
          return () => { mocks.peerResetListeners = mocks.peerResetListeners.filter(item => item !== listener); };
        },
        onPresenceChanged: (listener: (value: { deviceId: string; online: boolean }) => void) => {
          mocks.presenceListeners.push(listener);
          return () => { mocks.presenceListeners = mocks.presenceListeners.filter(item => item !== listener); };
        },
        onStatusChanged: (listener: (value: { status: 'online' | 'connecting' | 'stopped' }) => void) => {
          mocks.statusListeners.push(listener);
          return () => { mocks.statusListeners = mocks.statusListeners.filter(item => item !== listener); };
        },
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

// PR #11105 r4609961173, unit: a mounted task must not repeatedly invoke the
// write-through native quota RPC. Existing polling tests cover Settings only.
// Advance three minutes with a passive task, then attach/remove Settings and
// explicitly refresh: shared values must update without a task-owned timer.
it('shares native quota without polling from passive task consumers', async () => {
  const response = (usedPercent: number) => ({ providerId: 'openai', account: { planType: 'pro' },
    rateLimits: { secondary: { usedPercent, windowMinutes: 10080 } } });
  mocks.invoke.mockResolvedValue(response(4));
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  const task = renderHook(() => useRemoteCodexAccountUsage('mini', 'openai', { live: true, poll: false }));
  expect(mocks.invoke).not.toHaveBeenCalled();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await flushMicrotasks();
  await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(task.result.current?.secondary?.usedPercent).toBe(4);
  mocks.invoke.mockResolvedValue(response(22));
  const settings = renderHook(() => useRemoteCodexAccountUsage('mini', 'openai', { live: true }));
  await flushMicrotasks();
  expect(task.result.current?.secondary?.usedPercent).toBe(22);
  mocks.invoke.mockResolvedValue(response(30));
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(mocks.invoke).toHaveBeenCalledTimes(3);
  expect(task.result.current?.secondary?.usedPercent).toBe(30);
  settings.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
  expect(mocks.invoke).toHaveBeenCalledTimes(3);
  mocks.invoke.mockResolvedValue(response(42));
  act(() => requestRemoteCodexLiveRefresh('mini', 'openai'));
  await flushMicrotasks();
  expect(mocks.invoke).toHaveBeenCalledTimes(4);
  expect(task.result.current?.secondary?.usedPercent).toBe(42);
});

// Issue #11093, unit: real shared reader, with two visible consumers and an old
// fallback. Existing mirror tests did not cover opening a mounted native reader,
// its failure indicator, or value/time consistency after recovery.
it('calibrates shared remote quota on opening and keeps retained observation times honest', async () => {
  const oldTime = Date.now() - 86_400_000;
  const old = { secondary: { usedPercent: 4, windowMinutes: 10080 }, updatedAt: oldTime };
  mocks.invoke.mockImplementation(async (_device, channel) => {
    if (channel === 'maker:usage:codex-rate-limits') throw new Error('offline');
    return old;
  });
  const first = renderHook(() => ({
    quota: useRemoteCodexAccountUsage('mini', 'openai', { live: true }),
    state: useRemoteCodexRefreshState('mini', 'openai'),
  }));
  const second = renderHook(() => useRemoteCodexAccountUsage('mini', 'openai', { live: true }));
  await flushMicrotasks();
  expect(mocks.invoke).toHaveBeenCalledTimes(2); // one native read + one fallback, shared
  expect(first.result.current.quota?.updatedAt).toBe(oldTime);
  expect(first.result.current.state.failed).toBe(true);
  expect(second.result.current).toBe(first.result.current.quota);
  await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
  mocks.invoke.mockResolvedValue({ account: { planType: 'pro' }, providerId: 'openai',
    rateLimits: { secondary: { usedPercent: 22, windowMinutes: 10080 } } });
  act(() => { requestRemoteCodexLiveRefresh('mini', 'openai'); requestRemoteCodexLiveRefresh('mini', 'openai'); });
  await flushMicrotasks();
  expect(mocks.invoke).toHaveBeenCalledTimes(3);
  const selected = selectRemoteCodexAccountUsage(first.result.current.quota, 'app-server');
  expect(selected?.secondary?.usedPercent).toBe(22);
  expect(selected?.updatedAt).toBe(Date.now());
  expect(first.result.current.state).toEqual({ failed: false, refreshing: false });
  expect(second.result.current).toBe(first.result.current.quota);
});

it('backs off failed remote quota reads and recovers only the visible target', async () => {
  mocks.invoke.mockRejectedValue(new Error('offline'));
  const first = renderHook(() => ({ quota: useRemoteCodexAccountUsage('mini', 'openai', { live: true }),
    state: useRemoteCodexRefreshState('mini', 'openai') }));
  await flushMicrotasks();
  expect(first.result.current.state.failed).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  expect(mocks.invoke).toHaveBeenCalledTimes(4); // next attempt at 60s; then a 120s backoff
  act(() => mocks.reopenedListeners.forEach(cb => cb({ deviceId: 'other' })));
  expect(mocks.invoke).toHaveBeenCalledTimes(4);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  act(() => mocks.reopenedListeners.forEach(cb => cb({ deviceId: 'mini' })));
  expect(mocks.invoke).toHaveBeenCalledTimes(4);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  mocks.invoke.mockResolvedValue(null);
  act(() => mocks.reopenedListeners.forEach(cb => cb({ deviceId: 'mini' })));
  await flushMicrotasks();
  expect(first.result.current).toEqual({ quota: null, state: { failed: false, refreshing: false } });
});

// PR #11105 r4599742041, unit: the existing hidden-reconnect case did not cover
// hiding AFTER recovery queued behind a slow native read. No hidden RPC should
// start; restoring visibility consumes the queued recovery and updates the quota.
it.each([true, false])('defers queued quota recovery until visible with polling=%s', async poll => {
  let finish!: (value: unknown) => void;
  mocks.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = renderHook(() => useRemoteCodexAccountUsage('mini', 'openai', { live: true, poll }));
  act(() => mocks.reopenedListeners.forEach(cb => cb({ deviceId: 'mini' })));
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
  const response = (usedPercent: number) => ({ account: { planType: 'pro' }, providerId: 'openai',
    rateLimits: { secondary: { usedPercent, windowMinutes: 10080 } } });
  mocks.invoke.mockResolvedValue(response(22));
  act(() => finish(response(4)));
  await flushMicrotasks();
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(view.result.current?.secondary?.usedPercent).toBe(4);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await flushMicrotasks();
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
  expect(view.result.current?.secondary?.usedPercent).toBe(22);
});

// Unit r4389934308: a live card's owned recovery queue must be discarded by
// identity clear or owner change even while another ordinary subscriber remains.
// Previous owner/push tests did not contain a queued live observation-gap read.
it.each(['clear', 'owner'] as const)('invalidates a queued live mirror reread after %s', async stop => {
  const mirror = createRemoteDeviceUsageMirror<{ remaining: number }>({ invokeChannel: 'usage:test', pushChannel: 'usage:test-changed' });
  let resolve!: (value: { remaining: number }) => void;
  mocks.invoke.mockImplementation(() => new Promise(done => { resolve = done; }));
  const other = renderHook(() => mirror.useMirror('mini'));
  const live = renderHook(({ active }) => mirror.useMirror(active ? 'mini' : null, undefined, { live: true }),
    { initialProps: { active: true } });
  live.rerender({ active: false });
  live.rerender({ active: true });
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  if (stop === 'clear') act(() => emitPush({ deviceId: 'mini', channel: 'usage:test-changed', payload: null }));
  else act(() => setDataOwnerGeneration('owner-b'));
  await act(async () => resolve({ remaining: 82 }));
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(other.result.current).toBeNull();
});

describe('createRemoteDeviceUsageMirror', () => {
  it('push 整帧替换、null 清空,push-only 镜像不发 invoke', async () => {
    const pushOnly = createRemoteDeviceUsageMirror<{ v?: number }>({
      invokeChannel: null,
      pushChannel: 'test:push-only-changed',
    });
    const { result } = renderHook(() => pushOnly.useMirror('device-1'));
    await flushMicrotasks();
    expect(mocks.invoke).not.toHaveBeenCalled();

    act(() => emitPush({ deviceId: 'device-1', channel: 'test:push-only-changed', payload: { v: 1 } }));
    expect(result.current).toEqual({ v: 1 });
    act(() => emitPush({ deviceId: 'device-1', channel: 'test:push-only-changed', payload: null }));
    expect(result.current).toBeNull();
    // 异常形状保留现值。
    act(() => emitPush({ deviceId: 'device-1', channel: 'test:push-only-changed', payload: { v: 2 } }));
    act(() => emitPush({ deviceId: 'device-1', channel: 'test:push-only-changed', payload: 'junk' }));
    expect(result.current).toEqual({ v: 2 });
    pushOnly.resetForTest();
  });

  it('useRemoteCodexAccountUsage 经 maker:usage:account 携带 agentKind 参数', async () => {
    mocks.invoke.mockResolvedValue({ primary: { usedPercent: 3 } });
    const { result } = renderHook(() => useRemoteCodexAccountUsage('device-1'));
    await flushMicrotasks();
    expect(mocks.invoke).toHaveBeenCalledWith('device-1', 'maker:usage:account', ['codex', 'openai', 'default-subscription-account']);
    expect(result.current).toMatchObject({ primary: { usedPercent: 3 } });
  });

  it('shares one device read between concurrent consumers of the same account', async () => {
    mocks.invoke.mockImplementation(async (_deviceId, _channel, args) => ({
      providerId: args[1],
      primary: { usedPercent: 3 },
    }));
    const chip = renderHook(() => useRemoteCodexAccountUsage('device-1', 'account-2'));
    await flushMicrotasks();
    // A second consumer (model picker) mounting beside a live consumer reuses its fresh snapshot.
    vi.advanceTimersByTime(59_000);
    const picker = renderHook(() => useRemoteCodexAccountUsage('device-1', 'account-2'));
    await flushMicrotasks();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(picker.result.current).toMatchObject({ primary: { usedPercent: 3 } });

    act(() =>
      emitPush({
        deviceId: 'device-1',
        channel: 'usage:codex-provider-account-changed',
        payload: { providerId: 'account-2', snapshot: { primary: { usedPercent: 7 } } },
      }),
    );
    expect(chip.result.current).toMatchObject({ primary: { usedPercent: 7 } });
    expect(picker.result.current).toMatchObject({ primary: { usedPercent: 7 } });
    // Other accounts on the same device keep their own entry and read.
    renderHook(() => useRemoteCodexAccountUsage('device-1', 'account-3'));
    await flushMicrotasks();
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it('re-reads beside a live consumer once its snapshot is older than the reuse window', async () => {
    // Pushes are lost while the link is down; a long-lived chip must not pin a stale snapshot.
    mocks.invoke.mockResolvedValue({ primary: { usedPercent: 3 } });
    renderHook(() => useRemoteCodexAccountUsage('device-1'));
    await flushMicrotasks();
    vi.advanceTimersByTime(61_000);
    mocks.invoke.mockResolvedValue({ primary: { usedPercent: 9 } });
    const picker = renderHook(() => useRemoteCodexAccountUsage('device-1'));
    await flushMicrotasks();
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(picker.result.current).toMatchObject({ primary: { usedPercent: 9 } });
  });

  it('always re-reads on mount when no consumer was listening for pushes', async () => {
    // A logout/account-switch clear pushed while nobody listened must not leave the old quota.
    mocks.invoke.mockResolvedValue({ primary: { usedPercent: 3 } });
    renderHook(() => useRemoteCodexAccountUsage('device-1')).unmount();
    await flushMicrotasks();
    mocks.invoke.mockResolvedValue(null);
    const reopened = renderHook(() => useRemoteCodexAccountUsage('device-1'));
    await flushMicrotasks();
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(reopened.result.current).toBeNull();
  });

  it('keeps retrying mounts after a failed read', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('offline'));
    const first = renderHook(() => useRemoteCodexAccountUsage('device-1'));
    await flushMicrotasks();
    first.unmount();
    mocks.invoke.mockResolvedValue({ primary: { usedPercent: 3 } });
    const second = renderHook(() => useRemoteCodexAccountUsage('device-1'));
    await flushMicrotasks();
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(second.result.current).toMatchObject({ primary: { usedPercent: 3 } });
  });
});

// Unit regression (provider-groups.md §10): native quota has a richer RPC result
// than the account push. Existing mirror tests do not cover those different shapes.
// Minimal inputs: two cards share one pending native read; a clear arrives before it settles.
// Single-file command wall time: 2.54s (2026-10-22).
describe('remote native Codex quota', () => {
  // Unit, #11329: the two production quota views previously shared only within
  // their own mirrors. A slow group card and a live task for the same account
  // must share the actual native RPC, while another peer remains independent.
  it('shares a pending native RPC across group cards and live task quota views', async () => {
    let finish!: (value: unknown) => void;
    mocks.invoke.mockImplementation((device) => device === 'slow'
      ? new Promise(resolve => { finish = resolve; })
      : Promise.resolve({ providerId: 'openai', account: { planType: 'pro' },
        rateLimits: { primary: { usedPercent: 12 } } }));
    const group = renderHook(() => useRemoteCodexRateLimits('slow', 'openai'));
    const task = renderHook(() => useRemoteCodexAccountUsage('slow', 'openai', { live: true, poll: false }));
    const healthy = renderHook(() => useRemoteCodexAccountUsage('healthy', 'openai', { live: true, poll: false }));
    await flushMicrotasks();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(mocks.invoke.mock.calls.filter(([device]) => device === 'slow')).toHaveLength(1);
    expect(healthy.result.current?.primary?.usedPercent).toBe(12);
    await act(async () => finish({ providerId: 'openai', account: { planType: 'pro' },
      rateLimits: { primary: { usedPercent: 34 } } }));
    expect(group.result.current?.rateLimits.primary?.usedPercent).toBe(34);
    expect(task.result.current?.primary?.usedPercent).toBe(34);
  });

  // Unit, #11329: cross-view sharing must not lend a pre-clear/pre-owner RPC
  // to a new observation. Existing clear tests exercise only one mirror.
  it.each([
    { boundary: 'clear', providerId: 'openai' },
    { boundary: 'clear', providerId: 'openai-extra' },
    { boundary: 'owner', providerId: 'openai' },
  ])('separates a new $providerId quota observation after $boundary', async ({ boundary, providerId }) => {
    const finishes: Array<(value: unknown) => void> = [];
    mocks.invoke.mockImplementation(() => new Promise(resolve => { finishes.push(resolve); }));
    const old = renderHook(() => useRemoteCodexRateLimits('mini', providerId));
    if (boundary === 'clear') act(() => emitPush(providerId === 'openai'
      ? { deviceId: 'mini', channel: 'usage:codex-account-changed', payload: null }
      : { deviceId: 'mini', channel: 'usage:codex-provider-account-changed', payload: { providerId, snapshot: null } }));
    else act(() => { setDataOwnerGeneration('owner-b'); setDataOwnerGeneration('owner-a'); });
    const current = renderHook(() => useRemoteCodexAccountUsage('mini', providerId, { live: true, poll: false }));
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    const response = (usedPercent: number) => ({ providerId, account: { planType: 'pro' },
      rateLimits: { primary: { usedPercent } } });
    await act(async () => finishes[0](response(90)));
    expect(old.result.current).toBeNull();
    expect(current.result.current).toBeNull();
    // Finishing the retired read cannot evict the newer in-flight request.
    act(() => requestRemoteCodexLiveRefresh('mini', providerId));
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    await act(async () => finishes[1](response(15)));
    expect(current.result.current?.primary?.usedPercent).toBe(15);
  });

  // Unit, #11329: an unsupported shared native RPC still permits the existing
  // task-only legacy fallback; sharing its failure must not create extra retries.
  it('settles a shared native failure and preserves the legacy snapshot fallback', async () => {
    let fail!: (error: unknown) => void;
    const old = { primary: { usedPercent: 7 }, updatedAt: Date.now() - 60_000 };
    mocks.invoke.mockImplementation((_device, channel) => channel === 'maker:usage:codex-rate-limits'
      ? new Promise((_resolve, reject) => { fail = reject; }) : Promise.resolve(old));
    const group = renderHook(() => useRemoteCodexRateLimits('mini', 'openai'));
    const task = renderHook(() => useRemoteCodexAccountUsage('mini', 'openai', { live: true, poll: false }));
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    await act(async () => fail(new Error('[CHANNEL_NOT_ALLOWED] old host')));
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(mocks.invoke).toHaveBeenLastCalledWith('mini', 'maker:usage:account', ['codex', 'openai', 'default-subscription-account']);
    expect(group.result.current).toBeNull();
    expect(task.result.current).toEqual({ ...old, refreshFailed: true });
  });

  it('shares native reads, ignores read-generated usage pushes, and fences late reads after a clear', async () => {
    let resolve!: (value: unknown) => void;
    mocks.invoke.mockImplementation(() => new Promise(done => { resolve = done; }));
    const first = renderHook(() => useRemoteCodexRateLimits('device-1', 'openai-extra'));
    const second = renderHook(() => useRemoteCodexRateLimits('device-1', 'openai-extra'));
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith('device-1', 'maker:usage:codex-rate-limits', ['openai-extra']);
    const native = { providerId: 'openai-extra', account: { planType: 'plus' }, rateLimits: { primary: { usedPercent: 73 } } };
    await act(async () => resolve(native));
    expect(first.result.current).toEqual(native);
    expect(second.result.current).toEqual(native);
    act(() => emitPush({ deviceId: 'device-1', channel: 'usage:codex-provider-account-changed',
      payload: { providerId: 'openai-extra', snapshot: { primary: { usedPercent: 74 } } } }));
    expect(first.result.current).toEqual(native);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);

    act(() => requestRemoteCodexRateLimitsRefresh('device-1', 'openai-extra'));
    act(() => emitPush({ deviceId: 'device-1', channel: 'usage:codex-provider-account-changed',
      payload: { providerId: 'openai-extra', snapshot: null } }));
    await act(async () => resolve(native));
    expect(first.result.current).toBeNull();
    expect(second.result.current).toBeNull();
  });

  it('invalidates cached native quota when a reread cannot establish the named account', async () => {
    // PR #6752 r4344811616: a rejected/malformed/cleared native reread must not
    // leave an earlier account cached. Existing coverage started from null.
    const native = { providerId: 'openai-extra', account: { planType: 'plus' }, rateLimits: { primary: { usedPercent: 73 } } };
    mocks.invoke.mockResolvedValue(native);
    const hook = renderHook(() => useRemoteCodexRateLimits('device-1', 'openai-extra'));
    await flushMicrotasks();
    for (const invalid of [
      { account: { planType: 'plus' }, rateLimits: { primary: { usedPercent: 9 } } },
      { providerId: 'openai-extra', account: null, rateLimits: {} },
      null,
    ]) {
      mocks.invoke.mockResolvedValue(native);
      act(() => requestRemoteCodexRateLimitsRefresh('device-1', 'openai-extra'));
      await flushMicrotasks();
      expect(hook.result.current).toEqual(native);
      mocks.invoke.mockResolvedValue(invalid);
      act(() => requestRemoteCodexRateLimitsRefresh('device-1', 'openai-extra'));
      await flushMicrotasks();
      expect(hook.result.current).toBeNull();
    }
  });
});

describe('selectRemoteCodexAccountUsage', () => {
  const bucketA = {
    limitId: 'codex',
    primary: { usedPercent: 12, windowMinutes: 300 },
  };
  const bucketSpark = {
    limitId: 'codex_bengalfox',
    limitName: 'GPT-5.3-Codex-Spark',
    primary: { usedPercent: 1, windowMinutes: 11_520 },
  };

  it('bridge 形态取 web 槽', () => {
    const web = { source: 'openai-web', primary: { usedPercent: 9 } };
    expect(
      selectRemoteCodexAccountUsage(
        { webSnapshot: web, appServerBuckets: { codex: bucketA } },
        'openai-web',
        'chatgpt/gpt-5.6',
      ),
    ).toMatchObject({ primary: { usedPercent: 9 } });
  });

  it('app-server 形态按模型匹配桶,通用模型不显示模型专属促销桶', () => {
    const selected = selectRemoteCodexAccountUsage(
      {
        ...bucketA,
        webSnapshot: null,
        appServerBuckets: { codex: bucketA, codex_bengalfox: bucketSpark },
      },
      'app-server',
      'gpt-5.6-sol',
    );
    expect(selected?.limitId).toBe('codex');
  });

  it('桶表为空(旧被控端)回退顶层兼容位;payload 为 null 返回 null', () => {
    expect(
      selectRemoteCodexAccountUsage(
        { ...bucketA, webSnapshot: null, appServerBuckets: null },
        'app-server',
        'gpt-5.6-sol',
      )?.primary?.usedPercent,
    ).toBe(12);
    expect(selectRemoteCodexAccountUsage(null, 'app-server', 'gpt-5.6-sol')).toBeNull();
  });
});

describe('useRemoteClaudeSessionRoute', () => {
  it('应用被控端观察值,并按 deviceId+sessionId 过滤 push 更新', async () => {
    mocks.invoke.mockResolvedValue(null);
    const { result } = renderHook(() => useRemoteClaudeSessionRoute('device-1', 'sess-1'));
    await flushMicrotasks();
    expect(mocks.invoke).toHaveBeenCalledWith('device-1', 'maker:claude-session-route:get', ['sess-1']);
    expect(result.current).toBeNull();

    // 其它会话 / 其它设备的 push 不影响本会话。
    act(() => emitPush({
      deviceId: 'device-1',
      channel: 'maker:claude-session-route-changed',
      payload: { sessionId: 'sess-other', route: 'gateway' },
    }));
    expect(result.current).toBeNull();

    act(() => emitPush({
      deviceId: 'device-1',
      channel: 'maker:claude-session-route-changed',
      payload: { sessionId: 'sess-1', route: 'subscription' },
    }));
    expect(result.current).toBe('subscription');
  });

  it('warm-start 观察值直接生效', async () => {
    mocks.invoke.mockResolvedValue('gateway');
    const { result } = renderHook(() => useRemoteClaudeSessionRoute('device-1', 'sess-2'));
    await flushMicrotasks();
    expect(result.current).toBe('gateway');
  });

  // MagicLizi P1 (#3789): a warm-start GET that resolves after a newer push must not win.
  it.each([null, 'gateway'])('迟到的 warm-start GET(%s)不覆盖在途期间到达的 push', async (late) => {
    let resolveGet: (v: unknown) => void = () => {};
    mocks.invoke.mockImplementation(() => new Promise((resolve) => { resolveGet = resolve; }));
    const { result } = renderHook(() => useRemoteClaudeSessionRoute('device-1', 'sess-3'));
    await flushMicrotasks();
    expect(result.current).toBeNull();
    act(() => emitPush({
      deviceId: 'device-1',
      channel: 'maker:claude-session-route-changed',
      payload: { sessionId: 'sess-3', route: 'subscription' },
    }));
    expect(result.current).toBe('subscription');
    await act(async () => { resolveGet(late); await flushMicrotasks(); });
    expect(result.current).toBe('subscription');
  });

  it('无 push 时 warm-start GET 正常生效(revision 未变)', async () => {
    let resolveGet: (v: unknown) => void = () => {};
    mocks.invoke.mockImplementation(() => new Promise((resolve) => { resolveGet = resolve; }));
    const { result } = renderHook(() => useRemoteClaudeSessionRoute('device-1', 'sess-4'));
    await flushMicrotasks();
    await act(async () => { resolveGet('gateway'); await flushMicrotasks(); });
    expect(result.current).toBe('gateway');
  });
});


describe('remote account parity', () => {
  it('keeps builtin and named provider reads, pushes and clears separate on one device', async () => {
    mocks.invoke.mockImplementation(async (_device, _channel, args) => args[1] && args[1] !== 'openai'
      ? { providerId: args[1], primary: { usedPercent: 70 } }
      : { primary: { usedPercent: 10 } });
    const builtin = renderHook(() => useRemoteCodexAccountUsage('device-1'));
    const named = renderHook(() => useRemoteCodexAccountUsage('device-1', 'account-2'));
    await flushMicrotasks();
    expect(mocks.invoke).toHaveBeenCalledWith('device-1', 'maker:usage:account', ['codex', 'account-2']);
    expect(builtin.result.current?.primary?.usedPercent).toBe(10);
    expect(named.result.current?.primary?.usedPercent).toBe(70);
    act(() => emitPush({ deviceId: 'device-1', channel: 'usage:codex-provider-account-changed',
      payload: { providerId: 'account-2', snapshot: { primary: { usedPercent: 80 } } } }));
    expect(named.result.current?.primary?.usedPercent).toBe(80);
    expect(builtin.result.current?.primary?.usedPercent).toBe(10);
    act(() => emitPush({ deviceId: 'device-1', channel: 'usage:codex-account-changed', payload: null }));
    expect(builtin.result.current).toBeNull();
    expect(named.result.current?.primary?.usedPercent).toBe(80);
    act(() => emitPush({ deviceId: 'device-1', channel: 'usage:codex-provider-account-changed',
      payload: { providerId: 'account-2', snapshot: null } }));
    expect(named.result.current).toBeNull();
  });

  // MagicLizi P1 (#3789): xAI rate-limit mirrors are account-scoped too. An independent
  // account's record must not land in the builtin mirror and its clear must not empty it.
  it('keeps builtin and independent xAI rate-limit mirrors separate on one device', () => {
    const builtin = renderHook(() => useRemoteXaiRateLimit('device-1'));
    const named = renderHook(() => useRemoteXaiRateLimit('device-1', 'xai-second'));
    expect(mocks.invoke).not.toHaveBeenCalled();
    act(() => emitPush({ deviceId: 'device-1', channel: 'usage:xai-rate-limit-changed',
      payload: { updatedAt: 1, remainingRequests: 5 } }));
    expect(builtin.result.current?.remainingRequests).toBe(5);
    expect(named.result.current).toBeNull();
    act(() => emitPush({ deviceId: 'device-1', channel: 'usage:xai-provider-rate-limit-changed',
      payload: { providerId: 'xai-second', snapshot: { updatedAt: 2, remainingRequests: 9 } } }));
    expect(named.result.current?.remainingRequests).toBe(9);
    expect(builtin.result.current?.remainingRequests).toBe(5);
    // Independent account clear leaves the still-logged-in builtin account untouched.
    act(() => emitPush({ deviceId: 'device-1', channel: 'usage:xai-provider-rate-limit-changed',
      payload: { providerId: 'xai-second', snapshot: null } }));
    expect(named.result.current).toBeNull();
    expect(builtin.result.current?.remainingRequests).toBe(5);
  });

  it('rejects a legacy host builtin response when a named account was requested', async () => {
    mocks.invoke.mockResolvedValue({ primary: { usedPercent: 10 } });
    const { result } = renderHook(() => useRemoteCodexAccountUsage('device-1', 'account-2'));
    await flushMicrotasks();
    expect(result.current).toBeNull();
  });

  it('does not let a late initial read overwrite a newer usage push', async () => {
    let finish!: (value: unknown) => void;
    mocks.invoke.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const { result } = renderHook(() => useRemoteCodexAccountUsage('device-1'));
    act(() => emitPush({ deviceId: 'device-1', channel: 'usage:codex-account-changed',
      payload: { primary: { usedPercent: 80 } } }));
    await act(async () => finish({ primary: { usedPercent: 10 } }));
    expect(result.current?.primary?.usedPercent).toBe(80);
  });

  it('does not expose another device snapshot during a device switch', async () => {
    mocks.invoke.mockResolvedValueOnce({ primary: { usedPercent: 10 } });
    const seen: unknown[] = [];
    const { rerender } = renderHook(({ device }) => {
      const snapshot = useRemoteCodexAccountUsage(device);
      seen.push(snapshot);
      return snapshot;
    }, { initialProps: { device: 'device-1' } });
    await flushMicrotasks();
    mocks.invoke.mockReturnValue(new Promise(() => {}));
    seen.length = 0;
    rerender({ device: 'device-2' });
    expect(seen).toEqual([null]);
  });
});

// Unit: the remote mirror must retain the daily-limit switch on reads and pushes,
// including a switch-off update without dropping the monthly quota.
it('mirrors enterprise daily-limit changes through device-link', async () => {
  const quota = { spend: 12, maxBudget: 100, currency: 'CNY', todaySpend: 1, fetchedAt: 1, dailyLimitEnabled: true };
  mocks.invoke.mockResolvedValue(quota);
  const view = renderHook(() => useRemoteClaudeAccountUsage('daily-switch'));
  await flushMicrotasks();
  expect(view.result.current).toEqual(quota);
  const disabled = { ...quota, todaySpend: null, dailyLimitEnabled: false };
  act(() => emitPush({ deviceId: 'daily-switch', channel: 'usage:claude-account-changed', payload: disabled }));
  expect(view.result.current).toEqual(disabled);
});

it.each(['unlimited', 'invalidated'])('retains remote quota on unavailable reads but replays a missed %s clear', async (quotaState) => {
  const quota = { spend: 12, maxBudget: 100, currency: 'CNY', todaySpend: null, fetchedAt: 1 };
  mocks.invoke.mockResolvedValue(quota);
  const first = renderHook(() => useRemoteClaudeAccountUsage('device-quota'));
  await flushMicrotasks();
  expect(first.result.current).toEqual(quota);
  first.unmount();
  mocks.invoke.mockResolvedValue(null);
  const unavailable = renderHook(() => useRemoteClaudeAccountUsage('device-quota'));
  await flushMicrotasks();
  expect(unavailable.result.current).toEqual(quota);
  unavailable.unmount();
  mocks.invoke.mockResolvedValue({ quotaState });
  const cleared = renderHook(() => useRemoteClaudeAccountUsage('device-quota'));
  await flushMicrotasks();
  expect(cleared.result.current).toBeNull();
});

it('rereads only the recovered quota peer while consumers remain mounted', async () => {
  const quota = { spend: 12, maxBudget: 100, currency: 'CNY', todaySpend: null, fetchedAt: 1 };
  mocks.invoke.mockResolvedValue(quota);
  const a = renderHook(() => useRemoteClaudeAccountUsage('peer-a'));
  const b = renderHook(() => useRemoteClaudeAccountUsage('peer-b'));
  await flushMicrotasks();
  mocks.invoke.mockClear();
  mocks.invoke.mockResolvedValue({ quotaState: 'unlimited' });
  act(() => mocks.presenceListeners.forEach(cb => cb({ deviceId: 'peer-a', online: false })));
  act(() => mocks.presenceListeners.forEach(cb => cb({ deviceId: 'peer-a', online: true })));
  await flushMicrotasks();
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(mocks.invoke.mock.calls[0]?.[0]).toBe('peer-a');
  expect(a.result.current).toBeNull();
  expect(b.result.current).toEqual(quota);
});

it('queues a recovery read when a previous quota request is still in flight', async () => {
  let finish!: (value: unknown) => void;
  mocks.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  mocks.invoke.mockResolvedValue({ quotaState: 'unlimited' });
  const a = renderHook(() => useRemoteClaudeAccountUsage('peer-pending'));
  act(() => mocks.presenceListeners.forEach(cb => cb({ deviceId: 'peer-pending', online: true })));
  await act(async () => finish(null));
  await flushMicrotasks();
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
  expect(a.result.current).toBeNull();
});

it('rereads when the target comes online after an early relay recovery read fails', async () => {
  const quota = { spend: 12, maxBudget: 100, currency: 'CNY', todaySpend: null, fetchedAt: 1 };
  mocks.invoke.mockResolvedValue(quota);
  const view = renderHook(() => useRemoteClaudeAccountUsage('peer-late'));
  await flushMicrotasks();
  act(() => mocks.statusListeners.forEach(cb => cb({ status: 'online' })));
  act(() => mocks.presenceListeners.forEach(cb => cb({ deviceId: 'peer-late', online: true })));
  await flushMicrotasks();
  mocks.invoke.mockRejectedValue(new Error('target offline'));
  act(() => mocks.statusListeners.forEach(cb => cb({ status: 'connecting' })));
  act(() => mocks.statusListeners.forEach(cb => cb({ status: 'online' })));
  await flushMicrotasks();
  expect(view.result.current).toEqual(quota);
  mocks.invoke.mockClear();
  mocks.invoke.mockResolvedValue({ quotaState: 'unlimited' });
  act(() => mocks.presenceListeners.forEach(cb => cb({ deviceId: 'peer-late', online: true })));
  await flushMicrotasks();
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(view.result.current).toBeNull();
});

it('rereads only the reset peer without needing relay or presence changes', async () => {
  const quota = { spend: 12, maxBudget: 100, currency: 'CNY', todaySpend: null, fetchedAt: 1 };
  mocks.invoke.mockResolvedValue(quota);
  const a = renderHook(() => useRemoteClaudeAccountUsage('reset-a'));
  const b = renderHook(() => useRemoteClaudeAccountUsage('reset-b'));
  await flushMicrotasks();
  mocks.invoke.mockClear();
  mocks.invoke.mockResolvedValue({ quotaState: 'unlimited' });
  act(() => mocks.peerResetListeners.forEach(cb => cb({ deviceId: 'reset-a' })));
  await flushMicrotasks();
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(mocks.invoke.mock.calls[0]?.[0]).toBe('reset-a');
  expect(a.result.current).toBeNull();
  expect(b.result.current).toEqual(quota);
  a.unmount();
  b.unmount();
  expect(mocks.peerResetListeners).toHaveLength(0);
});

it('rereads the recovered peer after the initial reset read failed, leaving its neighbor untouched', async () => {
  const finite = { spend: 1, maxBudget: 10, currency: 'CNY', fetchedAt: 1 };
  mocks.invoke.mockResolvedValue(finite);
  const a = renderHook(() => useRemoteClaudeAccountUsage('retry-a'));
  const b = renderHook(() => useRemoteClaudeAccountUsage('retry-b'));
  await flushMicrotasks();
  mocks.invoke.mockRejectedValueOnce(new Error('first open failed'));
  act(() => mocks.peerResetListeners.forEach(cb => cb({ deviceId: 'retry-a' })));
  await flushMicrotasks();
  expect(a.result.current).toEqual(finite);
  mocks.invoke.mockClear();
  mocks.invoke.mockResolvedValue({ quotaState: 'invalidated' });
  act(() => mocks.reopenedListeners.forEach(cb => cb({ deviceId: 'retry-a' })));
  await flushMicrotasks();
  expect(a.result.current).toBeNull();
  expect(b.result.current).toEqual(finite);
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(mocks.invoke.mock.calls[0]?.[0]).toBe('retry-a');
  a.unmount(); b.unmount();
  expect(mocks.reopenedListeners).toHaveLength(0);
});
