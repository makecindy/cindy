import { beforeEach, expect, it, vi } from 'vitest';
const disk = vi.hoisted(() => new Map<string, string>());
const files = vi.hoisted(() => new Map<string, string>());
const io = vi.hoisted(() => ({
  read: vi.fn(async (key: string) => files.get(key) ?? null),
  write: vi.fn(async (key: string, value: string) => { files.set(key, value); }),
  remove: vi.fn(async (key: string) => { files.delete(key); }),
  files: vi.fn(async () => [...files.keys()]),
}));
vi.mock('@/session/historyDiskStoreExpo', () => ({ createHistoryDiskIO: () => io }));
vi.mock('@/session/cacheWriteNotice', () => ({ notifyCacheWriteFailure: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async (key: string) => disk.get(key) ?? null,
  setItem: async (key: string, value: string) => {
    const total = [...disk].filter(([existing]) => existing !== key).reduce((sum, [, text]) => sum + text.length, value.length);
    if (total > 6 * 1024 * 1024) throw new Error('SQLITE_FULL');
    disk.set(key, value);
  },
  removeItem: async (key: string) => { disk.delete(key); },
} }));
import { createMobileChatHistoryStore, clearMobileChatHistoryStore } from '@/chat/chatHistoryStore';
import type { ChatHistoryState } from '@cindy/maker-shared/chat-history';
const state: ChatHistoryState = { generation: 'a', cursor: '12', metadataDirty: false,
  snapshot: { room: { id: 'room' }, cursor: '12', messages: [] }, pages: { 'limit=100': ['m'] }, messages: { m: { id: 'm', seq: '1', revision: 2, deleted: true } } };
const store = (owner = 'owner', realm = 'global', endpoint = 'https://chat.example', human = 'human', current = () => true) =>
  createMobileChatHistoryStore(owner, realm, endpoint, human, current);
beforeEach(() => { disk.clear(); files.clear(); vi.clearAllMocks(); });
// Unit: actual mobile storage entry points, not native mocks of the cache algorithm.
it('restores data and cursor together and partitions owner, region, server and verified identity', async () => {
  const first = store(); await first.read('room'); await first.write('room', state);
  expect(await store().read('room')).toEqual(state);
  for (const other of [store('other'), store(undefined, 'cn'), store(undefined, undefined, 'https://other.example'), store(undefined, undefined, undefined, 'other-human')])
    expect(await other.read('room')).toBeUndefined();
  let current = true; const old = store(undefined, undefined, undefined, undefined, () => current);
  await old.read('room'); current = false;
  await expect(old.write('room', null)).rejects.toThrow('OWNER_CHANGED');
  expect(await store().read('room')).toEqual(state);
});
it('prevents concurrent mounts from overwriting a newer durable cursor', async () => {
  const a = store(), b = store(); await a.read('room'); await b.read('room');
  await a.write('room', state);
  // A stale revocation/cleanup cannot erase another mount's newer commit.
  await expect(b.write('room', null)).rejects.toThrow('CHAT_CACHE_CONFLICT');
  await expect(b.write('room', { ...state, cursor: '3' })).rejects.toThrow('CHAT_CACHE_CONFLICT');
  expect(await store().read('room')).toEqual(state);
  await b.read('room'); await a.write('room', null);
  await a.write('room', { ...state, generation: 'rebuilt' });
  await expect(b.write('room', null)).rejects.toThrow('CHAT_CACHE_CONFLICT');
  await expect(b.write('room', state)).rejects.toThrow('CHAT_CACHE_CONFLICT');
  expect(await store().read('room')).toMatchObject({ generation: 'rebuilt', cursor: '12' });
  await a.write('room', null); expect(await b.read('room')).toBeUndefined();
});

// Unit regression: each room is below the old per-value cap, but their total exceeds
// Android AsyncStorage's shared budget and used to break unrelated draft/outbox writes.
it('persists many room histories without consuming the preferences database', async () => {
  const cache = store();
  const large = { ...state, messages: { m: { ...state.messages.m, text: 'x'.repeat(250_000) } } };
  for (let index = 0; index < 30; index++) await cache.write(`room-${index}`, large);
  expect(await store().read('room-29')).toEqual(large);
  expect(disk.size).toBe(0);
});

// Unit: logout must drain a native write already in flight before deleting files,
// and revoke its old instance even when its caller has not rerendered yet.
it('drains a delayed write on account cleanup and fences old and queued instances', async () => {
  const old = store(); await old.write('room', state);
  let finish!: () => void;
  io.write.mockImplementationOnce(async (key, value) => {
    await new Promise<void>(resolve => { finish = resolve; }); files.set(key, value);
  });
  const pending = old.write('room', { ...state, cursor: '13' });
  const rejected = expect(pending).rejects.toThrow('OWNER_CHANGED');
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'), { interval: 1 });
  const clearing = clearMobileChatHistoryStore();
  await expect(old.write('another', state)).rejects.toThrow('OWNER_CHANGED');
  finish(); await rejected; await clearing;
  expect(files.size).toBe(0);
  await expect(old.read('room')).rejects.toThrow('OWNER_CHANGED');
  expect(await store().read('room')).toBeUndefined();
});

it('attempts every deletion and retries failures before a new account can persist', async () => {
  const old = store(); await old.write('a', state); await old.write('b', state);
  io.remove.mockRejectedValueOnce(new Error('busy'));
  await expect(clearMobileChatHistoryStore()).rejects.toThrow('Chat cache cleanup failed');
  expect(files.size).toBe(1);
  await clearMobileChatHistoryStore(); expect(files.size).toBe(0);
  const next = store('new-owner'); await next.write('room', state);
  expect(await next.read('room')).toEqual(state);
});
