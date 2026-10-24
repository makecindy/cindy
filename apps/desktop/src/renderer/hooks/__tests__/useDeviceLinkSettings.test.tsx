// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
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

  // 服务端以「在线」拒绝删除(409 → ALREADY_EXISTS)：列出 target 后点删除，返回 remove() 的结果。
  async function removeAfterOnlineRejection(
    onlineBefore: boolean,
    refreshed: 'offline' | 'online' | 'gone' | 'fails' | 'never returns',
  ) {
    const off = vi.fn();
    const subscribe = vi.fn(() => off);
    const listed = (online: boolean) => ({
      devices: [{ deviceId: 'target', name: 'MacBook', platform: 'darwin', appVersion: null, lastSeenAt: null,
        online, busy: false, remoteControlEnabled: false, controlEnabled: true, isSelf: false }],
    });
    const listDevices = vi.fn().mockResolvedValueOnce(listed(onlineBefore));
    if (refreshed === 'fails') listDevices.mockRejectedValue(new Error('[INTERNAL] list failed'));
    else if (refreshed === 'never returns') listDevices.mockReturnValue(new Promise<never>(() => {}));
    else if (refreshed === 'gone') listDevices.mockResolvedValue({ devices: [] });
    else listDevices.mockResolvedValue(listed(refreshed === 'online'));
    const api = {
      getState: vi.fn(() => new Promise<never>(() => {})),
      listDevices,
      deleteDevice: vi.fn().mockRejectedValue(new Error('[ALREADY_EXISTS] device is online')),
      onOwnershipChanged: subscribe,
      onPresenceChanged: subscribe,
      onStatusChanged: subscribe,
      onConnectionIssue: subscribe,
      onControlledState: subscribe,
      onControlTargetChanged: subscribe,
    };
    (window as unknown as { electronAPI: { deviceLink: typeof api } }).electronAPI = { deviceLink: api };
    const { result, unmount } = renderHook(() => useDeviceLinkSettings());
    await waitFor(() => expect(result.current.devices).toHaveLength(1));

    vi.useFakeTimers();
    let deleted: boolean | undefined;
    try {
      await act(async () => {
        const removing = result.current.remove('target').then((value) => { deleted = value; });
        // 「一直不返回」靠超时收口；其余情况不需要推进时间也已结束。
        await vi.advanceTimersByTimeAsync(60_000);
        await removing;
      });
    } finally {
      vi.useRealTimers();
    }
    expect(api.listDevices).toHaveBeenCalledTimes(2);
    unmount();
    return deleted;
  }

  // 被拒后先刷新列表再选提示，提示要跟此刻界面上的列表一致：仍显示离线的设备不能再提示「尚不
  // 支持移除在线设备」；点删除时与刷新后状态不同，以刷新后的为准。刷新一直不返回时界面仍是原
  // 列表，按原列表选提示；刷新失败时界面换成错误块，沿用原提示。没有截止时间的请求也不能让
  // 删除一直不返回。
  it.each([
    [false, 'offline', 'settings.devices.toast.deleteRejectedWhileOffline'],
    [true, 'online', 'settings.devices.toast.deleteOnline'],
    [false, 'online', 'settings.devices.toast.deleteOnline'],
    [true, 'offline', 'settings.devices.toast.deleteRejectedWhileOffline'],
    [false, 'fails', 'settings.devices.toast.deleteOnline'],
    [false, 'never returns', 'settings.devices.toast.deleteRejectedWhileOffline'],
    [true, 'never returns', 'settings.devices.toast.deleteOnline'],
  ] as const)('explains an online rejection by the refreshed list (online before: %s, refresh: %s)', async (onlineBefore, refreshed, message) => {
    expect(await removeAfterOnlineRejection(onlineBefore, refreshed)).toBe(false);
    expect(effects.error).toHaveBeenCalledWith(message);
    expect(effects.removeDevice).not.toHaveBeenCalled();
  });

  // 被拒之后设备被别处删掉：刷新后的列表里已经没有它，界面那一行已消失。确认框要按已删除关闭，
  // 不能报「在线设备」错误、留下一个指向不存在设备的确认框。
  it('closes as deleted when the refreshed list no longer has the device', async () => {
    expect(await removeAfterOnlineRejection(false, 'gone')).toBe(true);
    expect(effects.success).toHaveBeenCalledWith('settings.devices.toast.deleted');
    expect(effects.removeDevice).toHaveBeenCalledWith('target');
    expect(effects.error).not.toHaveBeenCalled();
  });
});
