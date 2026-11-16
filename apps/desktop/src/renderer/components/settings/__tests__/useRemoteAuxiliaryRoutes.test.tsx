// @vitest-environment jsdom
// Unit: execution capabilities and device catalogs must agree before a remote route can be saved.
// Existing picker tests mock the selector and cannot detect a stale or forged capability response.
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
  const devices = [
    { deviceId: 'a', name: 'A', online: true, platform: 'macos' },
    { deviceId: 'b', name: 'B', online: true, platform: 'macos' },
  ];
  const provider = { id: 'same', name: 'Same', agents: ['pi'], connected: true, remoteInvocationEnabled: true,
    models: { pi: [{ id: 'model', name: 'Model', contextWindow: 1024, efforts: [], defaultEffort: null, mode: 'chat', defaultEnabled: true }] }, routing: {} };
  const catalogs = new Map(devices.map((device) => [device.deviceId, { providers: [provider], loading: false, error: null }]));
  return { devices, catalogs, empty: new Map(), invoke: vi.fn() };
});
vi.mock('@/hooks/useControllableDevices', () => ({ useSelectableDevices: () => ({ devices: fixture.devices, loaded: true }) }));
vi.mock('@/hooks/useDevicesProviders', () => ({ useDevicesProviders: (ids: string[]) => ids.length ? fixture.catalogs : fixture.empty }));

import { useRemoteAuxiliaryRoutes } from '../useRemoteAuxiliaryRoutes';

describe('remote auxiliary routes', () => {
  beforeEach(() => {
    fixture.invoke.mockReset();
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { deviceLink: { invoke: fixture.invoke } } });
  });

  it('only admits the exact device and route returned by validated caps', async () => {
    fixture.invoke.mockImplementation(async (id: string) => ({ version: 1, op: 'caps', ok: true, hostEpoch: 'epoch',
      allowedRoutes: id === 'a' ? [{ providerId: 'same', agentKind: 'pi', model: 'model' }] : [] }));
    const { result } = renderHook(() => useRemoteAuxiliaryRoutes(true));
    await waitFor(() => expect(result.current.encode('a', 'same', 'pi', 'model')).not.toBeNull());
    expect(result.current.encode('b', 'same', 'pi', 'model')).toBeNull();
    expect(result.current.encode('a', 'same', 'codex', 'model')).toBeNull();
  });

  it('reuses in-flight and completed reads across presence rerenders and refreshes only the changed catalog', async () => {
    let finishA!: (value: unknown) => void;
    fixture.invoke.mockImplementation((id: string) => id === 'a' && fixture.invoke.mock.calls.filter((call) => call[0] === 'a').length === 1
      ? new Promise((resolve) => { finishA = resolve; })
      : Promise.resolve({ version: 1, op: 'caps', ok: true, hostEpoch: 'epoch', allowedRoutes: [] }));
    const { rerender } = renderHook(() => useRemoteAuxiliaryRoutes(true));
    await waitFor(() => expect(fixture.invoke).toHaveBeenCalledTimes(2));
    fixture.devices = [...fixture.devices];
    rerender();
    expect(fixture.invoke).toHaveBeenCalledTimes(2);
    finishA({ version: 1, op: 'caps', ok: true, hostEpoch: 'epoch', allowedRoutes: [] });
    await waitFor(() => expect(fixture.invoke).toHaveBeenCalledTimes(2));
    const a = fixture.catalogs.get('a')!;
    fixture.catalogs = new Map(fixture.catalogs).set('a', { ...a, providers: [...a.providers] });
    rerender();
    await waitFor(() => expect(fixture.invoke).toHaveBeenCalledTimes(3));
    expect(fixture.invoke.mock.calls.filter((call) => call[0] === 'b')).toHaveLength(1);
  });

  it('reports a proven old version separately from revoked access', async () => {
    fixture.invoke.mockImplementation((id: string) => id === 'a'
      ? Promise.reject(new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] unsupported'))
      : Promise.resolve({ version: 1, op: 'error', ok: false, code: 'UNAUTHORIZED' }));
    const { result } = renderHook(() => useRemoteAuxiliaryRoutes(true));
    await waitFor(() => expect(result.current.statuses.map((item) => item.status)).toEqual(['outdated', 'revoked']));
  });

  it('fails closed for malformed capability payloads and does not fetch while closed', async () => {
    fixture.invoke.mockResolvedValue({ version: 1, op: 'caps', ok: true, hostEpoch: 'epoch', allowedRoutes: 'invalid' });
    const { result, rerender } = renderHook(({ open }) => useRemoteAuxiliaryRoutes(open), { initialProps: { open: false } });
    expect(fixture.invoke).not.toHaveBeenCalled();
    rerender({ open: true });
    await waitFor(() => expect(fixture.invoke).toHaveBeenCalledTimes(2));
    expect(result.current.encode('a', 'same', 'pi', 'model')).toBeNull();
  });
});
