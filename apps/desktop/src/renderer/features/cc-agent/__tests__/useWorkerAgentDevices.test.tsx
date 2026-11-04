// @vitest-environment jsdom
/**
 * 协同 Worker 面板与任务输入框共用被控电脑的来源名单，包括控制端自身和仅主机加载的分享。
 * 旧主机继续沿用直接读取与可读性限制。
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useWorkerAgentDevices } from '../hooks/useWorkerAgentDevices';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { evictAllDeviceProviders, useDeviceProviders } from '@/hooks/useDeviceProviders';
import { evictAllRemoteCapabilities, useAgentCapabilities } from '@/hooks/useAgentCapabilities';
import { modelCatalogKey } from '../../../../shared/controlledModelCatalog';
import { __resetAvailableAgentsCacheForTest, useAvailableAgents } from '@/hooks/useAvailableAgents';

const mocks = vi.hoisted(() => ({
  selfDeviceId: 'self-pc' as string | null,
  devices: [] as Array<{ deviceId: string; name: string; online: boolean }>,
  received: [] as Array<{ deviceId: string; name: string }>,
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ deviceId: mocks.selfDeviceId }),
}));
vi.mock('@/hooks/useControllableDevices', () => ({
  useSelectableDevices: () => ({ devices: mocks.devices }),
}));
vi.mock('@/features/provider-share/useProviderShareAgentDevices', () => ({
  useProviderShareAgentDevices: () => ({
    devices: mocks.received,
    isReceived: (id: string | null | undefined) => mocks.received.some((share) => share.deviceId === id),
  }),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  evictAllDeviceProviders();
  evictAllRemoteCapabilities();
  __resetAvailableAgentsCacheForTest();
  vi.unstubAllGlobals();
  mocks.devices = [];
  mocks.received = [];
  setDataOwnerGeneration(null);
});

describe('useWorkerAgentDevices', () => {
  // PR #8028 review r4429879562 / unit: a single failed push refresh must not
  // leave B's source menu empty until an unrelated event. Existing cases only
  // recover after another push. Use the mounted production route and fake time.
  it('retries a transient refresh without another push or disturbing another host', async () => {
    vi.useFakeTimers();
    const listeners = new Set<(event: { deviceId: string; channel: string }) => void>();
    const invoke = vi.fn(async (host: string) => ({ locations: [{ agentDeviceId: `${host}-source`, name: 'Source' }] }));
    vi.stubGlobal('electronAPI', { deviceLink: { invoke, onRemotePush: (listener: (event: { deviceId: string; channel: string }) => void) => {
      listeners.add(listener); return () => listeners.delete(listener);
    } } });
    const b = renderHook(() => useWorkerAgentDevices({ controlledDeviceId: 'host-b', leadAgentDeviceId: null }));
    const d = renderHook(() => useWorkerAgentDevices({ controlledDeviceId: 'host-d', leadAgentDeviceId: null }));
    await act(async () => {});
    const healthy = d.result.current;
    invoke.mockClear();
    invoke.mockRejectedValueOnce(new Error('[DEVICE_LINK_TIMEOUT] timed out'));
    await act(async () => {
      for (const push of listeners) push({ deviceId: 'host-b', channel: 'maker:provider:changed' });
    });
    expect(b.result.current.devices).toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(b.result.current.devices).toEqual([{ deviceId: 'host-b-source', name: 'Source' }]);
    expect(d.result.current).toBe(healthy);
    expect(invoke.mock.calls.map(([host]) => host)).toEqual(['host-b', 'host-b']);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it.each(['unmount', 'host', 'owner', 'offline'] as const)('cancels a pending location retry on %s change', async change => {
    vi.useFakeTimers();
    let status!: (event: { status: string }) => void;
    const invoke = vi.fn().mockRejectedValue(new Error('[DEVICE_LINK_TIMEOUT] timed out'));
    vi.stubGlobal('electronAPI', { deviceLink: { invoke, onStatusChanged: (listener: typeof status) => { status = listener; return () => {}; } } });
    const view = renderHook(({ host }) => useWorkerAgentDevices({ controlledDeviceId: host, leadAgentDeviceId: null }), {
      initialProps: { host: 'host-b' },
    });
    await act(async () => {});
    invoke.mockResolvedValue({ locations: [{ agentDeviceId: 'fresh', name: 'Fresh' }] });
    if (change === 'unmount') view.unmount();
    else if (change === 'host') view.rerender({ host: 'host-c' });
    else if (change === 'owner') setDataOwnerGeneration('next-account');
    else act(() => status({ status: 'connecting' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(invoke.mock.calls.map(([host]) => host)).toEqual(change === 'host' ? ['host-b', 'host-c'] : ['host-b']);
    if (change === 'host') expect(view.result.current.devices).toEqual([{ deviceId: 'fresh', name: 'Fresh' }]);
  });

  it('bounds failed discovery attempts and still recovers on a later focus', async () => {
    vi.useFakeTimers();
    const invoke = vi.fn().mockRejectedValue(new Error('[DEVICE_LINK_TIMEOUT] timed out'));
    vi.stubGlobal('electronAPI', { deviceLink: { invoke } });
    mocks.received = [{ deviceId: 'share:controller-only', name: 'Private' }];
    const { result } = renderHook(() => useWorkerAgentDevices({ controlledDeviceId: 'host', leadAgentDeviceId: null }));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(result.current.catalogHostDeviceId).toBe('host');
    expect(result.current.devices).toEqual([]);
    invoke.mockResolvedValue({ locations: [{ agentDeviceId: 'recovered', name: 'Recovered' }] });
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(result.current.devices).toEqual([{ deviceId: 'recovered', name: 'Recovered' }]);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(invoke).toHaveBeenCalledTimes(4);
  });

  it.each(['DEVICE_LINK_CHANNEL_NOT_ALLOWED', 'ACCESS_REVOKED', 'DEVICE_UNRESPONSIVE'])('does not retry %s location errors', async code => {
    vi.useFakeTimers();
    const invoke = vi.fn().mockRejectedValue(new Error(`[${code}] unavailable`));
    vi.stubGlobal('electronAPI', { deviceLink: { invoke } });
    renderHook(() => useWorkerAgentDevices({ controlledDeviceId: 'host', leadAgentDeviceId: null }));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  // #8010 / unit: mounted production route + provider/capability hooks, with only
  // the transport faked. Earlier cases did not exercise refresh of live consumers.
  // Review gap: local provider/agent events must invalidate A's catalog and runtime roster via B.
  // Minimum input: B using A, an unrelated host/source, plus B's home catalog.
  it.each(['peer reset', 'local providers', 'local agents'])('refreshes B source catalogs after %s without evicting B home or an unrelated task host', async trigger => {
    const resetListeners = new Set<(event: { deviceId: string }) => void>();
    const providerListeners = new Set<() => void>();
    const agentListeners = new Set<() => void>();
    let revision = 1;
    const invoke = vi.fn(async (host: string, channel: string, args: unknown[]) => {
      if (channel === 'maker:model-catalog:read') {
        const request = args[0] as { op: string; channel: string };
        if (request.op === 'locations') return { locations: [{ agentDeviceId: host === 'host-d' ? 'other-pc' : 'self-pc', name: 'Source' }] };
        channel = request.channel;
      }
      if (channel === 'maker:get-capabilities') return {
        availableModels: [{ id: 'model', displayName: `${host}:${revision}`, contextWindow: 1000, efforts: [], defaultEffort: null }],
        hasFastMode: false, effortLevels: [], permissionModes: [],
      };
      if (channel === 'maker:list-available-agents') return revision === 1 ? ['claude-code', 'pi'] : ['claude-code'];
      if (channel === 'maker:provider:list') return { providers: [{
        id: 'provider', name: `${host}:${revision}`, source: 'user', agents: ['claude-code'],
        auth: { method: 'none' }, routing: { 'claude-code': { upstream: 'https://example.invalid', authStrategy: 'none' } },
        models: { 'claude-code': [] }, connected: true,
      }] };
      throw new Error(`unexpected channel: ${channel}`);
    });
    vi.stubGlobal('electronAPI', { maker: {
      onProvidersChanged: (listener: () => void) => { providerListeners.add(listener); return () => providerListeners.delete(listener); },
      onAgentsChanged: (listener: () => void) => { agentListeners.add(listener); return () => agentListeners.delete(listener); },
    }, deviceLink: {
      invoke, onPeerLinkReset: (listener: (event: { deviceId: string }) => void) => {
        resetListeners.add(listener); return () => resetListeners.delete(listener);
      },
    } });
    const useSource = (host: string) => {
      const source = host === 'host-d' ? 'other-pc' : 'self-pc';
      const route = useWorkerAgentDevices({ controlledDeviceId: host, leadAgentDeviceId: source });
      const key = modelCatalogKey(source, route.catalogHostDeviceId);
      return { providers: useDeviceProviders(key), caps: useAgentCapabilities('claude-code', key), roster: useAvailableAgents(key) };
    };
    const b = renderHook(() => useSource('host-b'));
    const d = renderHook(() => useSource('host-d'));
    const home = renderHook(() => useDeviceProviders('host-b'));
    await act(async () => {});
    expect(b.result.current.providers.providers[0].name).toBe('host-b:1');
    expect(b.result.current.caps.capabilities?.availableModels[0].displayName).toBe('host-b:1');
    expect(b.result.current.roster.availableVendors.has('pi')).toBe(true);
    const dSnapshot = d.result.current;
    const homeSnapshot = home.result.current;
    invoke.mockClear();
    revision = 2;
    await act(async () => {
      if (trigger === 'peer reset') for (const reset of resetListeners) reset({ deviceId: 'host-b' });
      else for (const refresh of trigger === 'local providers' ? providerListeners : agentListeners) refresh();
    });
    expect(b.result.current.providers.providers[0].name).toBe('host-b:2');
    expect(b.result.current.caps.capabilities?.availableModels[0].displayName).toBe('host-b:2');
    expect(b.result.current.roster.loaded).toBe(true);
    expect(b.result.current.roster.availableVendors.has('pi')).toBe(false);
    expect(d.result.current).toBe(dSnapshot);
    expect(home.result.current).toBe(homeSnapshot);
    expect(invoke.mock.calls.every(([host, channel]) => host === 'host-b' && channel === 'maker:model-catalog:read')).toBe(true);
    b.unmount(); d.unmount(); home.unmount();
    expect(providerListeners.size).toBe(0);
    expect(agentListeners.size).toBe(0);
  });

  // #8010 review / unit: a degraded directory confirms shares, not missing PCs.
  // Retain prior PC names but apply actual share removals, then complete revocation.
  it.each(['complete', 'host switch'])('retains known computers during degradation, then applies %s without stale sources', async next => {
    let push!: (event: { deviceId: string; channel: string }) => void;
    const invoke = vi.fn().mockResolvedValue({ status: 'complete', locations: [
      { agentDeviceId: 'source-pc', name: 'Source PC' },
      { agentDeviceId: 'share:revoked', name: 'Old share' },
    ] });
    vi.stubGlobal('electronAPI', { deviceLink: { invoke, onRemotePush: (listener: typeof push) => { push = listener; return () => {}; } } });
    const { result, rerender } = renderHook(({ host }) => useWorkerAgentDevices({ controlledDeviceId: host, leadAgentDeviceId: null }), {
      initialProps: { host: 'host-b' },
    });
    await act(async () => {});
    invoke.mockResolvedValue({ status: 'degraded', locations: [{ agentDeviceId: 'share:new', name: 'New share' }] });
    await act(async () => { push({ deviceId: 'host-b', channel: 'maker:model-catalog:changed' }); });
    expect(result.current.devices).toEqual([
      { deviceId: 'source-pc', name: 'Source PC' }, { deviceId: 'share:new', name: 'New share' },
    ]);
    if (next === 'host switch') {
      rerender({ host: 'host-c' });
      await act(async () => {});
      expect(result.current.devices).toEqual([{ deviceId: 'share:new', name: 'New share' }]);
    } else {
      invoke.mockResolvedValue({ status: 'complete', locations: [] });
      await act(async () => { push({ deviceId: 'host-b', channel: 'maker:model-catalog:changed' }); });
      expect(result.current.devices).toEqual([]);
      invoke.mockResolvedValue({ status: 'degraded', locations: [] });
      await act(async () => { push({ deviceId: 'host-b', channel: 'maker:model-catalog:changed' }); });
      expect(result.current.devices).toEqual([]);
    }
  });

  it('coalesces pushes during discovery, drops the stale response and removes subscriptions on unmount', async () => {
    const listeners = new Set<(event: { deviceId: string; channel: string }) => void>();
    let finish!: (value: unknown) => void;
    const invoke = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue({ locations: [{ agentDeviceId: 'fresh', name: 'Fresh' }] });
    vi.stubGlobal('electronAPI', { deviceLink: { invoke, onRemotePush: (listener: (event: { deviceId: string; channel: string }) => void) => {
      listeners.add(listener); return () => listeners.delete(listener);
    } } });
    const { result, unmount } = renderHook(() => useWorkerAgentDevices({
      controlledDeviceId: 'host', leadAgentDeviceId: 'self-pc', pendingAgentDeviceId: 'share:pending',
    }));
    await act(async () => {
      for (let i = 0; i < 3; i++) for (const push of listeners) push({ deviceId: 'host', channel: 'maker:model-catalog:changed' });
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ locations: [{ agentDeviceId: 'stale', name: 'Stale' }] }); });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result.current.devices?.map(device => device.deviceId)).toEqual(['fresh', 'self-pc', 'share:pending']);
    unmount();
    expect(listeners.size).toBe(0);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('never substitutes controller sources after an initial network failure', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('[DEVICE_LINK_UNREACHABLE] offline'));
    vi.stubGlobal('electronAPI', { deviceLink: { invoke } });
    mocks.received = [{ deviceId: 'share:controller-only', name: 'Private' }];
    const { result } = renderHook(() => useWorkerAgentDevices({ controlledDeviceId: 'host', leadAgentDeviceId: 'self-pc' }));
    await act(async () => {});
    expect(result.current).toEqual({ catalogHostDeviceId: 'host', leadAgentDeviceId: 'self-pc',
      devices: [{ deviceId: 'self-pc', name: 'self-pc' }],
    });
  });
  // #8010, unit: use the real route discovery hook, not controller received shares.
  // The old tests below exercise only the legacy-host fallback.
  it('uses B sources including self and B-only shares, and clears revoked sources without falling back to A', async () => {
    let push!: (event: { deviceId: string; channel: string }) => void;
    const favoriteSource = { shareId: 'only-host', memberId: 'member-b', providerId: 'shared', owner: { region: 'global' } };
    const invoke = vi.fn().mockResolvedValue({ locations: [
      { agentDeviceId: 'self-pc', name: 'A' },
      { agentDeviceId: 'share:only-host', name: 'B share', favoriteSource },
    ] });
    vi.stubGlobal('electronAPI', { deviceLink: { invoke, onRemotePush: (listener: typeof push) => { push = listener; return () => {}; } } });
    const { result } = renderHook(() => useWorkerAgentDevices({ controlledDeviceId: 'host', leadAgentDeviceId: 'self-pc' }));
    await act(async () => {});
    expect(result.current).toEqual({ catalogHostDeviceId: 'host', leadAgentDeviceId: 'self-pc', devices: [
      { deviceId: 'self-pc', name: 'A' }, { deviceId: 'share:only-host', name: 'B share', favoriteSource },
    ] });
    expect(invoke).toHaveBeenCalledWith('host', 'maker:model-catalog:read', [{ op: 'locations' }]);
    await act(async () => { push({ deviceId: 'unrelated', channel: 'maker:provider:changed' }); });
    expect(invoke).toHaveBeenCalledTimes(1);
    mocks.received = [{ deviceId: 'share:only-controller', name: 'A share' }];
    invoke.mockRejectedValue(new Error('disconnected'));
    await act(async () => { push({ deviceId: 'host', channel: 'maker:model-catalog:changed' }); });
    expect(result.current.catalogHostDeviceId).toBe('host');
    expect(result.current.devices).toEqual([{ deviceId: 'self-pc', name: 'self-pc' }]);
    invoke.mockResolvedValue({ locations: [] });
    await act(async () => { push({ deviceId: 'host', channel: 'maker:model-catalog:changed' }); });
    expect(result.current.devices).toEqual([{ deviceId: 'self-pc', name: 'self-pc' }]);
  });

  it('ignores a late host response after switching task computer or account', async () => {
    let finish!: (value: unknown) => void;
    const invoke = vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    vi.stubGlobal('electronAPI', { deviceLink: { invoke } });
    const { result, rerender } = renderHook(({ host }) => useWorkerAgentDevices({ controlledDeviceId: host, leadAgentDeviceId: null }), {
      initialProps: { host: 'host-b' },
    });
    const finishB = finish;
    rerender({ host: 'host-c' });
    await act(async () => { finishB({ locations: [{ agentDeviceId: 'old', name: 'Old' }] }); });
    expect(result.current.devices).not.toContainEqual({ deviceId: 'old', name: 'Old' });
    setDataOwnerGeneration('next-account');
    await act(async () => { finish({ locations: [{ agentDeviceId: 'old', name: 'Old' }] }); });
    expect(result.current.devices).toEqual([]);
  });

  it('falls back only when the old host explicitly rejects the catalog channel', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] old host'));
    vi.stubGlobal('electronAPI', { deviceLink: { invoke } });
    mocks.devices = [{ deviceId: 'office', name: 'Office', online: true }];
    const { result } = renderHook(() => useWorkerAgentDevices({ controlledDeviceId: 'host', leadAgentDeviceId: null }));
    await act(async () => {});
    expect(result.current).toEqual({ leadAgentDeviceId: null, devices: [{ deviceId: 'office', name: 'Office' }] });
  });

  it('lists online computers and received shares for a Lead on this computer', () => {
    mocks.devices = [
      { deviceId: 'office', name: 'Office', online: true },
      { deviceId: 'studio', name: 'Studio', online: false },
    ];
    mocks.received = [{ deviceId: 'share:s1', name: 'Anthropic · Alice' }];
    const { result } = renderHook(() =>
      useWorkerAgentDevices({ controlledDeviceId: null, leadAgentDeviceId: 'studio' }),
    );
    expect(result.current).toEqual({
      leadAgentDeviceId: 'studio',
      // 当前位置掉线也保留，换得回来。
      devices: [
        { deviceId: 'office', name: 'Office' },
        { deviceId: 'studio', name: 'Studio' },
        { deviceId: 'share:s1', name: 'Anthropic · Alice' },
      ],
    });
  });

  it('offers nothing before the Lead is resolved or for an SSH Lead', () => {
    const invoke = vi.fn();
    vi.stubGlobal('electronAPI', { deviceLink: { invoke } });
    mocks.devices = [{ deviceId: 'office', name: 'Office', online: true }];
    expect(renderHook(() =>
      useWorkerAgentDevices({ controlledDeviceId: undefined, leadAgentDeviceId: undefined }),
    ).result.current).toEqual({ leadAgentDeviceId: null, devices: undefined });
    expect(renderHook(() =>
      useWorkerAgentDevices({ controlledDeviceId: 'host', leadAgentDeviceId: null, sshRemote: true }),
    ).result.current.devices).toBeUndefined();
    renderHook(() => useWorkerAgentDevices({ controlledDeviceId: null, leadAgentDeviceId: null }));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps the controlled computer's catalog when this computer cannot read the Lead's location", () => {
    mocks.devices = [{ deviceId: 'office', name: 'Office', online: true }];
    // Lead 的 Agent 就在控制端自己：设备互联连不到自己。
    expect(renderHook(() =>
      useWorkerAgentDevices({ controlledDeviceId: 'host', leadAgentDeviceId: 'self-pc' }),
    ).result.current).toEqual({ leadAgentDeviceId: null, devices: undefined });
    // 只有被控电脑收到的分享。
    expect(renderHook(() =>
      useWorkerAgentDevices({ controlledDeviceId: 'host', leadAgentDeviceId: 'share:only-host' }),
    ).result.current).toEqual({ leadAgentDeviceId: null, devices: undefined });
  });

  it.each([null, 'share:s1'])('lists all received shares for a controlled Lead running at %s', (lead) => {
    mocks.devices = [
      { deviceId: 'host', name: 'Host', online: true },
      { deviceId: 'office', name: 'Office', online: true },
    ];
    mocks.received = [
      { deviceId: 'share:s1', name: 'Anthropic · Alice' },
      { deviceId: 'share:s2', name: 'OpenAI · Bob' },
    ];
    const { result } = renderHook(() =>
      useWorkerAgentDevices({ controlledDeviceId: 'host', leadAgentDeviceId: lead }),
    );
    expect(result.current).toEqual({
      leadAgentDeviceId: lead,
      devices: [
        { deviceId: 'office', name: 'Office' },
        { deviceId: 'share:s1', name: 'Anthropic · Alice' },
        { deviceId: 'share:s2', name: 'OpenAI · Bob' },
      ],
    });
  });
});
