import { deleteSecureItem, getSecureItem, setSecureItem } from '@/auth/secureStorage';
import { compactVoiceInputHistoryIfNeeded, normalizeVoiceHistoryText } from '@cindy/voice-input-core';
export { MAX_REFINEMENT_HISTORY_ITEM_CHARS as MAX_MOBILE_VOICE_HISTORY_ITEM_CHARS } from '@cindy/voice-input-core';

const STORAGE_KEY_PREFIX = 'xdt.mobileVoiceHistory.v1';
const STORAGE_INDEX_KEY = `${STORAGE_KEY_PREFIX}.hosts`;

type StoredMobileVoiceHistoryEntry = {
  id: string;
  text: string;
  createdAt: number;
};

type StoredMobileVoiceHistory = {
  entries: StoredMobileVoiceHistoryEntry[];
  desktopSnapshot?: string;
};

export async function getMobileVoiceInputHistoryForHost(
  hostDeviceId: string,
  syncedDesktopHistory?: readonly string[],
): Promise<string[]> {
  const state = await readMobileVoiceHistory(hostDeviceId);
  if (syncedDesktopHistory?.length) {
    const desktopEntries = normalizeHistoryEntries(syncedDesktopHistory.map((text, index) => ({
      text, id: `desktop-${index}-${fnv1a(text)}`, createdAt: 1,
    })));
    const snapshot = JSON.stringify(desktopEntries.map((entry) => entry.text));
    // Remember the imported snapshot separately from the legacy history array.
    // Otherwise each dictation reimports entries removed by the last compaction.
    if (state.desktopSnapshot !== snapshot) {
      const localEntries = state.entries.filter((entry) => !entry.id.startsWith('desktop-'));
      const priorDesktopEntries = state.entries.filter((entry) => entry.id.startsWith('desktop-'));
      state.entries = normalizeHistoryEntries([...localEntries, ...desktopEntries, ...priorDesktopEntries]);
      state.desktopSnapshot = snapshot;
      // History is advisory; unavailable secure storage must not block recording.
      await writeMobileVoiceHistory(hostDeviceId, state).catch(() => undefined);
    }
  }
  return state.entries.map((entry) => entry.text);
}

export async function recordMobileVoiceInputHistoryForHost(
  hostDeviceId: string,
  text: string,
): Promise<string | null> {
  const normalizedHost = normalizeHostDeviceId(hostDeviceId);
  const normalizedText = normalizeHistoryText(text);
  if (!normalizedText) return null;
  const entries = await readMobileVoiceHistoryEntries(normalizedHost);
  await addHostToHistoryIndex(normalizedHost);
  const duplicate = entries.find((entry) => entry.text === normalizedText);
  if (duplicate) return duplicate.id;
  const createdAt = Date.now();
  const entry = {
    id: createMobileVoiceHistoryId(normalizedText, createdAt),
    text: normalizedText,
    createdAt,
  };
  await writeMobileVoiceHistoryEntries(normalizedHost, [
    entry,
    ...entries,
  ]);
  return entry.id;
}

export async function updateMobileVoiceInputHistoryEntryForHost(
  hostDeviceId: string,
  entryId: string,
  text: string,
): Promise<void> {
  const normalizedHost = normalizeHostDeviceId(hostDeviceId);
  const normalizedId = entryId.trim();
  const normalizedText = normalizeHistoryText(text);
  if (!normalizedId || !normalizedText) return;
  const entries = await readMobileVoiceHistoryEntries(normalizedHost);
  const entry = entries.find((candidate) => candidate.id === normalizedId);
  if (!entry) return;
  await writeMobileVoiceHistoryEntries(normalizedHost, [
    {
      ...entry,
      text: normalizedText,
    },
    ...entries.filter((candidate) => candidate.id !== normalizedId),
  ]);
}

export async function clearAllMobileVoiceInputHistories(): Promise<void> {
  const hosts = await readHistoryHostIndex();
  await Promise.all(
    hosts.flatMap((hostDeviceId) => [
      deleteSecureItem(storageKeyForHostDevice(hostDeviceId)).catch(() => undefined),
      deleteSecureItem(snapshotKeyForHostDevice(hostDeviceId)).catch(() => undefined),
    ]),
  );
  await deleteSecureItem(STORAGE_INDEX_KEY).catch(() => undefined);
}

async function readMobileVoiceHistoryEntries(hostDeviceId: string): Promise<StoredMobileVoiceHistoryEntry[]> {
  return (await readMobileVoiceHistory(hostDeviceId)).entries;
}

async function readMobileVoiceHistory(hostDeviceId: string): Promise<StoredMobileVoiceHistory> {
  const normalizedHost = normalizeHostDeviceId(hostDeviceId);
  const [raw, snapshot] = await Promise.all([
    getSecureItem(storageKeyForHostDevice(normalizedHost)).catch(() => null),
    getSecureItem(snapshotKeyForHostDevice(normalizedHost)).catch(() => null),
  ]);
  if (!raw) return { entries: [] };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return {
      entries: normalizeHistoryEntries(parsed),
      desktopSnapshot: snapshot ?? undefined,
    };
    // Recover development builds that wrote an object; the next write restores
    // the array understood by installed bundles and OTA rollback versions.
    if (!parsed || typeof parsed !== 'object') return { entries: [] };
    const state = parsed as Partial<StoredMobileVoiceHistory>;
    return {
      entries: normalizeHistoryEntries(Array.isArray(state.entries) ? state.entries : []),
      desktopSnapshot: typeof state.desktopSnapshot === 'string' ? state.desktopSnapshot : undefined,
    };
  } catch {
    return { entries: [] };
  }
}

async function writeMobileVoiceHistoryEntries(
  hostDeviceId: string,
  entries: StoredMobileVoiceHistoryEntry[],
): Promise<void> {
  const state = await readMobileVoiceHistory(hostDeviceId);
  await writeMobileVoiceHistory(hostDeviceId, { ...state, entries });
}

async function writeMobileVoiceHistory(hostDeviceId: string, state: StoredMobileVoiceHistory): Promise<void> {
  const normalizedHost = normalizeHostDeviceId(hostDeviceId);
  const entries = normalizeHistoryEntries(state.entries);
  await addHostToHistoryIndex(normalizedHost);
  // Always keep this v1 value readable by older bundles. Commit history before
  // its advisory marker so a failed history write cannot suppress a later import.
  await setSecureItem(storageKeyForHostDevice(normalizedHost), JSON.stringify(entries));
  if (state.desktopSnapshot) {
    await setSecureItem(snapshotKeyForHostDevice(normalizedHost), state.desktopSnapshot);
  }
}

function normalizeHistoryEntries(input: unknown[]): StoredMobileVoiceHistoryEntry[] {
  const entries: StoredMobileVoiceHistoryEntry[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Partial<StoredMobileVoiceHistoryEntry>;
    const text = normalizeHistoryText(record.text);
    if (!text || entries.some((entry) => entry.text === text)) continue;
    const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
      ? record.createdAt
      : Date.now();
    entries.push({
      id: typeof record.id === 'string' && record.id.trim()
        ? record.id.trim()
        : createMobileVoiceHistoryId(text, createdAt),
      text,
      createdAt,
    });
  }
  return compactVoiceInputHistoryIfNeeded(entries);
}

function normalizeHistoryText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return normalizeVoiceHistoryText(value);
}

function normalizeHostDeviceId(hostDeviceId: string): string {
  const normalized = hostDeviceId.trim();
  if (!normalized) throw new Error('host device id is required');
  return normalized;
}

function storageKeyForHostDevice(hostDeviceId: string): string {
  const safePrefix = hostDeviceId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'host';
  return `${STORAGE_KEY_PREFIX}.${safePrefix}.${fnv1a(hostDeviceId)}`;
}

function createMobileVoiceHistoryId(text: string, timestamp: number): string {
  return `voice-${timestamp.toString(36)}-${fnv1a(`${timestamp}:${text}`)}`;
}

function snapshotKeyForHostDevice(hostDeviceId: string): string {
  return `${storageKeyForHostDevice(hostDeviceId)}.desktopSnapshot`;
}

async function addHostToHistoryIndex(hostDeviceId: string): Promise<void> {
  const hosts = await readHistoryHostIndex();
  if (hosts.includes(hostDeviceId)) return;
  await writeHistoryHostIndex([...hosts, hostDeviceId]);
}

/**
 * 供凭据存量清理复用:用过语音输入的 host 一定同步过穿透凭据,这个索引是
 * SecureStore 无法枚举键时的第二个 host 推导来源(见
 * mobileVoiceCredentialStore.clearAllMobileVoiceCredentials)。
 */
export async function listMobileVoiceHistoryHosts(): Promise<string[]> {
  return readHistoryHostIndex();
}

async function readHistoryHostIndex(): Promise<string[]> {
  const raw = await getSecureItem(STORAGE_INDEX_KEY).catch(() => null);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const hosts: string[] = [];
    for (const item of parsed) {
      if (typeof item !== 'string') continue;
      const normalized = item.trim();
      if (normalized && !hosts.includes(normalized)) hosts.push(normalized);
    }
    return hosts;
  } catch {
    return [];
  }
}

async function writeHistoryHostIndex(hosts: string[]): Promise<void> {
  const normalizedHosts = hosts
    .map((host) => host.trim())
    .filter((host, index, list) => host && list.indexOf(host) === index);
  if (normalizedHosts.length === 0) {
    await deleteSecureItem(STORAGE_INDEX_KEY);
    return;
  }
  await setSecureItem(STORAGE_INDEX_KEY, JSON.stringify(normalizedHosts));
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export const __testing = {
  normalizeHistoryEntries,
  readHistoryHostIndex,
  storageIndexKey: STORAGE_INDEX_KEY,
  storageKeyForHostDevice,
  snapshotKeyForHostDevice,
};
