// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  owner: 'owner-a',
  devices: [] as any[],
  invoke: vi.fn(),
  cloudEnabled: false,
  copies: vi.fn(),
  status: null as any,
  push: null as any,
}));
vi.mock('../companionCloudStore', () => ({
  useCompanionCloud: () => ({ enabled: h.cloudEnabled, actors: [] }),
  companionCloudApi: () => ({ listCindyCopies: h.copies }),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ dataOwnerId: h.owner, isAuthenticated: true }),
}));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: () => h.devices,
}));
vi.mock('@/lib/remoteDataOwnerPushFence', () => ({ isDeviceLinkRemotePushCurrent: () => true }));
import { useRemoteBotSync, useRemoteBots, useRemoteCindyIds, markRemoteBotRead } from '../useRemoteBots';
import { parseRemoteCollectionListRequest, REMOTE_RESOURCE_LIST_CHANNEL, REMOTE_RESOURCE_CHANGED_CHANNEL } from '@cindy/device-link';
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
  h.cloudEnabled = false;
  h.copies.mockReset();
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
    for (const call of h.invoke.mock.calls.filter(call => call[1] === REMOTE_RESOURCE_LIST_CHANNEL))
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

it('does not reinterpret a resource read error as device disconnection', async () => {
  h.devices = [host('reachable')];
  h.invoke.mockResolvedValue(collection());
  const { result } = renderHook(useRoster);
  await waitFor(() => expect(result.current).toHaveLength(1));
  expect(result.current[0].online).toBe(true);
  h.invoke.mockRejectedValue(new Error('model/resource failure'));
  act(() => h.status({ status: 'online' }));
  await waitFor(() => expect(h.invoke.mock.calls.filter(call => call[1] === REMOTE_RESOURCE_LIST_CHANNEL)).toHaveLength(2));
  expect(result.current[0].online).toBe(true);
  act(() => h.status({ status: 'stopped' }));
  expect(result.current[0].online).toBe(false);
  expect(result.current[0].connectionKnown).toBe(true);
});

it('parses exact following links without confusing them with the canonical conversation', () => {
  const response = collection();
  response.items[0].links.push(
    { rel: 'following', target: { kind: 'session', sessionId: 'taken-over' } },
    { rel: 'following', target: { kind: 'session', sessionId: 'taken-over' } },
    { rel: 'following', target: { kind: 'resource', sessionId: 'not-a-task' } },
  );
  expect(parseRemoteBots(response, 'a', 'Laptop')[0]).toMatchObject({
    sessionId: 'canonical', followingSessionIds: ['taken-over'],
  });
  expect(parseRemoteBots(collection(), 'a', 'Laptop')[0]).toMatchObject({
    followingSessionIds: [],
  });
});

// Regression: released hosts advertise teammates without any created-task links.
it('hydrates exact creation attribution through the existing task-card API on each computer', async () => {
  h.invoke.mockImplementation(async (device, channel) => channel === REMOTE_RESOURCE_LIST_CHANNEL
    ? collection() : { ok: true, delegations: [
      { requestingBotId: 'same-bot', childSessionId: `${device}-child` },
      { requestingBotId: 'same-bot', childSessionId: `${device}-child` },
      { requestingBotId: 'someone-else', childSessionId: 'not-owned' },
      { requestingBotId: 'same-bot', childSessionId: null },
    ] });
  const { result } = renderHook(useRoster);
  await waitFor(() => expect(result.current.map(bot => bot.delegatedSessionIds)).toEqual([['a-child'], ['b-child']]));
  expect(h.invoke).toHaveBeenCalledWith('a', 'maker:bot-delegations:list', ['canonical']);
  expect(h.invoke).toHaveBeenCalledWith('b', 'maker:bot-delegations:list', ['canonical']);
});

it('refreshes creation attribution on a delegation push, keeps it on failure and clears it on a successful empty read', async () => {
  h.devices = [host('a')];
  let response: unknown = { ok: true, delegations: [{ requestingBotId: 'same-bot', childSessionId: 'child' }] };
  h.invoke.mockImplementation(async (_device, channel) => channel === REMOTE_RESOURCE_LIST_CHANNEL ? collection() : response);
  const { result } = renderHook(useRoster);
  await waitFor(() => expect(result.current[0]?.delegatedSessionIds).toEqual(['child']));
  const taskReads = () => h.invoke.mock.calls.filter(call => call[1] === 'maker:bot-delegations:list').length;
  const beforeStatusPush = taskReads();
  vi.useFakeTimers();
  try {
    act(() => h.push({ deviceId: 'a', channel: REMOTE_RESOURCE_CHANGED_CHANNEL }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(taskReads()).toBe(beforeStatusPush);
  } finally { vi.useRealTimers(); }
  response = { ok: false, errorCode: 'HOST_NOT_READY' };
  act(() => h.status({ status: 'online' }));
  await act(async () => {});
  expect(result.current[0].delegatedSessionIds).toEqual(['child']);
  response = { ok: true, delegations: [] };
  vi.useFakeTimers();
  try {
    act(() => h.push({ deviceId: 'a', channel: 'maker:bot-delegation:changed' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(result.current[0].delegatedSessionIds).toEqual([]);
  } finally { vi.useRealTimers(); }
});

it('cannot restore old attribution when a pending task-card read completes after switching accounts', async () => {
  h.devices = [host('a')];
  let finish!: (value: unknown) => void;
  h.invoke.mockImplementation(async (_device, channel) => channel === REMOTE_RESOURCE_LIST_CHANNEL
    ? collection() : new Promise(resolve => { finish = resolve; }));
  const { result, rerender } = renderHook(useRoster);
  await waitFor(() => expect(finish).toBeDefined());
  h.owner = 'new-owner';
  h.devices = [];
  rerender();
  await act(async () => finish({ ok: true, delegations: [{ requestingBotId: 'same-bot', childSessionId: 'old-child' }] }));
  expect(result.current).toEqual([]);
});

// The compact legacy roster has no templateId; the cloud knows the built-in identity.
it('applies cloud Cindy identity regardless of roster arrival order and rejects a late old-owner reply', async () => {
  h.cloudEnabled = true;
  let finish!: (value: unknown) => void;
  h.copies.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const { result, rerender } = renderHook(useRoster);
  await waitFor(() => expect(result.current).toHaveLength(2));
  await act(async () => finish([{ botId: 'same-bot' }]));
  expect(result.current.every(bot => bot.templateId === 'cindy')).toBe(true);
  act(() => h.status({ status: 'online' }));
  await act(async () => {});
  expect(result.current.every(bot => bot.templateId === 'cindy')).toBe(true);
  h.owner = 'another-owner';
  rerender();
  await act(async () => {});
  expect(result.current.every(bot => bot.templateId === undefined)).toBe(true);
  const oldFinish = finish;
  h.owner = 'third-owner';
  h.cloudEnabled = false;
  rerender();
  await act(async () => oldFinish([{ botId: 'same-bot' }]));
  expect(result.current.every(bot => bot.templateId === undefined)).toBe(true);
});

// Unit / review4390134785: identity must be available without any roster rows;
// previous arrival-order coverage only read templateId on already listed rows.
it('exposes known Cindy IDs before an offline home provides its roster and clears on owner switch', async () => {
  h.devices = [];
  h.cloudEnabled = true;
  h.copies.mockResolvedValue([{ botId: 'same-bot' }]);
  const { result, rerender } = renderHook(() => {
    useRemoteBotSync();
    return { rows: useRemoteBots(), ids: useRemoteCindyIds() };
  });
  await waitFor(() => expect(result.current.ids.has('same-bot')).toBe(true));
  expect(result.current.rows).toEqual([]);
  h.owner = 'new-empty-owner';
  h.cloudEnabled = false;
  rerender();
  expect(result.current.ids.size).toBe(0);
});
