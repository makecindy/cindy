// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useDeviceLinkReconnectEpoch } from '../useDeviceLinkReconnectEpoch';

type PresenceListener = (snapshot: DeviceLinkPresenceSnapshot) => void;
type StatusListener = (
  payload: { status: 'stopped' | 'connecting' | 'online' },
) => void;

let presenceListener: PresenceListener | null;
let statusListener: StatusListener | null;
const offPresence = vi.fn();
const offStatus = vi.fn();

describe('useDeviceLinkReconnectEpoch', () => {
  beforeEach(() => {
    presenceListener = null;
    statusListener = null;
    offPresence.mockClear();
    offStatus.mockClear();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        deviceLink: {
          onPresenceChanged: vi.fn((listener: PresenceListener) => {
            presenceListener = listener;
            return offPresence;
          }),
          onStatusChanged: vi.fn((listener: StatusListener) => {
            statusListener = listener;
            return offStatus;
          }),
        },
      },
    });
  });

  it('bumps only when the relay or selected target recovers online', () => {
    const { result } = renderHook(() => useDeviceLinkReconnectEpoch('device-1'));
    expect(result.current).toBe(0);

    act(() => statusListener?.({ status: 'connecting' }));
    expect(result.current).toBe(0);
    act(() => statusListener?.({ status: 'online' }));
    expect(result.current).toBe(1);
    act(() => statusListener?.({ status: 'online' }));
    expect(result.current).toBe(1);

    act(() => presenceListener?.(presence('device-2', true)));
    expect(result.current).toBe(1);
    act(() => presenceListener?.(presence('device-1', true)));
    expect(result.current).toBe(2);
    act(() => presenceListener?.(presence('device-1', true)));
    expect(result.current).toBe(2);
    act(() => presenceListener?.(presence('device-1', false)));
    expect(result.current).toBe(2);
    act(() => presenceListener?.(presence('device-1', true)));
    expect(result.current).toBe(3);
  });

  it('does not subscribe without a target and cleans up listeners', () => {
    const api = window.electronAPI.deviceLink;
    const initialProps: { deviceId: string | undefined } = {
      deviceId: undefined,
    };
    const { rerender, unmount } = renderHook(
      ({ deviceId }: { deviceId: string | undefined }) =>
        useDeviceLinkReconnectEpoch(deviceId),
      { initialProps },
    );
    expect(api.onPresenceChanged).not.toHaveBeenCalled();
    expect(api.onStatusChanged).not.toHaveBeenCalled();

    rerender({ deviceId: 'device-1' });
    expect(api.onPresenceChanged).toHaveBeenCalledOnce();
    expect(api.onStatusChanged).toHaveBeenCalledOnce();
    unmount();
    expect(offPresence).toHaveBeenCalledOnce();
    expect(offStatus).toHaveBeenCalledOnce();
  });
});

function presence(deviceId: string, online: boolean): DeviceLinkPresenceSnapshot {
  return {
    deviceId,
    online,
    deviceName: deviceId,
    platform: 'darwin',
    appVersion: '1.0.0',
    lastSeenAt: Date.now(),
    remoteControlEnabled: true,
    busy: false,
  };
}
