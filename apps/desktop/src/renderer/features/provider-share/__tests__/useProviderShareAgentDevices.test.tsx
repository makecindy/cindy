// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderShareReceived } from '@cindy/device-link';
import { PROVIDER_SHARE_RECEIVED_CATALOGS_CHANNEL } from '@cindy/device-link';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

import { resetProviderShareStoreForTests } from '../providerShareStore';
import { useProviderShareAgentDevices } from '../useProviderShareAgentDevices';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string; index?: number }) =>
      key === 'providerShare.received.fromOwner'
        ? `from ${options?.name}`
        : key === 'providerShare.picker.numbered'
          ? `${options?.name} (${options?.index})`
          : key,
  }),
}));

const catalog = vi.hoisted(() => ({
  refresh: vi.fn<(deviceId: string) => Promise<void>>(async () => undefined),
  cached: new Set<string>(),
  subscriptions: new Set<string>(),
  stale: new Set<string>(),
}));
vi.mock('@/lib/remoteCatalogSnapshot', () => ({ refreshRemoteCatalogSnapshot: catalog.refresh }));
vi.mock('@/hooks/useDeviceProviders', () => ({
  getCachedDeviceProviders: (deviceId: string) => (catalog.cached.has(deviceId) ? {
    providers: catalog.subscriptions.has(deviceId) ? [{ subscriptionFastPolicy: { allowFast: false } }] : [],
  } : null),
  isSubscriptionShareCatalogStale: (deviceId: string) => catalog.stale.has(deviceId),
  hasSubscriptionShareCatalog: (deviceId: string) => catalog.subscriptions.has(deviceId),
}));

function share(partial: Partial<ProviderShareReceived>): ProviderShareReceived {
  return {
    shareId: 's1',
    memberId: 'm1',
    providerId: 'xd',
    providerLabel: 'Cindy AI',
    hostDeviceId: 'host-1',
    deviceName: "Magi's Mac Mini",
    owner: { displayName: 'Magi', avatarUrl: null, region: 'global' },
    status: 'active',
    hostOnline: true,
    hostCapable: true,
    ...partial,
  };
}

let push: ((list: ProviderShareReceived[]) => void) | null = null;
let catalogPush: ((event: { deviceId: string; channel: string; payload: unknown }) => void) | null = null;
let initial: ProviderShareReceived[] = [];
let linkStatus: ((payload: { status: 'online' | 'connecting' | 'stopped' }) => void) | null = null;
let linkPresence: ((payload: { deviceId: string; online: boolean; remoteControlEnabled: boolean }) => void) | null = null;
let linkPeerReset: ((payload: { deviceId: string }) => void) | null = null;
let linkControlTarget: ((payload: { deviceId: string; enabled: boolean; disabledControlDeviceIds: string[] }) => void) | null = null;
const invoke = vi.fn();
const unavailablePresence = [
  { label: 'offline', online: false, remoteControlEnabled: true },
  { label: 'remote control disabled', online: true, remoteControlEnabled: false },
];

function hostShares(...entries: Array<{ shareId: string; status?: 'active' | 'paused' }>) {
  return { shares: entries.map((entry) => ({
    ...share(entry), agentDeviceId: `share:${entry.shareId}`, catalog: null,
  })) };
}

beforeEach(() => {
  resetProviderShareStoreForTests();
  catalog.refresh.mockClear();
  catalog.cached.clear();
  catalog.subscriptions.clear();
  catalog.stale.clear();
  catalogPush = null;
  push = null;
  initial = [];
  linkStatus = null;
  linkPresence = null;
  linkPeerReset = null;
  linkControlTarget = null;
  invoke.mockReset().mockResolvedValue(hostShares());
  setDataOwnerGeneration('owner', 1);
  Object.assign(window, {
    electronAPI: {
      deviceLink: {
        invoke,
        onRemotePush: (callback: typeof catalogPush) => { catalogPush = callback; return () => { catalogPush = null; }; },
        onStatusChanged: (callback: typeof linkStatus) => {
          linkStatus = callback;
          return () => { linkStatus = null; };
        },
        onPresenceChanged: (callback: typeof linkPresence) => {
          linkPresence = callback;
          return () => { linkPresence = null; };
        },
        onPeerLinkReset: (callback: typeof linkPeerReset) => {
          linkPeerReset = callback;
          return () => { linkPeerReset = null; };
        },
        onControlTargetChanged: (callback: typeof linkControlTarget) => {
          linkControlTarget = callback;
          return () => { linkControlTarget = null; };
        },
      },
      providerShare: {
        command: vi.fn(async () => initial),
        onReceivedChanged: (cb: (list: ProviderShareReceived[]) => void) => {
          push = cb;
          return () => undefined;
        },
      },
    },
  });
});

afterEach(() => cleanup());

describe('useProviderShareAgentDevices', () => {
  it('refreshes an authorized subscription share on catalog invalidation and ignores custom API shares and unrelated peers', async () => {
    initial = [share({ shareId: 'subscription', providerId: 'openai' }), share({ shareId: 'api' })];
    const { result } = renderHook(() => useProviderShareAgentDevices());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    catalog.refresh.mockClear();
    catalog.cached.add('share:subscription'); catalog.cached.add('share:api');
    catalog.subscriptions.add('share:subscription');
    act(() => {
      catalogPush?.({ deviceId: 'share:subscription', channel: 'maker:provider:changed', payload: {} });
      catalogPush?.({ deviceId: 'share:api', channel: 'maker:provider:changed', payload: {} });
      catalogPush?.({ deviceId: 'share:unknown', channel: 'maker:provider:changed', payload: {} });
      catalogPush?.({ deviceId: 'share:subscription', channel: 'maker:event', payload: {} });
    });
    expect(catalog.refresh.mock.calls).toEqual([['share:subscription']]);
    // A failed soft refresh leaves no authoritative cache, but another push
    // must still retry the previously recognized subscription (never API peers).
    catalog.cached.delete('share:subscription');
    act(() => catalogPush?.({ deviceId: 'share:subscription', channel: 'maker:provider:changed', payload: {} }));
    expect(catalog.refresh.mock.calls).toEqual([['share:subscription'], ['share:subscription']]);
  });

  it('refreshes stale subscription catalogs even when a membership snapshot has no changes', async () => {
    initial = [share({ shareId: 'subscription', providerId: 'openai' }), share({ shareId: 'api' })];
    const { result } = renderHook(() => useProviderShareAgentDevices());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    catalog.refresh.mockClear();
    catalog.cached.add('share:subscription');
    catalog.subscriptions.add('share:subscription');
    catalog.stale.add('share:subscription');
    act(() => push?.(initial));
    expect(catalog.refresh.mock.calls).toEqual([['share:subscription']]);
  });
  it('only offers new shares that the controlled host has loaded, even if the controller has more cross-region shares', async () => {
    initial = [share({ shareId: 'both' }), share({ shareId: 'controller-only' })];
    invoke.mockResolvedValue(hostShares({ shareId: 'both' }, { shareId: 'host-only' }));
    const { result } = renderHook(() => useProviderShareAgentDevices([], 'host-b'));
    await waitFor(() => expect(result.current.devices.map((d) => d.deviceId)).toEqual(['share:both']));
    expect(invoke).toHaveBeenCalledWith('host-b', PROVIDER_SHARE_RECEIVED_CATALOGS_CHANNEL, [
      { includeCatalog: false },
    ]);
    // host 的目录暂时读不到(catalog: null)不等于 host 没有加载分享；目录仍走既有分享读取。
    expect(result.current.isReceived('share:controller-only')).toBe(true);
  });

  it('retries a not-yet-ready controlled host instead of caching its transient empty list', async () => {
    initial = [share({ shareId: 'both' })];
    invoke.mockResolvedValueOnce({ ready: false, shares: [] }).mockResolvedValueOnce(hostShares({ shareId: 'both' }));
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useProviderShareAgentDevices([], 'host-b'));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(result.current.devices).toEqual([]);
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(result.current.devices.map((d) => d.deviceId)).toEqual(['share:both']);
      expect(invoke).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps controlled-host shares past the 64-entry catalog limit', async () => {
    initial = Array.from({ length: 130 }, (_, i) => share({ shareId: `s${i}` }));
    invoke.mockResolvedValue(hostShares(
      ...initial.slice(0, 129).map(({ shareId }, i) => ({ shareId, status: i === 65 ? 'paused' as const : 'active' as const })),
      { shareId: 'host-only' },
    ));
    const { result } = renderHook(() => useProviderShareAgentDevices([], 'host-b'));
    await waitFor(() => expect(result.current.devices.map((d) => d.deviceId)).toEqual(
      initial.slice(0, 129).filter((_, i) => i !== 65).map(({ shareId }) => `share:${shareId}`),
    ));
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('uses only known active share identities and never reads the host catalog', async () => {
    initial = ['valid', 'paused', 'unknown-status', 'mismatched', 'missing-status', 'controller-only']
      .map((shareId) => share({ shareId }));
    const readCatalog = vi.fn(() => { throw new Error('Catalog must not be read for identity discovery'); });
    const valid = { shareId: 'valid', agentDeviceId: 'share:valid', status: 'active' };
    Object.defineProperty(valid, 'catalog', { get: readCatalog });
    invoke.mockResolvedValue({ ready: true, shares: [
      null, [], 42, {}, valid,
      { shareId: 'paused', agentDeviceId: 'share:paused', status: 'paused' },
      { shareId: 'unknown-status', agentDeviceId: 'share:unknown-status', status: 'unknown' },
      { shareId: 'mismatched', agentDeviceId: 'share:valid', status: 'active' },
      { shareId: 'missing-status', agentDeviceId: 'share:missing-status' },
      { shareId: 'host-only', agentDeviceId: 'share:host-only', status: 'active' },
    ] });
    const { result } = renderHook(() => useProviderShareAgentDevices([], 'host-b'));
    await waitFor(() => expect(result.current.devices.map((d) => d.deviceId)).toEqual(['share:valid']));
    expect(readCatalog).not.toHaveBeenCalled();
  });

  it('caps readiness backoff and clears the pending retry after recovery', async () => {
    initial = [share({ shareId: 'both' })];
    invoke.mockResolvedValue({ ready: false, shares: [] });
    vi.useFakeTimers();
    try {
      const { result, unmount } = renderHook(() => useProviderShareAgentDevices([], 'host-b'));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(invoke).toHaveBeenCalledTimes(1);
      let calls = 1;
      for (const delay of [250, 500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
        await act(async () => { await vi.advanceTimersByTimeAsync(delay - 1); });
        expect(invoke).toHaveBeenCalledTimes(calls);
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(invoke).toHaveBeenCalledTimes(++calls);
      }
      invoke.mockResolvedValue(hostShares({ shareId: 'both' }));
      await act(async () => { window.dispatchEvent(new Event('focus')); });
      expect(result.current.devices.map((d) => d.deviceId)).toEqual(['share:both']);
      expect(invoke).toHaveBeenCalledTimes(++calls);
      await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
      expect(invoke).toHaveBeenCalledTimes(calls);

      invoke.mockResolvedValue({ ready: false, shares: [] });
      await act(async () => { window.dispatchEvent(new Event('focus')); });
      expect(invoke).toHaveBeenCalledTimes(++calls);
      await act(async () => { await vi.advanceTimersByTimeAsync(249); });
      expect(invoke).toHaveBeenCalledTimes(calls);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(invoke).toHaveBeenCalledTimes(++calls);
      act(() => linkStatus?.({ status: 'stopped' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
      expect(invoke).toHaveBeenCalledTimes(calls);
      await act(async () => { linkStatus?.({ status: 'online' }); });
      expect(invoke).toHaveBeenCalledTimes(++calls);
      unmount();
      await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
      expect(invoke).toHaveBeenCalledTimes(calls);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it.each(['local', 'cross-region'])('offers loaded %s shares while another region is not ready', async (available) => {
    const delayed = available === 'local' ? 'cross-region' : 'local';
    initial = [available, delayed, 'controller-only', 'paused'].map((shareId) => share({ shareId }));
    invoke.mockResolvedValue({
      ready: false,
      ...hostShares({ shareId: available }, { shareId: 'paused', status: 'paused' }),
    });
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useProviderShareAgentDevices([], 'host-b'));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(result.current.devices.map((d) => d.deviceId)).toEqual(['share:' + available]);
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(result.current.devices.map((d) => d.deviceId)).toEqual(['share:' + available]);

      // A partial response still carries authoritative pause/removal updates.
      invoke.mockResolvedValue({ ready: false, ...hostShares({ shareId: available, status: 'paused' }) });
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(result.current.devices).toEqual([]);
      invoke.mockResolvedValue({ ready: true, ...hostShares({ shareId: delayed }) });
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(result.current.devices.map((d) => d.deviceId)).toEqual(['share:' + delayed]);
      await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
      expect(invoke).toHaveBeenCalledTimes(4);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it('keeps current/pending shares while excluding new shares paused or unknown on the controlled host', async () => {
    initial = ['current', 'pending', 'paused', 'unknown'].map((shareId) => share({ shareId }));
    invoke.mockResolvedValue(hostShares({ shareId: 'paused', status: 'paused' }));
    const { result } = renderHook(() => useProviderShareAgentDevices(['share:current', 'share:pending'], 'host-b'));
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(result.current.devices.map((d) => d.deviceId)).toEqual(['share:current', 'share:pending']);
  });

  it.each(['DEVICE_LINK_CHANNEL_NOT_ALLOWED', 'DEVICE_LINK_NOT_CONNECTED'])('does not fall back to controller shares after %s; retries on focus', async (code) => {
    initial = [share({ shareId: 'both' })];
    invoke.mockRejectedValueOnce(new Error(`[${code}] host unavailable`));
    const { result } = renderHook(() => useProviderShareAgentDevices([], 'host-b'));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(result.current.devices).toEqual([]);
    invoke.mockResolvedValue(hostShares({ shareId: 'both' }));
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(result.current.devices).toHaveLength(1));
    invoke.mockResolvedValue(hostShares());
    act(() => push?.([...initial]));
    await waitFor(() => expect(result.current.devices).toEqual([]));
  });

  it('does not use another host’s result or a late disconnected response', async () => {
    initial = [share({ shareId: 'both' })];
    let finish!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { result, rerender } = renderHook(({ host }) => useProviderShareAgentDevices([], host), { initialProps: { host: 'host-b' } });
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    rerender({ host: 'host-c' });
    await act(async () => finish(hostShares({ shareId: 'both' })));
    expect(result.current.devices).toEqual([]);
    invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    act(() => window.dispatchEvent(new Event('focus')));
    act(() => linkStatus?.({ status: 'stopped' }));
    await act(async () => finish(hostShares({ shareId: 'both' })));
    expect(result.current.devices).toEqual([]);
    invoke.mockResolvedValue(hostShares({ shareId: 'both' }));
    act(() => linkStatus?.({ status: 'online' }));
    await waitFor(() => expect(result.current.devices).toHaveLength(1));
  });

  it.each(['DEVICE_LINK_NOT_CONNECTED', 'DEVICE_LINK_PEER_RESET'])('recovers from %s when only the controlled host comes online', async (code) => {
    initial = [share({ shareId: 'both' })];
    invoke.mockRejectedValueOnce(new Error(`[${code}] host unavailable`));
    const { result, unmount } = renderHook(() => useProviderShareAgentDevices([], 'host-b'));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(result.current.devices).toEqual([]);
    invoke.mockResolvedValue(hostShares({ shareId: 'both' }));
    await act(async () => {
      linkPresence?.({ deviceId: 'host-c', online: false, remoteControlEnabled: true });
      linkPresence?.({ deviceId: 'host-c', online: true, remoteControlEnabled: true });
      linkPresence?.({ deviceId: 'host-b', online: false, remoteControlEnabled: true });
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(async () => { linkPresence?.({ deviceId: 'host-b', online: true, remoteControlEnabled: true }); });
    expect(result.current.devices.map((d) => d.deviceId)).toEqual(['share:both']);
    expect(invoke).toHaveBeenCalledTimes(2);
    // Busy/name updates on an already-online peer must not start another query.
    await act(async () => { linkPresence?.({ deviceId: 'host-b', online: true, remoteControlEnabled: true }); });
    expect(invoke).toHaveBeenCalledTimes(2);
    unmount();
    expect(linkPresence).toBeNull();
    expect(linkStatus).toBeNull();
  });

  it.each(unavailablePresence)('ignores an old response after the controlled host recovers from $label', async ({ online, remoteControlEnabled }) => {
    initial = [share({ shareId: 'old' }), share({ shareId: 'new' })];
    let finish!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { result } = renderHook(() => useProviderShareAgentDevices([], 'host-b'));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    act(() => linkPresence?.({ deviceId: 'host-b', online, remoteControlEnabled }));
    invoke.mockResolvedValue(hostShares({ shareId: 'new' }));
    await act(async () => { linkPresence?.({ deviceId: 'host-b', online: true, remoteControlEnabled: true }); });
    expect(result.current.devices.map((d) => d.deviceId)).toEqual(['share:new']);
    await act(async () => finish(hostShares({ shareId: 'old' })));
    expect(result.current.devices.map((d) => d.deviceId)).toEqual(['share:new']);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it.each(unavailablePresence)('pauses readiness retries while the controlled host is $label and resumes on presence', async ({ online, remoteControlEnabled }) => {
    initial = [share({ shareId: 'both' })];
    invoke.mockResolvedValue({ ready: false, ...hostShares({ shareId: 'both' }) });
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useProviderShareAgentDevices([], 'host-b'));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(result.current.devices.map((d) => d.deviceId)).toEqual(['share:both']);
      act(() => linkPresence?.({ deviceId: 'host-b', online, remoteControlEnabled }));
      expect(result.current.devices).toEqual([]);
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(invoke).toHaveBeenCalledTimes(1);
      invoke.mockResolvedValue(hostShares({ shareId: 'both' }));
      await act(async () => { linkPresence?.({ deviceId: 'host-b', online: true, remoteControlEnabled: true }); });
      expect(result.current.devices.map((d) => d.deviceId)).toEqual(['share:both']);
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(invoke).toHaveBeenCalledTimes(2);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it('invalidates and reloads shares when remote control is toggled while the host stays online', async () => {
    initial = [share({ shareId: 'old' }), share({ shareId: 'new' })];
    invoke.mockResolvedValue(hostShares({ shareId: 'old' }));
    const { result } = renderHook(() => useProviderShareAgentDevices([], 'host-b'));
    await waitFor(() => expect(result.current.devices.map((d) => d.deviceId)).toEqual(['share:old']));
    await act(async () => { linkPresence?.({ deviceId: 'host-b', online: true, remoteControlEnabled: true }); });
    invoke.mockClear();
    await act(async () => {
      linkPresence?.({ deviceId: 'host-b', online: true, remoteControlEnabled: false });
      linkPresence?.({ deviceId: 'host-b', online: true, remoteControlEnabled: false });
      window.dispatchEvent(new Event('focus'));
    });
    expect(result.current.devices).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockResolvedValue(hostShares({ shareId: 'new' }));
    await act(async () => { linkPresence?.({ deviceId: 'host-b', online: true, remoteControlEnabled: true }); });
    expect(result.current.devices.map((d) => d.deviceId)).toEqual(['share:new']);
    await act(async () => { linkPresence?.({ deviceId: 'host-b', online: true, remoteControlEnabled: true }); });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('rejects an in-flight result after an account generation change', async () => {
    initial = [share({ shareId: 'both' })];
    let finish!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { result } = renderHook(() => useProviderShareAgentDevices([], 'host-b'));
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    setDataOwnerGeneration('another-owner', 2);
    await act(async () => finish(hostShares({ shareId: 'both' })));
    expect(result.current.devices).toEqual([]);
  });

  it('retries a failed share query on peer reset without relay or presence changes', async () => {
    initial = [share({ shareId: 'both' })];
    invoke.mockRejectedValueOnce(new Error('[DEVICE_LINK_PEER_RESET] peer reset'));
    const { result, unmount } = renderHook(() => useProviderShareAgentDevices([], 'host-b'));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    invoke.mockResolvedValue(hostShares({ shareId: 'both' }));
    await act(async () => {
      linkPeerReset?.({ deviceId: 'host-c' });
      linkControlTarget?.({ deviceId: 'host-c', enabled: false, disabledControlDeviceIds: ['host-c'] });
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(async () => { linkPeerReset?.({ deviceId: 'host-b' }); });
    expect(result.current.devices.map((d) => d.deviceId)).toEqual(['share:both']);
    expect(invoke).toHaveBeenCalledTimes(2);
    unmount();
    expect(linkPeerReset).toBeNull();
    expect(linkControlTarget).toBeNull();
  });

  it.each(['peer reset', 'local control disabled'])('ignores an old share response after %s recovery', async (reason) => {
    initial = [share({ shareId: 'old' }), share({ shareId: 'new' })];
    let finish!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { result } = renderHook(() => useProviderShareAgentDevices([], 'host-b'));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    invoke.mockResolvedValue(hostShares({ shareId: 'new' }));
    await act(async () => {
      if (reason === 'peer reset') linkPeerReset?.({ deviceId: 'host-b' });
      else {
        linkControlTarget?.({ deviceId: 'host-b', enabled: false, disabledControlDeviceIds: ['host-b'] });
        linkControlTarget?.({ deviceId: 'host-b', enabled: true, disabledControlDeviceIds: [] });
      }
    });
    expect(result.current.devices.map((d) => d.deviceId)).toEqual(['share:new']);
    await act(async () => finish(hostShares({ shareId: 'old' })));
    expect(result.current.devices.map((d) => d.deviceId)).toEqual(['share:new']);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('pauses queries while local control is disabled and resumes when enabled', async () => {
    initial = [share({ shareId: 'both' })];
    invoke.mockResolvedValue({ ready: false, ...hostShares({ shareId: 'both' }) });
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useProviderShareAgentDevices([], 'host-b'));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(result.current.devices.map((d) => d.deviceId)).toEqual(['share:both']);
      act(() => linkControlTarget?.({ deviceId: 'host-b', enabled: false, disabledControlDeviceIds: ['host-b'] }));
      expect(result.current.devices).toEqual([]);
      await act(async () => {
        linkPeerReset?.({ deviceId: 'host-b' });
        linkPresence?.({ deviceId: 'host-b', online: true, remoteControlEnabled: true });
        linkStatus?.({ status: 'online' });
        window.dispatchEvent(new Event('focus'));
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(invoke).toHaveBeenCalledTimes(1);
      invoke.mockResolvedValue(hostShares({ shareId: 'both' }));
      await act(async () => {
        linkControlTarget?.({ deviceId: 'host-b', enabled: true, disabledControlDeviceIds: [] });
      });
      expect(result.current.devices.map((d) => d.deviceId)).toEqual(['share:both']);
      await act(async () => {
        linkControlTarget?.({ deviceId: 'host-b', enabled: true, disabledControlDeviceIds: [] });
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(invoke).toHaveBeenCalledTimes(2);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it.each(['relay offline', 'peer unavailable'])('does not query on peer reset or local enable while %s', async (reason) => {
    initial = [share({ shareId: 'both' })];
    invoke.mockResolvedValue(hostShares({ shareId: 'both' }));
    const { result } = renderHook(() => useProviderShareAgentDevices([], 'host-b'));
    await waitFor(() => expect(result.current.devices).toHaveLength(1));
    await act(async () => {
      if (reason === 'relay offline') linkStatus?.({ status: 'connecting' });
      else linkPresence?.({ deviceId: 'host-b', online: false, remoteControlEnabled: true });
      linkPeerReset?.({ deviceId: 'host-b' });
      linkControlTarget?.({ deviceId: 'host-b', enabled: true, disabledControlDeviceIds: [] });
      window.dispatchEvent(new Event('focus'));
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result.current.devices).toEqual([]);
    await act(async () => {
      if (reason === 'relay offline') linkStatus?.({ status: 'online' });
      else linkPresence?.({ deviceId: 'host-b', online: true, remoteControlEnabled: true });
    });
    expect(result.current.devices.map((d) => d.deviceId)).toEqual(['share:both']);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('names shares by owner only (numbering repeats), never by the sharer’s computer', async () => {
    initial = [
      share({ shareId: 'a' }),
      share({ shareId: 'b', status: 'paused', deviceName: 'Studio' }),
      share({ shareId: 'c', providerLabel: 'Anthropic', deviceName: 'Laptop' }),
    ];
    const { result } = renderHook(() => useProviderShareAgentDevices());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.devices).toEqual([
      { deviceId: 'share:a', name: 'from Magi' },
      { deviceId: 'share:c', name: 'from Magi' },
    ]);
    // 同一位分享者的同一个供应商第二份加序号；暂停的也算在内，序号不因暂停而变。
    expect(result.current.nameFor('share:b')).toBe('from Magi (2)');
    expect(JSON.stringify(result.current.devices)).not.toMatch(/Mac Mini|Studio|Laptop/);
    expect(result.current.nameFor('device-123')).toBeNull();
    expect(result.current.isKnown('share:b')).toBe(true);
    expect(result.current.isKnown('share:zzz')).toBe(false);
    expect(result.current.isReceived('share:b')).toBe(true);
    expect(result.current.isReceived('share:zzz')).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps the current paused or removed share so the task can see and leave it', async () => {
    initial = [share({ shareId: 'paused', status: 'paused' })];
    const { result } = renderHook(() => useProviderShareAgentDevices(['share:paused', 'share:gone', 'device-1']));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.devices.map((device) => device.deviceId)).toEqual(['share:paused', 'share:gone']);
    expect(result.current.devices[1].name).toBe('providerShare.picker.unavailable');
  });

  it('does not treat the not-yet-loaded list as removed', () => {
    Object.assign(window.electronAPI.providerShare, { command: vi.fn(() => new Promise(() => undefined)) });
    const { result } = renderHook(() => useProviderShareAgentDevices(['share:x']));
    expect(result.current.loaded).toBe(false);
    expect(result.current.isKnown('share:x')).toBe(true);
    expect(result.current.isReceived('share:x')).toBe(false);
    expect(result.current.devices).toEqual([]);
  });

  it('treats the empty list pushed on disconnect as temporarily unknown, not removed', async () => {
    initial = [share({ shareId: 'a' })];
    const { result } = renderHook(() => useProviderShareAgentDevices(['share:a']));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    catalog.cached.add('share:a');
    act(() => push?.([]));
    expect(catalog.refresh).not.toHaveBeenCalled();
    expect(result.current.isKnown('share:a')).toBe(true);
  });

  it('refreshes catalogs of shares whose availability changed and of cached removed shares', async () => {
    initial = [share({ shareId: 'a' }), share({ shareId: 'b' }), share({ shareId: 'c' })];
    const { result } = renderHook(() => useProviderShareAgentDevices());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    catalog.cached.add('share:c');
    act(() => push?.([share({ shareId: 'a' }), share({ shareId: 'b', hostOnline: false })]));
    expect(catalog.refresh.mock.calls.map(([deviceId]) => deviceId).sort()).toEqual(['share:b', 'share:c']);
    expect(result.current.devices.map((device) => device.deviceId)).toEqual(['share:a', 'share:b']);
  });
});
