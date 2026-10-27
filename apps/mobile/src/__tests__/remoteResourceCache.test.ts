import { beforeEach, expect, it, vi } from 'vitest';
const disk = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: vi.fn(async (key: string) => disk.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => { disk.set(key, value); }),
  removeItem: vi.fn(async (key: string) => { disk.delete(key); }),
  getAllKeys: vi.fn(async () => [...disk.keys()]),
  multiRemove: vi.fn(async (keys: string[]) => { keys.forEach((key) => disk.delete(key)); }),
} }));
import { cacheChatRoster, readCachedChatRoster, cacheRemoteResourceHome, cacheRemoteResourceItems, cachedTaskFollowers, clearRemoteResourceCache, isRemoteResourceUnread, markRemoteResourceRead, readRemoteResourceSnapshot, remoteResourceCacheRevision, subscribeRemoteResourceCache } from '@/device-link/remoteResourceCache';
import { chatReadAt, chatRoomRow, type ChatSnapshot } from '@/chat/chatServerClient';
const rows = (deviceId: string, lastReplyAt: number) => [{
  key: `${deviceId}:bot:writer`, host: { deviceId, deviceName: deviceId },
  item: { ref: { collectionId: 'teammates', kind: 'bot', id: 'writer' }, display: { title: 'Writer', lastReplyAt }, revision: '1', links: [] },
}];
beforeEach(async () => { await clearRemoteResourceCache(); disk.clear(); });
it('restores the same collection-qualified row identity used by live lists', async () => {
  const live = rows('home', 100)[0];
  live.key = JSON.stringify(['home', 'teammates', 'bot', 'writer']);
  disk.set('cindy.remoteResources.v1.alice', JSON.stringify({ items: { teammates: [live] } }));
  expect((await readRemoteResourceSnapshot('alice')).items.teammates[0].key).toBe(live.key);
});
it('does not restore routines from an old offline snapshot while retaining companions', async () => {
  const home = [
    { id: 'routines', title: '例行任务', resourceKind: 'routine', targets: [{ deviceId: 'home', deviceName: 'Home' }] },
    { id: 'teammates', title: 'Companions', resourceKind: 'bot', targets: [{ deviceId: 'home', deviceName: 'Home' }] },
  ];
  disk.set('cindy.remoteResources.v1.alice', JSON.stringify({
    home,
    items: { teammates: rows('home', 100), routines: [{
      ...rows('home', 100)[0],
      item: { ref: { collectionId: 'routines', kind: 'routine', id: 'daily' }, display: { title: 'Daily' }, revision: '1', links: [] },
    }] },
    read: {},
  }));
  const snapshot = await readRemoteResourceSnapshot('alice');
  expect(snapshot.home.map((item) => item.id)).toEqual(['teammates']);
  expect(snapshot.items.routines).toBeUndefined();
  expect(snapshot.items.teammates).toHaveLength(1);
  await cacheRemoteResourceHome('alice', home);
  expect((await readRemoteResourceSnapshot('alice')).home.map((item) => item.id)).toEqual(['teammates']);
});
// Task rows draw the teammate mark from the roster's `following` links (desktop useSessionFollowers).
// The same task id on another computer, or a link the host withdrew, must never keep a mark.
it('finds the teammates following a task on its own computer, by name, and drops withdrawn links', async () => {
  const follower = (deviceId: string, id: string, title: string, sessionIds: string[]) => ({
    key: JSON.stringify([deviceId, 'teammates', 'bot', id]), host: { deviceId, deviceName: deviceId },
    item: { ref: { collectionId: 'teammates', kind: 'bot', id }, display: { title }, revision: '1',
      links: sessionIds.map((sessionId) => ({ rel: 'following', target: { kind: 'session' as const, sessionId } })) },
  });
  await cacheRemoteResourceItems('alice', 'teammates', [
    follower('home', 'lizi', 'LiZi', ['task']), follower('home', 'cindy', 'Cindy', ['task']), follower('office', 'dash', 'Dash', ['other']),
  ]);
  expect(cachedTaskFollowers('alice', 'home', 'task').map((row) => row.item.ref.id)).toEqual(['cindy', 'lizi']);
  expect(cachedTaskFollowers('alice', 'office', 'task')).toEqual([]);
  expect(cachedTaskFollowers('bob', 'home', 'task')).toEqual([]);
  await cacheRemoteResourceItems('alice', 'teammates', [follower('home', 'lizi', 'LiZi', []), follower('home', 'cindy', 'Cindy', ['task'])]);
  expect(cachedTaskFollowers('alice', 'home', 'task').map((row) => row.item.ref.id)).toEqual(['cindy']);
});
// A task row can ask before the disk cache answers on a cold start (#7066 review).
it('tells rows that read before the saved roster loaded once it arrives', async () => {
  disk.set('cindy.remoteResources.v1.alice', JSON.stringify({ items: { teammates: [{
    key: JSON.stringify(['home', 'teammates', 'bot', 'cindy']), host: { deviceId: 'home', deviceName: 'home' },
    item: { ref: { collectionId: 'teammates', kind: 'bot', id: 'cindy' }, display: { title: 'Cindy' }, revision: '1',
      links: [{ rel: 'following', target: { kind: 'session', sessionId: 'task' } }] },
  }] } }));
  expect(cachedTaskFollowers('alice', 'home', 'task')).toEqual([]);
  const listener = vi.fn();
  const unsubscribe = subscribeRemoteResourceCache(listener);
  try {
    await readRemoteResourceSnapshot('alice');
    expect(listener).toHaveBeenCalledOnce();
    expect(cachedTaskFollowers('alice', 'home', 'task').map((row) => row.item.ref.id)).toEqual(['cindy']);
  } finally {
    unsubscribe();
  }
});
it('keeps device-qualified read positions and treats only later host replies as unread', async () => {
  await cacheRemoteResourceItems('alice', 'teammates', [...rows('home', 100), ...rows('office', 100)]);
  expect(isRemoteResourceUnread('alice', 'home', 'writer', 100)).toBe(false);
  await cacheRemoteResourceItems('alice', 'teammates', [...rows('home', 200), ...rows('office', 100)]);
  expect(isRemoteResourceUnread('alice', 'home', 'writer', 200)).toBe(true);
  expect(isRemoteResourceUnread('alice', 'office', 'writer', 100)).toBe(false);
  await markRemoteResourceRead('alice', 'home', 'writer', 200);
  await markRemoteResourceRead('alice', 'home', 'writer', 100);
  expect(isRemoteResourceUnread('alice', 'home', 'writer', 200)).toBe(false);
  expect((await readRemoteResourceSnapshot('bob')).items).toEqual({});
});
it('preserves unread replies in the same millisecond using exact server sequences', async () => {
  const first = '9007199254740992', second = '9007199254740993';
  const data: ChatSnapshot = { room: { id: 'group', name: 'Discussion', kind: 'group', archived: false, revision: 1,
    created_at: '2026-10-09', updated_at: '2026-10-09', response_mode: 'all', speaking_mode: 'auto' }, cursor: second,
    reads: [{ thread_key: 'main', read_seq: first }], members: [], messages: [first, second].map((seq, index) => ({
      id: `incoming-${index}`, seq, authorId: 'other', author: { kind: 'human', name: 'Other' },
      createdAt: '2026-10-09T10:00:00.123Z', deleted: false, threadRootId: null, content: [{ type: 'text', text: 'hello' }],
    })) };
  const row = chatRoomRow(data.room, data, 'self');
  await markRemoteResourceRead('alice', '', 'group', chatReadAt(data, 'self'), first);
  expect(isRemoteResourceUnread('alice', '', 'group', row.item.display.lastReplyAt, second)).toBe(true);
  await markRemoteResourceRead('alice', '', 'group', row.item.display.lastReplyAt!, second);
  await markRemoteResourceRead('alice', '', 'group', chatReadAt(data, 'self'), first);
  expect(isRemoteResourceUnread('alice', '', 'group', row.item.display.lastReplyAt, second)).toBe(false);
  expect(isRemoteResourceUnread('bob', '', 'group', row.item.display.lastReplyAt, second)).toBe(true);
  vi.resetModules();
  const restored = await import('@/device-link/remoteResourceCache');
  await restored.readRemoteResourceSnapshot('alice');
  expect(restored.isRemoteResourceUnread('alice', '', 'group', row.item.display.lastReplyAt, second)).toBe(false);
});
it('stays silent when a read mark or roster refresh leaves the cache unchanged', async () => {
  const { default: storage } = await import('@react-native-async-storage/async-storage');
  await cacheRemoteResourceItems('alice', 'teammates', rows('home', 100));
  const listener = vi.fn();
  const unsubscribe = subscribeRemoteResourceCache(listener);
  const revision = remoteResourceCacheRevision();
  vi.mocked(storage.setItem).mockClear();
  try {
    // An open companion chat re-acknowledges the same reply on every render; these
    // must not notify subscribers, or the re-render acknowledges again (idle CPU loop).
    await markRemoteResourceRead('alice', 'home', 'writer', 100);
    await markRemoteResourceRead('alice', 'home', 'writer', 50);
    await cacheRemoteResourceItems('alice', 'teammates', rows('home', 100));
    expect(listener).not.toHaveBeenCalled();
    expect(remoteResourceCacheRevision()).toBe(revision);
    expect(storage.setItem).not.toHaveBeenCalled();

    await cacheRemoteResourceItems('alice', 'teammates', rows('home', 200));
    expect(isRemoteResourceUnread('alice', 'home', 'writer', 200)).toBe(true);
    await markRemoteResourceRead('alice', 'home', 'writer', 200);
    expect(isRemoteResourceUnread('alice', 'home', 'writer', 200)).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(storage.setItem).toHaveBeenCalledTimes(2);
  } finally {
    unsubscribe();
  }
});
it('retries a failed cache write on the next unchanged update without notifying', async () => {
  const { default: storage } = await import('@react-native-async-storage/async-storage');
  const persistedRead = () => JSON.parse(disk.get('cindy.remoteResources.v1.alice') ?? '{}').read?.['["home","writer"]'];
  await cacheRemoteResourceItems('alice', 'teammates', rows('home', 100));
  await cacheRemoteResourceItems('alice', 'teammates', rows('home', 200));
  vi.mocked(storage.setItem).mockRejectedValueOnce(new Error('disk full'));
  await markRemoteResourceRead('alice', 'home', 'writer', 200);
  expect(isRemoteResourceUnread('alice', 'home', 'writer', 200)).toBe(false);
  expect(persistedRead()).toBe(100);
  const listener = vi.fn();
  const unsubscribe = subscribeRemoteResourceCache(listener);
  try {
    // A later unchanged update (roster refresh or the same read mark) repairs the disk copy.
    await markRemoteResourceRead('alice', 'home', 'writer', 200);
    expect(persistedRead()).toBe(200);
    expect(listener).not.toHaveBeenCalled();
    vi.mocked(storage.setItem).mockClear();
    await cacheRemoteResourceItems('alice', 'teammates', rows('home', 200));
    expect(storage.setItem).not.toHaveBeenCalled();
  } finally {
    unsubscribe();
  }
});
it('restores portable roster data after process restart and never persists runtime facts', async () => {
  await cacheRemoteResourceHome('alice', [{ id: 'teammates', title: 'Companions', resourceKind: 'bot', targets: [{ deviceId: 'home', deviceName: 'Home' }] }]);
  const items = rows('home', 100);
  Object.assign(items[0].item, { permissionSnapshot: { secret: 'private' }, online: true });
  await cacheRemoteResourceItems('alice', 'teammates', items);
  vi.resetModules();
  const fresh = await import('@/device-link/remoteResourceCache');
  const restored = await fresh.readRemoteResourceSnapshot('alice');
  expect(restored.home[0].targets[0].deviceId).toBe('home');
  expect(restored.items.teammates[0].item.display.title).toBe('Writer');
  expect(JSON.stringify(restored)).not.toContain('permissionSnapshot');
  expect(JSON.stringify(restored)).not.toContain('online');
  await fresh.clearRemoteResourceCache();
  expect(disk.size).toBe(0);
});

// Review regression (unit): valid group/member data can exceed the shared 256 KiB
// budget. Exercise persistence and cold read, not just the in-memory mirror.
it('persists a bounded recent roster when group avatars exceed the disk budget', async () => {
  await cacheRemoteResourceItems('alice', 'teammates', rows('home', 1000));
  const groups = Array.from({ length: 100 }, (_, index) => ({
    key: `chat:group-${index}`, host: { deviceId: '', deviceName: '' },
    item: { ref: { collectionId: 'bot-groups', kind: 'bot-group', id: `group-${index}` },
      display: { title: `Group ${index}`, lastReplyAt: index, preview: 'Known summary' }, revision: '1', links: [] },
    groupMembers: Array.from({ length: 20 }, (_, member) => ({ botId: `member-${member}`, name: `Member ${member}`,
      avatar: '', avatarColor: '', avatarUrl: `https://avatars.example.invalid/${'a'.repeat(700)}/${member}.png` })),
  }));
  await cacheChatRoster('alice', 'global', groups, groups.map(row => row.item.ref.id));
  expect((await readCachedChatRoster('alice', 'global'))?.items).toHaveLength(100);
  const saved = disk.get('cindy.remoteResources.v1.alice')!;
  expect(saved.length).toBeLessThanOrEqual(256 * 1024);
  await clearRemoteResourceCache(); disk.set('cindy.remoteResources.v1.alice', saved);
  const restored = await readCachedChatRoster('alice', 'global');
  expect(restored?.items.length).toBeGreaterThan(0);
  expect(restored?.items.at(-1)).toMatchObject({ item: { ref: { id: 'group-99' }, display: { preview: 'Known summary' } }, groupMembers: groups[99].groupMembers.slice(0, 5) });
  expect(restored?.ids).toHaveLength(100);
  expect((await readRemoteResourceSnapshot('alice')).items.teammates).toHaveLength(1);
  await cacheChatRoster('alice', 'global', [], groups.map(row => row.item.ref.id));
  expect(JSON.parse(disk.get('cindy.remoteResources.v1.alice')!).chatRosters.global.items).toEqual([]);
});
