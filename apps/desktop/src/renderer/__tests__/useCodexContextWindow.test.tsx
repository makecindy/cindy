// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：经真实 preload `createRemoteReadBridge` + `useCodexContextWindow` + `useDeviceProviders`
 *   验证远程/本机 Codex 原生上下文窗口结果、并发多任务独立返回值、`maker:model-context-limit:get` 请求次数、
 *   以及切号/重连/同账号跨代/splash 延迟与临时策略恢复行为。
 * - Bug／规则依据：线上诊断旧被控端重复触发 80 次 `maker:model-context-limit:get` `CHANNEL_NOT_ALLOWED`；
 *   审阅指出等待首探门禁期间切号/重连不得继续把旧 `sessionId` 发往新连接；
 *   `docs/dev-rules/remote-and-mobile-adaptation.md`、`docs/dev-rules/protocol-compatibility.md`。
 * - 现有覆盖缺口：原有用例未接入 `#12556` `remoteReadBridge` 联合验证，未覆盖两个不同任务/模型并发各自返回正确值、
 *   等待首探期间切号/重连/取消不再补发旧 `sessionId`、同账号 `generation` 跨代丢弃旧在途结果、以及 splash 缺 handler 与临时策略恢复。
 * - 最小失败输入：1) Hook A 在途首探时 Hook B（携带旧 `sessionId`）等待门禁，期间触发切号或重连；
 *   2) 旧对端返回 `channel 'maker:model-context-limit:get' not allowed remotely` 后连续触发 80 轮刷新。
 * - tier：unit（jsdom 下挂载真实 preload bridge 与 React hook，无外部进程或真实网络）。
 * - 实测耗时：2.10s（`pnpm --dir apps/desktop exec vitest run src/renderer/__tests__/useCodexContextWindow.test.tsx`）
 */
import { EventEmitter } from 'node:events';
import { act, cleanup, renderHook } from '@testing-library/react';
import { sharedTaskGuestPeer, sharedTaskHostPeer } from '@cindy/device-link';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetCodexContextWindowProbesForTests,
  useCodexContextWindow,
} from '@/hooks/useCodexContextWindow';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import {
  evictAllDeviceProviders,
  evictDeviceProviders,
  prefetchDeviceProviders,
} from '@/hooks/useDeviceProviders';
import { createRemoteReadBridge } from '../../preload/remoteReadBridge';
import { modelCatalogKey } from '../../shared/controlledModelCatalog';
import { DEVICE_LINK_INVOKE, DEVICE_LINK_PUSH } from '../../shared/deviceLinkIpc';

const originalApi = window.electronAPI;

beforeEach(() => {
  evictAllDeviceProviders();
  resetCodexContextWindowProbesForTests();
  setDataOwnerGeneration('owner-a', 1);
});

afterEach(() => {
  cleanup();
  evictAllDeviceProviders();
  resetCodexContextWindowProbesForTests();
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: originalApi });
});

async function mountHook<Result, Props>(
  render: (props: Props) => Result,
  options?: { initialProps: Props },
) {
  let hook!: ReturnType<typeof renderHook<Result, Props>>;
  await act(async () => {
    hook = renderHook(render, options);
  });
  return hook;
}

function installApi(getModelContextLimit: unknown, invoke?: unknown) {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      maker: { getModelContextLimit },
      deviceLink: { invoke },
    },
  });
}

function installBridgedApi(
  rawRemoteInvoke: (deviceId: string, channel: string, args: unknown[]) => Promise<unknown>,
  getModelContextLimit: unknown = vi.fn(),
) {
  const ipcEvents = new EventEmitter();
  const ipcInvoke = vi.fn(async (method: string, payload: Record<string, unknown>) => {
    if (method === DEVICE_LINK_INVOKE.INVOKE) {
      return rawRemoteInvoke(
        payload.deviceId as string,
        payload.channel as string,
        (payload.args as unknown[]) ?? [],
      );
    }
    if (method === DEVICE_LINK_INVOKE.OPEN_LINK) {
      return { appVersion: '1.0.0', allowlistHash: 'h1', capabilities: [] };
    }
    return { ok: true };
  });
  const bridge = createRemoteReadBridge({ invoke: ipcInvoke, on: ipcEvents.on.bind(ipcEvents) });
  const subscribePush = <T,>(channel: string) => (cb: (payload: T) => void) => {
    const handler = (_event: unknown, payload: T) => cb(payload);
    ipcEvents.on(channel, handler);
    return () => {
      ipcEvents.off(channel, handler);
    };
  };
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      maker: { getModelContextLimit },
      deviceLink: {
        openLink: bridge.openLink,
        closeLink: bridge.closeLink,
        invoke: bridge.invoke,
        onPeerLinkReset: subscribePush<{ deviceId: string }>(DEVICE_LINK_PUSH.PEER_LINK_RESET),
        onPeerLinkReopened: subscribePush<{ deviceId: string }>(DEVICE_LINK_PUSH.PEER_LINK_REOPENED),
        onPresenceChanged: subscribePush<{
          deviceId: string;
          online: boolean;
          remoteControlEnabled?: boolean;
          appVersion?: string;
        }>(DEVICE_LINK_PUSH.PRESENCE_CHANGED),
        onStatusChanged: subscribePush<{ status: string; dataPathChangedDeviceId?: string }>(
          DEVICE_LINK_PUSH.STATUS_CHANGED,
        ),
        onAccessRevoked: subscribePush<{ deviceId: string }>(DEVICE_LINK_PUSH.ACCESS_REVOKED),
        onControlTargetChanged: subscribePush<{ deviceId: string; enabled: boolean }>(
          DEVICE_LINK_PUSH.CONTROL_TARGET_CHANGED,
        ),
        onOwnershipChanged: subscribePush<{ isOwner: boolean }>(DEVICE_LINK_PUSH.OWNERSHIP_CHANGED),
      },
    },
  });
  return {
    ipcInvoke,
    push: (event: string, payload?: unknown) => ipcEvents.emit(event, {}, payload),
  };
}

const info = { contextWindow: 272_000, usableContextWindow: 258_400, autoCompactTokenLimit: 244_800 };
const validProviderList = {
  providers: [
    {
      id: 'xd',
      name: 'XD',
      agents: ['codex'],
      connected: true,
      models: {
        codex: [{ id: 'gpt', name: 'GPT', contextWindow: 272_000, efforts: ['medium'] }],
      },
    },
  ],
};

describe('native Codex capacity lookup', () => {
  // #11716/#4477, unit: the old hook had no device scope and read the controller.
  // Minimal input: the same task/model on two devices with different native windows.
  it('reads the target task without consulting controller preferences and rejects a late device reply', async () => {
    let finish!: (value: unknown) => void;
    const local = vi.fn(async () => ({ codexContext: info }));
    const invoke = vi
      .fn()
      .mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue({ codexContext: { ...info, contextWindow: 100_000 } });
    installApi(local, invoke);
    const { result, rerender } = await mountHook(
      ({ deviceId }) =>
        useCodexContextWindow({
          enabled: true,
          deviceId,
          providerId: 'xd',
          modelId: 'gpt',
          sessionId: 'same-id',
        }),
      { initialProps: { deviceId: 'device-a' } },
    );
    expect(invoke).toHaveBeenCalledWith('device-a', 'maker:model-context-limit:get', [
      { agent: 'codex', providerId: 'xd', modelId: 'gpt', sessionId: 'same-id' },
    ]);
    await act(async () => {
      rerender({ deviceId: 'device-b' });
    });
    expect(result.current?.contextWindow).toBe(100_000);
    await act(async () => finish({ codexContext: info }));
    expect(result.current?.contextWindow).toBe(100_000);
    expect(local).not.toHaveBeenCalled();
  });

  it.each(['unsupported', 'timeout', 'disconnected'])('keeps a remote %s unknown instead of using local config', async error => {
    const local = vi.fn(async () => ({ codexContext: info }));
    installApi(local, vi.fn().mockRejectedValue(new Error(error)));
    const { result } = await mountHook(() =>
      useCodexContextWindow({
        enabled: true,
        deviceId: 'device-a',
        providerId: 'xd',
        modelId: 'gpt',
        sessionId: 'task',
      }),
    );
    expect(result.current).toBeNull();
    expect(local).not.toHaveBeenCalled();
  });

  it('discards in-flight facts on peer invalidation without retrying a disconnected peer', async () => {
    let finish!: (value: unknown) => void;
    const invoke = vi.fn().mockReturnValue(new Promise(resolve => { finish = resolve; }));
    installApi(vi.fn(), invoke);
    const { result } = await mountHook(() =>
      useCodexContextWindow({
        enabled: true,
        deviceId: 'device-a',
        providerId: 'xd',
        modelId: 'gpt',
        sessionId: 'task',
      }),
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    act(() => evictDeviceProviders('device-a'));
    await act(async () => finish({ codexContext: info }));
    expect(result.current).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('clears the previous account and rejects its delayed read', async () => {
    let finish!: (value: unknown) => void;
    const invoke = vi
      .fn()
      .mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue({ codexContext: null });
    installApi(vi.fn(), invoke);
    const { result } = await mountHook(() =>
      useCodexContextWindow({
        enabled: true,
        deviceId: 'device-a',
        providerId: 'xd',
        modelId: 'gpt',
        sessionId: 'task',
      }),
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(async () => {
      setDataOwnerGeneration('owner-b');
    });
    await act(async () => finish({ codexContext: info }));
    expect(result.current).toBeNull();
  });

  it('discards same-account previous-generation in-flight facts when owner generation advances', async () => {
    let finishGen1!: (value: unknown) => void;
    let finishGen2!: (value: unknown) => void;
    const invoke = vi
      .fn()
      .mockReturnValueOnce(new Promise(resolve => { finishGen1 = resolve; }))
      .mockReturnValueOnce(new Promise(resolve => { finishGen2 = resolve; }));
    installApi(vi.fn(), invoke);

    const { result } = await mountHook(() =>
      useCodexContextWindow({
        enabled: true,
        deviceId: 'device-a',
        providerId: 'xd',
        modelId: 'gpt',
        sessionId: 'task-gen',
      }),
    );
    expect(invoke).toHaveBeenCalledTimes(1);

    await act(async () => {
      setDataOwnerGeneration('owner-a', 2);
    });
    expect(invoke).toHaveBeenCalledTimes(2);

    // Stale generation-1 reply resolves first: must not bleed into generation 2.
    await act(async () => finishGen1({ codexContext: info }));
    expect(result.current).toBeNull();

    await act(async () => finishGen2({ codexContext: { ...info, contextWindow: 1_000_000 } }));
    expect(result.current?.contextWindow).toBe(1_000_000);
  });

  it('does not restore a retired peer snapshot when re-enabling the lookup', async () => {
    let settlePending!: (value: unknown) => void;
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ codexContext: info })
      .mockImplementation(() => new Promise(resolve => { settlePending = resolve; }));
    installApi(vi.fn(), invoke);
    const { result, rerender, unmount } = await mountHook(
      ({ enabled }) =>
        useCodexContextWindow({
          enabled,
          deviceId: 'device-a',
          providerId: 'xd',
          modelId: 'gpt',
          sessionId: 'task',
        }),
      { initialProps: { enabled: true } },
    );
    expect(result.current).toEqual(info);
    await act(async () => {
      rerender({ enabled: false });
    });
    act(() => evictDeviceProviders('device-a'));
    await act(async () => {
      rerender({ enabled: true });
    });
    expect(result.current).toBeNull();
    unmount();
    settlePending?.({ codexContext: null });
  });

  it('coalesces repeated inspections while the same remote native read is pending', async () => {
    let finish!: (value: unknown) => void;
    const invoke = vi
      .fn()
      .mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue({ codexContext: { ...info, contextWindow: 100_000 } });
    installApi(vi.fn(), invoke);
    const { result, rerender } = await mountHook(
      ({ refreshKey }) =>
        useCodexContextWindow({
          enabled: true,
          deviceId: 'device-a',
          providerId: 'xd',
          modelId: 'gpt',
          sessionId: 'task',
          refreshKey,
        }),
      { initialProps: { refreshKey: '0' } },
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(async () => {
      rerender({ refreshKey: '1' });
      rerender({ refreshKey: '2' });
      rerender({ refreshKey: '3' });
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(async () => finish({ codexContext: info }));
    expect(result.current?.contextWindow).toBe(100_000);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('waits for the native hidden-window signal before reading a hidden remote view', async () => {
    let hiddenChanged: ((hidden: boolean) => void) | undefined;
    const offHidden = vi.fn();
    const invoke = vi.fn().mockResolvedValue({ codexContext: info });
    installApi(vi.fn(), invoke);
    Object.assign(window.electronAPI, {
      onWindowHiddenChange: (callback: typeof hiddenChanged) => {
        hiddenChanged = callback;
        return offHidden;
      },
    });
    document.documentElement.setAttribute('data-app-hidden', '');
    const { result, unmount } = await mountHook(() =>
      useCodexContextWindow({
        enabled: true,
        deviceId: 'device-a',
        providerId: 'xd',
        modelId: 'gpt',
        sessionId: 'task',
      }),
    );
    document.documentElement.removeAttribute('data-app-hidden');
    await act(async () => {});
    expect(invoke).not.toHaveBeenCalled();
    await act(async () => {
      hiddenChanged?.(false);
    });
    expect(result.current).toEqual(info);
    unmount();
    expect(offHidden).toHaveBeenCalledTimes(1);
  });

  it('refreshes pending configuration when inspecting an idle task again', async () => {
    const getModelContextLimit = vi
      .fn()
      .mockResolvedValueOnce({ codexContext: { ...info, pendingApply: true } })
      .mockResolvedValue({ codexContext: { ...info, contextWindow: 1_000_000, pendingApply: true } });
    installApi(getModelContextLimit);
    const { result, rerender } = await mountHook(
      ({ refreshKey }) =>
        useCodexContextWindow({
          enabled: true,
          providerId: 'xd',
          modelId: 'gpt',
          sessionId: 'idle-task',
          refreshKey,
        }),
      { initialProps: { refreshKey: 'idle:0' } },
    );
    expect(result.current?.contextWindow).toBe(272_000);
    await act(async () => {
      rerender({ refreshKey: 'idle:1' });
    });
    expect(result.current).toMatchObject({ contextWindow: 1_000_000, pendingApply: true });
  });

  it('queries only the existing task and ignores model preference limits', async () => {
    const getModelContextLimit = vi.fn(async () => ({ limit: 1_000_000, codexContext: info }));
    installApi(getModelContextLimit);
    const { result } = await mountHook(() =>
      useCodexContextWindow({
        enabled: true,
        providerId: 'xd',
        modelId: 'glm',
        sessionId: 'running-task',
        reportedWindow: 258_400,
      }),
    );
    expect(result.current).toEqual(info);
    expect(getModelContextLimit).toHaveBeenCalledWith({
      agent: 'codex',
      providerId: 'xd',
      modelId: 'glm',
      sessionId: 'running-task',
    });
  });

  it('rejects delayed facts from the previously selected model', async () => {
    let finish!: (value: unknown) => void;
    const getModelContextLimit = vi
      .fn()
      .mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue({ limit: 500_000 });
    installApi(getModelContextLimit);
    const { result, rerender } = await mountHook(
      ({ modelId }) => useCodexContextWindow({ enabled: true, providerId: 'xd', modelId }),
      { initialProps: { modelId: 'gpt' } },
    );
    expect(getModelContextLimit).toHaveBeenCalledTimes(1);
    await act(async () => {
      rerender({ modelId: 'glm' });
    });
    await act(async () => finish({ codexContext: info }));
    expect(result.current).toBeNull();
  });

  it('returns distinct native context windows when two different tasks and models mount concurrently on the same peer', async () => {
    let releaseFirst!: () => void;
    const rawInvoke = vi.fn(async (_deviceId: string, _channel: string, args: unknown[]) => {
      const target = args[0] as { modelId: string; sessionId?: string };
      if (target.sessionId === 'task-a' && target.modelId === 'gpt-272k') {
        await new Promise<void>(resolve => {
          releaseFirst = resolve;
        });
        return { codexContext: { ...info, contextWindow: 272_000 } };
      }
      return { codexContext: { ...info, contextWindow: 1_000_000 } };
    });
    installBridgedApi(rawInvoke);

    let first!: ReturnType<typeof renderHook<ReturnType<typeof useCodexContextWindow>, unknown>>;
    let second!: ReturnType<typeof renderHook<ReturnType<typeof useCodexContextWindow>, unknown>>;
    await act(async () => {
      first = renderHook(() =>
        useCodexContextWindow({
          enabled: true,
          deviceId: 'device-modern',
          providerId: 'xd',
          modelId: 'gpt-272k',
          sessionId: 'task-a',
        }),
      );
      second = renderHook(() =>
        useCodexContextWindow({
          enabled: true,
          deviceId: 'device-modern',
          providerId: 'xd',
          modelId: 'gpt-1m',
          sessionId: 'task-b',
        }),
      );
    });

    expect(rawInvoke).toHaveBeenCalledTimes(1);
    await act(async () => {
      releaseFirst();
    });
    expect(first.result.current?.contextWindow).toBe(272_000);
    expect(second.result.current?.contextWindow).toBe(1_000_000);
    expect(rawInvoke).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'accountSwitch',
      (push: (event: string, payload?: unknown) => void) => {
        push('auth:state-change');
        setDataOwnerGeneration('owner-b', 1);
      },
    ],
    [
      'peerReconnect',
      (push: (event: string, payload?: unknown) => void) => {
        push(DEVICE_LINK_PUSH.PEER_LINK_REOPENED, { deviceId: 'device-a' });
      },
    ],
    [
      'providerEviction',
      () => {
        evictDeviceProviders('device-a');
      },
    ],
    ['unmountQueuedHook', (_push: unknown, unmountQueued: () => void) => unmountQueued()],
  ])('never dispatches a queued probe with stale sessionId after %s while waiting on first-probe gate', async (_label, interrupt) => {
    let settleFirst!: (value: unknown) => void;
    const rawInvoke = vi.fn((_deviceId: string, _channel: string, args: unknown[]) => {
      const target = args[0] as { sessionId?: string };
      if (target.sessionId === 'probe-1') {
        return new Promise(resolve => {
          settleFirst = resolve;
        });
      }
      return Promise.resolve({ codexContext: info });
    });
    const { push } = installBridgedApi(rawInvoke);

    let queued!: ReturnType<typeof renderHook<ReturnType<typeof useCodexContextWindow>, { sessionId: string }>>;
    await act(async () => {
      renderHook(() =>
        useCodexContextWindow({
          enabled: true,
          deviceId: 'device-a',
          providerId: 'xd',
          modelId: 'gpt',
          sessionId: 'probe-1',
        }),
      );
      // Second hook mounts while probe-1 holds the first-probe gate, carrying `stale-before-boundary`.
      queued = renderHook(
        ({ sessionId }) =>
          useCodexContextWindow({
            enabled: true,
            deviceId: 'device-a',
            providerId: 'xd',
            modelId: 'gpt-mini',
            sessionId,
          }),
        { initialProps: { sessionId: 'stale-before-boundary' } },
      );
    });

    expect(rawInvoke).toHaveBeenCalledTimes(1);
    await act(async () => {
      if (_label === 'accountSwitch') {
        queued.rerender({ sessionId: 'owner-b-fresh-task' });
      }
      interrupt(push, () => queued.unmount());
    });
    await act(async () => {
      settleFirst({ codexContext: info });
    });

    const sentSessions = rawInvoke.mock.calls.map(([, , args]) => (args[0] as { sessionId?: string })?.sessionId);
    expect(sentSessions).not.toContain('stale-before-boundary');
    if (_label === 'accountSwitch') {
      expect(sentSessions).toContain('owner-b-fresh-task');
    } else {
      expect(sentSessions).toEqual(['probe-1']);
    }
  });

  it('suppresses 80 repeated CHANNEL_NOT_ALLOWED probes via remoteReadBridge while recovering splash NOT_FOUND and temporary policy errors', async () => {
    let splashDone = false;
    let policyBlocked = true;
    let oldPeerUpgraded = false;
    const rawInvoke = vi.fn(async (deviceId: string, channel: string) => {
      if (channel === 'maker:provider:list') {
        splashDone = true;
        return validProviderList;
      }
      if (deviceId === 'device-old') {
        if (!oldPeerUpgraded) {
          throw new Error(
            "Error invoking remote method 'device-link:invoke': Error: [DEVICE_LINK_CHANNEL_NOT_ALLOWED] channel 'maker:model-context-limit:get' not allowed remotely",
          );
        }
        return { codexContext: info };
      }
      if (deviceId === 'device-splash') {
        if (!splashDone) {
          throw new Error(
            "Error invoking remote method 'device-link:invoke': Error: [NOT_FOUND] no local IPC handler for channel 'maker:model-context-limit:get'",
          );
        }
        return { codexContext: info };
      }
      if (deviceId === 'device-policy' && policyBlocked) {
        throw new Error(
          "Error invoking remote method 'device-link:invoke': Error: [DEVICE_LINK_CHANNEL_NOT_ALLOWED] Transport disabled by current host policy",
        );
      }
      return { codexContext: info };
    });
    const { push } = installBridgedApi(rawInvoke);

    // 1) Old peer: concurrent mount + 80 turns/inspections/same-owner generation repair send only 1 IPC call.
    let oldA!: ReturnType<
      typeof renderHook<
        ReturnType<typeof useCodexContextWindow>,
        { refreshKey: string; reportedWindow: number; sessionId: string }
      >
    >;
    let oldB!: ReturnType<typeof renderHook<ReturnType<typeof useCodexContextWindow>, unknown>>;
    await act(async () => {
      oldA = renderHook(
        ({ refreshKey, reportedWindow, sessionId }) =>
          useCodexContextWindow({
            enabled: true,
            deviceId: 'device-old',
            providerId: 'xd',
            modelId: 'gpt',
            sessionId,
            reportedWindow,
            refreshKey,
          }),
        { initialProps: { refreshKey: '0', reportedWindow: 200_000, sessionId: 't-0' } },
      );
      oldB = renderHook(() =>
        useCodexContextWindow({
          enabled: true,
          deviceId: 'device-old',
          providerId: 'xd',
          modelId: 'gpt-mini',
          sessionId: 't-concurrent',
        }),
      );
    });
    for (let i = 1; i <= 80; i++) {
      await act(async () => {
        oldA.rerender({ refreshKey: String(i), reportedWindow: 200_000 + i, sessionId: `t-${i % 4}` });
      });
    }
    await act(async () => {
      setDataOwnerGeneration('owner-a', 2);
      await prefetchDeviceProviders('device-old');
    });
    const countContextCalls = (peer: string) =>
      rawInvoke.mock.calls.filter(([d, ch]) => d === peer && ch === 'maker:model-context-limit:get').length;
    expect(countContextCalls('device-old')).toBe(1);
    oldB.unmount();

    // Upgrading old peer and reopening link recovers native context facts.
    oldPeerUpgraded = true;
    act(() => push(DEVICE_LINK_PUSH.PEER_LINK_REOPENED, { deviceId: 'device-old' }));
    await act(async () => {
      oldA.rerender({ refreshKey: 'upgraded', reportedWindow: 272_000, sessionId: 't-0' });
    });
    expect(oldA.result.current).toEqual(info);
    expect(countContextCalls('device-old')).toBe(2);

    // 2) Splash missing-handler stays recoverable once registerMakerIpcsAfterSplash (`maker:provider:list` ready) completes.
    splashDone = false;
    const splash = await mountHook(() =>
      useCodexContextWindow({
        enabled: true,
        deviceId: 'device-splash',
        providerId: 'xd',
        modelId: 'gpt',
        sessionId: 'task-splash',
      }),
    );
    expect(splash.result.current).toBeNull();
    await act(async () => {
      await prefetchDeviceProviders('device-splash');
    });
    expect(splash.result.current).toEqual(info);

    // 3) Temporary local transport policy (`CHANNEL_NOT_ALLOWED`) recovers on next refresh.
    const policy = await mountHook(
      ({ refreshKey }) =>
        useCodexContextWindow({
          enabled: true,
          deviceId: 'device-policy',
          providerId: 'xd',
          modelId: 'gpt',
          sessionId: 'task-policy',
          refreshKey,
        }),
      { initialProps: { refreshKey: 'blocked' } },
    );
    expect(policy.result.current).toBeNull();
    policyBlocked = false;
    await act(async () => {
      policy.rerender({ refreshKey: 'allowed' });
    });
    expect(policy.result.current).toEqual(info);
  });

  it.each([
    modelCatalogKey('share:ps-1', 'device-a')!,
    sharedTaskHostPeer('st-1', 'host-1'),
    sharedTaskGuestPeer('st-1', 'member-1', 'guest-1'),
    'share:provider-1',
  ])('skips non-owner remote scope %s without probing context limits', async scopedDeviceId => {
    const invoke = vi.fn();
    installApi(vi.fn(), invoke);
    const { result } = await mountHook(() =>
      useCodexContextWindow({
        enabled: true,
        deviceId: scopedDeviceId,
        providerId: 'xd',
        modelId: 'gpt',
        sessionId: 'task',
      }),
    );
    expect(result.current).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});
