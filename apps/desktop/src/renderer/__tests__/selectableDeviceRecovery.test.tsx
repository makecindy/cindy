// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSelectableDevices } from '@/hooks/useControllableDevices';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';

type LinkStatus = 'stopped' | 'connecting' | 'online';
type Directory = { devices: DeviceLinkDeviceView[]; displayBudget?: { remainingMs: number } };

function device(overrides: Partial<DeviceLinkDeviceView> = {}): DeviceLinkDeviceView {
  return {
    deviceId: 'studio-pc', name: 'Studio PC', platform: 'linux',
    appVersion: '0.0.0-test', lastSeenAt: null, busy: false,
    online: false, remoteControlEnabled: false, controlEnabled: true, isSelf: false,
    ...overrides,
  };
}

// The device directory is one store per renderer, started once and bound to the preload bridge for
// the renderer's lifetime, so the file installs one bridge and starts the store once.
function bridge() {
  const statuses = new Set<(payload: { status: LinkStatus }) => void>();
  const presences = new Set<(payload: DeviceLinkPresenceSnapshot) => void>();
  const controls = new Set<() => void>();
  const listDevices = vi.fn<() => Promise<Directory>>();
  vi.stubGlobal('electronAPI', {
    deviceLink: {
      listDevices,
      getState: vi.fn().mockResolvedValue({ linkStatus: 'online' }),
      onStatusChanged: vi.fn((fn: (payload: { status: LinkStatus }) => void) => {
        statuses.add(fn); return () => statuses.delete(fn);
      }),
      onPresenceChanged: vi.fn((fn: (payload: DeviceLinkPresenceSnapshot) => void) => {
        presences.add(fn); return () => presences.delete(fn);
      }),
      onControlTargetChanged: vi.fn((fn: () => void) => {
        controls.add(fn); return () => controls.delete(fn);
      }),
    },
  });
  return {
    listDevices,
    status: (status: LinkStatus) => act(() => statuses.forEach((fn) => fn({ status }))),
    controls: () => act(() => controls.forEach((fn) => fn())),
    onlinePresence: () => act(() => presences.forEach((fn) => fn({
      deviceId: 'studio-pc', deviceName: 'Studio PC', platform: 'linux',
      appVersion: '0.0.0-test', lastSeenAt: 1000, online: true,
      remoteControlEnabled: true, busy: false,
    }))),
  };
}
let api: ReturnType<typeof bridge>;

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

function deferred() {
  let resolve!: (value: Directory) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Directory>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeAll(async () => {
  api = bridge();
  api.listDevices.mockResolvedValue({ devices: [] });
  const { unmount } = renderHook(useDeviceLinkDeviceList);
  await flush();
  unmount();
});
afterAll(() => { vi.unstubAllGlobals(); });
// Every case starts from a signed-out account (the relay stopped) and then mounts the picker and
// brings the relay online, as signing in does.
beforeEach(() => {
  vi.useFakeTimers();
  api.status('stopped');
  api.listDevices.mockReset();
});
afterEach(() => {
  cleanup(); vi.clearAllTimers(); vi.useRealTimers();
});
async function mountOnline<T>(hook: () => T) {
  const rendered = renderHook(hook);
  api.status('online');
  await flush();
  return rendered;
}

describe('new-task device picker recovery', () => {
  it('refreshes a stale offline row on relay reconnect without a new presence event', async () => {
    api.listDevices.mockResolvedValueOnce({ devices: [device()] })
      .mockResolvedValue({ devices: [device({ online: true, remoteControlEnabled: true })] });
    const { result } = await mountOnline(useSelectableDevices);
    expect(result.current.devices[0]?.online).toBe(false);
    api.status('online');
    await flush();
    expect(result.current.loaded).toBe(true);
    expect(result.current.devices[0]?.online).toBe(true);
  });

  it('retains cached rows on failure and retries without another push', async () => {
    api.listDevices.mockResolvedValueOnce({ devices: [device()] })
      .mockRejectedValueOnce(new Error('temporary directory failure'))
      .mockResolvedValue({ devices: [device({ online: true, remoteControlEnabled: true })] });
    const { result } = await mountOnline(useSelectableDevices);
    api.onlinePresence();
    await flush();
    expect(result.current.loaded).toBe(false);
    expect(result.current.devices[0]?.online).toBe(false);
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(result.current.loaded).toBe(true);
    expect(result.current.devices[0]?.online).toBe(true);
  });

  it('shares one directory read with the sidebar and keeps another peer usable', async () => {
    const mac = device({ deviceId: 'office-mac', name: 'Office Mac', platform: 'darwin',
      online: true, remoteControlEnabled: true });
    api.listDevices.mockResolvedValueOnce({ devices: [device(), mac] })
      .mockResolvedValue({ devices: [device({ online: true, remoteControlEnabled: true }), mac] });
    const { result } = await mountOnline(() => ({
      picker: useSelectableDevices(), sidebar: useDeviceLinkDeviceList(),
    }));
    expect(api.listDevices).toHaveBeenCalledTimes(1);
    expect(result.current.picker.devices.find((d) => d.deviceId === 'office-mac')?.online).toBe(true);
    api.onlinePresence();
    await flush();
    expect(api.listDevices).toHaveBeenCalledTimes(2);
    expect(result.current.picker.devices.every((d) => d.online)).toBe(true);
    expect(result.current.sidebar?.every((d) => d.online)).toBe(true);
  });

  it('clears the rows when Device Link stops and drops the late response', async () => {
    const pending = deferred();
    api.listDevices.mockResolvedValueOnce({ devices: [device()] })
      .mockReturnValueOnce(pending.promise);
    const { result } = await mountOnline(useSelectableDevices);
    api.controls();
    await flush();
    api.status('stopped');
    await flush();
    expect(result.current.devices).toEqual([]);
    pending.resolve({ devices: [device({ online: true, remoteControlEnabled: true })] });
    await flush();
    expect(result.current.devices).toEqual([]);
    expect(result.current.loaded).toBe(true);
  });

  it.each(['resolve', 'reject'] as const)('ignores a superseded response that later %ss', async (finish) => {
    const old = deferred();
    api.listDevices.mockReturnValueOnce(old.promise).mockResolvedValue({ devices: [] });
    const { result } = await mountOnline(useSelectableDevices);
    api.controls();
    await flush();
    expect(result.current).toEqual({ devices: [], loaded: true });
    if (finish === 'resolve') old.resolve({ devices: [device()] });
    else old.reject(new Error('superseded failure'));
    await flush();
    expect(result.current).toEqual({ devices: [], loaded: true });
  });

  it('does not treat a failed first read as an authoritative empty directory', async () => {
    api.listDevices.mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue({ devices: [] });
    const { result } = await mountOnline(useSelectableDevices);
    expect(result.current).toEqual({ devices: [], loaded: false });
    api.controls();
    await flush();
    expect(result.current).toEqual({ devices: [], loaded: true });
  });

  it('keeps the rows and stays loaded while an unrelated refresh revalidates', async () => {
    const studio = device({ online: true, remoteControlEnabled: true });
    const phone = device({ deviceId: 'phone', name: 'Phone', platform: 'ios' });
    const pending = deferred();
    api.listDevices.mockResolvedValueOnce({ devices: [studio, phone] })
      .mockReturnValueOnce(pending.promise);
    const { result } = await mountOnline(useSelectableDevices);
    const rows = result.current.devices;
    expect(result.current.loaded).toBe(true);
    // A refresh that cannot change the selectable computers (here the phone coming
    // online) must not look like a reload: consumers probe every row again on a new
    // array or a loaded=false flip.
    api.controls();
    await flush();
    expect(result.current.loaded).toBe(true);
    expect(result.current.devices).toBe(rows);
    pending.resolve({ devices: [studio, { ...phone, online: true }] });
    await flush();
    expect(result.current.loaded).toBe(true);
    expect(result.current.devices).toBe(rows);
  });

  it('keeps a way back to this computer when the directory expires and the re-read fails', async () => {
    api.listDevices
      .mockResolvedValueOnce({
        devices: [device({ online: true, remoteControlEnabled: true })],
        displayBudget: { remainingMs: 1000 },
      })
      .mockRejectedValue(new Error('directory unavailable'));
    const { result } = await mountOnline(useSelectableDevices);
    expect(result.current.devices[0]?.online).toBe(true);
    await act(async () => { vi.advanceTimersByTime(1500); });
    await flush();
    // The expired rows stay listed (offline, not selectable) so the switcher, and
    // with it the way back to this computer, does not disappear; nothing is
    // authoritative until a read succeeds.
    expect(result.current).toEqual({
      devices: [{ deviceId: 'studio-pc', name: 'Studio PC', platform: 'linux', online: false }],
      loaded: false,
    });
  });
});
