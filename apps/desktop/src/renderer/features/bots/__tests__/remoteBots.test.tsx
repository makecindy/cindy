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
import { parseRemoteCollectionListRequest, REMOTE_RESOURCE_INVOKE_CHANNEL, REMOTE_RESOURCE_LIST_CHANNEL, REMOTE_RESOURCE_CHANGED_CHANNEL } from '@cindy/device-link';
import { parseRemoteBots, remoteBotKey, isRemoteBotUnread } from '../remoteBotRoster';
import { setDataOwnerGeneration, getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { resetBotReadStateForTests, startBotReadStateSync, getBotReadStateSyncStatus, subscribeBotReadState } from '../botReadState';
import { botReadStateFixture } from './botReadStateFixture';
let reads: ReturnType<typeof botReadStateFixture>;
let stopReads: () => void;
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
/** Bootstrap commits every legacy row through the fixture's real Main files before `ready`; on a
 * loaded Windows runner 205 atomic writes outlast vi.waitFor's 1 s poll, so await the phase event. */
async function readStateSettled() {
  const settled = () => getBotReadStateSyncStatus().phase !== 'loading' && getBotReadStateSyncStatus().phase !== 'idle';
  await new Promise<void>(resolve => {
    const off = subscribeBotReadState(() => { if (settled()) { off(); resolve(); } });
    if (settled()) { off(); resolve(); }
  });
  expect(getBotReadStateSyncStatus().phase).toBe('ready');
}
beforeEach(async () => {
  window.history.replaceState({}, '', '/');
  window.localStorage.clear();
  resetBotReadStateForTests();
  h.cloudEnabled = false;
  h.copies.mockReset();
  h.owner = `owner-${Math.random()}`;
  setDataOwnerGeneration(h.owner);
  reads = botReadStateFixture();
  h.devices = [host('a'), host('b')];
  h.invoke.mockReset().mockResolvedValue(collection());
  vi.stubGlobal('electronAPI', undefined);
  window.electronAPI = {
    maker: reads.bridge,
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
  stopReads = startBotReadStateSync();
  await readStateSettled();
});
afterEach(async () => {
  cleanup(); stopReads(); resetBotReadStateForTests();
  const owner = getDataOwnerGeneration();
  await reads.bridge.botReadState({ owner: { ...owner, dataOwnerId: owner.dataOwnerId! }, action: 'snapshot' });
  reads.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});
// R4: hook/store unit coverage, no real remote sockets. The old aggregate cache slice
// dropped identities after 200; old progressive publication repeatedly scanned read storage.
it('keeps more than 200 device-qualified companions and never scans read storage per delegation', async () => {
  const get = vi.spyOn(Storage.prototype, 'getItem');
  const keys = vi.spyOn(Storage.prototype, 'key');
  const many = { collectionId: 'teammates', items: Array.from({ length: 110 }, (_, i) => ({
    ref: { collectionId: 'teammates', kind: 'bot', id: `bot-${i}` },
    display: { title: `Writer ${i}`, lastReplyAt: 100 },
    links: [{ rel: 'conversation', target: { kind: 'session', sessionId: `canonical-${i}` } }],
  })) };
  h.invoke.mockImplementation(async (_device, channel) => channel === REMOTE_RESOURCE_LIST_CHANNEL
    ? many : { ok: true, delegations: [] });
  const { result, rerender } = renderHook(useRoster);
  await waitFor(() => expect(result.current).toHaveLength(220));
  await waitFor(() => expect(result.current.every(bot => bot.delegatedSessionIds !== undefined)).toBe(true));
  expect(keys).not.toHaveBeenCalled();
  expect(get).toHaveBeenCalledTimes(1); // one roster-cache read, no read-position scans
  act(() => markRemoteBotRead('b', 'bot-109', 300));
  h.devices = [host('a', false), host('b', false)]; rerender();
  const late = result.current.find(bot => bot.deviceId === 'b' && bot.id === 'bot-109')!;
  expect(late.readAt).toBe(300);
  expect(result.current).toHaveLength(220);
});
it('restores all cached rows beyond 200 and imports legacy device-qualified acknowledgements', async () => {
  stopReads(); resetBotReadStateForTests();
  const rows = Array.from({ length: 205 }, (_, i) => ({ id: `old-${i}`, deviceId: 'a', deviceName: 'A', name: 'Writer',
    avatar: '', avatarColor: '', description: '', preview: '', activityAt: 100, lastReplyAt: 200, readAt: 300 }));
  localStorage.setItem(`cindy.remoteBots.v1.${h.owner}`, JSON.stringify(rows));
  stopReads = startBotReadStateSync();
  await readStateSettled();
  h.devices = [host('a', false)];
  const { result } = renderHook(useRoster);
  await waitFor(() => expect(result.current).toHaveLength(205));
  expect(result.current[204].readAt).toBe(300);
  expect(result.current.some(isRemoteBotUnread)).toBe(false);
});
it('keeps a corrupt migration source intact even after the main window obtains a live roster', async () => {
  stopReads(); resetBotReadStateForTests();
  const key = `cindy.remoteBots.v1.${h.owner}`;
  localStorage.setItem(key, '{corrupt');
  stopReads = startBotReadStateSync();
  await readStateSettled();
  const { result } = renderHook(useRoster);
  await waitFor(() => expect(result.current).toHaveLength(2));
  expect(getBotReadStateSyncStatus().corruptSources).toContain(key);
  expect(localStorage.getItem(key)).toBe('{corrupt');
});
it('lets secondary mirrors update but never replace the main window roster cache', async () => {
  window.history.replaceState({}, '', '/?secondaryWindow=1');
  const write = vi.spyOn(Storage.prototype, 'setItem');
  const { result } = renderHook(useRoster);
  await waitFor(() => expect(result.current).toHaveLength(2));
  act(() => markRemoteBotRead('a', 'same-bot', 300));
  expect(result.current.find(bot => bot.deviceId === 'a')?.readAt).toBe(300);
  expect(write).not.toHaveBeenCalled();
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
    setDataOwnerGeneration(h.owner);
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

// Reading while the home computer is unreachable (or a request fails) advances the local read
// position first. The computer must still hear about it: showing the same reply again, or the
// next reconnect, sends it, and once the computer has it nothing is sent again.
it('re-sends a read position the home computer has not acknowledged, on the next read and on reconnect', async () => {
  let hostRead = 100;
  let failing = true;
  const published = () => { const value = collection(); Object.assign(value.items[0].display, { lastReplyAt: 200, lastReadAt: hostRead }); return value; };
  h.invoke.mockImplementation(async (_device, channel) => {
    if (channel === REMOTE_RESOURCE_LIST_CHANNEL) return published();
    if (channel === REMOTE_RESOURCE_INVOKE_CHANNEL) { if (failing) throw new Error('offline'); return { effects: [], lastReadAt: 200 }; }
    return { ok: true, delegations: [] };
  });
  const reads = () => h.invoke.mock.calls.filter(call => call[0] === 'a' && call[1] === REMOTE_RESOURCE_INVOKE_CHANNEL);
  const { result } = renderHook(useRoster);
  await waitFor(() => expect(result.current).toHaveLength(2));
  await act(async () => markRemoteBotRead('a', 'same-bot', 200));
  expect(reads()).toHaveLength(1);
  expect(reads()[0][2][0]).toMatchObject({ actionId: 'read', resourceRef: { id: 'same-bot' }, input: { at: 200 } });
  await act(async () => markRemoteBotRead('a', 'same-bot', 200)); // same reply shown again
  expect(reads()).toHaveLength(2);
  const lists = () => h.invoke.mock.calls.filter(call => call[1] === REMOTE_RESOURCE_LIST_CHANNEL).length;
  failing = false;
  let before = lists();
  act(() => h.status({ status: 'online' })); // reconnect: the roster read carries the position
  await waitFor(() => expect(reads()).toHaveLength(3));
  hostRead = 200; // the computer now has it
  before = lists();
  act(() => h.status({ status: 'online' }));
  await waitFor(() => expect(lists()).toBeGreaterThan(before));
  expect(reads()).toHaveLength(3);
  expect(isRemoteBotUnread(result.current.find((bot) => bot.deviceId === 'a')!)).toBe(false);
  expect(reads().every(call => call[0] === 'a')).toBe(true);
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

const taskReads = () => h.invoke.mock.calls.filter(call => call[1] === 'maker:bot-delegations:list').length;
const rosterReads = () => h.invoke.mock.calls.filter(call => call[1] === REMOTE_RESOURCE_LIST_CHANNEL).length;

// Unit, cindy-bots-runtime.md §6.1: current hosts answer the V1 list from rows that no longer
// change. Before, every connect / reconnect re-read it once per teammate (field logs: 16-18
// timeouts of 10-30 s per host over 8 days). Minimal input: attribution known, relay reconnects.
// Older hosts that push `maker:bot-delegation:changed` still refresh, and catch up on reconnect.
it('reads creation attribution once, then only on delegation pushes, keeping it on failure', async () => {
  h.devices = [host('a')];
  let response: unknown = { ok: true, delegations: [{ requestingBotId: 'same-bot', childSessionId: 'child' }] };
  h.invoke.mockImplementation(async (_device, channel) => channel === REMOTE_RESOURCE_LIST_CHANNEL ? collection() : response);
  const { result } = renderHook(useRoster);
  await waitFor(() => expect(result.current[0]?.delegatedSessionIds).toEqual(['child']));
  expect(taskReads()).toBe(1);
  vi.useFakeTimers();
  try {
    act(() => h.push({ deviceId: 'a', channel: REMOTE_RESOURCE_CHANGED_CHANNEL }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    act(() => h.status({ status: 'reconnecting' }));
    act(() => h.status({ status: 'online' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(rosterReads()).toBe(3);
    expect(taskReads()).toBe(1);
    response = { ok: false, errorCode: 'HOST_NOT_READY' };
    act(() => h.push({ deviceId: 'a', channel: 'maker:bot-delegation:changed' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(taskReads()).toBe(2);
    expect(result.current[0].delegatedSessionIds).toEqual(['child']);
    // This host still runs V1 tasks: a reconnect re-reads what may have changed while away.
    response = { ok: true, delegations: [] };
    act(() => h.status({ status: 'online' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(taskReads()).toBe(3);
    expect(result.current[0].delegatedSessionIds).toEqual([]);
  } finally { vi.useRealTimers(); }
});

// Unit, same rule: a teammate's main chat changed and the read for it failed. The row already
// shows the new chat next to the previous attribution; that must not count as confirmed.
// Minimal input: sessionId changes, first read fails, a later ordinary refresh after the backoff.
it('retries attribution for a changed main chat until a read succeeds', async () => {
  h.devices = [host('a')];
  let roster = collection();
  let response: unknown = { ok: true, delegations: [{ requestingBotId: 'same-bot', childSessionId: 'child' }] };
  h.invoke.mockImplementation(async (_device, channel) => channel === REMOTE_RESOURCE_LIST_CHANNEL ? roster : response);
  const { result } = renderHook(useRoster);
  await waitFor(() => expect(result.current[0]?.delegatedSessionIds).toEqual(['child']));
  roster = collection();
  roster.items[0].links = [{ rel: 'conversation', target: { kind: 'session', sessionId: 'moved' } }];
  response = { ok: false, errorCode: 'HOST_NOT_READY' };
  vi.useFakeTimers();
  try {
    act(() => h.status({ status: 'online' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(taskReads()).toBe(2);
    expect(result.current[0]).toMatchObject({ sessionId: 'moved', delegatedSessionIds: ['child'] });
    response = { ok: true, delegations: [{ requestingBotId: 'same-bot', childSessionId: 'moved-child' }] };
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
    act(() => h.status({ status: 'online' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(taskReads()).toBe(3);
    expect(result.current[0].delegatedSessionIds).toEqual(['moved-child']);
  } finally { vi.useRealTimers(); }
});

// Unit, same rule: the display cache keeps attribution across launches; a teammate cached
// without it (never read successfully) is still read once. Before, a missing field restored as [].
it('reads attribution only for cached teammates that do not have it yet', async () => {
  const cached = (deviceId: string, extra = {}) => ({ id: 'same-bot', deviceId, deviceName: deviceId, name: 'Writer',
    avatar: '', avatarColor: '', description: '', preview: '', activityAt: 100, sessionId: 'canonical', ...extra });
  localStorage.setItem(`cindy.remoteBots.v1.${h.owner}`, JSON.stringify([cached('a', { delegatedSessionIds: ['a-child'] }), cached('b')]));
  h.invoke.mockImplementation(async (device, channel) => channel === REMOTE_RESOURCE_LIST_CHANNEL
    ? collection() : { ok: true, delegations: [{ requestingBotId: 'same-bot', childSessionId: `${device}-new` }] });
  const { result } = renderHook(useRoster);
  await waitFor(() => expect(result.current.map(bot => bot.delegatedSessionIds)).toEqual([['a-child'], ['b-new']]));
  expect(h.invoke.mock.calls.filter(call => call[1] === 'maker:bot-delegations:list')).toEqual([['b', 'maker:bot-delegations:list', ['canonical']]]);
});

// Unit, #11997 review (changes requested): while this app was closed an older host added a V1
// task; after restart the cache still has the old attribution, nothing is pushed, and the
// legacy-host set starts empty. Ordinary refreshes keep using the cache, but one delayed check
// per sign-in must add the new task's creator. Minimal input: cached mark, no push, 60 s pass.
it('checks restored attribution once per sign-in so a task added while the app was closed gets its creator', async () => {
  h.devices = [host('a')];
  localStorage.setItem(`cindy.remoteBots.v1.${h.owner}`, JSON.stringify([{ id: 'same-bot', deviceId: 'a', deviceName: 'a',
    name: 'Writer', avatar: '', avatarColor: '', description: '', preview: '', activityAt: 100, sessionId: 'canonical',
    delegatedSessionIds: ['old-child'] }]));
  h.invoke.mockImplementation(async (_device, channel) => channel === REMOTE_RESOURCE_LIST_CHANNEL ? collection() : {
    ok: true, delegations: [{ requestingBotId: 'same-bot', childSessionId: 'old-child' }, { requestingBotId: 'same-bot', childSessionId: 'new-child' }] });
  const online = async () => {
    act(() => h.status({ status: 'online' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  };
  vi.useFakeTimers();
  try {
    const { result } = renderHook(useRoster);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    await online();
    expect(rosterReads()).toBe(2);
    expect(taskTargets()).toEqual([]);
    expect(result.current[0].delegatedSessionIds).toEqual(['old-child']);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(taskTargets()).toEqual(['canonical']);
    expect(result.current[0].delegatedSessionIds).toEqual(['old-child', 'new-child']);
    await online();
    expect(taskTargets()).toEqual(['canonical']);
  } finally { vi.useRealTimers(); }
});

// Unit, same rule: the only cached teammate's main chat changed, so its attribution is read and
// confirmed right away. The delayed check then has nothing left: no extra roster read on the
// shared channel at 60 s. Minimal input: cached chat `old-chat`, roster chat `canonical`.
it('skips the delayed check when restored attribution was already confirmed', async () => {
  h.devices = [host('a')];
  localStorage.setItem(`cindy.remoteBots.v1.${h.owner}`, JSON.stringify([{ id: 'same-bot', deviceId: 'a', deviceName: 'a',
    name: 'Writer', avatar: '', avatarColor: '', description: '', preview: '', activityAt: 100, sessionId: 'old-chat',
    delegatedSessionIds: ['old-child'] }]));
  h.invoke.mockImplementation(async (_device, channel) => channel === REMOTE_RESOURCE_LIST_CHANNEL ? collection()
    : { ok: true, delegations: [{ requestingBotId: 'same-bot', childSessionId: 'new-child' }] });
  vi.useFakeTimers();
  try {
    const { result } = renderHook(useRoster);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(taskTargets()).toEqual(['canonical']);
    expect(result.current[0].delegatedSessionIds).toEqual(['new-child']);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(rosterReads()).toBe(1);
    expect(taskTargets()).toEqual(['canonical']);
  } finally { vi.useRealTimers(); }
});

/** Roster A (`same-bot`, chat `canonical`) then B (`second-bot`, chat `second`), both unknown. */
const teammatesAB = () => {
  const roster = collection();
  roster.items.push({ ...roster.items[0], ref: { ...roster.items[0].ref, id: 'second-bot' },
    links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'second' } }] });
  return roster;
};
const createdBy = (sessionId: string) => ({ ok: true, delegations: [
  { requestingBotId: sessionId === 'canonical' ? 'same-bot' : 'second-bot', childSessionId: `${sessionId}-child` }] });
const taskTargets = () => h.invoke.mock.calls.filter(call => call[1] === 'maker:bot-delegations:list').map(call => call[2][0]);

// Unit, same rule (#12001 review, timing 1): a roster push starts a new round, the old round's
// attribution read then times out, and only afterwards the new roster arrives. The superseded
// round must not pause the recovered host. Minimal input: A's first read never answers.
it('a superseded round timing out late cannot pause the round that replaced it', async () => {
  h.devices = [host('a')];
  let finishRoster!: (value: unknown) => void;
  let rosterCalls = 0;
  let aReads = 0;
  h.invoke.mockImplementation((_device, channel, args) => {
    if (channel === REMOTE_RESOURCE_LIST_CHANNEL) {
      return ++rosterCalls === 2 ? new Promise(resolve => { finishRoster = resolve; }) : Promise.resolve(teammatesAB());
    }
    return args[0] === 'canonical' && ++aReads === 1 ? new Promise(() => {}) : Promise.resolve(createdBy(args[0]));
  });
  vi.useFakeTimers();
  try {
    const { result } = renderHook(useRoster);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    act(() => h.push({ deviceId: 'a', channel: REMOTE_RESOURCE_CHANGED_CHANNEL }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(rosterReads()).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(9_500); }); // the old read times out
    await act(async () => { finishRoster(teammatesAB()); await vi.advanceTimersByTimeAsync(0); });
    expect(taskTargets()).toEqual(['canonical', 'canonical', 'second']);
    expect(result.current.map(bot => bot.delegatedSessionIds)).toEqual([['canonical-child'], ['second-child']]);
  } finally { vi.useRealTimers(); }
});

// Unit, same rule (#12001 review, timing 2): a host that never answers holds the read for 10 s,
// not the 30 s invoke budget, and the round stops so nothing queues behind it. A stalled
// teammate must not keep the next one on that host from ever being read. Minimal input: fixed
// order A, B, both unknown, only A keeps timing out, one ordinary refresh 5 minutes later.
it('stops waiting for a stalled attribution read, pauses the host, and does not starve later teammates', async () => {
  h.devices = [host('a')];
  h.invoke.mockImplementation((_device, channel, args) => channel === REMOTE_RESOURCE_LIST_CHANNEL
    ? Promise.resolve(teammatesAB()) : args[0] === 'canonical' ? new Promise(() => {}) : Promise.resolve(createdBy(args[0])));
  const online = async () => {
    act(() => h.status({ status: 'online' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  };
  vi.useFakeTimers();
  try {
    const { result } = renderHook(useRoster);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    await online();
    expect(rosterReads()).toBe(2);
    expect(taskTargets()).toEqual(['canonical']);
    expect(result.current.map(bot => bot.delegatedSessionIds)).toEqual([undefined, undefined]);
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
    await online();
    expect(taskTargets()).toEqual(['canonical', 'second', 'canonical']);
    expect(result.current.map(bot => bot.delegatedSessionIds)).toEqual([undefined, ['second-child']]);
  } finally { vi.useRealTimers(); }
});

// Unit, same rule: an older host pushes a delegation change and the forced re-read stops at A's
// timeout. B was skipped though its cached mark may be stale; the next ordinary refresh after the
// host pause must still read it, also when that refresh only comes after A's 5-minute backoff and
// A keeps stalling (B, never tried, goes before A's retry). Minimal input: A, B known; A stalls
// from its second read on; one ordinary refresh 30 s or 5 minutes later.
it.each([
  { label: 'after the host pause', wait: 30_000, rest: ['second'] },
  { label: 'only after the stalled teammate\'s backoff', wait: 5 * 60_000, rest: ['second', 'canonical'] },
])('keeps teammates skipped by a timed-out forced re-read unconfirmed for the next refresh ($label)', async ({ wait, rest }) => {
  h.devices = [host('a')];
  let aReads = 0;
  let bReads = 0;
  h.invoke.mockImplementation((_device, channel, args) => {
    if (channel === REMOTE_RESOURCE_LIST_CHANNEL) return Promise.resolve(teammatesAB());
    if (args[0] === 'canonical') return ++aReads >= 2 ? new Promise(() => {}) : Promise.resolve(createdBy('canonical'));
    return Promise.resolve(++bReads === 1 ? createdBy('second') : { ok: true, delegations: [
      { requestingBotId: 'second-bot', childSessionId: 'second-new' }] });
  });
  vi.useFakeTimers();
  try {
    const { result } = renderHook(useRoster);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.map(bot => bot.delegatedSessionIds)).toEqual([['canonical-child'], ['second-child']]);
    act(() => h.push({ deviceId: 'a', channel: 'maker:bot-delegation:changed' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_500); });
    expect(taskTargets()).toEqual(['canonical', 'second', 'canonical']);
    await act(async () => { await vi.advanceTimersByTimeAsync(wait); });
    act(() => h.push({ deviceId: 'a', channel: REMOTE_RESOURCE_CHANGED_CHANNEL }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(taskTargets()).toEqual(['canonical', 'second', 'canonical', ...rest]);
    expect(result.current.map(bot => bot.delegatedSessionIds)).toEqual([['canonical-child'], ['second-new']]);
  } finally { vi.useRealTimers(); }
});

// Unit, same rule: the host is paused after A stalled, and B's main chat changes meanwhile. The
// ordinary refresh skips B for the pause before any read; the row already pairs the new chat with
// the old attribution, which must not count as confirmed once the pause ends. Minimal input:
// roster B, A; A stalls; B's chat moves during the pause; one ordinary refresh after it.
it('keeps a main chat change skipped by the host pause unconfirmed until it is read', async () => {
  h.devices = [host('a')];
  const rosterBA = (bChat: string) => {
    const roster = teammatesAB();
    roster.items.reverse();
    roster.items[0] = { ...roster.items[0], links: [{ rel: 'conversation', target: { kind: 'session', sessionId: bChat } }] };
    return roster;
  };
  let bChat = 'second';
  h.invoke.mockImplementation((_device, channel, args) => {
    if (channel === REMOTE_RESOURCE_LIST_CHANNEL) return Promise.resolve(rosterBA(bChat));
    if (args[0] === 'canonical') return new Promise(() => {});
    return Promise.resolve({ ok: true, delegations: [{ requestingBotId: 'second-bot', childSessionId: `${args[0]}-child` }] });
  });
  vi.useFakeTimers();
  try {
    const { result } = renderHook(useRoster);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(taskTargets()).toEqual(['second', 'canonical']);
    bChat = 'moved';
    act(() => h.push({ deviceId: 'a', channel: REMOTE_RESOURCE_CHANGED_CHANNEL }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(taskTargets()).toEqual(['second', 'canonical']);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    act(() => h.push({ deviceId: 'a', channel: REMOTE_RESOURCE_CHANGED_CHANNEL }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(taskTargets()).toEqual(['second', 'canonical', 'moved']);
    expect(result.current.find(bot => bot.id === 'second-bot')?.delegatedSessionIds).toEqual(['moved-child']);
  } finally { vi.useRealTimers(); }
});

// Unit, same rule: B is known; the next roster adds A ahead of it and moves B's main chat. A's
// read times out and stops the ordinary round before B is reached; B must still be read after
// the host pause. Minimal input: roster [B] then [A, B moved]; A never answers.
it('keeps a main chat change unconfirmed when an earlier teammate\'s timeout ends the round', async () => {
  h.devices = [host('a')];
  let roster = teammatesAB();
  roster.items.shift();
  h.invoke.mockImplementation((_device, channel, args) => {
    if (channel === REMOTE_RESOURCE_LIST_CHANNEL) return Promise.resolve(roster);
    if (args[0] === 'canonical') return new Promise(() => {});
    return Promise.resolve({ ok: true, delegations: [{ requestingBotId: 'second-bot', childSessionId: `${args[0]}-child` }] });
  });
  vi.useFakeTimers();
  try {
    const { result } = renderHook(useRoster);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(taskTargets()).toEqual(['second']);
    roster = teammatesAB();
    roster.items[1] = { ...roster.items[1], links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'moved' } }] };
    act(() => h.push({ deviceId: 'a', channel: REMOTE_RESOURCE_CHANGED_CHANNEL }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_500); });
    expect(taskTargets()).toEqual(['second', 'canonical']);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    act(() => h.push({ deviceId: 'a', channel: REMOTE_RESOURCE_CHANGED_CHANNEL }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(taskTargets()).toEqual(['second', 'canonical', 'moved']);
    expect(result.current.find(bot => bot.id === 'second-bot')?.delegatedSessionIds).toEqual(['moved-child']);
  } finally { vi.useRealTimers(); }
});

// Unit, same rule: attribution is known and the host has not pushed yet, so a reconnect starts
// an ordinary refresh. The first delegation push arrives while that roster request is in
// flight and the roster returns before the 500 ms push timer: the round must read for the push
// instead of clearing it. Minimal input: deferred roster, push, roster returns at 100 ms.
it('reads for a delegation push that arrives while an ordinary roster request is in flight', async () => {
  h.devices = [host('a')];
  let finishRoster: ((value: unknown) => void) | null = null;
  let deferRoster = false;
  let aReads = 0;
  h.invoke.mockImplementation((_device, channel) => {
    if (channel === REMOTE_RESOURCE_LIST_CHANNEL) {
      return deferRoster ? new Promise(resolve => { deferRoster = false; finishRoster = resolve; }) : Promise.resolve(collection());
    }
    return Promise.resolve({ ok: true, delegations: [{ requestingBotId: 'same-bot', childSessionId: ++aReads === 1 ? 'child' : 'new-child' }] });
  });
  vi.useFakeTimers();
  try {
    const { result } = renderHook(useRoster);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current[0].delegatedSessionIds).toEqual(['child']);
    deferRoster = true;
    act(() => h.status({ status: 'online' }));
    act(() => h.push({ deviceId: 'a', channel: 'maker:bot-delegation:changed' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    await act(async () => { finishRoster!(collection()); await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(taskTargets()).toEqual(['canonical', 'canonical']);
    expect(result.current[0].delegatedSessionIds).toEqual(['new-child']);
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
  setDataOwnerGeneration(h.owner);
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
  setDataOwnerGeneration(h.owner);
  rerender();
  await act(async () => {});
  expect(result.current.every(bot => bot.templateId === undefined)).toBe(true);
  const oldFinish = finish;
  h.owner = 'third-owner';
  setDataOwnerGeneration(h.owner);
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
  setDataOwnerGeneration(h.owner);
  h.cloudEnabled = false;
  rerender();
  expect(result.current.ids.size).toBe(0);
});
