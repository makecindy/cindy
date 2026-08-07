// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDeviceLinkSettings } from '../useDeviceLinkSettings';

const translate = vi.hoisted(() => (key: string) => key);

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
      onControlledState: subscribe,
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

    await act(async () => {
      state.resolve({
        remoteControlEnabled: true,
        keepAwake: false,
        linkStatus: 'online',
        connectionIssue: null,
        standby: false,
        controlledBy: [],
        revokedControllers: [],
        disabledControlDeviceIds: [],
        unresponsiveDeviceIds: [],
      });
      await state.promise;
    });

    expect(result.current.standby).toBe(true);
    unmount();
  });
});
