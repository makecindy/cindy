import AsyncStorage from '@react-native-async-storage/async-storage';
import type { HistoryDiskIO } from './historyDiskStore';

let io: Promise<HistoryDiskIO> | undefined;
const disk = () => io ??= import('./historyDiskStoreExpo')
  .then(({ createHistoryDiskIO }) => createHistoryDiskIO('session-messages-v1'))
  .catch(error => { io = undefined; throw error; });

async function persist(operation: () => Promise<void>): Promise<void> {
  try { await operation(); }
  catch (error) {
    void import('./cacheWriteNotice').then(module => module.notifyCacheWriteFailure()).catch(() => undefined);
    throw error;
  }
}

function write(key: string, value: string): Promise<void> {
  return persist(async () => { await (await disk()).write(`${key}.json`, value); });
}

// Exhaust every deletion before rejecting. One unavailable backend/file must not
// prevent another from being removed, or let account cleanup finish early.
async function removeAll(operations: Array<() => Promise<void>>): Promise<void> {
  const errors: unknown[] = [];
  for (const operation of operations) {
    try { await operation(); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Cache cleanup failed');
}

// Callers serialize operations per key and fence reads/writes against logout.
// Both mobile platforms use the same private cache files, with no total quota/TTL.
export const messageCacheStorage = {
  async getItem(key: string): Promise<string | null> {
    const files = await disk();
    const current = await files.read(`${key}.json`);
    if (current !== null) return current;
    const legacy = await AsyncStorage.getItem(key);
    if (legacy === null) return null;
    try {
      await write(key, legacy);
      await AsyncStorage.removeItem(key);
    } catch { /* Migration failure must leave the old cache readable. */ }
    return legacy;
  },
  async setItem(key: string, value: string): Promise<void> {
    await write(key, value);
    // Disk is authoritative even if cleanup fails; retry on the next write.
    await AsyncStorage.removeItem(key).catch(() => undefined);
  },
  async removeItem(key: string): Promise<void> {
    await persist(() => removeAll([
      () => AsyncStorage.removeItem(key),
      async () => { await (await disk()).remove(`${key}.json`); },
    ]));
  },
  async clear(prefix: string): Promise<void> {
    await persist(() => removeAll([
      async () => {
        const keys = (await AsyncStorage.getAllKeys()).filter(key => key.startsWith(`${prefix}.`));
        if (keys.length) await AsyncStorage.multiRemove(keys);
      },
      async () => {
        const files = await disk();
        await removeAll((await files.files()).map(name => () => files.remove(name)));
      },
    ]));
  },
};
