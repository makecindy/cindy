// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderShareReceived } from '@cindy/device-link';

import { resetProviderShareStoreForTests } from '../providerShareStore';
import { useProviderShareAgentDevices } from '../useProviderShareAgentDevices';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { device?: string; owner?: string }) =>
      key === 'providerShare.picker.deviceName' ? `${options?.device} · from ${options?.owner}` : key,
  }),
}));

const catalog = vi.hoisted(() => ({
  refresh: vi.fn<(deviceId: string) => Promise<void>>(async () => undefined),
  cached: new Set<string>(),
}));
vi.mock('@/lib/remoteCatalogSnapshot', () => ({ refreshRemoteCatalogSnapshot: catalog.refresh }));
vi.mock('@/hooks/useDeviceProviders', () => ({
  getCachedDeviceProviders: (deviceId: string) => (catalog.cached.has(deviceId) ? { providers: [] } : null),
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
let initial: ProviderShareReceived[] = [];

beforeEach(() => {
  resetProviderShareStoreForTests();
  catalog.refresh.mockClear();
  catalog.cached.clear();
  push = null;
  initial = [];
  Object.assign(window, {
    electronAPI: {
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
  it('lists active shares under the "device · from owner" name and resolves names', async () => {
    initial = [share({ shareId: 'a' }), share({ shareId: 'b', status: 'paused', deviceName: 'Studio' })];
    const { result } = renderHook(() => useProviderShareAgentDevices());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.devices).toEqual([{ deviceId: 'share:a', name: "Magi's Mac Mini · from Magi" }]);
    expect(result.current.nameFor('share:b')).toBe('Studio · from Magi');
    expect(result.current.nameFor('device-123')).toBeNull();
    expect(result.current.isKnown('share:b')).toBe(true);
    expect(result.current.isKnown('share:zzz')).toBe(false);
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
