import type { HistoryMessageSource, HistoryViewSnapshot } from '@cindy/maker-shared/message-window';
import { historyWorkSummaries } from '@cindy/maker-shared/message-window';

/** One eligibility rule for write admission, serialization and old cache reads. */
export function currentRemoteHistoryDetails<T extends HistoryMessageSource>(snapshot: HistoryViewSnapshot<T>) {
  const summaries = new Map(historyWorkSummaries(snapshot.items).map((summary) => [summary.key, summary]));
  return new Map([...snapshot.details].filter(([key, detail]) => {
    const summary = summaries.get(key);
    return summary && detail.complete && !detail.loading && !detail.error
      && detail.revision === summary.revision && detail.lastMessageId === summary.lastMessageId;
  }));
}

/** Same bounded, versioned snapshot in Main's existing account-scoped mirror file. */
export const MAX_HISTORY_CACHE_CHARS = 512 * 1024;

/** Reserve space for StoredMessages metadata; historyView is itself a JSON string. */
export function fitsRemoteHistoryCache(text: string): boolean {
  return text.length <= MAX_HISTORY_CACHE_CHARS
    && new TextEncoder().encode(JSON.stringify(text)).byteLength + 256 <= 512 * 1024;
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function validRows(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (row) =>
        record(row) &&
        ['id', 'clientId', 'role', 'createdAt'].every((key) => typeof row[key] === 'string') &&
        typeof row.content === 'string' &&
        !row.isPendingPersist &&
        !row.localSendPrecedingClientIds,
    )
  );
}

function validSummary(value: unknown, depth: number): boolean {
  return (
    depth < 32 &&
    record(value) &&
    ['key', 'firstMessageId', 'lastMessageId', 'revision'].every(
      (key) => typeof value[key] === 'string',
    ) &&
    ['startedAtMs', 'endedAtMs', 'messageCount', 'toolCount'].every(
      (key) => typeof value[key] === 'number' && Number.isFinite(value[key]),
    ) &&
    typeof value.isStreaming === 'boolean' &&
    (value.parentToolUseId === undefined || typeof value.parentToolUseId === 'string') &&
    (value.model === undefined || typeof value.model === 'string') &&
    (value.artifacts === undefined || Array.isArray(value.artifacts) && value.artifacts.every((file) =>
      record(file) && typeof file.path === 'string' && typeof file.createdAt === 'string'
      && (file.source === 'tool' || file.source === 'command')
      && (file.ready === undefined || typeof file.ready === 'boolean')
      && (file.exclude === undefined || file.exclude === 'all' || file.exclude === 'command'))) &&
    (value.preview === undefined || validSummary(value.preview, depth + 1))
  );
}

function validItems(value: unknown, depth = 0): boolean {
  return (
    depth < 32 &&
    Array.isArray(value) &&
    value.every(
      (item) =>
        record(item) &&
        typeof item.key === 'string' &&
        (item.type === 'messages'
          ? validRows(item.messages) && (item.deferred === undefined || validSummary(item.deferred, depth))
          : item.type === 'work' &&
            validSummary(item.summary, depth) &&
            (item.children === undefined || validItems(item.children, depth + 1))),
    )
  );
}

export function decodeRemoteHistory<T extends HistoryMessageSource>(
  text: unknown,
): HistoryViewSnapshot<T> | null {
  if (typeof text !== 'string' || text.length > MAX_HISTORY_CACHE_CHARS) return null;
  try {
    const value = JSON.parse(text);
    if (
      !record(value) ||
      value.version !== 1 ||
      !validItems(value.items) ||
      typeof value.hasMore !== 'boolean' ||
      !(value.nextCursor === null || typeof value.nextCursor === 'string') ||
      !Array.isArray(value.expanded) ||
      !value.expanded.every((key) => typeof key === 'string') ||
      !Array.isArray(value.details) ||
      !value.details.every(
        (entry) =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === 'string' &&
          record(entry[1]) &&
          entry[1].complete === true &&
          entry[1].loading === false &&
          entry[1].error === null &&
          typeof entry[1].revision === 'string' &&
          typeof entry[1].lastMessageId === 'string' &&
          validRows(entry[1].messages),
      )
    )
      return null;
    const snapshot = {
      items: value.items,
      details: new Map(value.details),
      expanded: new Set(value.expanded),
      hasMore: value.hasMore,
      nextCursor: value.nextCursor,
      ready: true,
      loading: false,
      error: null,
    } as HistoryViewSnapshot<T>;
    return { ...snapshot, details: currentRemoteHistoryDetails(snapshot) };
  } catch {
    return null;
  }
}

export function encodeRemoteHistory<T extends HistoryMessageSource>(
  snapshot: HistoryViewSnapshot<T>,
): string {
  return JSON.stringify(
    {
      version: 1,
      items: snapshot.items,
      details: [...currentRemoteHistoryDetails(snapshot)],
      expanded: [...snapshot.expanded],
      hasMore: snapshot.hasMore,
      nextCursor: snapshot.nextCursor,
    },
    (key, value) => {
      // A cached transcript may be read offline. Never revive a live indicator or send payload.
      if (key === 'isStreaming' || key === 'streaming') return false;
      if (
        key === 'retryFiles' ||
        key === 'localSendPrecedingClientIds' ||
        key === 'isPendingPersist'
      )
        return undefined;
      return value;
    },
  );
}
