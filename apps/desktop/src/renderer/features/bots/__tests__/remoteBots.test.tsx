// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  owner: 'owner-a',
  devices: [] as any[],
  invoke: vi.fn(),
  status: null as any,
  push: null as any,
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ dataOwnerId: h.owner, isAuthenticated: true }),
}));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: () => h.devices,
}));
vi.mock('@/lib/remoteDataOwnerPushFence', () => ({ isDeviceLinkRemotePushCurrent: () => true }));
import { useRemoteBotSync, useRemoteBots, markRemoteBotRead } from '../useRemoteBots';
import { parseRemoteCollectionListRequest } from '@cindy/device-link';
import { parseRemoteBots, remoteBotKey, isRemoteBotUnread } from '../remoteBotRoster';
const host = (deviceId: string, online = true) => ({
  deviceId,
  name: deviceId,
  online,
  isSelf: false,
  controlEnabled: true,
  remoteControlEnabled: true,
});
const collection = (name = 'Writer') => ({
  collectionId: 'teammates',
  items: [
    {
      ref: { collectionId: 'teammates', kind: 'bot', id: 'same-bot' },
      display: { title: name },
      links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'canonical' } }],
    },
  ],
});
function useRoster() {
  useRemoteBotSync();
  return useRemoteBots();
}
beforeEach(() => {
  h.owner = `owner-${Math.random()}`;
  h.devices = [host('a'), host('b')];
  h.invoke.mockReset().mockResolvedValue(collection());
  vi.stubGlobal('electronAPI', undefined);
  window.electronAPI = {
    deviceLink: {
      invoke: h.invoke,
      getState: vi.fn().mockResolvedValue({ linkStatus: 'online' }),
      onStatusChanged: (fn: any) => {
        h.status = fn;
        return () => {};
      },
      onRemotePush: (fn: any) => {
        h.push = fn;
        return () => {};
      },
    },
  } as any;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe('remote teammate roster', () => {
  it('keeps identical bot ids on two hosts distinct and retains only the offline host as offline', async () => {
    const { result, rerender } = renderHook(useRoster);
    await waitFor(() => expect(result.current).toHaveLength(2));
    expect(new Set(result.current.map(remoteBotKey)).size).toBe(2);
    for (const call of h.invoke.mock.calls)
      expect(parseRemoteCollectionListRequest(call[2][0])).not.toBeNull();
    h.devices = [host('a', false), host('b')];
    rerender();
    expect(result.current.find((b) => b.deviceId === 'b')?.online).toBe(true);
    await waitFor(() => expect(result.current.find((b) => b.deviceId === 'b')?.online).toBe(true));
    expect(result.current.find((b) => b.deviceId === 'a')?.online).toBe(false);
    h.devices = [host('a'), host('b')];
    rerender();
    await waitFor(() => expect(result.current.every((b) => b.online)).toBe(true));
  });
  it('rejects a late reply after the relay stops', async () => {
    let finish!: (value: unknown) => void;
    h.invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { result } = renderHook(useRoster);
    await waitFor(() => expect(h.invoke).toHaveBeenCalled());
    act(() => h.status({ status: 'stopped' }));
    await act(async () => finish(collection()));
    expect(result.current).toEqual([]);
  });
  it('drops the previous account and its late response', async () => {
    let finish!: (value: unknown) => void;
    h.invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { result, rerender } = renderHook(useRoster);
    await waitFor(() => expect(h.invoke).toHaveBeenCalled());
    h.owner = 'new-account';
    h.devices = [];
    rerender();
    await act(async () => finish(collection('Old account')));
    expect(result.current).toEqual([]);
  });
  it('an unsupported older host cannot erase a working host', async () => {
    h.invoke.mockImplementation((id) =>
      id === 'a' ? Promise.reject(new Error('CHANNEL_NOT_ALLOWED')) : Promise.resolve(collection()),
    );
    const { result } = renderHook(useRoster);
    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0].deviceId).toBe('b');
  });
  it('rejects another resource kind instead of treating it as a writable companion', () => {
    const wrong = collection();
    wrong.items[0].ref.kind = 'document';
    expect(() => parseRemoteBots(wrong, 'a', 'A')).toThrow();
  });
});


it('does not let a late initial online state undo a stopped relay push', async () => {
  let finish!: (state: unknown) => void;
  (window.electronAPI.deviceLink.getState as any).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  renderHook(useRoster);
  act(() => h.status({ status: 'stopped' }));
  await act(async () => finish({ linkStatus: 'online' }));
  expect(h.invoke).not.toHaveBeenCalled();
});
it('keeps cached companions offline on reconnect and preserves device-qualified unread state', async () => {
  const withReply = (at: number) => { const value = collection(); Object.assign(value.items[0].display, { lastReplyAt: at }); return value; };
  h.invoke.mockResolvedValue(withReply(100));
  const { result } = renderHook(useRoster);
  await waitFor(() => expect(result.current).toHaveLength(2));
  expect(result.current.some(isRemoteBotUnread)).toBe(false);
  act(() => h.status({ status: 'reconnecting' }));
  expect(result.current.every((bot) => !bot.online)).toBe(true);
  h.invoke.mockResolvedValue(withReply(200));
  act(() => h.status({ status: 'online' }));
  await waitFor(() => expect(result.current.every(isRemoteBotUnread)).toBe(true));
  act(() => markRemoteBotRead('a', 'same-bot', 200));
  expect(isRemoteBotUnread(result.current.find((bot) => bot.deviceId === 'a')!)).toBe(false);
  expect(isRemoteBotUnread(result.current.find((bot) => bot.deviceId === 'b')!)).toBe(true);
});
