import AsyncStorage from '@react-native-async-storage/async-storage';
import { normalizeRemoteCollectionItems, parseRemoteResourceTargets, type HostedRemoteCollectionItem, type RemoteHomeCollection } from './remoteResources';

const PREFIX = 'cindy.remoteResources.v1.';
const MAX_CHARS = 256 * 1024;
type Snapshot = { home: RemoteHomeCollection[]; items: Record<string, HostedRemoteCollectionItem[]>; read: Record<string, number> };
const empty = (): Snapshot => ({ home: [], items: {}, read: {} });
let epoch = 0;
const writes = new Map<string, Promise<void>>();
const snapshots = new Map<string, Snapshot>();
const listeners = new Set<() => void>();
let revision = 0;
export const subscribeRemoteResourceCache = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const remoteResourceCacheRevision = () => revision;
const emit = () => { revision += 1; listeners.forEach((fn) => fn()); };

/** Cache only portable display/link fields; availability is always live. */
function normalize(raw: unknown): Snapshot {
  const out = empty();
  if (!raw || typeof raw !== 'object') return out;
  const value = raw as Partial<Snapshot>;
  if (Array.isArray(value.home)) for (const row of value.home.slice(0, 32)) {
    if (!row || typeof row.id !== 'string' || row.id.length > 160 || typeof row.title !== 'string' || typeof row.resourceKind !== 'string') continue;
    out.home.push({ id: row.id, title: row.title.slice(0, 512), resourceKind: row.resourceKind.slice(0,160), placement: 'home-scope', targets: parseRemoteResourceTargets(JSON.stringify(row.targets)) });
  }
  if (value.items && typeof value.items === 'object') for (const [id, rows] of Object.entries(value.items).slice(0, 32)) {
    if (id.length > 160 || !Array.isArray(rows)) continue;
    out.items[id] = rows.slice(0, 200).flatMap((row) => {
      if (!row) return [];
      const [host] = parseRemoteResourceTargets(JSON.stringify([row.host]));
      const [item] = normalizeRemoteCollectionItems({ items: [row.item] }, id);
      return host && item ? [{ host, item, key: JSON.stringify([host.deviceId, item.ref.kind, item.ref.id]) }] : [];
    });
  }
  if (value.read && typeof value.read === 'object') for (const [key, at] of Object.entries(value.read).slice(-2000)) {
    if (key.length <= 600 && typeof at === 'number' && Number.isFinite(at) && at >= 0) out.read[key] = at;
  }
  return out;
}

export async function readRemoteResourceSnapshot(userId: string): Promise<Snapshot> {
  if (!userId) return empty();
  const cached = snapshots.get(userId);
  if (cached) return cached;
  const expected = epoch;
  const raw = await AsyncStorage.getItem(PREFIX + userId).catch(() => null);
  let value = empty();
  try { if (raw && raw.length <= MAX_CHARS) value = normalize(JSON.parse(raw)); } catch { /* cache miss */ }
  if (epoch !== expected) return empty();
  if (!snapshots.has(userId)) snapshots.set(userId, value);
  return snapshots.get(userId)!;
}

async function update(userId: string, change: (snapshot: Snapshot) => void): Promise<void> {
  if (!userId) return;
  const expected = epoch;
  const previous = writes.get(userId) ?? Promise.resolve();
  const next = previous.then(async () => {
    const snapshot = await readRemoteResourceSnapshot(userId);
    if (expected !== epoch) return;
    change(snapshot);
    const cleaned = normalize(snapshot);
    snapshots.set(userId, cleaned); emit();
    const raw = JSON.stringify(cleaned);
    if (raw.length > MAX_CHARS) return;
    await AsyncStorage.setItem(PREFIX + userId, raw).catch(() => undefined);
    if (expected !== epoch) await AsyncStorage.removeItem(PREFIX + userId).catch(() => undefined);
  });
  writes.set(userId, next);
  await next.finally(() => { if (writes.get(userId) === next) writes.delete(userId); });
}
export const cacheRemoteResourceHome = (userId: string, home: RemoteHomeCollection[]) => update(userId, (s) => { s.home = home; });
export const remoteResourceReadKey = (deviceId: string, resourceId: string) => JSON.stringify([deviceId, resourceId]);
export const cacheRemoteResourceItems = (userId: string, collectionId: string, items: HostedRemoteCollectionItem[]) => update(userId, (s) => {
  s.items[collectionId] = items;
  for (const row of items) {
    const key = remoteResourceReadKey(row.host.deviceId, row.item.ref.id);
    if (row.item.ref.kind === 'bot' && s.read[key] === undefined) s.read[key] = row.item.display.lastReplyAt ?? 0;
  }
});
export const markRemoteResourceRead = (userId: string, deviceId: string, resourceId: string, at: number) => update(userId, (s) => {
  const key = remoteResourceReadKey(deviceId, resourceId);
  if (Number.isFinite(at) && at >= 0) s.read[key] = Math.max(s.read[key] ?? 0, at);
});
export function isRemoteResourceUnread(userId: string, deviceId: string, resourceId: string, at?: number): boolean {
  const read = snapshots.get(userId)?.read[remoteResourceReadKey(deviceId, resourceId)];
  return at !== undefined && read !== undefined && at > read;
}
export async function clearRemoteResourceCache(): Promise<void> {
  epoch += 1; snapshots.clear(); emit();
  await Promise.allSettled([...writes.values()]);
  const keys = await AsyncStorage.getAllKeys().catch(() => []);
  await AsyncStorage.multiRemove(keys.filter((key) => key.startsWith(PREFIX))).catch(() => undefined);
}
