// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDeviceLinkSettings } from '../useDeviceLinkSettings';

const translate = vi.hoisted(() => (key: string) => key);
const effects = vi.hoisted(() => ({ removeDevice: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({ remoteProjectsStore: { removeDevice: effects.removeDevice } }));
vi.mock('@/lib/toast', () => ({ toast: { success: effects.success, error: effects.error } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  vi.clearAllMocks();
});

describe('useDeviceLinkSettings ownership state', () => {
  it('keeps a newer ownership push when the initial getState snapshot resolves late', async () => {
    type State = Awaited<ReturnType<typeof window.electronAPI.deviceLink.getState>>;
    const state = deferred<State>();
    let controlledChanged:
      ((payload: { controllers: { deviceId: string; name: string }[] }) => void) | undefined;
    let ownershipChanged: ((payload: { standby: boolean }) => void) | undefined;
    const off = vi.fn();
    const subscribe = vi.fn(() => off);
    const api = {
      getState: vi.fn(() => state.promise),
      listDevices: vi.fn(async () => ({ devices: [] })),
      onOwnershipChanged: vi.fn((callback: (payload: { standby: boolean }) => void) => {
        ownershipChanged = callback;
        return off;
      }),
      onPresenceChanged: subscribe,
      onStatusChanged: subscribe,
      onConnectionIssue: subscribe,
      onControlledState: vi.fn((callback: typeof controlledChanged) => {
        controlledChanged = callback;
        return off;
      }),
      onControlTargetChanged: subscribe,
    };
    (window as unknown as { electronAPI: { deviceLink: typeof api } }).electronAPI = {
      deviceLink: api,
    };

    const { result, unmount } = renderHook(() => useDeviceLinkSettings());

    expect(api.onOwnershipChanged.mock.invocationCallOrder[0]).toBeLessThan(
      api.getState.mock.invocationCallOrder[0],
    );
    act(() => ownershipChanged?.({ standby: true }));
    expect(result.current.standby).toBe(true);
    act(() => controlledChanged?.({ controllers: [{ deviceId: 'mac', name: 'MacBook' }] }));

    await act(async () => {
      state.resolve({
        remoteControlEnabled: true,
        keepAwake: false,
        linkStatus: 'online',
        connectionIssue: null,
        standby: false,
        controlledBy: [
          { deviceId: 'mac', name: 'MacBook' },
          { deviceId: 'phone', name: 'Phone' },
        ],
        revokedControllers: [],
        disabledControlDeviceIds: [],
        unresponsiveDeviceIds: [],
      });
      await state.promise;
    });

    expect(result.current.standby).toBe(true);
    expect(result.current.controlledBy).toEqual([{ deviceId: 'mac', name: 'MacBook' }]);
    unmount();
  });
});


describe('useDeviceLinkSettings deletion', () => {
  it.each(['refused', 'wrong-device', 'error', 'deleted'] as const)('clears cached remote sessions only on confirmed success: %s', async outcome => {
    const deleteDevice = outcome === 'error' ? vi.fn().mockRejectedValue(new Error('offline'))
      : vi.fn().mockResolvedValue({ deviceId: outcome === 'wrong-device' ? 'other' : 'target', deleted: outcome !== 'refused' });
    const api = { deleteDevice };
    (window as unknown as { electronAPI: { deviceLink: typeof api } }).electronAPI = { deviceLink: api };
    const { result, unmount } = renderHook(() => useDeviceLinkSettings(false));
    let deleted = false;
    await act(async () => { deleted = await result.current.remove('target'); });
    expect(deleted).toBe(outcome === 'deleted');
    if (deleted) {
      expect(effects.removeDevice).toHaveBeenCalledWith('target');
      expect(effects.success).toHaveBeenCalledWith('settings.devices.toast.deleted');
    } else {
      expect(effects.removeDevice).not.toHaveBeenCalled();
      expect(effects.error).toHaveBeenCalledWith('settings.devices.toast.deleteFailed');
    }
    unmount();
  });
});
