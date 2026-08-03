import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY_PREFIX = 'cindy.mobile.fullAccessAcknowledged.v1:';
const ACKNOWLEDGED_VALUE = JSON.stringify({ acknowledged: true });

const acknowledgedKeys = new Set<string>();
let storageQueue: Promise<void> = Promise.resolve();

function normalizeScopePart(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? '';
  return normalized ? normalized : null;
}

function storageKeyForScope(
  accountId: string | null | undefined,
  controlledDeviceId: string | null | undefined,
): string | null {
  const account = normalizeScopePart(accountId);
  const device = normalizeScopePart(controlledDeviceId);
  if (!account || !device) return null;
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(account)}:${encodeURIComponent(device)}`;
}

function enqueueStorage<T>(operation: () => Promise<T>): Promise<T> {
  const run = storageQueue.then(operation, operation);
  storageQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function clearAcknowledgedKeys(accountPrefix: string): void {
  for (const key of acknowledgedKeys) {
    if (key.startsWith(accountPrefix)) acknowledgedKeys.delete(key);
  }
}

/** Read failures fail closed: the caller will show the warning again. */
export async function hasFullAccessAcknowledgement(
  accountId: string | null | undefined,
  controlledDeviceId: string | null | undefined,
): Promise<boolean> {
  const key = storageKeyForScope(accountId, controlledDeviceId);
  if (!key) return false;
  if (acknowledgedKeys.has(key)) return true;

  return enqueueStorage(async () => {
    if (acknowledgedKeys.has(key)) return true;
    const raw = await AsyncStorage.getItem(key).catch(() => null);
    if (!raw) return false;
    try {
      if (JSON.parse(raw)?.acknowledged !== true) return false;
    } catch {
      return false;
    }
    acknowledgedKeys.add(key);
    return true;
  });
}

/**
 * Keep the in-process acknowledgement even if persistence fails: the user just
 * approved this switch, but a later cold start will safely ask again.
 */
export async function rememberFullAccessAcknowledgement(
  accountId: string | null | undefined,
  controlledDeviceId: string | null | undefined,
): Promise<void> {
  const key = storageKeyForScope(accountId, controlledDeviceId);
  if (!key) return;
  acknowledgedKeys.add(key);
  await enqueueStorage(() => AsyncStorage.setItem(key, ACKNOWLEDGED_VALUE)).catch(() => undefined);
}

/** Explicit account deletion only. Ordinary logout intentionally keeps acknowledgement. */
export async function clearFullAccessAcknowledgementsForAccount(
  accountId: string | null | undefined,
): Promise<void> {
  const account = normalizeScopePart(accountId);
  if (!account) return;
  const accountPrefix = `${STORAGE_KEY_PREFIX}${encodeURIComponent(account)}:`;

  clearAcknowledgedKeys(accountPrefix);

  await enqueueStorage(async () => {
    // A read queued before this clear may have repopulated the memory cache.
    clearAcknowledgedKeys(accountPrefix);
    const keys = await AsyncStorage.getAllKeys().catch(() => [] as readonly string[]);
    const owned = keys.filter((key) => key.startsWith(accountPrefix));
    if (owned.length > 0) {
      await AsyncStorage.multiRemove(owned).catch(() => undefined);
    }
    clearAcknowledgedKeys(accountPrefix);
  });
}

export const __testing = {
  storageKeyForScope,
  storageKeyPrefix: STORAGE_KEY_PREFIX,
  resetMemory(): void {
    acknowledgedKeys.clear();
    storageQueue = Promise.resolve();
  },
};
