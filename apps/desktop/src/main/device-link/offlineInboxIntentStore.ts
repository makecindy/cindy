import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  normalizeOfflineInboxIntent,
  normalizeOfflineInboxIntents,
  offlineInboxIntentKey,
  type OfflineInboxIntent,
} from '@cindy/maker-shared/offline-inbox-intent';
import { ownerScopedUserDataPath } from '../appSessionState';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile';
import { throwIpcError } from '../utils/ipcValidate';

const STORE_FILENAME = 'offline-inbox-intents.json';
const MAX_STORE_BYTES = 256 * 1024;

interface StoredOfflineInboxIntents {
  schemaVersion: 1;
  intents: OfflineInboxIntent[];
}

export interface OfflineInboxIntentStore {
  list(): Promise<OfflineInboxIntent[]>;
  upsert(raw: unknown): Promise<OfflineInboxIntent[]>;
  remove(deviceId: string, sessionId: string): Promise<OfflineInboxIntent[]>;
  clearDevice(deviceId: string): Promise<OfflineInboxIntent[]>;
  clearAll(): Promise<void>;
}

/**
 * Owner-scoped local persistence for queued offline inbox actions (`snooze` / `complete`).
 * Main owns all disk IO and serializes read-modify-write operations so multiple windows
 * never clobber one another; callers receive normalized snapshots and cross-window broadcasts.
 */
export function createOfflineInboxIntentStore(
  resolveFilePath: () => string,
): OfflineInboxIntentStore {
  let chain: Promise<unknown> = Promise.resolve();

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = chain.then(task, task);
    chain = next.catch(() => undefined);
    return next;
  }

  function readAllSync(filePath: string): OfflineInboxIntent[] {
    let raw: string | null;
    try {
      raw = readAtomicFileSync(filePath);
    } catch {
      return [];
    }
    if (!raw || Buffer.byteLength(raw, 'utf8') > MAX_STORE_BYTES) return [];
    try {
      const parsed = JSON.parse(raw) as Partial<StoredOfflineInboxIntents>;
      return normalizeOfflineInboxIntents(parsed?.intents);
    } catch {
      return [];
    }
  }

  function writeAllSync(filePath: string, intents: OfflineInboxIntent[]): OfflineInboxIntent[] {
    const normalized = normalizeOfflineInboxIntents(intents);
    const payload: StoredOfflineInboxIntents = {
      schemaVersion: 1,
      intents: normalized,
    };
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_STORE_BYTES) {
      throwIpcError('INVALID_PARAMS', 'Offline inbox intent store exceeds size budget');
    }
    try {
      atomicWriteFileSync(filePath, serialized);
    } catch {
      throwIpcError('INTERNAL', 'Failed to persist offline inbox intents');
    }
    return normalized;
  }

  return {
    list(): Promise<OfflineInboxIntent[]> {
      return enqueue(async () => readAllSync(resolveFilePath()));
    },

    async upsert(raw: unknown): Promise<OfflineInboxIntent[]> {
      const intent = normalizeOfflineInboxIntent(raw);
      if (!intent) {
        throwIpcError('INVALID_PARAMS', 'Invalid offline inbox intent');
      }
      return enqueue(async () => {
        const filePath = resolveFilePath();
        const current = readAllSync(filePath);
        const key = offlineInboxIntentKey(intent.deviceId, intent.sessionId);
        const filtered = current.filter(
          (item) => offlineInboxIntentKey(item.deviceId, item.sessionId) !== key,
        );
        return writeAllSync(filePath, [intent, ...filtered]);
      });
    },

    async remove(deviceId: string, sessionId: string): Promise<OfflineInboxIntent[]> {
      const trimmedDevice = deviceId.trim();
      const trimmedSession = sessionId.trim();
      if (!trimmedDevice || !trimmedSession) {
        throwIpcError('INVALID_PARAMS', 'deviceId and sessionId are required');
      }
      return enqueue(async () => {
        const filePath = resolveFilePath();
        const current = readAllSync(filePath);
        const key = offlineInboxIntentKey(trimmedDevice, trimmedSession);
        const next = current.filter(
          (item) => offlineInboxIntentKey(item.deviceId, item.sessionId) !== key,
        );
        if (next.length === current.length) return current;
        return writeAllSync(filePath, next);
      });
    },

    async clearDevice(deviceId: string): Promise<OfflineInboxIntent[]> {
      const trimmedDevice = deviceId.trim();
      if (!trimmedDevice) {
        throwIpcError('INVALID_PARAMS', 'deviceId is required');
      }
      return enqueue(async () => {
        const filePath = resolveFilePath();
        const current = readAllSync(filePath);
        const next = current.filter((item) => item.deviceId !== trimmedDevice);
        if (next.length === current.length) return current;
        return writeAllSync(filePath, next);
      });
    },

    clearAll(): Promise<void> {
      return enqueue(async () => {
        const filePath = resolveFilePath();
        await Promise.all([
          fsp.rm(filePath, { force: true }).catch(() => undefined),
          fsp.rm(`${filePath}.bak`, { force: true }).catch(() => undefined),
        ]);
      });
    },
  };
}

let singleton: OfflineInboxIntentStore | null = null;

export function getOfflineInboxIntentStore(): OfflineInboxIntentStore {
  singleton ??= createOfflineInboxIntentStore(() =>
    path.join(ownerScopedUserDataPath('device-link-offline-inbox'), STORE_FILENAME),
  );
  return singleton;
}
