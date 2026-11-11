import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import type { ChatHistoryState, ChatHistoryStore } from '@cindy/maker-shared/chat-history';
import type { HistoryDiskIO } from '@/session/historyDiskStore';

const writes = new Map<string, Promise<unknown>>();
let io: Promise<HistoryDiskIO> | undefined;
let epoch = 0;
let clearing: Promise<void> | undefined;
const disk = () => io ??= import('@/session/historyDiskStoreExpo')
  .then(({ createHistoryDiskIO }) => createHistoryDiskIO('chat-history-v1'))
  .catch(error => { io = undefined; throw error; });
async function persist(operation: () => Promise<void>) {
  try { await operation(); }
  catch (error) {
    void import('@/session/cacheWriteNotice').then(module => module.notifyCacheWriteFailure()).catch(() => undefined);
    throw error;
  }
}

/** Private, disposable files share the existing atomic replacement backend; no AsyncStorage quota. */
export function createMobileChatHistoryStore(owner: string, realm: string, endpoint: string, human: string, current: () => boolean): ChatHistoryStore {
  const generation = epoch;
  const versions = new Map<string, number | null>();
  const generations = new Map<string, string | null>();
  const assertCurrent = () => { if (!owner || !current() || generation !== epoch || clearing) throw new Error('OWNER_CHANGED'); };
  function serial<T>(room: string, action: (files: HistoryDiskIO, key: string) => Promise<T>): Promise<T> {
    const key = `${bytesToHex(sha256(JSON.stringify([owner, realm, endpoint, human, room])))}.json`;
    const pending = (writes.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      assertCurrent();
      const files = await disk(); assertCurrent();
      const result = await action(files, key);
      assertCurrent();
      return result;
    });
    writes.set(key, pending);
    void pending.finally(() => { if (writes.get(key) === pending) writes.delete(key); }).catch(() => undefined);
    return pending;
  }
  const decode = (text: string | null): { version: number; state: ChatHistoryState } | null => {
    if (!text) return null;
    try { const value = JSON.parse(text); return value?.state?.snapshot && value?.state?.generation && Number.isSafeInteger(value.version) ? value : null; }
    catch { return null; }
  };
  return {
    read: room => serial(room, async (files, key) => {
      const value = decode(await files.read(key));
      versions.set(room, value?.version ?? null);
      generations.set(room, value?.state.generation ?? null);
      return value?.state;
    }),
    write: (room, state) => serial(room, async (files, key) => {
      const old = decode(await files.read(key));
      if ((old?.version ?? null) !== (versions.get(room) ?? null)
        || (old?.state.generation ?? null) !== (generations.get(room) ?? null)) throw new Error('CHAT_CACHE_CONFLICT');
      assertCurrent();
      if (!state) { await persist(() => files.remove(key)); versions.set(room, null); generations.set(room, null); return; }
      const version = (old?.version ?? 0) + 1;
      const payload = JSON.stringify({ version, state });
      await persist(() => files.write(key, payload));
      versions.set(room, version); generations.set(room, state.generation);
    }),
  };
}

/** Fence old mounts synchronously, drain native writes, then remove every account's files. */
export function clearMobileChatHistoryStore(): Promise<void> {
  if (clearing) return clearing;
  epoch++;
  const pending = [...writes.values()];
  clearing = (async () => {
    await Promise.allSettled(pending);
    await persist(async () => {
      const files = await disk();
      const results = await Promise.allSettled((await files.files()).map(name => files.remove(name)));
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, 'Chat cache cleanup failed');
    });
  })().finally(() => { clearing = undefined; });
  return clearing;
}
