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
    expect(mocks.invoke).toHaveBeenCalledWith('device-1', 'maker:usage:account', ['codex']);
    expect(result.current).toMatchObject({ primary: { usedPercent: 3 } });
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
    mocks.invoke.mockImplementation(async (_device, _channel, args) => args[1]
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
