// @vitest-environment jsdom
/**
 * remoteConnectionStatus.test.ts —— 远程会话连接状态派生(控制端 banner 依据)。
 * 本机链路非 online 优先级最高(reconnecting);本机在线但被控端离线 → host-offline;都在线 → connected。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { sharedTaskHostPeer } from '@cindy/device-link';

import { deriveRemoteConnectionStatus, useRemoteSessionConnection, useDeviceLinkConnectionIssue } from '@/features/cc-agent/hooks/useRemoteSessionConnection';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import type { Session } from '@/lib/ccAgent.types';

afterEach(() => { cleanup(); remoteProjectsStore.clear(); Reflect.deleteProperty(window, 'electronAPI'); });

// PR #8182: drive the real banner hook with primary IPC plus shared peer mirror,
// which also supplies the SessionView write gate. No real sockets or waits.
it('uses shared-peer health without inheriting primary relay status or issues', async () => {
  const listeners = new Set<(payload: { status: 'connecting' | 'online' | 'stopped' }) => void>();
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { deviceLink: {
    getState: async () => ({ linkStatus: 'stopped', connectionIssue: { kind: 'auth-failed' } }),
    onStatusChanged: (cb: (payload: { status: 'connecting' | 'online' | 'stopped' }) => void) => { listeners.add(cb); return () => listeners.delete(cb); },
    onConnectionIssue: () => () => {},
  } } });
  const peer = sharedTaskHostPeer('shared-task', 'shared-host');
  remoteProjectsStore.setDeviceSessions(peer, 'Shared', [{ id: 'shared', status: 'active' } as Session]);
  const hook = renderHook(() => ({
    shared: useRemoteSessionConnection(peer),
    ordinary: useRemoteSessionConnection('ordinary-host'),
    issue: useDeviceLinkConnectionIssue(true, peer),
  }));
  await act(async () => {});
  expect(hook.result.current).toEqual({ shared: 'connected', ordinary: 'reconnecting', issue: null });
  await act(async () => { for (const cb of listeners) cb({ status: 'connecting' }); });
  expect(hook.result.current.shared).toBe('connected');
  await act(async () => remoteProjectsStore.markDeviceDisconnected(peer));
  expect(hook.result.current.shared).toBe('host-offline');
  await act(async () => remoteProjectsStore.setDeviceSessions(peer, 'Shared', [{ id: 'shared', status: 'active' } as Session]));
  expect(hook.result.current.shared).toBe('connected');
});

describe('deriveRemoteConnectionStatus', () => {
  it('本机链路非 online → reconnecting(优先级最高,与被控端在线与否无关)', () => {
    expect(deriveRemoteConnectionStatus('connecting', true)).toBe('reconnecting');
    expect(deriveRemoteConnectionStatus('stopped', true)).toBe('reconnecting');
    expect(deriveRemoteConnectionStatus('connecting', false)).toBe('reconnecting');
  });
  it('本机 online + 被控端离线 → host-offline', () => {
    expect(deriveRemoteConnectionStatus('online', false)).toBe('host-offline');
  });
  it('本机 online + 被控端在线 → connected', () => {
    expect(deriveRemoteConnectionStatus('online', true)).toBe('connected');
  });
});
