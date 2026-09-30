import { beforeEach, expect, it, vi } from 'vitest';
const disk = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: vi.fn(async (key: string) => disk.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => { disk.set(key, value); }),
  removeItem: vi.fn(async (key: string) => { disk.delete(key); }),
  getAllKeys: vi.fn(async () => [...disk.keys()]),
  multiRemove: vi.fn(async (keys: string[]) => { keys.forEach((key) => disk.delete(key)); }),
} }));
import { cacheRemoteResourceHome, cacheRemoteResourceItems, clearRemoteResourceCache, isRemoteResourceUnread, markRemoteResourceRead, readRemoteResourceSnapshot, remoteResourceCacheRevision, subscribeRemoteResourceCache } from '@/device-link/remoteResourceCache';
const rows = (deviceId: string, lastReplyAt: number) => [{
  key: `${deviceId}:bot:writer`, host: { deviceId, deviceName: deviceId },
  item: { ref: { collectionId: 'teammates', kind: 'bot', id: 'writer' }, display: { title: 'Writer', lastReplyAt }, revision: '1', links: [] },
}];
beforeEach(async () => { await clearRemoteResourceCache(); disk.clear(); });
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
