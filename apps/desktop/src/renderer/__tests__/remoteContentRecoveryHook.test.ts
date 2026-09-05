// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useRemoteSessionSync } from '../features/cc-agent/hooks/useRemoteSessionSync';

const mocks = vi.hoisted(() => ({ reconcile: vi.fn(async () => true), running: false }));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    reconcileRemoteMessages: mocks.reconcile,
    getSnapshot: () => ({ agentStatus: { isRunning: mocks.running } }),
    subscribe: () => () => {},
    getLastInboundEventAt: () => Date.now(),
  },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn() }),
}));
vi.mock('@/lib/makerTransport', () => ({ isSessionTurnRunningFor: async () => true }));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  remoteProjectsStore: { getDeviceIds: () => ['host'] },
}));
vi.mock('@/features/device-link/refreshRemoteSessions', () => ({
  refreshRemoteDeviceSessions: vi.fn(),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('does not reset a recovered mounted task on its first busy presence update', async () => {
  vi.useFakeTimers();
  let presence!: (snapshot: {
    deviceId: string;
    online: boolean;
    remoteControlEnabled: boolean;
    busy: boolean;
  }) => void;
  vi.stubGlobal('electronAPI', undefined);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      deviceLink: {
        subscribe: async () => {},
        unsubscribe: async () => {},
        onStatusChanged: () => () => {},
        onPresenceChanged: (cb: typeof presence) => {
          presence = cb;
          return () => {};
        },
        onResponsivenessChanged: () => () => {},
      },
    },
  });
  mocks.running = false;
  mocks.reconcile.mockResolvedValue(true);
  const hook = renderHook(() => useRemoteSessionSync('session', 'host'));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(hook.result.current.contentState).toBe('ready');
  mocks.running = true;
  mocks.reconcile.mockResolvedValue(false);
  act(() => presence({ deviceId: 'host', online: true, remoteControlEnabled: true, busy: true }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(hook.result.current.contentState).toBe('ready');
  act(() => presence({ deviceId: 'host', online: false, remoteControlEnabled: true, busy: true }));
  expect(hook.result.current.contentState).toBe('syncing');
  act(() => presence({ deviceId: 'host', online: true, remoteControlEnabled: true, busy: true }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(hook.result.current.contentState).toBe('syncing');
  hook.unmount();
});
