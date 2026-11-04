// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppWindowSync } from '@/components/layout/AppWindowSync';
vi.mock('@/components/layout/AppBadgeAttentionSync', () => ({ AppBadgeAttentionSync: () => null }));
vi.mock('../botGroupOutbox', () => ({ startBotGroupOutbox: () => () => {} }));
vi.mock('../useBotUnreadSync', () => ({ useBotUnreadSync: () => {} }));
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
import { useRemoteBotSync, useRemoteBots, useRemoteCindyIds, markRemoteBotRead, readRemoteBots } from '../useRemoteBots';
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
const readEntryKey = (account: string, deviceId: string, id: string, at: number) =>
  'cindy.remoteBotReads.v1.entry.' + JSON.stringify(account) + '.' + JSON.stringify([deviceId, id, at]);
const secondaryReadKeys = (account: string) => Object.keys(window.localStorage)
  .filter(key => key.startsWith('cindy.remoteBotReads.v1.entry.' + JSON.stringify(account) + '.'));
function fillReadPartition(account: string, at: number) {
  // First-discovery watermarks now occupy this same bounded partition.
  let used = secondaryReadKeys(account).reduce((size, entry) => size + entry.length + 1, 0);
  for (let index = 0; used < 256 * 1024 - 400; index++) {
    const entry = readEntryKey(account, 'removed-device', String(index).padStart(220, 'x'), at);
    window.localStorage.setItem(entry, '1');
    used += entry.length + 1;
  }
  const overhead = readEntryKey(account, 'removed-device', '', at).length + 1;
  const filler = readEntryKey(account, 'removed-device', 'z'.repeat(256 * 1024 - used - overhead), at);
  window.localStorage.setItem(filler, '1');
  expect(secondaryReadKeys(account).reduce((size, entry) => size + entry.length + 1, 0)).toBe(256 * 1024);
}
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
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
});
describe('remote teammate roster', () => {
  // Unit: the per-window production mount must populate the roster too; direct
  // hook tests alone missed the main-window-only parent guard.
  it('loads remote teammates when a secondary app window mounts', async () => {
    window.history.replaceState(null, '', '/?secondaryWindow=1');
    function Roster() { return <output>{useRemoteBots().map(bot => bot.name).join(',')}</output>; }
    const view = render(<><AppWindowSync /><Roster /></>);
    await waitFor(() => expect(screen.getByText('Writer,Writer')).toBeTruthy());
    view.unmount();
    const reads = h.invoke.mock.calls.length;
    act(() => h.status({ status: 'online' }));
    await act(async () => {});
    expect(h.invoke).toHaveBeenCalledTimes(reads);
  });
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

// Unit / review4453575198: another renderer writes its read position through
// shared localStorage. Existing single-window tests never delivered that event.
it('updates unread consumers from another window and ignores old-owner reads after switching or unmounting', async () => {
  const withReply = (at: number) => { const value = collection(); Object.assign(value.items[0].display, { lastReplyAt: at }); return value; };
  h.invoke.mockResolvedValue(withReply(100));
  const { result, rerender, unmount } = renderHook(useRoster);
  await waitFor(() => expect(result.current).toHaveLength(2));
  h.invoke.mockResolvedValue(withReply(200));
  act(() => h.status({ status: 'online' }));
  await waitFor(() => expect(result.current.every(isRemoteBotUnread)).toBe(true));
  const key = 'cindy.remoteBots.v1.' + h.owner;
  const otherWindow = result.current.map(bot => ({ ...bot, readAt: bot.deviceId === 'a' ? 200 : 100 }));
  const newValue = JSON.stringify(otherWindow);
  window.localStorage.setItem(key, newValue);
  const reads = h.invoke.mock.calls.length;
  act(() => window.dispatchEvent(new StorageEvent('storage', { key, newValue, storageArea: window.localStorage })));
  expect(result.current.filter(isRemoteBotUnread).map(bot => bot.deviceId)).toEqual(['b']);
  expect(readRemoteBots().filter(isRemoteBotUnread).map(bot => bot.deviceId)).toEqual(['b']);
  expect(h.invoke).toHaveBeenCalledTimes(reads);
  h.owner = 'other-reader';
  h.devices = [];
  rerender();
  act(() => window.dispatchEvent(new StorageEvent('storage', { key, newValue })));
  expect(result.current).toEqual([]);
  unmount();
  act(() => window.dispatchEvent(new StorageEvent('storage', { key, newValue })));
  expect(readRemoteBots()).toEqual([]);
});

// Unit / review4456333373: a failed secondary refresh must not replace the
// main window's newer reply/membership cache, including when marking a reply read.
it('preserves the shared roster through stale secondary refreshes and offline restoration', async () => {
  window.history.replaceState(null, '', '/?secondaryWindow=1');
  h.devices = [host('a')];
  const first = collection();
  Object.assign(first.items[0].display, { lastReplyAt: 100 });
  h.invoke.mockResolvedValue(first);
  const view = renderHook(useRoster);
  await waitFor(() => expect(view.result.current[0]?.lastReplyAt).toBe(100));
  const account = h.owner;
  const key = 'cindy.remoteBots.v1.' + account;
  // The main window has received a newer reply and a new companion. No read
  // position changes, so the secondary's storage handler need not publish.
  const newer = [
    { ...view.result.current[0], name: 'New name', preview: 'New reply', lastReplyAt: 200, activityAt: 200 },
    { ...view.result.current[0], id: 'new-bot', name: 'New companion' },
  ].map(bot => ({ ...bot, online: false }));
  window.localStorage.setItem(key, JSON.stringify(newer));
  h.invoke.mockRejectedValue(new Error('temporary host failure'));
  act(() => h.status({ status: 'online' }));
  await act(async () => {});
  expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual(newer);
  act(() => markRemoteBotRead('a', 'same-bot', 150));
  expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual(newer);
  expect(secondaryReadKeys(account)).toContain(readEntryKey(account, 'a', 'same-bot', 150));
  view.unmount();
  // Re-enter the account with no live host response, using the real cache load.
  h.owner = 'other-offline-owner';
  h.devices = [];
  renderHook(useRoster).unmount();
  h.owner = account;
  h.devices = [host('a', false)];
  const restored = renderHook(useRoster);
  expect(restored.result.current.map(bot => bot.name)).toEqual(['New name', 'New companion']);
  expect(restored.result.current[0].lastReplyAt).toBe(200);
  expect(restored.result.current[0].readAt).toBe(150);
  expect(isRemoteBotUnread(restored.result.current[0])).toBe(true);
});

// Unit / review4463310782: explicit-mark tests missed first discovery with no
// conversation opened. A later main discovery must not acknowledge reply200.
it('persists first-discovery reads before another remote mirror sees a later reply', async () => {
  window.history.replaceState(null, '', '/?secondaryWindow=1');
  h.devices = [host('a')];
  const first = collection();
  Object.assign(first.items[0].display, { lastReplyAt: 100 });
  h.invoke.mockResolvedValue(first);
  const secondary = renderHook(useRoster);
  await waitFor(() => expect(secondary.result.current[0]?.readAt).toBe(100));
  const account = h.owner;
  const reply = collection(); Object.assign(reply.items[0].display, { lastReplyAt: 200 });
  h.invoke.mockResolvedValue(reply);
  act(() => h.status({ status: 'online' }));
  await waitFor(() => expect(secondary.result.current[0]?.lastReplyAt).toBe(200));
  expect(isRemoteBotUnread(secondary.result.current[0])).toBe(true);
  secondary.unmount();
  h.owner = account + '-between'; h.devices = []; renderHook(useRoster).unmount();
  h.owner = account; h.devices = [host('a')];
  window.history.replaceState(null, '', '/');
  const main = renderHook(useRoster);
  await waitFor(() => expect(main.result.current[0]?.lastReplyAt).toBe(200));
  expect(main.result.current[0].readAt).toBe(100);
  expect(isRemoteBotUnread(main.result.current[0])).toBe(true);
});

// Unit / PR8637: a late first discovery must correct a newer automatic
// baseline already present in both the live projection and shared roster cache.
it.each([false, true])('merges concurrent first-discovery baselines with an explicit current read: %s', async (read) => {
  h.devices = [host('a')];
  const rows = collection(); Object.assign(rows.items[0].display, { lastReplyAt: 200 });
  let finishTasks!: (value: unknown) => void;
  const tasks = new Promise(resolve => { finishTasks = resolve; });
  h.invoke.mockImplementation((_device, channel) => channel === 'maker:bot-delegations:list' ? tasks : Promise.resolve(rows));
  const main = renderHook(useRoster);
  await waitFor(() => expect(main.result.current[0]?.readAt).toBe(200));
  if (read) act(() => markRemoteBotRead('a', 'same-bot', 200));
  const key = 'cindy.remoteBotReads.v1.entry.' + JSON.stringify(h.owner) + '.' + JSON.stringify(['a', 'same-bot', 100, 'initial']);
  window.localStorage.setItem(key, '1');
  act(() => window.dispatchEvent(new StorageEvent('storage', { key, newValue: '1', storageArea: window.localStorage })));
  expect(main.result.current[0].readAt).toBe(read ? 200 : 100);
  expect(isRemoteBotUnread({ ...main.result.current[0], lastReplyAt: 150 })).toBe(!read);
  // A pending delegation completion still holds the older refresh snapshot.
  await act(async () => finishTasks({ ok: true, delegations: [] }));
  expect(main.result.current[0].readAt).toBe(read ? 200 : 100);
  act(() => markRemoteBotRead('a', 'same-bot', 300));
  const late = key.replace(',100,', ',50,');
  window.localStorage.setItem(late, '1');
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: late, newValue: '1', storageArea: window.localStorage })));
  expect(main.result.current[0].readAt).toBe(300);
  expect(isRemoteBotUnread(main.result.current[0])).toBe(false);
  const account = h.owner;
  main.unmount(); h.owner = account + '-between'; h.devices = []; renderHook(useRoster).unmount();
  h.owner = account; h.devices = [host('a')];
  const restored = renderHook(useRoster);
  await waitFor(() => expect(restored.result.current[0]?.online).toBe(true));
  expect(restored.result.current[0].readAt).toBe(300);
});

it('retains a secondary-only companion read across main roster writes without resurrecting its row', async () => {
  window.history.replaceState(null, '', '/?secondaryWindow=1');
  h.devices = [host('a')];
  const secondaryOnly = collection();
  secondaryOnly.items[0].ref.id = 'only-secondary';
  Object.assign(secondaryOnly.items[0].display, { lastReplyAt: 100 });
  h.invoke.mockResolvedValue(secondaryOnly);
  const secondary = renderHook(useRoster);
  await waitFor(() => expect(secondary.result.current[0]?.id).toBe('only-secondary'));
  const account = h.owner;
  const key = 'cindy.remoteBots.v1.' + account;
  const mainRows = [{ ...secondary.result.current[0], id: 'same-bot', name: 'Main companion', online: false }];
  window.localStorage.setItem(key, JSON.stringify(mainRows));
  act(() => markRemoteBotRead('a', 'only-secondary', 300));
  expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual(mainRows);
  secondary.unmount();
  h.owner = 'between-window-owners'; h.devices = [];
  renderHook(useRoster).unmount();
  h.owner = account; h.devices = [host('a')];
  h.invoke.mockResolvedValue(collection('Main companion'));
  window.history.replaceState(null, '', '/');
  const main = renderHook(useRoster);
  await waitFor(() => expect(main.result.current[0]?.online).toBe(true));
  expect(JSON.parse(window.localStorage.getItem(key)!).map((bot: { id: string }) => bot.id)).toEqual(['same-bot']);
  // The read event is also consumed by the production main hook once the bot
  // becomes visible there; its independently newer reply stays unread.
  Object.assign(secondaryOnly.items[0].display, { lastReplyAt: 400 });
  h.invoke.mockResolvedValue(secondaryOnly);
  act(() => h.status({ status: 'online' }));
  await waitFor(() => expect(main.result.current[0]?.id).toBe('only-secondary'));
  expect(main.result.current[0].readAt).toBe(300);
  expect(isRemoteBotUnread(main.result.current[0])).toBe(true);
  const readsKey = readEntryKey(account, 'a', 'only-secondary', 400);
  const newValue = '1';
  window.localStorage.setItem(readsKey, newValue);
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: readsKey, newValue, storageArea: window.localStorage })));
  expect(isRemoteBotUnread(main.result.current[0])).toBe(false);
});

// Unit / review4457849952: a full independent read cache must still propagate
// the next explicit secondary read, including offline restoration.
it('evicts old read marks to persist a secondary read at the cache cap', async () => {
  window.history.replaceState(null, '', '/?secondaryWindow=1');
  h.devices = [host('a')];
  const secondary = renderHook(useRoster);
  await waitFor(() => expect(secondary.result.current).toHaveLength(1));
  const account = h.owner;
  const key = 'cindy.remoteBotReads.v1.' + account;
  const row = { deviceId: 'removed-device', id: 'x'.repeat(220), readAt: 1 };
  const count = Math.floor((256 * 1024 - 2) / (JSON.stringify(row).length + 1)) - 1;
  const rows = Array.from({ length: count }, (_, index) => ({ ...row, id: String(index).padStart(220, 'x') }));
  const raw = JSON.stringify(rows);
  const target = { deviceId: 'a', id: 'same-bot', readAt: 300 };
  // Fill the remaining space with a valid stale identity so the target cannot
  // fit without eviction; size is measured in the same units as production.
  rows.push({ ...row, id: 'z'.repeat(256 * 1024 - raw.length - JSON.stringify({ ...row, id: '' }).length - 1) });
  expect(JSON.stringify(rows).length).toBeLessThanOrEqual(256 * 1024);
  expect(JSON.stringify([...rows, target]).length).toBeGreaterThan(256 * 1024);
  window.localStorage.setItem(key, JSON.stringify(rows));
  // The compatible legacy array remains readable. Fill the new immutable
  // partition too, so this acknowledgement actually requires eviction there.
  fillReadPartition(account, 1);
  act(() => markRemoteBotRead('a', 'same-bot', 300));
  const saved = secondaryReadKeys(account);
  expect(saved.reduce((size, entry) => size + entry.length + 1, 0)).toBeLessThanOrEqual(256 * 1024);
  expect(saved).toContain(readEntryKey(account, 'a', 'same-bot', 300));
  expect(window.localStorage.getItem(key)).toBe(JSON.stringify(rows));
  secondary.unmount();
  h.devices = [];
  h.owner = account + '-between'; renderHook(useRoster).unmount();
  h.owner = account;
  h.devices = [host('a')];
  window.history.replaceState(null, '', '/');
  const main = renderHook(useRoster);
  await waitFor(() => expect(main.result.current).toHaveLength(1));
  expect(main.result.current[0].readAt).toBe(300);
  expect(isRemoteBotUnread(main.result.current[0])).toBe(false);
});

// Unit / review4459376600: pause A immediately before its native write;
// B acknowledges a different companion while A's eviction is in flight.
it.each(['before', 'after'] as const)('preserves concurrent acknowledgements paused %s the native write at capacity', async (pause) => {
  window.history.replaceState(null, '', '/?secondaryWindow=1');
  const outerId = 'a'.repeat(1000);
  const innerId = 'b'.repeat(1000);
  h.invoke.mockImplementation(async (deviceId: string) => ({ ...collection(), items: collection().items.map(item => ({
    ...item, ref: { ...item.ref, id: deviceId === 'a' ? outerId : innerId },
  })) }));
  const secondary = renderHook(useRoster);
  await waitFor(() => expect(secondary.result.current).toHaveLength(2));
  const account = h.owner;
  fillReadPartition(account, 400);
  const set = Storage.prototype.setItem;
  let interleave = true;
  const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (key === readEntryKey(account, pause === 'after' ? 'b' : 'a', pause === 'after' ? innerId : outerId, pause === 'after' ? 300 : 500) && interleave) {
      interleave = false;
      if (pause === 'after') set.call(this, key, value);
      if (pause === 'after') markRemoteBotRead('a', outerId, 500);
      else markRemoteBotRead('b', innerId, 300);
      if (pause === 'after') return;
    }
    set.call(this, key, value);
  });
  try { act(() => pause === 'after' ? markRemoteBotRead('b', innerId, 300) : markRemoteBotRead('a', outerId, 500)); }
  finally { spy.mockRestore(); }
  expect(interleave).toBe(false);
  secondary.unmount();
  h.devices = [];
  h.owner = account + '-between'; renderHook(useRoster).unmount();
  h.owner = account;
  h.devices = [host('b')];
  h.invoke.mockResolvedValue({ ...collection(), items: collection().items.map(item => ({
    ...item, ref: { ...item.ref, id: innerId }, display: { title: 'Writer', lastReplyAt: 600 },
  })) });
  window.history.replaceState(null, '', '/');
  const main = renderHook(useRoster);
  await waitFor(() => expect(main.result.current).toHaveLength(1));
  expect(main.result.current[0].readAt).toBe(300);
  expect(isRemoteBotUnread(main.result.current[0])).toBe(true);
});

// Unit / review4458970374: pause one renderer's storage read while another
// public acknowledgement commits, then close the source before main discovers it.
it.each(['b', 'a'])('retains concurrent read marks for host %s after the source window closes', async (otherDevice) => {
  window.history.replaceState(null, '', '/?secondaryWindow=1');
  const secondary = renderHook(useRoster);
  await waitFor(() => expect(secondary.result.current).toHaveLength(2));
  const account = h.owner;
  const readsKey = 'cindy.remoteBotReads.v1.' + account;
  const get = Storage.prototype.getItem;
  let interleave = true;
  const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
    const raw = get.call(this, key);
    if (key === readsKey && interleave) {
      interleave = false;
      markRemoteBotRead(otherDevice, 'same-bot', 300);
    }
    return raw;
  });
  try { act(() => markRemoteBotRead('a', 'same-bot', 200)); }
  finally { spy.mockRestore(); }
  expect(interleave).toBe(false);
  secondary.unmount();
  h.owner = account + '-between'; h.devices = [];
  renderHook(useRoster).unmount();
  h.owner = account;
  h.devices = [host(otherDevice)];
  window.history.replaceState(null, '', '/');
  const later = collection();
  Object.assign(later.items[0].display, { lastReplyAt: 400 });
  h.invoke.mockResolvedValue(later);
  const main = renderHook(useRoster);
  await waitFor(() => expect(main.result.current).toHaveLength(1));
  expect(main.result.current[0].readAt).toBe(300);
  expect(isRemoteBotUnread(main.result.current[0])).toBe(true);
});

it('merges a newer shared read before a stale refresh writes the roster cache', async () => {
  h.devices = [host('a')];
  const { result } = renderHook(useRoster);
  await waitFor(() => expect(result.current).toHaveLength(1));
  act(() => markRemoteBotRead('a', 'same-bot', 100));
  const key = 'cindy.remoteBots.v1.' + h.owner;
  // Other-window read is persisted, but its storage event has not arrived yet.
  window.localStorage.setItem(key, JSON.stringify(result.current.map(bot => ({ ...bot, readAt: 300 }))));
  act(() => h.status({ status: 'online' }));
  await act(async () => {});
  expect(result.current[0].readAt).toBe(300);
  expect(JSON.parse(window.localStorage.getItem(key)!)[0].readAt).toBe(300);
  // A queued older storage event must not rewind the current or saved position.
  const newValue = JSON.stringify(result.current.map(bot => ({ ...bot, readAt: 200 })));
  window.localStorage.setItem(key, newValue);
  act(() => window.dispatchEvent(new StorageEvent('storage', { key, newValue })));
  expect(result.current[0].readAt).toBe(300);
  expect(JSON.parse(window.localStorage.getItem(key)!)[0].readAt).toBe(300);
});

// Unit / review4454475377: 200 is per host, not the aggregate roster bound.
it('merges cross-window reads past row 200 across home devices', async () => {
  h.invoke.mockImplementation(async () => ({ collectionId: 'teammates', items: Array.from({ length: 101 }, (_, index) => ({
    ref: { collectionId: 'teammates', kind: 'bot', id: `bot-${index}` },
    display: { title: `Bot ${index}`, lastReplyAt: 100 },
  })) }));
  const { result } = renderHook(useRoster);
  await waitFor(() => expect(result.current).toHaveLength(202));
  const target = result.current[201];
  const key = 'cindy.remoteBots.v1.' + h.owner;
  const shared = (at: number) => JSON.stringify(result.current.map((bot, index) => ({ ...bot, readAt: index === 201 ? at : bot.readAt })));
  const newValue = shared(300);
  window.localStorage.setItem(key, newValue);
  act(() => window.dispatchEvent(new StorageEvent('storage', { key, newValue, storageArea: window.localStorage })));
  expect(result.current.find(bot => remoteBotKey(bot) === remoteBotKey(target))?.readAt).toBe(300);
  window.localStorage.setItem(key, shared(400));
  act(() => h.status({ status: 'online' }));
  await act(async () => {});
  expect(result.current.find(bot => remoteBotKey(bot) === remoteBotKey(target))?.readAt).toBe(400);
  expect(JSON.parse(window.localStorage.getItem(key)!)[201].readAt).toBe(400);
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

// Unit / review4460020599: one host can publish 200 delegation results.
// Count actual storage reads rather than a machine-dependent elapsed-time limit.
it('reuses a refresh read snapshot across delegation publishes without regressing an intervening read', async () => {
  h.devices = [host('a')];
  const value: { collectionId: string; items: unknown[] } = collection();
  value.items = Array.from({ length: 200 }, (_, index) => ({
    ...collection().items[0],
    ref: { ...collection().items[0].ref, id: 'bot-' + index },
    display: { title: 'Bot ' + index, lastReplyAt: 400 },
  }));
  window.localStorage.setItem(readEntryKey(h.owner, 'a', 'bot-0', 100), '1');
  let finish!: (value: unknown) => void;
  let first = true;
  h.invoke.mockImplementation(async (_device, channel) => {
    if (channel === REMOTE_RESOURCE_LIST_CHANNEL) return value;
    if (first) { first = false; return new Promise(resolve => { finish = resolve; }); }
    return { ok: true, delegations: [] };
  });
  const get = vi.spyOn(Storage.prototype, 'getItem');
  try {
    const { result } = renderHook(useRoster);
    await waitFor(() => expect(finish).toBeDefined());
    act(() => markRemoteBotRead('a', 'bot-0', 300));
    const prefix = 'cindy.remoteBotReads.v1.entry.' + JSON.stringify(h.owner) + '.';
    const scans = () => get.mock.calls.filter(([key]) => key.startsWith(prefix)).length;
    const before = scans();
    await act(async () => { finish({ ok: true, delegations: [] }); });
    await waitFor(() => expect(result.current.at(-1)?.delegatedSessionIds).toEqual([]));
    expect(h.invoke.mock.calls.filter(call => call[1] === 'maker:bot-delegations:list')).toHaveLength(200);
    expect(scans() - before).toBe(0);
    expect(result.current[0].readAt).toBe(300);
    expect(isRemoteBotUnread(result.current[0])).toBe(true);
  } finally { get.mockRestore(); }
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
