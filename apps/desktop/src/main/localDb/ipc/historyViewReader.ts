import { randomUUID } from 'node:crypto';
import { throwIpcError } from '../../utils/ipcValidate';
import {
  HISTORY_VIEW_PAGE_BYTES, HISTORY_VIEW_PAGE_ITEMS, HISTORY_DETAIL_PAGE_BYTES,
  projectHistoryView, historySubagentScopes, mapHistoryViewMessages, historyWorkSummaries, type HistoryMessageSource, type HistoryViewItem,
  type HistoryViewPage, type HistoryDetailPage, type HistoryWorkReference,
} from '@cindy/maker-shared/message-window';

export const MAX_HISTORY_SCAN_ROWS = 2000;
const MAX_HISTORY_SCAN_BYTES = 8 * 1024 * 1024;

interface ReadOptions { limit: number; before?: string; after?: string }
export interface HistoryViewReaderDependencies<T extends HistoryMessageSource> {
  list(sessionId: string, opts: ReadOptions, skipImport: boolean): Promise<T[]>;
  /** Lightweight rows sufficient for grouping, never used as message bodies. */
  outline?(sessionId: string, opts: ReadOptions, skipImport: boolean): Promise<T[]>;
  hydrate?(sessionId: string, ids: string[]): Promise<T[]>;
  revision?(): Promise<string>;
  validate?(sessionId: string, ids: string[]): Promise<void>;
  /** Must reject anchors outside this session, cleared history or rewound history. */
  anchor(sessionId: string, id: string, outline?: boolean): Promise<T>;
  running(sessionId: string): boolean;
  live?(sessionId: string): T[];
}

function compareRows(a: HistoryMessageSource, b: HistoryMessageSource): number {
  return Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.rowid ?? 0) - (b.rowid ?? 0);
}

function firstId<T extends HistoryMessageSource>(item: HistoryViewItem<T>): string {
  return item.type === 'work' ? item.summary.firstMessageId : item.messages[0].id;
}

export function createHistoryViewReader<T extends HistoryMessageSource>(deps: HistoryViewReaderDependencies<T>) {
  let readRevision = 0;
  const readerEpoch = randomUUID();
  // Only retain scoped headers, never hydrated bodies. Revisions invalidate the
  // cache on DB writes/account changes; live ranges remain uncached.
  const detailRanges = new Map<string, { rows: T[]; bytes: number }>();
  let detailRevision: string | undefined;
  let detailCacheBytes = 0;
  return {
    async page(sessionId: string, before?: string, lazyDetails = false): Promise<HistoryViewPage<T>> {
      const outlined = lazyDetails && !!deps.outline && !!deps.hydrate;
      const batchSize = outlined ? 1000 : 100;
      const rowBudget = outlined ? 100000 : MAX_HISTORY_SCAN_ROWS;
      const read = outlined ? deps.outline! : deps.list;
      const outlineRevision = outlined ? `${readerEpoch}:${await deps.revision?.() ?? ++readRevision}` : undefined;
      const beforeAnchor = before ? await deps.anchor(sessionId, before, outlined) : undefined;
      let cursor = beforeAnchor?.id.startsWith('history-live:') ? undefined : beforeAnchor?.id;
      const chunks: T[][] = [];
      let raw: T[] = [];
      let exhausted = false;
      let items: HistoryViewItem<T>[] = [];
      let scannedRows = 0;
      let scannedBytes = 0;
      const unavailable = () => throwIpcError('UNSUPPORTED_CAPABILITY', 'History view scan budget exceeded');
      const liveRows = (stored: readonly T[]) => {
        const ids = new Set(stored.map((row) => row.clientId));
        const live: T[] = [];
        let bytes = scannedBytes;
        for (const row of !before ? (deps.live?.(sessionId) ?? []) : []) {
          if (ids.has(row.clientId)) continue;
          bytes += Buffer.byteLength(JSON.stringify(row), 'utf8');
          if (scannedRows + live.length + 1 > rowBudget || live.length >= MAX_HISTORY_SCAN_ROWS || bytes > MAX_HISTORY_SCAN_BYTES) unavailable();
          live.push(row);
        }
        return live;
      };
      // Scan locally until the *visible* page fills. The oldest open group is
      // withheld until a boundary is known, so a long run is not split per DB batch.
      for (let scan = 0; ; scan++) {
        // Never split a work group to satisfy this budget. Oversized history
        // uses the existing raw window path; one DB batch may transiently exceed it.
        if (scannedRows >= rowBudget) unavailable();
        const rows = await read(sessionId, { limit: batchSize, ...(cursor ? { before: cursor } : {}) }, scan > 0);
        for (const row of rows) {
          scannedRows++;
          scannedBytes += Buffer.byteLength(JSON.stringify(row), 'utf8');
          if (scannedRows > rowBudget || scannedBytes > MAX_HISTORY_SCAN_BYTES) unavailable();
        }
        if (rows.length === 0) { exhausted = true; break; }
        const next = rows[rows.length - 1].id;
        if (next === cursor) throwIpcError('INTERNAL', 'History cursor did not advance');
        cursor = next;
        chunks.push(rows.slice().reverse());
        exhausted = rows.length < batchSize;
        if (!exhausted && !rows.some((row) => row.role === 'user' || row.role === 'system')) continue;
        raw = chunks.slice().reverse().flat();
        const live = liveRows(raw);
        const boundary = exhausted ? 0 : raw.findIndex((row) => row.role === 'user' || row.role === 'system');
        items = boundary < 0 ? [] : projectHistoryView([...raw.slice(boundary), ...live], !before && deps.running(sessionId), lazyDetails);
        if (exhausted || items.length >= HISTORY_VIEW_PAGE_ITEMS) break;
      }
      raw = chunks.slice().reverse().flat();
      const live = liveRows(raw);
      const boundary = exhausted ? 0 : raw.findIndex((row) => row.role === 'user' || row.role === 'system');
      items = boundary < 0 ? [] : projectHistoryView([...raw.slice(boundary), ...live], !before && deps.running(sessionId), lazyDetails);
      if (outlined) {
        // Select by visible objects before reading any hidden payloads. Every
        // hydrated row is rechecked against the current session/rewind epoch.
        const candidate = items.slice(-HISTORY_VIEW_PAGE_ITEMS);
        const ids: string[] = [];
        mapHistoryViewMessages(candidate, (rows) => {
          ids.push(...rows.filter((row) => !row.id.startsWith('history-live:')).map((row) => row.id));
          return rows;
        });
        const hydrated = new Map((await deps.hydrate!(sessionId, [...new Set(ids)])).map((row) => [row.id, row]));
        items.splice(items.length - candidate.length, candidate.length,
          ...mapHistoryViewMessages(candidate, (rows) => rows.map((row) => hydrated.get(row.id) ?? row)));
        // The outline deliberately omits bodies, so it cannot hash their bytes.
        // SQLite change counters also cover edits to hidden bodies without
        // reading them. Unchanged snapshots retain their rendering identities.
        for (const summary of historyWorkSummaries(items)) summary.revision += `:${outlineRevision}`;
      }
      const selected: HistoryViewItem<T>[] = [];
      let bytes = 1024;
      for (let index = items.length - 1; index >= 0; index--) {
        const size = Buffer.byteLength(JSON.stringify(items[index]), 'utf8');
        if (selected.length > 0 && (selected.length >= HISTORY_VIEW_PAGE_ITEMS || bytes + size > HISTORY_VIEW_PAGE_BYTES)) break;
        selected.unshift(items[index]);
        bytes += size;
      }
      // A clear/rewind during the scan invalidates the whole snapshot, including
      // already-read rows. Never publish a prefix from the previous history epoch.
      if (raw.length) await Promise.all([deps.anchor(sessionId, raw[0].id, outlined), deps.anchor(sessionId, raw[raw.length - 1].id, outlined)]);
      const hasMore = !exhausted || selected.length < items.length;
      return { version: 1, items: selected, hasMore,
        nextCursor: hasMore && selected.length ? firstId(selected[0]) : null };
    },

    async details(sessionId: string, ref: HistoryWorkReference, after?: string): Promise<HistoryDetailPage<T>> {
      const finalize = async (page: HistoryDetailPage<T>): Promise<HistoryDetailPage<T>> => {
        // Like the summary scan, every detail exit must reject a clear/rewind
        // that happened while an earlier DB batch was already collected.
        const ids = new Set([ref.firstMessageId, ref.lastMessageId, ...page.messages.map((row) => row.id)]);
        if (deps.validate) await deps.validate(sessionId, [...ids]);
        else for (const id of ids) await deps.anchor(sessionId, id, true);
        return page;
      };
      if (ref.parentToolUseId && deps.outline && deps.hydrate) {
        const first = await deps.anchor(sessionId, ref.firstMessageId, true);
        const last = await deps.anchor(sessionId, ref.lastMessageId, true);
        if (compareRows(first, last) > 0) throwIpcError('INVALID_PARAMS', 'Invalid history range');
        const cursorAnchor = after ? await deps.anchor(sessionId, after, true) : undefined;
        if (cursorAnchor && (compareRows(cursorAnchor, first) < 0 || compareRows(cursorAnchor, last) > 0)) {
          throwIpcError('INVALID_PARAMS', 'Invalid detail cursor');
        }
        const revision = !ref.liveMessageIds?.length && deps.revision ? await deps.revision() : undefined;
        if (revision !== detailRevision) {
          detailRanges.clear(); detailCacheBytes = 0; detailRevision = revision;
        }
        const cacheKey = JSON.stringify([sessionId, ref.parentToolUseId, first.id, last.id, ref.lastStoredMessageId]);
        const cached = revision === undefined ? undefined : detailRanges.get(cacheKey);
        let scoped = cached?.rows;
        if (cached) {
          detailRanges.delete(cacheKey); detailRanges.set(cacheKey, cached);
        }
        if (!scoped) {
          const headers: T[] = [];
          if (!first.id.startsWith('history-live:')) {
            headers.push(first);
            let cursor = first.id;
            while (cursor !== (ref.lastStoredMessageId ?? last.id)) {
              const batch = (await deps.outline(sessionId, { limit: 1000, after: cursor }, true)).slice().reverse();
              if (!batch.length) break;
              const bounded = batch.filter((row) => compareRows(row, last) <= 0);
              headers.push(...bounded);
              if (headers.length > 100000) throwIpcError('INVALID_PARAMS', 'History detail range is too large');
              const next = batch.at(-1)!.id;
              if (next === cursor) throwIpcError('INTERNAL', 'History detail cursor did not advance');
              cursor = next;
              if (bounded.length < batch.length || batch.length < 1000) break;
            }
          }
          for (const id of ref.liveMessageIds ?? []) {
            const row = await deps.anchor(sessionId, id);
            if (!headers.some((stored) => stored.clientId === row.clientId)) headers.push(row);
          }
          const scopes = historySubagentScopes(headers, ref.parentToolUseId);
          scoped = headers.filter((row) => scopes.get(row.id) === ref.parentToolUseId);
          // A write during the scan must not publish a cache for an older epoch.
          if (revision !== undefined && revision === await deps.revision!() && revision === detailRevision) {
            const bytes = Buffer.byteLength(JSON.stringify(scoped), 'utf8');
            if (bytes <= MAX_HISTORY_SCAN_BYTES) {
              while (detailRanges.size && (detailRanges.size >= 2 || detailCacheBytes + bytes > MAX_HISTORY_SCAN_BYTES)) {
                const oldest = detailRanges.keys().next().value!;
                detailCacheBytes -= detailRanges.get(oldest)!.bytes;
                detailRanges.delete(oldest);
              }
              // Concurrent requests may have inserted the same range.
              detailCacheBytes -= detailRanges.get(cacheKey)?.bytes ?? 0;
              detailRanges.set(cacheKey, { rows: scoped, bytes }); detailCacheBytes += bytes;
            }
          }
        }
        const candidates = scoped.filter((row) => !cursorAnchor || compareRows(row, cursorAnchor) > 0);
        const collected: T[] = [];
        let bytes = 1024;
        for (let offset = 0; offset < candidates.length; offset += 100) {
          const batch = candidates.slice(offset, offset + 100);
          const stored = batch.filter((row) => !row.id.startsWith('history-live:'));
          const full = new Map((await deps.hydrate(sessionId, stored.map((row) => row.id))).map((row) => [row.id, row]));
          for (const header of batch) {
            const row = full.get(header.id) ?? header;
            const size = Buffer.byteLength(JSON.stringify(row), 'utf8');
            if (collected.length && bytes + size > HISTORY_DETAIL_PAGE_BYTES) {
              return finalize({ version: 1, messages: collected, hasMore: true, nextCursor: collected.at(-1)!.id });
            }
            collected.push(row); bytes += size;
          }
        }
        return finalize({ version: 1, messages: collected, hasMore: false, nextCursor: null });
      }
      if (ref.liveMessageIds?.length) {
        const liveCursor = after ? ref.liveMessageIds.indexOf(after) : -1;
        const stored = liveCursor >= 0 || !ref.firstStoredMessageId || !ref.lastStoredMessageId
          ? { version: 1 as const, messages: [] as T[], hasMore: false, nextCursor: null }
          : await this.details(sessionId, { key: ref.key, firstMessageId: ref.firstStoredMessageId, lastMessageId: ref.lastStoredMessageId }, after);
        if (stored.hasMore) return finalize(stored);
        const collected = [...stored.messages];
        let bytes = Buffer.byteLength(JSON.stringify(collected), 'utf8') + 1024;
        let cursor = stored.messages.at(-1)?.id ?? after ?? ref.lastStoredMessageId;
        for (let index = liveCursor + 1; index < ref.liveMessageIds.length; index++) {
          const row = await deps.anchor(sessionId, ref.liveMessageIds[index]);
          if (collected.some((storedRow) => storedRow.clientId === row.clientId)) continue;
          const size = Buffer.byteLength(JSON.stringify(row), 'utf8');
          if (collected.length > 0 && bytes + size > HISTORY_DETAIL_PAGE_BYTES) {
            return finalize({ version: 1, messages: collected, hasMore: true, nextCursor: cursor ?? null });
          }
          collected.push(row);
          bytes += size;
          cursor = ref.liveMessageIds[index];
        }
        return finalize({ version: 1, messages: collected, hasMore: false, nextCursor: null });
      }
      const first = await deps.anchor(sessionId, ref.firstMessageId);
      const last = await deps.anchor(sessionId, ref.lastMessageId);
      if (compareRows(first, last) > 0) throwIpcError('INVALID_PARAMS', 'Invalid history range');
      let cursor = after;
      const collected: T[] = [];
      let bytes = 1024;
      if (!after) {
        collected.push(first);
        bytes += Buffer.byteLength(JSON.stringify(first), 'utf8');
        cursor = first.id;
      } else {
        const anchor = await deps.anchor(sessionId, after);
        if (compareRows(anchor, first) < 0 || compareRows(anchor, last) > 0) throwIpcError('INVALID_PARAMS', 'Invalid detail cursor');
      }
      if (cursor === last.id) return finalize({ version: 1, messages: collected, nextCursor: null, hasMore: false });
      for (;;) {
        const rows = (await deps.list(sessionId, { limit: 100, after: cursor }, true)).slice().reverse();
        if (rows.length === 0) throwIpcError('NOT_FOUND', 'History range changed');
        for (const row of rows) {
          if (compareRows(row, last) > 0) throwIpcError('NOT_FOUND', 'History range changed');
          const size = Buffer.byteLength(JSON.stringify(row), 'utf8');
          if (collected.length > 0 && bytes + size > HISTORY_DETAIL_PAGE_BYTES) {
            return finalize({ version: 1, messages: collected, nextCursor: cursor ?? null, hasMore: true });
          }
          if (row.id === cursor) throwIpcError('INTERNAL', 'History detail cursor did not advance');
          collected.push(row);
          bytes += size;
          cursor = row.id;
          if (cursor === last.id) return finalize({ version: 1, messages: collected, nextCursor: null, hasMore: false });
          if (Date.parse(row.createdAt) > Date.parse(last.createdAt)) throwIpcError('NOT_FOUND', 'History range changed');
        }
      }
    },
  };
}
