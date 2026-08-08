/**
 * Custom marketplace icon loader.
 *
 * Main owns discovery and filesystem access. Renderer batches visible requests, keeps bytes in a
 * bounded shared LRU, and treats a changed customIconKey as a new immutable generation.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import type {
  PluginMarketItem,
  PluginMarketLocalIconRequest,
  PluginMarketLocalIconResult,
} from '../../../../shared/pluginMarket';
import { parseCustomMarketPluginId } from '../../../../shared/pluginMarket';

type LocalIconStatus = 'idle' | 'queued' | 'loading' | 'loaded' | 'missing' | 'retryable';

interface LocalIconSnapshot {
  status: LocalIconStatus;
  dataUrl?: string;
}

interface LocalIconRecord {
  request: PluginMarketLocalIconRequest;
  snapshot: LocalIconSnapshot;
  listeners: Set<() => void>;
  pinCount: number;
  lastUsed: number;
  dataSize: number;
  retryCount: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  loadAttempt: number;
}

interface LocalIconBatchEntry {
  record: LocalIconRecord;
  attempt: number;
}

const EMPTY_SNAPSHOT: LocalIconSnapshot = Object.freeze({ status: 'idle' });
const BATCH_SIZE = 8;
const RECORD_CACHE_LIMIT = 128;
const DATA_URL_CACHE_BUDGET = 16 * 1024 * 1024;
const LOCAL_ICON_REQUEST_TIMEOUT_MS = 10_000;
const MAX_UNSETTLED_LOCAL_ICON_REQUESTS = 2;
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000] as const;
const records = new Map<string, LocalIconRecord>();
const queuedKeys = new Set<string>();
const unsettledLocalIconRequests = new Set<object>();
let flushScheduled = false;
let flushInFlight = false;
let pruneScheduled = false;
let totalDataSize = 0;

function requestKey(request: PluginMarketLocalIconRequest): string {
  return `${request.pluginId}:${request.expectedIconKey}`;
}

function requestMarketKey(request: PluginMarketLocalIconRequest): string {
  return parseCustomMarketPluginId(request.pluginId)?.marketName ?? request.pluginId;
}

function recordFor(request: PluginMarketLocalIconRequest): LocalIconRecord {
  const key = requestKey(request);
  const existing = records.get(key);
  if (existing) return existing;
  const created: LocalIconRecord = {
    request,
    snapshot: EMPTY_SNAPSHOT,
    listeners: new Set(),
    pinCount: 0,
    lastUsed: Date.now(),
    dataSize: 0,
    retryCount: 0,
    retryTimer: null,
    loadAttempt: 0,
  };
  records.set(key, created);
  scheduleRecordPrune();
  return created;
}

function canRemoveRecord(record: LocalIconRecord): boolean {
  return (
    record.pinCount === 0 &&
    record.listeners.size === 0 &&
    record.snapshot.status !== 'queued' &&
    record.snapshot.status !== 'loading'
  );
}

function removeRecord(record: LocalIconRecord): void {
  if (!canRemoveRecord(record)) return;
  if (record.retryTimer !== null) {
    clearTimeout(record.retryTimer);
    record.retryTimer = null;
  }
  queuedKeys.delete(requestKey(record.request));
  if (record.dataSize > 0) {
    totalDataSize -= record.dataSize;
    record.dataSize = 0;
  }
  records.delete(requestKey(record.request));
}

function pruneRecords(): void {
  if (records.size <= RECORD_CACHE_LIMIT) return;
  const candidates = [...records.values()]
    .filter(canRemoveRecord)
    .sort((a, b) => a.lastUsed - b.lastUsed);
  for (const record of candidates) {
    removeRecord(record);
    if (records.size <= RECORD_CACHE_LIMIT) break;
  }
}

function scheduleRecordPrune(): void {
  if (pruneScheduled) return;
  pruneScheduled = true;
  queueMicrotask(() => {
    pruneScheduled = false;
    pruneRecords();
  });
}

function publish(record: LocalIconRecord, snapshot: LocalIconSnapshot): void {
  if (record.dataSize > 0) {
    totalDataSize -= record.dataSize;
    record.dataSize = 0;
  }
  record.snapshot = snapshot;
  if (snapshot.status === 'loaded' && snapshot.dataUrl) {
    record.dataSize = snapshot.dataUrl.length;
    totalDataSize += record.dataSize;
  }
  record.lastUsed = Date.now();
  for (const listener of record.listeners) listener();
}

function evictUnpinnedData(): void {
  if (totalDataSize <= DATA_URL_CACHE_BUDGET) return;
  const candidates = [...records.values()]
    .filter((record) => record.pinCount === 0 && record.snapshot.status === 'loaded')
    .sort((a, b) => a.lastUsed - b.lastUsed);
  for (const record of candidates) {
    publish(record, EMPTY_SNAPSHOT);
    if (totalDataSize <= DATA_URL_CACHE_BUDGET) break;
  }
}

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => void flushQueue());
}

function queueRecord(record: LocalIconRecord): void {
  if (record.snapshot.status !== 'idle' && record.snapshot.status !== 'retryable') {
    return;
  }
  if (record.retryTimer !== null) return;
  publish(record, { status: 'queued' });
  queuedKeys.add(requestKey(record.request));
  scheduleFlush();
}

function scheduleRetry(record: LocalIconRecord): void {
  if (record.pinCount === 0 || record.retryTimer !== null) return;
  const delay = RETRY_DELAYS_MS[record.retryCount];
  if (delay === undefined) {
    publish(record, { status: 'missing' });
    return;
  }
  record.retryCount += 1;
  record.retryTimer = setTimeout(() => {
    record.retryTimer = null;
    queueRecord(record);
  }, delay);
}

function markRetryable(record: LocalIconRecord): void {
  publish(record, { status: 'retryable' });
  scheduleRetry(record);
}

function localIconsWithinTimeoutFromPromise(
  request: Promise<PluginMarketLocalIconResult[]>,
): Promise<PluginMarketLocalIconResult[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('custom marketplace icon request timed out')),
      LOCAL_ICON_REQUEST_TIMEOUT_MS,
    );
  });
  // Electron invoke cannot be cancelled from Renderer. Promise.race only releases this batch;
  // loadAttempt below prevents a late response from overwriting a retried record.
  return Promise.race([request, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<PluginMarketLocalIconResult[]>;
}

function trackUnsettledLocalIconRequest(request: Promise<PluginMarketLocalIconResult[]>): void {
  const token = {};
  unsettledLocalIconRequests.add(token);
  void request.then(
    () => unsettledLocalIconRequests.delete(token),
    () => unsettledLocalIconRequests.delete(token),
  );
}
function applyResult(record: LocalIconRecord, result: PluginMarketLocalIconResult): void {
  if (result.status === 'loaded') {
    publish(record, { status: 'loaded', dataUrl: result.dataUrl });
    evictUnpinnedData();
    pruneRecords();
    return;
  }
  if (result.status === 'missing') {
    publish(record, { status: 'missing' });
    pruneRecords();
    return;
  }
  markRetryable(record);
  pruneRecords();
}

async function flushQueue(): Promise<void> {
  flushScheduled = false;
  if (flushInFlight) return;
  const batch: LocalIconBatchEntry[] = [];
  if (unsettledLocalIconRequests.size >= MAX_UNSETTLED_LOCAL_ICON_REQUESTS) {
    for (const key of queuedKeys) {
      queuedKeys.delete(key);
      const record = records.get(key);
      if (!record || record.snapshot.status !== 'queued') continue;
      publish(record, { status: 'loading' });
      markRetryable(record);
    }
    return;
  }
  const pendingKeys = [...queuedKeys];
  const firstPendingRecord = pendingKeys
    .map((key) => records.get(key))
    .find((record): record is LocalIconRecord => record?.snapshot.status === 'queued');
  const batchMarket = firstPendingRecord ? requestMarketKey(firstPendingRecord.request) : null;
  for (const key of pendingKeys) {
    queuedKeys.delete(key);
    const record = records.get(key);
    if (!record || record.snapshot.status !== 'queued') continue;
    if (batchMarket !== null && requestMarketKey(record.request) !== batchMarket) {
      queuedKeys.add(key);
      continue;
    }
    publish(record, { status: 'loading' });
    batch.push({ record, attempt: (record.loadAttempt += 1) });
    if (batch.length === BATCH_SIZE) break;
  }
  if (batch.length === 0) return;

  let ipcRequest: Promise<PluginMarketLocalIconResult[]>;
  try {
    ipcRequest = window.electronAPI.pluginMarket.localIcons(
      batch.map(({ record }) => record.request),
    );
  } catch {
    for (const { record, attempt } of batch) {
      if (record.loadAttempt === attempt) markRetryable(record);
    }
    if (queuedKeys.size > 0) scheduleFlush();
    return;
  }

  trackUnsettledLocalIconRequest(ipcRequest);
  flushInFlight = true;
  try {
    const results = await localIconsWithinTimeoutFromPromise(ipcRequest);
    const byKey = new Map(results.map((result) => [requestKey(result), result]));
    for (const { record, attempt } of batch) {
      if (record.loadAttempt !== attempt) continue;
      const result = byKey.get(requestKey(record.request));
      if (result) applyResult(record, result);
      else markRetryable(record);
    }
  } catch {
    for (const { record, attempt } of batch) {
      if (record.loadAttempt === attempt) markRetryable(record);
    }
  } finally {
    // A timeout is a logical failure boundary: release the queue so a hung Main request cannot
    // stop all later cards. The original invoke is already observed by Promise.race; its late
    // result is intentionally ignored and cannot overwrite a newer loadAttempt.
    flushInFlight = false;
    pruneRecords();
    if (queuedKeys.size > 0) scheduleFlush();
  }
}

function subscribe(request: PluginMarketLocalIconRequest | null, listener: () => void): () => void {
  if (!request) return () => undefined;
  const record = recordFor(request);
  record.listeners.add(listener);
  return () => {
    record.listeners.delete(listener);
    pruneRecords();
  };
}

function snapshot(request: PluginMarketLocalIconRequest | null): LocalIconSnapshot {
  return request ? recordFor(request).snapshot : EMPTY_SNAPSHOT;
}

function pin(request: PluginMarketLocalIconRequest): () => void {
  const record = recordFor(request);
  record.pinCount += 1;
  record.lastUsed = Date.now();
  queueRecord(record);
  return () => {
    record.pinCount = Math.max(0, record.pinCount - 1);
    if (record.pinCount === 0 && record.retryTimer !== null) {
      clearTimeout(record.retryTimer);
      record.retryTimer = null;
    }
    evictUnpinnedData();
    pruneRecords();
  };
}

function reportDecodeFailure(request: PluginMarketLocalIconRequest): void {
  const record = recordFor(request);
  markRetryable(record);
}

function reportDecodeSuccess(request: PluginMarketLocalIconRequest): void {
  const record = recordFor(request);
  record.retryCount = 0;
}

export function usePluginMarketIcon(
  item: Pick<PluginMarketItem, 'pluginId' | 'icon' | 'customIconKey' | 'sourceType'>,
  { deferUntilVisible }: { deferUntilVisible: boolean },
) {
  const request = useMemo<PluginMarketLocalIconRequest | null>(
    () =>
      item.sourceType !== 'server' && item.customIconKey
        ? { pluginId: item.pluginId, expectedIconKey: item.customIconKey }
        : null,
    [item.customIconKey, item.pluginId, item.sourceType],
  );
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [nearViewport, setNearViewport] = useState(
    () => !deferUntilVisible || typeof IntersectionObserver === 'undefined',
  );

  useEffect(() => {
    if (!request || !deferUntilVisible) {
      setNearViewport(true);
      return;
    }
    if (!target || typeof IntersectionObserver === 'undefined') {
      setNearViewport(typeof IntersectionObserver === 'undefined');
      return;
    }
    setNearViewport(false);
    const observer = new IntersectionObserver(
      (entries) => setNearViewport(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: '240px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [deferUntilVisible, request, target]);

  const subscribeToRequest = useCallback(
    (listener: () => void) => subscribe(request, listener),
    [request],
  );
  const getSnapshot = useCallback(() => snapshot(request), [request]);
  const current = useSyncExternalStore(subscribeToRequest, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!request || !nearViewport) return;
    return pin(request);
  }, [nearViewport, request]);

  const onIconLoadError = useCallback(
    (fallback?: () => void) => {
      if (request) reportDecodeFailure(request);
      else fallback?.();
    },
    [request],
  );
  const onIconLoad = useCallback(() => {
    if (request) reportDecodeSuccess(request);
  }, [request]);

  return {
    containerRef: setTarget,
    iconDataUrl:
      request && current.status === 'loaded'
        ? current.dataUrl
        : request
          ? undefined
          : item.icon?.url,
    onIconLoad,
    onIconLoadError,
  };
}

export function __resetPluginMarketIconStoreForTest(): void {
  for (const record of records.values()) {
    if (record.retryTimer !== null) clearTimeout(record.retryTimer);
  }
  records.clear();
  queuedKeys.clear();
  unsettledLocalIconRequests.clear();

  flushInFlight = false;
  pruneScheduled = false;
  totalDataSize = 0;
}

export function __pluginMarketIconStoreStatsForTest(): {
  records: number;
  loadedDataSize: number;
  unsettledRequests: number;
} {
  return {
    records: records.size,
    loadedDataSize: totalDataSize,
    unsettledRequests: unsettledLocalIconRequests.size,
  };
}
