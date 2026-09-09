import type { HistoryViewItem, HistoryViewSnapshot, HistoryWorkSummary } from '@cindy/maker-shared/message-window';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { getActiveMobileSessionRealm } from '@/config/env';
import { HistoryDiskStore, HISTORY_DISK_ITEM_BYTES, historyValueBytes } from './historyDiskStore';
import type { RemoteMessage } from './types';

let store: Promise<HistoryDiskStore> | null = null;
let epoch = 0;
const keyEpochs = new Map<string, number>();
const disk = () => store ??= import('./historyDiskStoreExpo')
  .then(({ createHistoryDiskIO }) => new HistoryDiskStore(createHistoryDiskIO()));
export function historyDiskAuthority(deviceId: string, sessionId: string) {
  const owner = getMobileAuthOwner();
  const realm = getActiveMobileSessionRealm();
  const generation = epoch;
  const key = JSON.stringify([realm, owner.accountId, deviceId, sessionId]);
  const keyEpoch = keyEpochs.get(key) ?? 0;
  keyEpochs.set(key, keyEpoch);
  const ownerCurrent = () => !!owner.accountId && isMobileAuthOwnerCurrent(owner) && realm === getActiveMobileSessionRealm();
  return {
    key,
    ownerCurrent,
    current: () => !!owner.accountId && !!deviceId && !!sessionId
      && generation === epoch && keyEpoch === (keyEpochs.get(key) ?? 0)
      && ownerCurrent(),
  };
}
type Authority = ReturnType<typeof historyDiskAuthority>;

function validSummary(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object' || depth > 32) return false;
  const s = value as Record<string, unknown>;
  return ['key', 'firstMessageId', 'lastMessageId', 'revision'].every(key => typeof s[key] === 'string')
    && ['startedAtMs', 'endedAtMs', 'messageCount', 'toolCount'].every(key => typeof s[key] === 'number' && Number.isFinite(s[key]))
    && typeof s.isStreaming === 'boolean' && (!s.preview || validSummary(s.preview, depth + 1));
}
function validItems(value: unknown, depth = 0): boolean {
  if (!Array.isArray(value) || depth > 32) return false;
  return value.every(item => item && typeof item.key === 'string' && (
    item.type === 'messages' ? Array.isArray(item.messages) && item.messages.every((m: RemoteMessage) =>
      m && typeof m.id === 'string' && typeof m.clientId === 'string' && typeof m.role === 'string'
      && typeof m.createdAt === 'string')
      : item.type === 'work' && validSummary(item.summary)
        && (!item.children || validItems(item.children, depth + 1))
  ));
}
export async function readHistoryDisk(authority: Authority): Promise<HistoryViewSnapshot<RemoteMessage> | null> {
  if (!authority.current()) return null;
  try {
    const text = await (await disk()).read(authority.key, authority.current);
    if (!text || !authority.current()) return null;
    const value = JSON.parse(text);
    if (value.version !== 1 || !validItems(value.items) || typeof value.hasMore !== 'boolean'
      || (value.nextCursor !== null && typeof value.nextCursor !== 'string')
      || !Array.isArray(value.expanded) || !value.expanded.every((key: unknown) => typeof key === 'string')
      || !Array.isArray(value.details) || !value.details.every((entry: unknown[]) => Array.isArray(entry)
        && typeof entry[0] === 'string' && entry[1] && typeof entry[1] === 'object'
        && (entry[1] as { complete: unknown }).complete === true
        && (entry[1] as { loading: unknown }).loading === false
        && typeof (entry[1] as { revision: unknown }).revision === 'string'
        && typeof (entry[1] as { lastMessageId: unknown }).lastMessageId === 'string'
        && validItems([{ type: 'messages', key: '', messages: (entry[1] as { messages: unknown }).messages }]))) return null;
    return { ...value, details: new Map(value.details), expanded: new Set(value.expanded),
      ready: true, loading: false, error: null };
  } catch { return null; }
}
export async function writeHistoryDisk(authority: Authority, snapshot: HistoryViewSnapshot<RemoteMessage>): Promise<void> {
  if (!authority.current() || !snapshot.ready || snapshot.loading || snapshot.error) return;
  if (historyValueBytes([snapshot.items, snapshot.details, snapshot.expanded, snapshot.nextCursor], HISTORY_DISK_ITEM_BYTES - 1024) > HISTORY_DISK_ITEM_BYTES - 1024) return;
  try {
    const messages = (rows: readonly RemoteMessage[]) => rows.map(row =>
      row.agentMeta?.isStreaming === true || row.agentMeta?.streaming === true
        ? { ...row, agentMeta: { ...row.agentMeta,
          ...(row.agentMeta.isStreaming === true ? { isStreaming: false } : {}),
          ...(row.agentMeta.streaming === true ? { streaming: false } : {}),
        } } : row);
    const summary = (value: HistoryWorkSummary): HistoryWorkSummary => ({ ...value, isStreaming: false,
      ...(value.preview ? { preview: summary(value.preview) } : {}),
    });
    const items = (values: readonly HistoryViewItem<RemoteMessage>[]): HistoryViewItem<RemoteMessage>[] => values.map(item =>
      item.type === 'messages' ? { ...item, messages: messages(item.messages) }
        : { ...item, summary: summary(item.summary), ...(item.children ? { children: items(item.children) } : {}) });
    const text = JSON.stringify({ version: 1, items: items(snapshot.items),
      details: [...snapshot.details].filter(([, detail]) => detail.complete && !detail.loading && !detail.error)
        .map(([key, detail]) => [key, { ...detail, messages: messages(detail.messages) }]),
      expanded: [...snapshot.expanded], nextCursor: snapshot.nextCursor, hasMore: snapshot.hasMore,
    });
    await (await disk()).write(authority.key, text, authority.current);
  } catch { /* Cache failure must not affect reading or synchronizing. */ }
}

export function clearHistoryDisk(deviceId?: string, sessionId?: string): Promise<void> {
  // Fence late reads, pending debounce callbacks and unmount writes synchronously.
  const matches = (key: string) => {
    try {
      const [, , device, session] = JSON.parse(key);
      return (deviceId === undefined || device === deviceId) && (sessionId === undefined || session === sessionId);
    } catch { return true; }
  };
  if (deviceId === undefined && sessionId === undefined) { epoch++; keyEpochs.clear(); }
  else for (const [key, value] of keyEpochs) if (matches(key)) keyEpochs.set(key, value + 1);
  return disk().then(cache => cache.clear(matches)).catch(() => undefined);
}
