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

it('requires a fresh ACK and snapshot after peer-only resets without invalidating neighbors', async () => {
  vi.useFakeTimers();
  const resets = new Set<(payload: { deviceId: string }) => void>();
  const subscribe = vi.fn(async () => {});
  vi.stubGlobal('electronAPI', {
    deviceLink: {
      subscribe,
      unsubscribe: async () => {},
      onStatusChanged: () => () => {},
      onPresenceChanged: () => () => {},
      onResponsivenessChanged: () => () => {},
      onPeerLinkReset: (cb: (payload: { deviceId: string }) => void) => {
        resets.add(cb);
        return () => resets.delete(cb);
      },
    },
  });
  mocks.running = false;
  mocks.reconcile.mockResolvedValue(true);
  const affected = renderHook(() => useRemoteSessionSync('session', 'host'));
  const neighbor = renderHook(() => useRemoteSessionSync('neighbor-session', 'neighbor'));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(affected.result.current.contentState).toBe('ready');
  expect(neighbor.result.current.contentState).toBe('ready');

  let ack!: () => void;
  let oldSnapshot!: (value: boolean) => void;
  let newSnapshot!: (value: boolean) => void;
  subscribe.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        ack = resolve;
      }),
  );
  mocks.reconcile
    .mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          oldSnapshot = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          newSnapshot = resolve;
        }),
    );
  const callsBeforeReset = mocks.reconcile.mock.calls.length;
  await act(async () => {
    resets.forEach((cb) => cb({ deviceId: 'host' }));
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(affected.result.current.contentState).toBe('syncing');
  expect(neighbor.result.current.contentState).toBe('ready');
  expect(mocks.reconcile).toHaveBeenCalledTimes(callsBeforeReset);
  await act(async () => {
    ack();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(affected.result.current.contentState).toBe('syncing');
  await act(async () => {
    resets.forEach((cb) => cb({ deviceId: 'host' }));
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    oldSnapshot(true);
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(affected.result.current.contentState).toBe('syncing');
  expect(neighbor.result.current.contentState).toBe('ready');
  await act(async () => {
    newSnapshot(true);
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(affected.result.current.contentState).toBe('ready');
  affected.unmount();
  neighbor.unmount();
  expect(resets.size).toBe(0);
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
