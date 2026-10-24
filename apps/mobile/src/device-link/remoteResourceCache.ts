import AsyncStorage from '@react-native-async-storage/async-storage';
import { resolveRemoteText } from '@cindy/device-link';
import { isMobileRemoteCollectionSupported, normalizeRemoteCollectionItems, parseRemoteResourceTargets, type HostedRemoteCollectionItem, type RemoteHomeCollection } from './remoteResources';

const PREFIX = 'cindy.remoteResources.v1.';
const MAX_CHARS = 256 * 1024;
type ChatRoster = { items: HostedRemoteCollectionItem[]; ids: string[] };
type Snapshot = { home: RemoteHomeCollection[]; items: Record<string, HostedRemoteCollectionItem[]>; read: Record<string, number>; readSequences?: Record<string, string>; chatRosters?: Record<string, ChatRoster> };
const empty = (): Snapshot => ({ home: [], items: {}, read: {}, readSequences: {} });
const validSequence = (value: unknown): value is string => typeof value === 'string' && /^\d{1,30}$/.test(value);
let epoch = 0;
const writes = new Map<string, Promise<void>>();
const snapshots = new Map<string, Snapshot>();
// Users whose last disk write failed; the next update retries it even when unchanged.
const unsaved = new Set<string>();
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
    if (!isMobileRemoteCollectionSupported(row.id)) continue;
    out.home.push({ id: row.id, title: row.title.slice(0, 512), resourceKind: row.resourceKind.slice(0,160), placement: 'home-scope', targets: parseRemoteResourceTargets(JSON.stringify(row.targets)) });
  }
  if (value.items && typeof value.items === 'object') for (const [id, rows] of Object.entries(value.items).slice(0, 32)) {
    if (id.length > 160 || !Array.isArray(rows) || !isMobileRemoteCollectionSupported(id)) continue;
    out.items[id] = rows.slice(0, 200).flatMap((row) => {
      if (!row) return [];
      const [host] = parseRemoteResourceTargets(JSON.stringify([row.host]));
      const [item] = normalizeRemoteCollectionItems({ items: [row.item] }, id);
      return host && item ? [{ host, item, key: JSON.stringify([host.deviceId, item.ref.collectionId, item.ref.kind, item.ref.id]) }] : [];
    });
  }
  if (value.read && typeof value.read === 'object') for (const [key, at] of Object.entries(value.read).slice(-2000)) {
    if (key.length <= 600 && typeof at === 'number' && Number.isFinite(at) && at >= 0) out.read[key] = at;
  }
  if (value.readSequences && typeof value.readSequences === 'object') for (const [key, sequence] of Object.entries(value.readSequences).slice(-2000)) {
    if (key.length <= 600 && validSequence(sequence)) out.readSequences![key] = sequence;
  }
  // Direct server rows have no device host. Keep their display mirror separate from
  // legacy computer rows; neither cached membership nor presence grants access.
  if (value.chatRosters && typeof value.chatRosters === 'object') for (const realm of ['cn', 'global']) {
    const roster = value.chatRosters[realm];
    if (!roster || !Array.isArray(roster.items) || !Array.isArray(roster.ids)) continue;
    const items = roster.items.slice(0, 200).flatMap(row => {
      const [item] = normalizeRemoteCollectionItems({ items: [row?.item] }, 'bot-groups');
      if (!item || item.ref.kind !== 'bot-group') return [];
      const groupMembers = Array.isArray(row.groupMembers) ? row.groupMembers.slice(0, 200).flatMap(member => {
        if (!member || typeof member.botId !== 'string' || typeof member.name !== 'string') return [];
        return [{ botId: member.botId.slice(0, 160), name: member.name.slice(0, 512),
          avatar: typeof member.avatar === 'string' ? member.avatar.slice(0, 8192) : '',
          ...(typeof member.avatarUrl === 'string' && member.avatarUrl.startsWith('https://') ? { avatarUrl: member.avatarUrl.slice(0, 8192) } : {}),
          avatarColor: typeof member.avatarColor === 'string' ? member.avatarColor.slice(0, 64) : '' }];
      }) : undefined;
      return [{ key: `chat:${item.ref.id}`, host: { deviceId: '', deviceName: '' }, item, groupMembers,
        ...(row.chatUnread && Number.isInteger(row.chatUnread.count) && row.chatUnread.count >= 0
          && typeof row.chatUnread.mentioned === 'boolean' && Number.isInteger(row.chatUnread.threadCount)
          && row.chatUnread.threadCount >= 0 && row.chatUnread.threadCount <= row.chatUnread.count
          && typeof row.chatUnread.threadMentioned === 'boolean'
          ? { chatUnread: { count: Math.min(row.chatUnread.count, 999), mentioned: row.chatUnread.mentioned, threadCount: Math.min(row.chatUnread.threadCount, 999), threadMentioned: row.chatUnread.threadMentioned } } : {}),
        ...(validSequence(row.lastReplySequence) ? { lastReplySequence: row.lastReplySequence } : {}) }];
    });
    (out.chatRosters ??= {})[realm] = { items, ids: [...new Set(roster.ids.filter(id => typeof id === 'string' && id.length <= 160))].slice(-2000) };
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
  if (!snapshots.has(userId)) {
    snapshots.set(userId, value);
    // Rows read before the disk answered (e.g. task follow marks) must see the restored roster.
    if (raw) emit();
  }
  return snapshots.get(userId)!;
}

/** Trim only the disposable disk mirror; live rows and read positions stay intact. */
function diskSnapshot(raw: string): string {
  if (raw.length <= MAX_CHARS) return raw;
  const copy: Snapshot = JSON.parse(raw);
  // The group list paints at most five avatars; full membership comes from opening it.
  for (const roster of Object.values(copy.chatRosters ?? {})) {
    for (const row of roster.items) if (row.groupMembers) row.groupMembers = row.groupMembers.slice(0, 5);
  }
  let remaining = JSON.stringify(copy).length - MAX_CHARS;
  const lists = [...Object.values(copy.items), ...Object.values(copy.chatRosters ?? {}).map(roster => roster.items)];
  const candidates = lists.flat().sort((a, b) => (a.item.display.lastReplyAt ?? 0) - (b.item.display.lastReplyAt ?? 0));
  const removed = new Set<HostedRemoteCollectionItem>();
  for (const row of candidates) {
    if (remaining <= 0) break;
    removed.add(row); remaining -= JSON.stringify(row).length;
  }
  for (const list of lists) {
    const kept = list.filter(row => !removed.has(row));
    list.splice(0, list.length, ...kept);
  }
  // Pathological metadata alone can exhaust the budget too. Retain newer markers
  // before older ones, rather than silently leaving a stale whole snapshot on disk.
  for (const map of [copy.read, copy.readSequences ?? {}]) for (const key of Object.keys(map)) {
    if (remaining <= 0) break;
    remaining -= JSON.stringify(key).length + JSON.stringify(map[key]).length + 1;
    delete map[key];
  }
  for (const roster of Object.values(copy.chatRosters ?? {})) while (remaining > 0 && roster.ids.length) {
    remaining -= JSON.stringify(roster.ids.shift()).length;
  }
  while (remaining > 0 && copy.home.length) remaining -= JSON.stringify(copy.home.shift()).length;
  return JSON.stringify(copy);
}

async function update(userId: string, change: (snapshot: Snapshot) => void): Promise<void> {
  if (!userId) return;
  const expected = epoch;
  const previous = writes.get(userId) ?? Promise.resolve();
  const next = previous.then(async () => {
    const snapshot = await readRemoteResourceSnapshot(userId);
    if (expected !== epoch) return;
    const before = JSON.stringify(snapshot);
    change(snapshot);
    const cleaned = normalize(snapshot);
    const raw = JSON.stringify(cleaned);
    snapshots.set(userId, cleaned);
    // An unchanged cache must stay silent: subscribers re-render on every emit, and an
    // open companion chat re-acknowledges its read position on render (a JS render loop).
    if (raw === before && !unsaved.has(userId)) return;
    if (raw !== before) emit();
    const saved = await AsyncStorage.setItem(PREFIX + userId, diskSnapshot(raw)).then(() => true, () => false);
    if (expected !== epoch) { await AsyncStorage.removeItem(PREFIX + userId).catch(() => undefined); return; }
    if (saved) unsaved.delete(userId); else unsaved.add(userId);
  });
  writes.set(userId, next);
  await next.finally(() => { if (writes.get(userId) === next) writes.delete(userId); });
}
export const cacheRemoteResourceHome = (userId: string, home: RemoteHomeCollection[]) => update(userId, (s) => { s.home = home; });
export const readCachedChatRoster = async (userId: string, realm: string): Promise<ChatRoster | null> =>
  (await readRemoteResourceSnapshot(userId)).chatRosters?.[realm] ?? null;
export const cacheChatRoster = (userId: string, realm: string, items: HostedRemoteCollectionItem[], ids: Iterable<string>) => update(userId, s => {
  (s.chatRosters ??= {})[realm] = { items, ids: [...ids] };
});
export const hideCachedChatRooms = (userId: string, realm: string, ids: string[]) => update(userId, s => {
  const roster = s.chatRosters?.[realm];
  if (roster) { roster.items = roster.items.filter(row => !ids.includes(row.item.ref.id)); roster.ids = [...new Set([...roster.ids, ...ids])]; }
});
export const remoteResourceReadKey = (deviceId: string, resourceId: string) => JSON.stringify([deviceId, resourceId]);
export const cacheRemoteResourceItems = (userId: string, collectionId: string, items: HostedRemoteCollectionItem[]) => update(userId, (s) => {
  s.items[collectionId] = items;
  for (const row of items) {
    const key = remoteResourceReadKey(row.host.deviceId, row.item.ref.id);
    if ((row.item.ref.kind === 'bot' || row.item.ref.kind === 'bot-group') && s.read[key] === undefined) s.read[key] = row.item.display.lastReplyAt ?? 0;
  }
});
export const markRemoteResourceRead = (userId: string, deviceId: string, resourceId: string, at: number, sequence?: string) => update(userId, (s) => {
  const key = remoteResourceReadKey(deviceId, resourceId);
  if (Number.isFinite(at) && at >= 0) s.read[key] = Math.max(s.read[key] ?? 0, at);
  if (validSequence(sequence)) {
    const sequences = s.readSequences ??= {};
    if (sequences[key] === undefined || BigInt(sequence) > BigInt(sequences[key])) sequences[key] = sequence;
  }
});
export function isRemoteResourceUnread(userId: string, deviceId: string, resourceId: string, at?: number, sequence?: string): boolean {
  const snapshot = snapshots.get(userId);
  const key = remoteResourceReadKey(deviceId, resourceId);
  if (validSequence(sequence)) return BigInt(sequence) > BigInt(snapshot?.readSequences?.[key] ?? '0');
  const read = snapshot?.read[key];
  return at !== undefined && read !== undefined && at > read;
}
/** Name the cached Bot whose conversation link is this task. Presentation only; access stays live. */
export function cachedBotIdForSession(userId: string, collectionId: string, deviceId: string, sessionId: string): string {
  const row = snapshots.get(userId)?.items[collectionId]?.find(({ host, item }) => host.deviceId === deviceId
    && item.ref.kind === 'bot' && item.links.some(({ rel, target }) => rel === 'conversation'
      && target.kind === 'session' && target.sessionId === sessionId));
  return row?.item.ref.id ?? '';
}
const NO_FOLLOWERS: readonly HostedRemoteCollectionItem[] = [];
let followIndex: { userId: string; revision: number; byTask: Map<string, HostedRemoteCollectionItem[]> } | null = null;
/**
 * Teammates whose roster row follows this task (link rel `following`), by name, as the desktop
 * sidebar mark orders them. Same computer only; presentation only, never authorization.
 */
export function cachedTaskFollowers(userId: string, deviceId: string, sessionId: string): readonly HostedRemoteCollectionItem[] {
  if (!userId || !deviceId) return NO_FOLLOWERS;
  if (followIndex?.userId !== userId || followIndex.revision !== revision) {
    const byTask = new Map<string, HostedRemoteCollectionItem[]>();
    for (const row of snapshots.get(userId)?.items.teammates ?? []) {
      if (row.item.ref.kind !== 'bot') continue;
      for (const { rel, target } of row.item.links) {
        if (rel !== 'following' || target.kind !== 'session') continue;
        const key = JSON.stringify([row.host.deviceId, target.sessionId]);
        byTask.set(key, [...(byTask.get(key) ?? []), row]);
      }
    }
    const name = (row: HostedRemoteCollectionItem) => resolveRemoteText(row.item.display.title);
    for (const rows of byTask.values()) rows.sort((left, right) => name(left).localeCompare(name(right)));
    followIndex = { userId, revision, byTask };
  }
  return followIndex.byTask.get(JSON.stringify([deviceId, sessionId])) ?? NO_FOLLOWERS;
}
/** A cached roster row for display (name/avatar) only; never an authorization or availability signal. */
export function cachedBotItem(userId: string, collectionId: string, deviceId: string, botId: string) {
  return snapshots.get(userId)?.items[collectionId]?.find(({ host, item }) => host.deviceId === deviceId
    && item.ref.kind === 'bot' && item.ref.id === botId)?.item ?? null;
}
export async function clearRemoteResourceCache(): Promise<void> {
  epoch += 1; snapshots.clear(); unsaved.clear(); emit();
  await Promise.allSettled([...writes.values()]);
  const keys = await AsyncStorage.getAllKeys().catch(() => []);
  await AsyncStorage.multiRemove(keys.filter((key) => key.startsWith(PREFIX))).catch(() => undefined);
}

/** Drop only this account's display/unread mirror after a confirmed personal removal. */
export const forgetRemoteResource = (userId: string, resourceId: string) => update(userId, s => {
  for (const id of Object.keys(s.items)) s.items[id] = s.items[id].filter(row => row.item.ref.id !== resourceId);
  for (const roster of Object.values(s.chatRosters ?? {})) roster.items = roster.items.filter(row => row.item.ref.id !== resourceId);
  for (const map of [s.read, s.readSequences ?? {}]) for (const key of Object.keys(map)) {
    try { if (JSON.parse(key)[1] === resourceId) delete map[key]; } catch { /* legacy cache key */ }
  }
});
