// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：经真实 preload `createRemoteReadBridge`（含 `openLink` 与 `invoke`）+
 *   `useDeviceModelGroups` + `useDevicesModelGroups` 验证远程电脑模型组的 `unsupported` / `config` 状态、
 *   `model-groups:get` 请求次数、无重复 `publish` 渲染、同账号跨代结果隔离、同 `appVersion` 下 `openLink`
 *   能力指纹变更重探、以及全局离线重连后新旧组件的缓存一致性。
 * - Bug／规则依据：线上诊断 `model-groups:get` 重复触发 2 次 `CHANNEL_NOT_ALLOWED`；审阅指出：
 *   1) 全局离线清空 map 会导致旧 `useMemo` 组件与新组件读写分裂缓存；
 *   2) 仅按 `ownerId` 校验会把同账号上一代在途结果带入新代；
 *   3) `remoteModelGroups` 本地短路 `current.unsupported` 会挡住同 `appVersion` 仅 `allowlistHash`/`capabilities`
 *      经 `bridge.openLink` 变更后的选择器重读；
 *   `docs/product-rules/model-groups.md` §6.3、`docs/dev-rules/protocol-compatibility/model-groups-remote-pickers.md`。
 * - 现有覆盖缺口：原有用例未接入 `#12556` `remoteReadBridge` 联合验证，未覆盖离线重连后新旧组件共享同一缓存、
 *   同账号 `generation` 递增丢弃上一代在途 `config` 同时不重复发 `CHANNEL_NOT_ALLOWED`、同版本 `openLink`
 *   能力变更穿透重读、以及本机传输策略拦截即时恢复。
 * - 最小失败输入：1) 对端返回不支持后，同 `appVersion` 下 `bridge.openLink` 返回新 `allowlistHash`/`capabilities`（无额外 reset/presence），随后调用 `read()`；
 *   2) 组件 A 挂载后触发 `STATUS_CHANGED: reconnecting -> online`，再挂载组件 B 执行 `read()`。
 * - tier：unit（jsdom 下挂载真实 preload bridge 与 React hooks，无外部进程或真实网络）。
 * - 实测耗时：1.80s（`pnpm --dir apps/desktop exec vitest run src/renderer/__tests__/remoteModelGroups.test.tsx`）
 */
import { EventEmitter } from 'node:events';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import {
  isModelGroupsUnsupportedError,
  resetDeviceModelGroupsForTests,
  useDeviceModelGroups,
  useDevicesModelGroups,
} from '@/features/model-groups/remoteModelGroups';
import { evictAllDeviceProviders, prefetchDeviceProviders } from '@/hooks/useDeviceProviders';
import { createRemoteReadBridge } from '../../preload/remoteReadBridge';
import { DEVICE_LINK_INVOKE, DEVICE_LINK_PUSH } from '../../shared/deviceLinkIpc';

const routes = [{ id: 'daily', name: 'Daily coding', strategy: 'order', candidates: [] }];
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

let rawInvoke: ReturnType<typeof vi.fn>;
let openLinkOffer: { appVersion: string; allowlistHash: string; capabilities: string[] };
let ipcEvents: EventEmitter;
let push: (channel: string, payload?: unknown) => void;

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

beforeEach(() => {
  evictAllDeviceProviders();
  resetDeviceModelGroupsForTests();
  setDataOwnerGeneration('owner', 1);
  rawInvoke = vi.fn();
  openLinkOffer = { appVersion: '2.0.0', allowlistHash: 'h1', capabilities: [] };
  ipcEvents = new EventEmitter();
  push = (channel: string, payload?: unknown) => ipcEvents.emit(channel, {}, payload);

  const ipcInvoke = vi.fn(async (method: string, payload: Record<string, unknown>) => {
    if (method === DEVICE_LINK_INVOKE.INVOKE) {
      return rawInvoke(payload.deviceId, payload.channel, payload.args ?? []);
    }
    if (method === DEVICE_LINK_INVOKE.OPEN_LINK) {
      return openLinkOffer;
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

  Object.assign(window, {
    electronAPI: {
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
});

afterEach(() => {
  cleanup();
  evictAllDeviceProviders();
  resetDeviceModelGroupsForTests();
  setDataOwnerGeneration(null, 0);
  Reflect.deleteProperty(window, 'electronAPI');
});

describe('remote device model groups', () => {
  it('suppresses duplicate model-groups:get probes and avoids redundant publishes across picker reopens and same-owner generation bumps', async () => {
    rawInvoke.mockImplementation(async (deviceId: string) => {
      if (deviceId === 'desk-old-allowlist') {
        throw new Error(
          "Error invoking remote method 'device-link:invoke': Error: [DEVICE_LINK_CHANNEL_NOT_ALLOWED] channel 'model-groups:get' not allowed remotely",
        );
      }
      if (deviceId === 'desk-old-handler') {
        throw new Error(
          "Error invoking remote method 'device-link:invoke': Error: [NOT_FOUND] no local IPC handler for channel 'model-groups:get'",
        );
      }
      return { routes };
    });

    let controlledRenders = 0;
    const picker = await mountHook(() =>
      useDevicesModelGroups(['desk-old-allowlist', 'desk-old-handler', 'desk-modern']),
    );
    const controlled = await mountHook(() => {
      controlledRenders += 1;
      return useDeviceModelGroups('desk-old-allowlist', true);
    });
    await act(async () => {
      picker.result.current.read();
    });

    expect(picker.result.current.groups.get('desk-old-allowlist')?.unsupported).toBe(true);
    expect(picker.result.current.groups.get('desk-old-handler')?.unsupported).toBe(true);
    expect(picker.result.current.groups.get('desk-modern')?.config?.routes.map(r => r.id)).toEqual(['daily']);
    expect(controlled.result.current.unsupported).toBe(true);

    const callsFor = (peer: string) =>
      rawInvoke.mock.calls.filter(([d, ch]) => d === peer && ch === 'model-groups:get').length;
    expect(callsFor('desk-old-allowlist')).toBe(1);
    expect(callsFor('desk-old-handler')).toBe(1);

    // Repeated read() on an already-unsupported peer short-circuits in preload without wire calls OR redundant publish re-renders.
    const rendersBeforeRepeat = controlledRenders;
    await act(async () => {
      controlled.result.current.read();
      picker.result.current.read();
    });
    expect(controlledRenders).toBe(rendersBeforeRepeat);
    expect(callsFor('desk-old-allowlist')).toBe(1);
    expect(callsFor('desk-modern')).toBe(1);

    // Same-account startup generation repair creates a clean business bucket, while preload remoteReadBridge prevents a 2nd wire probe.
    await act(async () => {
      setDataOwnerGeneration('owner', 2);
    });
    await act(async () => {
      picker.result.current.read();
    });
    expect(controlled.result.current.unsupported).toBe(true);
    expect(picker.result.current.groups.get('desk-old-allowlist')?.unsupported).toBe(true);
    expect(callsFor('desk-old-allowlist')).toBe(1);
    expect(callsFor('desk-old-handler')).toBe(1);
  });

  it('recovers on picker read() when bridge.openLink observes changed allowlistHash or capabilities at the same appVersion without reset or presence events', async () => {
    let allowlisted = false;
    rawInvoke.mockImplementation(async () => {
      if (!allowlisted) {
        throw new Error(
          "Error invoking remote method 'device-link:invoke': Error: [DEVICE_LINK_CHANNEL_NOT_ALLOWED] channel 'model-groups:get' not allowed remotely",
        );
      }
      return { routes };
    });

    // Establish initial handshake at appVersion 2.0.0, allowlistHash h1.
    await act(async () => {
      await window.electronAPI.deviceLink.openLink('desk-2');
    });

    const { result } = await mountHook(() => useDeviceModelGroups('desk-2', true));
    expect(result.current.unsupported).toBe(true);
    expect(rawInvoke).toHaveBeenCalledTimes(1);

    // Identical openLink handshake keeps preload negative memory: read() still sends 0 remote frames.
    await act(async () => {
      await window.electronAPI.deviceLink.openLink('desk-2');
      result.current.read();
    });
    expect(result.current.unsupported).toBe(true);
    expect(rawInvoke).toHaveBeenCalledTimes(1);

    // Same appVersion ('2.0.0'), changed allowlistHash + capabilities via bridge.openLink, with zero reset/presence pushes.
    allowlisted = true;
    openLinkOffer = { appVersion: '2.0.0', allowlistHash: 'h2', capabilities: ['model-groups-v1'] };
    await act(async () => {
      await window.electronAPI.deviceLink.openLink('desk-2');
    });
    await act(async () => {
      result.current.read();
    });

    expect(result.current.unsupported).toBe(false);
    expect(result.current.config?.routes.map(r => r.id)).toEqual(['daily']);
    expect(rawInvoke).toHaveBeenCalledTimes(2);
  });

  it('discards same-account previous-generation in-flight business data when generation advances', async () => {
    let resolveGen1!: (value: unknown) => void;
    let resolveGen2!: (value: unknown) => void;
    rawInvoke
      .mockReturnValueOnce(
        new Promise(resolve => {
          resolveGen1 = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise(resolve => {
          resolveGen2 = resolve;
        }),
      );

    const { result } = await mountHook(() => useDeviceModelGroups('desk-2', true));
    expect(rawInvoke).toHaveBeenCalledTimes(1);

    // Advance generation for the same owner before gen-1 reply arrives.
    await act(async () => {
      setDataOwnerGeneration('owner', 2);
    });
    expect(rawInvoke).toHaveBeenCalledTimes(2);

    // Gen-1 stale payload resolves first: must be discarded, not shown under generation 2.
    await act(async () => {
      resolveGen1({
        routes: [{ id: 'stale-gen-1', name: 'Stale', strategy: 'order', candidates: [] }],
      });
    });
    expect(result.current.config).toBeNull();

    await act(async () => {
      resolveGen2({
        routes: [{ id: 'fresh-gen-2', name: 'Fresh', strategy: 'order', candidates: [] }],
      });
    });
    expect(result.current.config?.routes.map(r => r.id)).toEqual(['fresh-gen-2']);
  });

  it('keeps previously mounted and newly mounted hooks on the same cache entry across global offline and reconnect', async () => {
    rawInvoke
      .mockResolvedValueOnce({
        routes: [{ id: 'before-offline', name: 'Before', strategy: 'order', candidates: [] }],
      })
      .mockResolvedValueOnce({
        routes: [{ id: 'after-reconnect', name: 'After', strategy: 'order', candidates: [] }],
      });

    // Component A mounts before global disconnect.
    const existingHook = await mountHook(() => useDeviceModelGroups('desk-2', true));
    expect(existingHook.result.current.config?.routes.map(r => r.id)).toEqual(['before-offline']);

    // Global offline evicts in place without detaching Component A's memoized DeviceGroups entry.
    act(() => push(DEVICE_LINK_PUSH.STATUS_CHANGED, { status: 'reconnecting' }));
    expect(existingHook.result.current.config).toBeNull();

    // Reconnect and mount a brand-new picker hook (Component B).
    act(() => push(DEVICE_LINK_PUSH.STATUS_CHANGED, { status: 'online' }));
    const newlyMountedPicker = await mountHook(() => useDevicesModelGroups(['desk-2']));

    await act(async () => {
      newlyMountedPicker.result.current.read();
    });

    // Both old and new components observe the exact same updated config from 1 shared read.
    expect(newlyMountedPicker.result.current.groups.get('desk-2')?.config?.routes.map(r => r.id)).toEqual([
      'after-reconnect',
    ]);
    expect(existingHook.result.current.config?.routes.map(r => r.id)).toEqual(['after-reconnect']);
    expect(rawInvoke).toHaveBeenCalledTimes(2);

    // Calling read() on Component A reuses the fresh 15s shared snapshot without issuing another IPC call.
    await act(async () => {
      existingHook.result.current.read();
    });
    expect(rawInvoke).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['local policy: transport disabled', '[DEVICE_LINK_CHANNEL_NOT_ALLOWED] Transport disabled by current host policy'],
    ['local policy: untrusted transport', '[DEVICE_LINK_CHANNEL_NOT_ALLOWED] Untrusted transport mode'],
    ['local policy: encrypted required', '[DEVICE_LINK_CHANNEL_NOT_ALLOWED] Encrypted transport required'],
    ['local policy: control disabled', '[DEVICE_LINK_CONTROL_DISABLED] device control is disabled locally'],
    ['non-owner link denial', '[DEVICE_LINK_CHANNEL_NOT_ALLOWED] An account-owned link is required'],
    ['scoped channel denial', "[DEVICE_LINK_CHANNEL_NOT_ALLOWED] channel 'model-groups:get' not allowed"],
    ['other channel allowlist error', "[DEVICE_LINK_CHANNEL_NOT_ALLOWED] channel 'other:channel' not allowed remotely"],
    ['precondition failed', '[PRECONDITION_FAILED] remote model groups require an owner controller'],
    ['permission denied', '[PERMISSION_DENIED] access denied'],
    ['host client capability refusal', '[UNSUPPORTED_CAPABILITY] Capability model-groups:get is not supported in host client mode'],
    ['business not found', '[NOT_FOUND] session not found'],
  ])('keeps unsupported false and allows immediate retry without 15s cooldown after %s', async (_label, message) => {
    const error = new Error(message);
    expect(isModelGroupsUnsupportedError(error)).toBe(false);

    rawInvoke.mockRejectedValueOnce(error).mockResolvedValueOnce({ routes });
    const { result } = await mountHook(() => useDeviceModelGroups('desk-2', true));
    expect(rawInvoke).toHaveBeenCalledTimes(1);
    expect(result.current.unsupported).toBe(false);
    expect(result.current.config).toBeNull();

    await act(async () => {
      result.current.read();
    });
    expect(result.current.config?.routes.map(r => r.id)).toEqual(['daily']);
    expect(rawInvoke).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['peerLinkReset', () => push(DEVICE_LINK_PUSH.PEER_LINK_RESET, { deviceId: 'desk-2' })],
    ['peerLinkReopened', () => push(DEVICE_LINK_PUSH.PEER_LINK_REOPENED, { deviceId: 'desk-2' })],
    ['presenceOffline', () => push(DEVICE_LINK_PUSH.PRESENCE_CHANGED, { deviceId: 'desk-2', online: false })],
    [
      'presenceRemoteDisabled',
      () => push(DEVICE_LINK_PUSH.PRESENCE_CHANGED, { deviceId: 'desk-2', online: true, remoteControlEnabled: false }),
    ],
    [
      'presenceVersionUpgrade',
      () => push(DEVICE_LINK_PUSH.PRESENCE_CHANGED, { deviceId: 'desk-2', online: true, appVersion: '2.1.0' }),
    ],
    [
      'directPathChanged',
      () => push(DEVICE_LINK_PUSH.STATUS_CHANGED, { status: 'online', dataPathChangedDeviceId: 'desk-2' }),
    ],
    ['accessRevoked', () => push(DEVICE_LINK_PUSH.ACCESS_REVOKED, { deviceId: 'desk-2' })],
    [
      'controlTargetChanged',
      () => push(DEVICE_LINK_PUSH.CONTROL_TARGET_CHANGED, { deviceId: 'desk-2', enabled: false }),
    ],
    ['ownershipChanged', () => push(DEVICE_LINK_PUSH.OWNERSHIP_CHANGED, { isOwner: true })],
  ])('asks an upgraded computer again after %s without clearing on routine online heartbeats', async (_label, invalidate) => {
    act(() => push(DEVICE_LINK_PUSH.PRESENCE_CHANGED, { deviceId: 'desk-2', online: true, appVersion: '2.0.0' }));
    rawInvoke.mockRejectedValueOnce(
      new Error("[DEVICE_LINK_CHANNEL_NOT_ALLOWED] channel 'model-groups:get' not allowed remotely"),
    );

    const { result } = await mountHook(() => useDeviceModelGroups('desk-2', true));
    expect(result.current.unsupported).toBe(true);

    // Repeated same-version online pushes do not clear unsupported state.
    await act(async () => {
      push(DEVICE_LINK_PUSH.PRESENCE_CHANGED, { deviceId: 'desk-2', online: true, appVersion: '2.0.0' });
      result.current.read();
    });
    expect(rawInvoke).toHaveBeenCalledTimes(1);

    rawInvoke.mockImplementation(async (_deviceId: string, channel: string) => {
      if (channel === 'maker:provider:list') return validProviderList;
      return { routes };
    });
    act(() => invalidate());
    await act(async () => {
      await prefetchDeviceProviders('desk-2');
    });
    expect(result.current.config?.routes.map(route => route.id)).toEqual(['daily']);
    expect(rawInvoke).toHaveBeenCalledWith('desk-2', 'model-groups:get', []);
  });

  it('ignores a stale pre-reconnect unsupported error after link reset', async () => {
    let rejectStale!: (reason: unknown) => void;
    rawInvoke
      .mockReturnValueOnce(
        new Promise((_, reject) => {
          rejectStale = reject;
        }),
      )
      .mockResolvedValueOnce({ routes });

    const { result } = await mountHook(() => useDeviceModelGroups('desk-2', true));
    expect(rawInvoke).toHaveBeenCalledTimes(1);

    act(() => push(DEVICE_LINK_PUSH.PEER_LINK_RESET, { deviceId: 'desk-2' }));
    await act(async () => {
      rejectStale(new Error("[DEVICE_LINK_CHANNEL_NOT_ALLOWED] channel 'model-groups:get' not allowed remotely"));
    });
    expect(result.current.unsupported).toBe(false);

    await act(async () => {
      result.current.read();
    });
    expect(result.current.config?.routes.map(r => r.id)).toEqual(['daily']);
    expect(rawInvoke).toHaveBeenCalledTimes(2);
  });
});
