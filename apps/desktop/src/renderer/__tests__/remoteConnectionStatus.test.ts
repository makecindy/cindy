// @vitest-environment jsdom
/**
 * remoteConnectionStatus.test.ts —— 远程会话连接状态派生(控制端 banner 依据)。
 * 本机链路非 online 优先级最高(reconnecting);本机在线但被控端离线 → host-offline;都在线 → connected。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { sharedTaskHostPeer } from '@cindy/device-link';

import { deriveRemoteConnectionStatus, useRemoteSessionConnection, useDeviceLinkConnectionIssue, useOutboundProxyVerdict } from '@/features/cc-agent/hooks/useRemoteSessionConnection';
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
  it('keeps the retained direct target writable without treating the other peer or relay as online', async () => {
    type Status = { status: 'connecting' | 'online' | 'stopped'; directDataDeviceIds?: string[]; dataPathChangedDeviceId?: string };
    const listeners = new Set<(status: Status) => void>();
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { deviceLink: {
      getState: async () => ({ linkStatus: 'online', directDataDeviceIds: ['M'] }),
      onStatusChanged: (cb: (status: Status) => void) => { listeners.add(cb); return () => listeners.delete(cb); },
    } } });
    const row = { id: 'task', status: 'active' } as Session;
    remoteProjectsStore.setDeviceSessions('M', 'M', [row]);
    remoteProjectsStore.setDeviceSessions('other', 'Other', [row]);
    const hook = renderHook(() => ({ m: useRemoteSessionConnection('M'), other: useRemoteSessionConnection('other') }));
    await act(async () => {});
    await act(async () => { for (const cb of listeners) cb({ status: 'connecting', directDataDeviceIds: ['M'] }); });
    expect(hook.result.current).toEqual({ m: 'connected', other: 'reconnecting' });
    await act(async () => { for (const cb of listeners) cb({ status: 'connecting', directDataDeviceIds: [], dataPathChangedDeviceId: 'M' }); });
    expect(hook.result.current).toEqual({ m: 'reconnecting', other: 'reconnecting' });
  });
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

describe('useOutboundProxyVerdict (#9537 degraded 诊断)', () => {
  // Issue #9537:连接反复失败只说「设备无响应」,用户无法区分「对端不可达」与「本机网络 /
  // Proxy 问题」。banner 只在 degraded 时探一次出站路径判定,且只把已确证的 kind='proxy'
  // 当事实展示;unknown 是 fail-open 兜底(「没问出判定」≠「确认无代理」),direct / 失败
  // 同样不提示 —— 诊断不得替用户猜。
  it('仅确证 kind=proxy 时给出判定;unknown / 失败 / 非降级一律 null,且不降级不探测', async () => {
    const getProxyVerdict = vi.fn(
      async (): Promise<DeviceLinkProxyVerdict | null> => ({ kind: 'proxy', proxy: 'http://127.0.0.1:7890' }),
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { deviceLink: { getProxyVerdict } },
    });
    const hook = renderHook(
      ({ active, deviceId }: { active: boolean; deviceId?: string }) => useOutboundProxyVerdict(active, deviceId),
      { initialProps: { active: false, deviceId: 'peer-a' } },
    );
    await act(async () => {});
    expect(getProxyVerdict).not.toHaveBeenCalled(); // 非 degraded 不探测
    expect(hook.result.current).toBeNull();

    hook.rerender({ active: true, deviceId: 'peer-a' });
    await act(async () => {});
    expect(getProxyVerdict).toHaveBeenCalledTimes(1);
    // deviceId 一并下发:main 据此取这个对端实际走的 transport URL
    expect(getProxyVerdict).toHaveBeenCalledWith('peer-a');
    expect(hook.result.current).toEqual({ kind: 'proxy', proxy: 'http://127.0.0.1:7890' });

    // unknown(fail-open 兜底)不得当「确认走 Proxy」展示
    getProxyVerdict.mockResolvedValue({ kind: 'unknown', proxy: null });
    hook.rerender({ active: false, deviceId: 'peer-a' });
    await act(async () => {});
    expect(hook.result.current).toBeNull(); // 降级恢复即清空
    hook.rerender({ active: true, deviceId: 'peer-a' });
    await act(async () => {});
    expect(hook.result.current).toBeNull();

    // 探测失败静默 → null(banner 不得因诊断自身报错打扰用户)
    getProxyVerdict.mockRejectedValue(new Error('probe failed'));
    hook.rerender({ active: false, deviceId: 'peer-a' });
    await act(async () => {});
    hook.rerender({ active: true, deviceId: 'peer-a' });
    await act(async () => {});
    expect(hook.result.current).toBeNull();
  });
});
