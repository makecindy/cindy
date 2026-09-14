import { throwIpcError } from '../../utils/ipcValidate';
import {
  HISTORY_VIEW_PAGE_BYTES, HISTORY_VIEW_PAGE_ITEMS, HISTORY_DETAIL_PAGE_BYTES,
  projectHistoryView, type HistoryMessageSource, type HistoryViewItem,
  type HistoryViewPage, type HistoryDetailPage, type HistoryWorkReference,
} from '@cindy/maker-shared/message-window';

export const MAX_HISTORY_SCAN_ROWS = 2000;
const MAX_HISTORY_SCAN_BYTES = 8 * 1024 * 1024;

interface ReadOptions { limit: number; before?: string; after?: string }
export interface HistoryViewReaderDependencies<T extends HistoryMessageSource> {
  list(sessionId: string, opts: ReadOptions, skipImport: boolean): Promise<T[]>;
  /** Must reject anchors outside this session, cleared history or rewound history. */
  anchor(sessionId: string, id: string): Promise<T>;
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
  return {
    async page(sessionId: string, before?: string): Promise<HistoryViewPage<T>> {
      const beforeAnchor = before ? await deps.anchor(sessionId, before) : undefined;
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
          if (scannedRows + live.length + 1 > MAX_HISTORY_SCAN_ROWS || bytes > MAX_HISTORY_SCAN_BYTES) unavailable();
          live.push(row);
        }
        return live;
      };
      // Scan locally until the *visible* page fills. The oldest open group is
      // withheld until a boundary is known, so a long run is not split per DB batch.
      for (let scan = 0; ; scan++) {
        // Never split a work group to satisfy this budget. Oversized history
        // uses the existing raw window path; one DB batch may transiently exceed it.
        if (scannedRows >= MAX_HISTORY_SCAN_ROWS) unavailable();
        const rows = await deps.list(sessionId, { limit: 100, ...(cursor ? { before: cursor } : {}) }, scan > 0);
        for (const row of rows) {
          scannedRows++;
          scannedBytes += Buffer.byteLength(JSON.stringify(row), 'utf8');
          if (scannedRows > MAX_HISTORY_SCAN_ROWS || scannedBytes > MAX_HISTORY_SCAN_BYTES) unavailable();
        }
        if (rows.length === 0) { exhausted = true; break; }
        const next = rows[rows.length - 1].id;
        if (next === cursor) throwIpcError('INTERNAL', 'History cursor did not advance');
        cursor = next;
        chunks.push(rows.slice().reverse());
        exhausted = rows.length < 100;
        if (!exhausted && !rows.some((row) => row.role === 'user' || row.role === 'system')) continue;
        raw = chunks.slice().reverse().flat();
        const live = liveRows(raw);
        const boundary = exhausted ? 0 : raw.findIndex((row) => row.role === 'user' || row.role === 'system');
        items = boundary < 0 ? [] : projectHistoryView([...raw.slice(boundary), ...live], !before && deps.running(sessionId));
        if (exhausted || items.length >= HISTORY_VIEW_PAGE_ITEMS) break;
      }
      raw = chunks.slice().reverse().flat();
      const live = liveRows(raw);
      const boundary = exhausted ? 0 : raw.findIndex((row) => row.role === 'user' || row.role === 'system');
      items = boundary < 0 ? [] : projectHistoryView([...raw.slice(boundary), ...live], !before && deps.running(sessionId));
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
      if (raw.length) await Promise.all([deps.anchor(sessionId, raw[0].id), deps.anchor(sessionId, raw[raw.length - 1].id)]);
      const hasMore = !exhausted || selected.length < items.length;
      return { version: 1, items: selected, hasMore,
        nextCursor: hasMore && selected.length ? firstId(selected[0]) : null };
    },

    async details(sessionId: string, ref: HistoryWorkReference, after?: string): Promise<HistoryDetailPage<T>> {
      const finalize = async (page: HistoryDetailPage<T>): Promise<HistoryDetailPage<T>> => {
        // Like the summary scan, every detail exit must reject a clear/rewind
        // that happened while an earlier DB batch was already collected.
        const ids = new Set([ref.firstMessageId, ref.lastMessageId, ...page.messages.map((row) => row.id)]);
        for (const id of ids) await deps.anchor(sessionId, id);
        return page;
      };
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
